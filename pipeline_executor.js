import OSS from 'ali-oss';
import crypto from 'crypto';
import sharp from 'sharp';
import { getSetting } from './config_manager.js';

/**
 * Parses nodes and edges into an execution graph
 */
function buildGraph(nodes, edges) {
  const graph = {
    nodes: {},
    inEdges: {},
    outEdges: {}
  };

  for (const node of nodes) {
    graph.nodes[node.id] = node;
    graph.inEdges[node.id] = [];
    graph.outEdges[node.id] = [];
  }

  for (const edge of edges) {
    if (graph.nodes[edge.source] && graph.nodes[edge.target]) {
      graph.outEdges[edge.source].push(edge);
      graph.inEdges[edge.target].push(edge);
    }
  }

  return graph;
}

/**
 * Topologically sort nodes
 */
function topoSort(graph) {
  const sorted = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(nodeId) {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new Error(`Cycle detected at node ${nodeId}`);
    
    visiting.add(nodeId);
    for (const edge of graph.outEdges[nodeId]) {
      visit(edge.target);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    sorted.unshift(nodeId); // prepend
  }

  for (const nodeId of Object.keys(graph.nodes)) {
    visit(nodeId);
  }
  return sorted;
}

/**
 * Sleeps for ms
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Helper to download from a URL and upload directly to OSS with retry
 */
export async function uploadToOSS(ossClient, url, openid, order_id, set_index, filenamePrefix) {
  let buffer;
  let ext = 'png';

  if (url.startsWith('data:image')) {
    const matches = url.match(/^data:image\/(\w+);base64,(.+)$/);
    if (matches) {
      ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      throw new Error('Invalid base64 image string');
    }
  }

  const MAX_RETRIES = 3;
  const DOWNLOAD_TIMEOUT_MS = 60000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (!buffer) {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);

        const extMatch = url.split('.').pop().split('?')[0].match(/^(jpg|jpeg|png|webp|gif)$/i);
        if (extMatch) ext = extMatch[1];
      }

      const filename = `${filenamePrefix}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const ossPath = `delivery_imgs/${openid}/${order_id}/set${set_index}/${filename}`;

      const result = await ossClient.put(ossPath, buffer);
      return result.url;
    } catch (err) {
      console.warn(`[OSS Upload] Attempt ${attempt}/${MAX_RETRIES} failed for ${url.substring(0, 120)}: ${err.message}`);
      if (attempt === MAX_RETRIES) {
        console.error(`[OSS Upload] All ${MAX_RETRIES} attempts exhausted, giving up.`);
        throw err;
      }
      await sleep(2000 * attempt); // exponential backoff: 2s, 4s, 6s
    }
  }
}

/**
 * Executes a Seedream (Volcengine Ark) image generation
 */
async function executeSeedream(node, inputs, env, pool) {
  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) prompt = prompt.filter(Boolean).join('\n');
  const globalEndpointId = env.VOLCENGINE_ENDPOINT_ID || await getSetting(pool, 'VOLCENGINE_ENDPOINT_ID');
  const endpointId = node.data.endpoint_id || node.data.endpointId || globalEndpointId || 'ep-xxxx';
  const sizePreset = node.data.size || '2k (Origin)';
  let images = inputs.images || [];
  
  // if inputs.images is a single string, make it an array
  if (typeof images === 'string') images = [images];

  const apiKey = env.VOLCENGINE_API_KEY || await getSetting(pool, 'VOLCENGINE_API_KEY');
  if (!apiKey || apiKey === 'your-volcengine-api-key') throw new Error('VOLCENGINE_API_KEY environment variable is not set. Please set it in .env');

  let apiSize = sizePreset;
  if (sizePreset.includes('1k')) apiSize = '1k';
  else if (sizePreset.includes('2k')) apiSize = '2k';
  else if (sizePreset.includes('4k')) apiSize = '4k';
  else {
    const match = sizePreset.match(/^(\d+x\d+)/);
    if (match) apiSize = match[1];
  }

  const payload = {
    model: endpointId,
    prompt: prompt,
    size: apiSize,
    logo_info: {
      add_logo: false
    }
  };

  if (images.length > 0) {
    const base64Images = [];
    for (const url of images) {
      if (!url) continue;
      if (url.startsWith('data:image')) {
        base64Images.push(url);
      } else {
        try {
          const resp = await fetch(url);
          if (!resp.ok) continue;
          const arrayBuffer = await resp.arrayBuffer();
          let buffer = Buffer.from(arrayBuffer);
          
          // Pre-compress using sharp to avoid huge payloads (max 1536px, 85% JPEG)
          buffer = await sharp(buffer)
            .resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
            
          const base64 = buffer.toString('base64');
          base64Images.push(`data:image/jpeg;base64,${base64}`);
        } catch (imgErr) {
          console.warn(`[Pipeline] Failed to process image ${url.substring(0, 100)} for Seedream:`, imgErr.message);
        }
      }
    }
    if (base64Images.length > 0) {
      payload.image = base64Images;
    }
  }

  console.log(`[Pipeline] Seedream executing... model: ${endpointId}, size: ${apiSize}`);
  
  const res = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
    method: 'POST',
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300000)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Volcengine API Error [${res.status}]: ${errText}`);
  }

  const data = await res.json();
  const outputImages = [];
  
  if (data.data && data.data.length > 0) {
    for (const item of data.data) {
      if (item.url) {
        outputImages.push(item.url);
      } else if (item.b64_json) {
        outputImages.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
  }

  if (outputImages.length === 0) {
    throw new Error('Seedream returned no images');
  }

  return { output: outputImages };
}

/**
 * Executes a single OpenRouter API Call
 */
async function executeOpenRouterPreset(node, inputs, env, pool, orderContext) {
  const configuredEndpoint = env.OPENROUTER_API_ENDPOINT || await getSetting(pool, 'OPENROUTER_API_ENDPOINT') || 'https://openrouter.ai/api/v1/chat/completions';
  // Ensure endpoint always points to /chat/completions
  const endpoint = configuredEndpoint.includes('/chat/completions') ? configuredEndpoint : `${configuredEndpoint.replace(/\/$/, '')}/chat/completions`;
  const apiKey = env.OPENROUTER_API_KEY || await getSetting(pool, 'OPENROUTER_API_KEY');

  if (!apiKey) {
    throw new Error('OpenRouter API Key not configured in .env or Settings');
  }

  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) prompt = prompt.filter(Boolean).join('\n');
  const modelId = node.data.modelId || 'openai/gpt-5.4-image-2';
  const aspectRatio = node.data.aspectRatio || '';
  const imageResolution = node.data.imageResolution || '';

  // Collect images in order from handles
  let combined_images = [
    inputs.ref_image_1 || node.data.ref_image_1,
    inputs.ref_image_2 || node.data.ref_image_2,
    inputs.ref_image_3 || node.data.ref_image_3,
    inputs.ref_images || node.data.ref_images || []
  ].flat().filter(img => typeof img === 'string' && img.trim() !== '');

  // Aspect ratio → concrete pixel size mapping
  const RATIO_TO_SIZE = {
    '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536',
    '4:3': '1536x1024', '3:4': '1024x1536', '16:9': '1792x1024', '9:16': '1024x1792'
  };
  const RATIO_TO_SIZE_2K = {
    '1:1': '2048x2048', '3:2': '2048x1536', '2:3': '1536x2048',
    '4:3': '2048x1536', '3:4': '1536x2048', '16:9': '2048x1152', '9:16': '1152x2048'
  };

  const resolvedSize = aspectRatio
    ? ((imageResolution === '2K' || imageResolution === '4K') ? RATIO_TO_SIZE_2K : RATIO_TO_SIZE)[aspectRatio] || '1024x1024'
    : '';

  // Build message content
  let messageContent;
  if (combined_images.length > 0) {
    messageContent = [{ type: "text", text: prompt }];
    combined_images.forEach(imgUrl => {
      messageContent.push({ type: "image_url", image_url: { url: imgUrl } });
    });
  } else {
    messageContent = prompt;
  }

  const payload = {
    model: modelId,
    messages: [{ role: "user", content: messageContent }],
    modalities: ["image", "text"]
  };

  // Pass size via all known mechanisms for maximum compatibility
  if (aspectRatio || imageResolution) {
    payload.image_config = {};
    if (aspectRatio) payload.image_config.aspect_ratio = aspectRatio;
    if (imageResolution) payload.image_config.image_size = imageResolution;
  }
  if (resolvedSize) payload.size = resolvedSize;

  console.log(`[OpenRouter Execute] POST ${endpoint}, model=${modelId}, prompt=${prompt.length}chars, images=${combined_images.length}, size=${resolvedSize || 'auto'}`);

  // Image generation can take a long time — use 180s timeout
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'Authorization': `Bearer ${apiKey.trim()}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000)
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[OpenRouter Execute] FAILED [${res.status}] Payload sent: ${JSON.stringify(payload).substring(0, 500)}`);
    console.error(`[OpenRouter Execute] Error response: ${errText.substring(0, 1000)}`);
    throw new Error(`OpenRouter API error: [${res.status}] ${errText.substring(0, 500)}`);
  }

  const data = await res.json();
  console.log(`[OpenRouter Execute] Raw response keys: ${JSON.stringify(Object.keys(data))}`);

  let imageUrls = [];

  // ===== Parse /images/generations response: { data: [{ b64_json: "...", url: "..." }] } =====
  if (data.data && Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item.b64_json) imageUrls.push(`data:image/png;base64,${item.b64_json}`);
      else if (item.url) imageUrls.push(item.url);
    }
    console.log(`[OpenRouter Execute] /images/generations format: found ${imageUrls.length} images`);
  }

  // ===== Parse /chat/completions response =====
  if (imageUrls.length === 0 && data.choices && data.choices[0] && data.choices[0].message) {
    const message = data.choices[0].message;
    console.log(`[OpenRouter Execute] message keys: ${JSON.stringify(Object.keys(message))}, content type: ${typeof message.content}, has images: ${!!message.images}`);

    // Strategy 1: message.images array (documented OpenRouter format)
    if (message.images && Array.isArray(message.images)) {
      for (const img of message.images) {
        if (typeof img === 'string') {
          imageUrls.push(img);
        } else if (img && typeof img === 'object') {
          const url = img.image_url?.url || img.url || img.b64_json || img.data;
          if (url) imageUrls.push(url);
        }
      }
      console.log(`[OpenRouter Execute] Strategy 1 (message.images): found ${imageUrls.length} images`);
    }

    // Strategy 2: message.content is array (OpenAI vision-style)
    if (imageUrls.length === 0 && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item && item.type === 'image_url' && item.image_url?.url) {
          imageUrls.push(item.image_url.url);
        }
      }
      console.log(`[OpenRouter Execute] Strategy 2 (content array): found ${imageUrls.length} images`);
    }

    // Strategy 3: message.content is string containing markdown image links
    if (imageUrls.length === 0 && typeof message.content === 'string') {
      const mdRegex = /!\[.*?\]\((.*?)\)/g;
      let match;
      while ((match = mdRegex.exec(message.content)) !== null) {
        if (match[1]) imageUrls.push(match[1]);
      }
      if (imageUrls.length === 0) {
        const urlRegex = /(https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp|gif)[^\s"'<>]*)/gi;
        while ((match = urlRegex.exec(message.content)) !== null) {
          imageUrls.push(match[1]);
        }
      }
      if (imageUrls.length === 0 && (message.content.startsWith('http') || message.content.startsWith('data:image'))) {
        imageUrls.push(message.content.trim());
      }
      console.log(`[OpenRouter Execute] Strategy 3 (content string): found ${imageUrls.length} images`);
    }
  }

  // Normalize: ensure any raw base64 strings get the data URI prefix
  imageUrls = imageUrls.map(url => {
    if (typeof url === 'string' && !url.startsWith('http') && !url.startsWith('data:')) {
      return `data:image/png;base64,${url.trim()}`;
    }
    return url;
  });

  if (imageUrls.length === 0) {
    const debugFull = JSON.stringify(data).substring(0, 800);
    throw new Error(`OpenRouter did not return any generated images. Response: ${debugFull}`);
  }

  console.log(`[OpenRouter Execute] Succeeded! Received ${imageUrls.length} images. First URL prefix: ${imageUrls[0]?.substring(0, 40)}...`);
  return { output_images: imageUrls, output: imageUrls, images: imageUrls };
}

/**
 * Executes an ApiYi API Call
 */
async function executeApiyiPreset(node, inputs, env, pool, orderContext) {
  const endpointBase = env.APIYI_API_ENDPOINT || await getSetting(pool, 'APIYI_API_ENDPOINT') || 'https://api.apiyi.com/v1';
  const apiKey = env.APIYI_API_KEY || await getSetting(pool, 'APIYI_API_KEY');

  if (!apiKey) {
    throw new Error('ApiYi API Key not configured in .env or Settings');
  }

  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) prompt = prompt.filter(Boolean).join('\n');
  const modelId = node.data.modelId || 'gpt-image-2-vip';
  const size = node.data.imageResolution || '1024x1024';

  // Collect images
  let combined_images = [
    inputs.ref_image_1 || node.data.ref_image_1,
    inputs.ref_image_2 || node.data.ref_image_2,
    inputs.ref_image_3 || node.data.ref_image_3,
    inputs.ref_images || node.data.ref_images || []
  ].flat().filter(img => typeof img === 'string' && img.trim() !== '');

  const hasReferenceImages = combined_images.length > 0;
  let endpointUrl;
  let reqBody;
  let headers = {
    'Authorization': `Bearer ${apiKey.trim()}`
  };

  if (hasReferenceImages) {
    // Image-to-image mode via /v1/images/edits
    endpointUrl = `${endpointBase.replace(/\/$/, '')}/images/edits`;
    const fd = new FormData();
    fd.append('model', modelId);
    fd.append('prompt', prompt);
    if (size) fd.append('size', size);
    fd.append('n', "1");

    // Fetch the first reference image and append
    const imgUrl = combined_images[0];
    try {
      const imgRes = await fetch(imgUrl);
      if (!imgRes.ok) throw new Error(`Failed to fetch reference image: ${imgRes.status}`);
      const imgBlob = await imgRes.blob();
      fd.append('image', imgBlob, 'image.png');
    } catch (e) {
      throw new Error(`ApiYi failed to process reference image: ${e.message}`);
    }

    reqBody = fd;
  } else {
    // Text-to-image mode via /v1/images/generations
    endpointUrl = `${endpointBase.replace(/\/$/, '')}/images/generations`;
    const payload = {
      model: modelId,
      prompt: prompt,
      n: 1
    };
    if (size) payload.size = size;

    reqBody = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json';
  }

  console.log(`[ApiYi Execute] POST ${endpointUrl}, model=${modelId}, size=${size}, hasImages=${hasReferenceImages}`);

  const res = await fetch(endpointUrl, {
    method: 'POST',
    headers: headers,
    body: reqBody,
    signal: AbortSignal.timeout(360000) // 360s timeout
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[ApiYi Execute] FAILED [${res.status}] Error response: ${errText.substring(0, 1000)}`);
    throw new Error(`ApiYi API error: [${res.status}] ${errText.substring(0, 500)}`);
  }

  const data = await res.json();
  const imageUrls = data.data?.map(img => img.url).filter(Boolean) || [];

  if (imageUrls.length === 0) {
    throw new Error(`ApiYi did not return any generated images. Response: ${JSON.stringify(data)}`);
  }

  console.log(`[ApiYi Execute] Succeeded! Received ${imageUrls.length} images. First URL prefix: ${imageUrls[0]?.substring(0, 40)}...`);
  return { output_images: imageUrls, output: imageUrls, images: imageUrls };
}

/**
 * Executes a single Grsai API Call with polling
 */
async function executeGrsaiPreset(node, inputs, env, pool, orderContext) {
  const endpoint = env.GRSAI_API_ENDPOINT || await getSetting(pool, 'GRSAI_API_ENDPOINT');
  const apiKey = env.GRSAI_API_KEY || await getSetting(pool, 'GRSAI_API_KEY');

  if (!endpoint || !apiKey) {
    throw new Error('Grsai API Key or Endpoint not configured in .env');
  }

  let baseUrl = endpoint.trim();
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  const generateUrl = baseUrl.endsWith('/generate') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/generate`;
  const resultUrl = generateUrl.replace(/\/generate$/, '/result');
  
  const token = apiKey.trim().replace(/^Bearer\s+/i, '');

  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) prompt = prompt.filter(Boolean).join('\n');
  
  // Combine ordered image inputs
  let combined_images = [
    inputs.ref_image_1 || node.data.ref_image_1,
    inputs.ref_image_2 || node.data.ref_image_2,
    inputs.ref_image_3 || node.data.ref_image_3,
    inputs.ref_images || node.data.ref_image || []
  ].flat().filter(img => typeof img === 'string' && img.trim() !== '');

  const payload = {
    model: node.data.modelId || node.data.model || 'gpt-image-2',
    prompt: prompt,
    images: combined_images,
    aspectRatio: node.data.genSize || node.data.resolution || '1024x1024',
    quality: node.data.genQuality || 'standard',
    replyType: 'async'
  };

  console.log(`[Grsai Execute] Submitting task to ${generateUrl} with payload:`, JSON.stringify(payload));
  const res = await fetch(generateUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Grsai API error: [${res.status}] ${errText}`);
  }

  const data = await res.json();
  if (!data.id) {
    throw new Error('Grsai API did not return a task ID');
  }

  const taskId = data.id;
  console.log(`[Grsai Execute] Task ID ${taskId} received. Polling results...`);

  // Polling loop
  try {
    let consecutiveErrors = 0;
    const intervals = [3000, 3000, 3000, 3000, 3000, 5000, 5000, 5000, 5000, 10000];
    let pollIdx = 0;
    let lastLoggedProgress = -1;
    let lastLoggedTime = 0;

    for (let i = 0; i < 300; i++) { // Max ~3000s
      const currentInterval = intervals[Math.min(pollIdx++, intervals.length - 1)];
      await sleep(currentInterval);
      
      let pollRes;
      try {
        pollRes = await fetch(`${resultUrl}?id=${encodeURIComponent(taskId)}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(15000)
        });
      } catch (fetchErr) {
        consecutiveErrors++;
        console.warn(`[Grsai Execute] Poll fetch error (${consecutiveErrors}):`, fetchErr.message);
        if (consecutiveErrors >= 10) {
          throw new Error(`Poll failed after ${consecutiveErrors} consecutive network errors: ${fetchErr.message}`);
        }
        continue;
      }
      
      if (!pollRes.ok) {
        if (pollRes.status === 401 || pollRes.status === 403) {
          throw new Error(`Grsai API Authentication failed (${pollRes.status}), aborting poll.`);
        }
        consecutiveErrors++;
        console.warn(`[Grsai Execute] Poll HTTP ${pollRes.status} (${consecutiveErrors})`);
        if (consecutiveErrors >= 10) {
          throw new Error(`Poll failed after ${consecutiveErrors} consecutive HTTP errors (last: ${pollRes.status})`);
        }
        continue;
      }
      
      consecutiveErrors = 0;
      const pollData = await pollRes.json();
      
      if (pollData.status === 'succeeded' && pollData.results && pollData.results.length > 0) {
        console.log(`[Grsai Execute] Task ${taskId} succeeded!`);
        const urls = pollData.results.map(r => r.url);
        return { output_images: urls, output: urls };
      } else if (pollData.status === 'failed') {
        const errorDetail = pollData.error || pollData.message || 'Task failed internally';
        throw new Error(`Grsai Task ${taskId} failed: ${errorDetail}`);
      } else {
        console.log(`[Grsai Execute] Task ${taskId} status: ${pollData.status} (${pollData.progress || 0}%)`);
      }
    }

    throw new Error(`Grsai Task ${taskId} timed out after 3000s`);
    
  } catch (pipelineErr) {
    throw pipelineErr;
  }
}

/**
 * Main execution function
 */
export async function runPipeline(workflowJson, orderContext, pool) {
  const pipelineLogId = `pipeline_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  try {
    const parsedData = typeof workflowJson === 'string' ? JSON.parse(workflowJson) : workflowJson;
    const { nodes, edges } = parsedData;
    
    if (!nodes || !edges) {
      throw new Error("Invalid workflow data: Missing 'nodes' or 'edges' arrays");
    }

    if (pool) {
      await pool.query(
        `INSERT INTO yizi_api_logs (id, order_id, model, status, progress, created_at, updated_at) 
         VALUES ($1, $2, $3, 'processing', 0, NOW(), NOW())`,
        [pipelineLogId, orderContext?.order_id || 'toolkit_run', 'API Workflow']
      ).catch(e => console.warn('[Pipeline Log] Insert Error:', e.message));
    }

    const graph = buildGraph(nodes, edges);
    const sortedNodeIds = topoSort(graph);


    // Node output context: nodeId -> { outputKey: value }
    const context = {};
    const totalNodes = sortedNodeIds.length;
    let completedNodes = 0;

    // State for tracking random prompt picks within this pipeline execution to prevent duplication
    const usedPromptIds = [];
    const promptLibraryMutex = {
      promise: Promise.resolve(),
      lock: function() {
        let resolve;
        const current = this.promise;
        this.promise = new Promise(r => resolve = r);
        return async () => {
          await current;
          return resolve;
        };
      }
    };

    console.log(`[Pipeline] Starting CONCURRENT execution of ${totalNodes} nodes...`);

    // === DATAFLOW CONCURRENCY ===
    // Each node gets its own Promise. Before executing, it awaits only its direct
    // upstream dependencies. Nodes without mutual dependencies run in parallel.
    const nodePromises = {};

    for (const nodeId of sortedNodeIds) {
      const node = graph.nodes[nodeId];
      const incomingEdges = graph.inEdges[nodeId] || [];

      // Collect unique upstream node IDs this node depends on
      const depNodeIds = [...new Set(incomingEdges.map(e => e.source))];

      nodePromises[nodeId] = (async () => {
        // Wait for all direct dependencies to finish
        if (depNodeIds.length > 0) {
          const depPromises = depNodeIds.map(dep => nodePromises[dep]).filter(Boolean);
          await Promise.all(depPromises);
        }

        console.log(`[Pipeline] Executing node: ${node.type} (${node.id})`);

        // Resolve inputs based on incoming edges (deps are guaranteed complete)
        const inputs = {};
        for (const edge of incomingEdges) {
          const sourceOutputs = context[edge.source] || {};
          const val = sourceOutputs[edge.sourceHandle || 'output'];
          if (val !== undefined) {
            const key = edge.targetHandle || 'input';
            if (inputs[key] !== undefined) {
              // Multiple edges target the same handle — merge into array
              const existing = Array.isArray(inputs[key]) ? inputs[key] : [inputs[key]];
              const incomingVal = Array.isArray(val) ? val : [val];
              inputs[key] = [...existing, ...incomingVal];
            } else {
              inputs[key] = val;
            }
          }
        }

        // Execute Node
        let outputs = {};
        switch (node.type) {
          case 'toolkit_input': {
            const imgArray = orderContext.toolkit_images || [];
            const idx = parseInt(node.data?.image_index) || 0;
            outputs = {
              images: imgArray,
              prompt: orderContext.toolkit_prompt || '',
              toolkit_user: orderContext.openid || 'unknown',
              single_image: imgArray[idx] || ''
            };
            break;
          }

          case 'order_input':
            outputs = {
              user_prompt: orderContext.prompt || '',
              user_images: orderContext.images || [],
              order_info: {
                openid: orderContext.openid,
                order_id: orderContext.order_id,
                set_index: orderContext.set_index || 0
              },
              model_name: orderContext.model_name || '',
              model_uuid: orderContext.model_uuid || ''
            };
            
            // Random Pose Image Fetching
            outputs.random_pose_image = '';
            if (outputs.model_uuid) {
              try {
                const ossClient = new OSS({
                  region: process.env.OSS_REGION,
                  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
                  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
                  bucket: process.env.OSS_BUCKET
                });
                const poseFolder = orderContext.sku_pose_folder || 'poses';
                const prefix = `models/${outputs.model_uuid}/${poseFolder}/`;
                
                const result = await ossClient.list({ prefix, 'max-keys': 100 });
                if (result.objects && result.objects.length > 0) {
                  const files = result.objects.filter(obj => !obj.name.endsWith('/'));
                  if (files.length > 0) {
                    const randomFile = files[Math.floor(Math.random() * files.length)];
                    outputs.random_pose_image = randomFile.url;
                    console.log(`[Pipeline] Randomly picked pose image for ${outputs.model_uuid}:`, outputs.random_pose_image);
                  }
                } else {
                  console.warn(`[Pipeline] No pose images found for model ${outputs.model_uuid} in folder ${poseFolder}`);
                }
              } catch (err) {
                console.warn(`[Pipeline] Failed to fetch random pose from OSS for model ${outputs.model_uuid}:`, err.message);
              }
            }

            // Note: removed circular self-reference (outputs.output = outputs) that caused issues
            break;

          case 'preset_seedream':
            outputs = await executeSeedreamPreset(node, inputs, process.env, pool);
            break;
          case 'preset_apiyi':
            outputs = await executeApiyiPreset(node, inputs, process.env, pool, orderContext);
            break;
          case 'preset_grsai':
            outputs = await executeGrsaiPreset(node, inputs, process.env, pool, orderContext);
            break;
          case 'preset_openrouter':
            outputs = await executeOpenRouterPreset(node, inputs, process.env, pool, orderContext);
            break;

          case 'seedream':
            outputs = await executeSeedream(node, inputs, process.env, pool);
            break;

          case 'text_input':
            outputs.output = node.data.text || '';
            break;

          case 'prompt_board': {
            // Support arrays if multiple nodes connected, and fallback to generic 'input'
            const incomingTextArr = [inputs.text_in, inputs.input].flat().filter(Boolean);
            const incomingText = incomingTextArr.join('\n');
            
            const basePrompt = node.data.prompt || '';
            // Aggregate both, if both exist
            outputs.prompt = [incomingText, basePrompt].filter(s => typeof s === 'string' && s.trim() !== '').join('\n');
            // Also alias to output for flexibility
            outputs.output = outputs.prompt;
            break;
          }

          case 'string_concat': {
            const s1 = inputs.str1 || '';
            const s2 = inputs.str2 || '';
            const s3 = inputs.str3 || '';
            const s4 = inputs.str4 || '';
            outputs.output = [s1, s2, s3, s4].filter(s => typeof s === 'string' && s.trim() !== '').join('\n');
            break;
          }

          case 'llm_call': {
            const llmUrl = node.data.api_url || 'https://api.openai.com/v1';
            const llmKey = node.data.api_key || '';
            const llmModel = node.data.model_name || 'gpt-3.5-turbo';
            const llmPrompt = inputs.prompt || '';
            
            if (!llmKey) throw new Error(`LLM Node missing API Key`);

            console.log(`[Pipeline] LLM Call to ${llmUrl}/chat/completions`);
            const chatRes = await fetch(`${llmUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${llmKey}`
              },
              body: JSON.stringify({
                model: llmModel,
                messages: [{ role: 'user', content: llmPrompt }]
              }),
              signal: AbortSignal.timeout(120000)
            });

            if (!chatRes.ok) {
              throw new Error(`LLM Call failed: [${chatRes.status}] ${await chatRes.text()}`);
            }

            const chatData = await chatRes.json();
            outputs.output = chatData.choices?.[0]?.message?.content || '';
            break;
          }

          case 'prompt_library': {
            const mode = node.data.mode || (inputs.prompt_id ? 'direct' : 'random');
            let selectedPromptContent = '';
            let selectedPreviewImg = '';

            if (mode === 'direct') {
              const promptId = inputs.prompt_id || node.data.prompt_id;
              if (!promptId) throw new Error('prompt_library node missing prompt_id for direct mode');
              
              if (pool) {
                const res = await pool.query('SELECT content, data FROM "yizi_prompts" WHERE id = $1', [promptId]);
                if (res.rows.length > 0) {
                  selectedPromptContent = res.rows[0].content;
                  selectedPreviewImg = res.rows[0].data?.preview_img || '';
                } else {
                  throw new Error(`Prompt with ID ${promptId} not found in database.`);
                }
              } else {
                throw new Error('Database pool not available for prompt_library node execution');
              }
            } else if (mode === 'random') {
              const groupId = inputs.group_id || node.data.group_id;
              if (!groupId) throw new Error('prompt_library node missing group_id for random mode');

              if (pool) {
                const unlock = await promptLibraryMutex.lock();
                try {
                  let query = 'SELECT id, content, data FROM "yizi_prompts" WHERE group_id = $1';
                  let params = [groupId];
                  
                  if (usedPromptIds.length > 0) {
                    const placeholders = usedPromptIds.map((_, i) => `$${i + 2}`).join(',');
                    query += ` AND id NOT IN (${placeholders})`;
                    params.push(...usedPromptIds);
                  }
                  
                  query += ' ORDER BY RANDOM() LIMIT 1';
                  
                  const res = await pool.query(query, params);
                  if (res.rows.length > 0) {
                    selectedPromptContent = res.rows[0].content;
                    selectedPreviewImg = res.rows[0].data?.preview_img || '';
                    usedPromptIds.push(res.rows[0].id);
                  } else {
                    // Fallback to allow repeats if we exhausted all unused prompts in the group
                    console.warn(`[Pipeline] All unused prompts in group ${groupId} exhausted. Allowing repeats as fallback.`);
                    const fallbackRes = await pool.query('SELECT id, content, data FROM "yizi_prompts" WHERE group_id = $1 ORDER BY RANDOM() LIMIT 1', [groupId]);
                    if (fallbackRes.rows.length > 0) {
                      selectedPromptContent = fallbackRes.rows[0].content;
                      selectedPreviewImg = fallbackRes.rows[0].data?.preview_img || '';
                      usedPromptIds.push(fallbackRes.rows[0].id);
                    } else {
                      throw new Error(`No prompts found in group ${groupId}.`);
                    }
                  }
                } finally {
                  const resolveFn = await unlock();
                  resolveFn();
                }
              } else {
                throw new Error('Database pool not available for prompt_library node execution');
              }
            } else {
              throw new Error(`Unknown mode ${mode} for prompt_library node`);
            }

            outputs.output = selectedPromptContent;
            outputs.preview_img = selectedPreviewImg;
            break;
          }

          case 'image_preview':
            // Passthrough the image url
            outputs.output = inputs.image_url || inputs.output || node.data.preview_url || '';
            break;

          case 'oss_output': {
            // Normalize: accept images from any reasonable input key
            let rawImages = inputs.images || inputs.output_images || inputs.output || [];
            if (Array.isArray(inputs.images) && inputs.images.length > 0) rawImages = inputs.images;
            else if (Array.isArray(inputs.output_images) && inputs.output_images.length > 0) rawImages = inputs.output_images;
            
            const imagesToUpload = Array.isArray(rawImages) ? rawImages : [rawImages];
            const filteredImages = imagesToUpload.filter(u => typeof u === 'string' && (u.startsWith('http') || u.startsWith('data:image')));
            const orderInfo = inputs.order_info || orderContext;
            
            console.log(`[Pipeline] OSS Output: Received ${filteredImages.length} images from inputs keys: ${Object.keys(inputs).join(', ')}`);
            console.log(`[Pipeline] OSS Output: orderInfo =`, JSON.stringify({ openid: orderInfo?.openid, order_id: orderInfo?.order_id, set_index: orderInfo?.set_index, isRealOrder: orderContext?.isRealOrder }));
            
            if (!filteredImages.length) {
               const debugInfo = `inputs.images=${JSON.stringify(inputs.images)}, inputs.output_images=${JSON.stringify(inputs.output_images)}, inputs.output=${JSON.stringify(inputs.output)?.substring(0,200)}`;
               console.error(`[Pipeline] OSS Output: No valid images to upload. ${debugInfo}`);
               throw new Error(`OSS Output 节点未收到任何有效图片。请检查上游生图节点的连线是否正确。Debug: ${debugInfo}`);
            }

            if (!orderInfo || !orderInfo.openid || !orderInfo.order_id) {
               throw new Error(`OSS Output Node missing valid order_info (openid, order_id)`);
            }

            const ossConfig = {
              region: process.env.OSS_REGION,
              accessKeyId: process.env.OSS_ACCESS_KEY_ID,
              accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
              bucket: process.env.OSS_BUCKET,
              secure: true
            };

            if (!ossConfig.accessKeyId) {
               throw new Error('OSS configuration missing in backend .env');
            }

            const ossClient = new OSS(ossConfig);
            const uploadedUrls = [];
            const failedUploads = [];

            // === PARALLEL UPLOAD ===
            const uploadPromises = filteredImages.map(async (imgUrl, i) => {
              try {
                console.log(`[Pipeline] Uploading image ${i+1}/${filteredImages.length} to OSS...`);
                const url = await uploadToOSS(
                  ossClient, 
                  imgUrl, 
                  orderInfo.openid, 
                  orderInfo.order_id, 
                  orderInfo.set_index || 0,
                  `del_${Date.now()}_${i}` // Ensure unique suffix for parallel uploads
                );
                const secureUrl = url.replace('http://', 'https://');
                console.log(`[Pipeline] ✅ Uploaded ${i+1}/${filteredImages.length}: ${secureUrl}`);
                return { success: true, url: secureUrl };
              } catch (uploadErr) {
                console.error(`[Pipeline] ❌ Image ${i+1}/${filteredImages.length} failed after retries: ${uploadErr.message}`);
                return { success: false, index: i, sourceUrl: imgUrl, error: uploadErr.message };
              }
            });

            const uploadResults = await Promise.all(uploadPromises);
            
            for (const res of uploadResults) {
              if (res.success) {
                uploadedUrls.push(res.url);
              } else {
                failedUploads.push(res);
              }
            }

            console.log(`[Pipeline] OSS Upload Summary: ${uploadedUrls.length} succeeded, ${failedUploads.length} failed out of ${filteredImages.length} total.`);
            outputs.uploaded_urls = uploadedUrls;
            outputs.failed_uploads = failedUploads;

            // Note: Database writing has been decoupled and moved to runPipeline end
            break;
          }

          case 'http_request': {
            const method = node.data.method || 'GET';
            const reqUrl = inputs.url || node.data.url;
            if (!reqUrl) throw new Error('HTTP Request Node missing URL');
            
            const options = { method };
            if (method !== 'GET' && inputs.body) {
               options.body = typeof inputs.body === 'string' ? inputs.body : JSON.stringify(inputs.body);
               options.headers = { 'Content-Type': 'application/json' };
            }

            console.log(`[Pipeline] HTTP ${method} to ${reqUrl}`);
            const httpRes = await fetch(reqUrl, options);
            const httpData = await httpRes.json();
            outputs.response = httpData;
            break;
          }

          default:
            console.log(`[Pipeline] Unrecognized node type: ${node.type}, skipping execution.`);
            outputs.output = inputs; // Passthrough
            break;
        }

        try {
          // Write outputs to shared context (safe: each node writes only its own key)
          context[node.id] = outputs;
          completedNodes++;
          
          if (pool && completedNodes < totalNodes) {
             const progress = Math.floor((completedNodes / totalNodes) * 100);
             pool.query(`UPDATE yizi_api_logs SET progress = $1, updated_at = NOW() WHERE id = $2`, [progress, pipelineLogId]).catch(() => {});
          }
          
          console.log(`[Pipeline] Node ${node.id} finished. Outputs:`, Object.keys(outputs));
        } catch (postExecErr) {
          throw postExecErr;
        }
      })().catch(err => {
        // Append the node ID to the error message so it shows up in the DB logs
        const errorMsg = `[节点 ${node.type}] ${err.message}`;
        const newErr = new Error(errorMsg);
        newErr.stack = err.stack;
        throw newErr;
      });
    }

    // Wait for ALL node promises to settle, then check for failures
    const allResults = await Promise.allSettled(Object.values(nodePromises));
    const failures = allResults.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      console.error(`[Pipeline] ${failures.length} node(s) failed during concurrent execution.`);
      // Throw the first error to be caught by the outer try/catch
      throw failures[0].reason;
    }

    let finalOssImages = [];
    let rawGeneratedImages = [];

    for (const out of Object.values(context)) {
      if (out && out.uploaded_urls && Array.isArray(out.uploaded_urls)) {
         finalOssImages.push(...out.uploaded_urls);
      }
      if (out && out.final_image_urls && Array.isArray(out.final_image_urls)) {
         finalOssImages.push(...out.final_image_urls);
      }
      if (out && out.output && Array.isArray(out.output)) {
         rawGeneratedImages.push(...out.output.filter(u => typeof u === 'string' && (u.startsWith('http') || u.startsWith('data:image'))));
      }
    }

    let isOssSuccess = finalOssImages.length > 0;
    let imagesToSave = isOssSuccess ? finalOssImages : rawGeneratedImages;
    let errorSuffix = '';
    
    if (!isOssSuccess && rawGeneratedImages.length > 0) {
       errorSuffix = '注意: OSS上传失败或未执行，此为节点原始产出图';
    }

    if (pool) {
      pool.query(`UPDATE yizi_api_logs SET status = 'succeeded', progress = 100, result_images = $1, error_msg = $2, updated_at = NOW() WHERE id = $3`, [JSON.stringify(imagesToSave), errorSuffix, pipelineLogId]).catch(e => console.warn(e.message));
    }

    // === DECOUPLED DB WRITE: order update & auto delivery ===
    if (pool && orderContext.isRealOrder && orderContext.order_id) {
       let allFailedUploads = [];
       for (const out of Object.values(context)) {
          if (out && out.failed_uploads && Array.isArray(out.failed_uploads)) {
             allFailedUploads.push(...out.failed_uploads);
          }
       }
       
       if (finalOssImages.length > 0 || allFailedUploads.length > 0) {
         try {
           const pgClient = await pool.connect();
           try {
             await pgClient.query('BEGIN');
             const selectRes = await pgClient.query('SELECT data FROM "yizi_orders" WHERE id = $1 FOR UPDATE', [orderContext.order_id]);
             
             if (selectRes.rows.length > 0) {
               const orderData = selectRes.rows[0].data || {};
               if (!orderData.sets) orderData.sets = [{}];
               const setIndex = orderContext.set_index || 0;
               if (!orderData.sets[setIndex]) orderData.sets[setIndex] = {};
               
               // Persist random pose image
               const orderInputNode = Object.values(context).find(c => c.random_pose_image);
               if (orderInputNode && orderInputNode.random_pose_image) {
                 orderData.sets[setIndex].usedPoseUrl = orderInputNode.random_pose_image;
               }

               // Record failed uploads
               if (allFailedUploads.length > 0) {
                 orderData.sets[setIndex].upload_errors = allFailedUploads.map(f => ({
                   source: f.sourceUrl?.substring(0, 200),
                   error: f.error,
                   time: new Date().toISOString()
                 }));
               }

               // === AUTO DELIVERY LOGIC ===
               if (finalOssImages.length > 0 && orderContext.auto_delivery) {
                 if (!orderData.sets[setIndex].delivery_imgs) {
                   orderData.sets[setIndex].delivery_imgs = [];
                 }
                 for (const imgUrl of finalOssImages) {
                   orderData.sets[setIndex].delivery_imgs.push({
                     id: `del_${Date.now()}_${Math.random().toString(36).substr(2,4)}`,
                     img: imgUrl
                   });
                 }
                 console.log(`[Pipeline Auto-Delivery] Pushed ${finalOssImages.length} images to delivery pool for Order ${orderContext.order_id}`);

                 // Notify user via SSE
                 if (orderContext.eventEmitter) {
                   try {
                     orderContext.eventEmitter.emit(`orderUpdate:${orderContext.openid}`, {
                       orderId: orderContext.order_id,
                       event: 'AUTO_DELIVERY',
                       deliveryCount: finalOssImages.length
                     });
                     console.log(`[Pipeline Auto-Delivery] SSE notification sent to user ${orderContext.openid}`);
                   } catch (sseErr) {
                     console.warn(`[Pipeline Auto-Delivery] SSE emit failed:`, sseErr.message);
                   }
                 }
               }

               await pgClient.query(
                 'UPDATE "yizi_orders" SET data = $1, wait_delivery = $2 WHERE id = $3', 
                  [JSON.stringify(orderData), '0', orderContext.order_id]
               );
             }
             await pgClient.query('COMMIT');
           } catch (txErr) {
             await pgClient.query('ROLLBACK');
             console.error(`[Pipeline] Transaction failed for Order ${orderContext.order_id}:`, txErr.message);
           } finally {
             pgClient.release();
           }
         } catch (connErr) {
           console.error(`[Pipeline] Failed to connect to DB for final order update:`, connErr.message);
         }
       }
    }

    console.log(`[Pipeline] Execution completed successfully.`);
    return { success: true, context };

  } catch (err) {
    if (pool) {
      pool.query(`UPDATE yizi_api_logs SET status = 'failed', error_msg = $1, updated_at = NOW() WHERE id = $2`, [err.message, pipelineLogId]).catch(() => {});
    }
    console.error(`[Pipeline Error]`, err);
    return { success: false, error: err.message };
  }
}
