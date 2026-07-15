import { getSetting } from '../../config_manager.js';
import { fetchWithRetry } from '../core/fetch_helper.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function executeSeedream(node, inputs, env, pool, abortSignal) {
  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) prompt = prompt.filter(Boolean).join('\n');
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) prompt = 'a beautiful image';
  const globalEndpointId = env.VOLCENGINE_ENDPOINT_ID || await getSetting(pool, 'VOLCENGINE_ENDPOINT_ID');
  const endpointId = node.data.endpoint_id || node.data.endpointId || globalEndpointId || 'ep-xxxx';
  const sizePreset = node.data.size || '2k (Origin)';
  // Collect ordered image inputs: image_1, image_2, image_3, ... (preserves order)
  let images = [];
  for (let i = 1; i <= 20; i++) {
    const val = inputs[`image_${i}`];
    if (val !== undefined) {
      if (Array.isArray(val)) images = images.concat(val.flat().filter(Boolean));
      else if (val) images.push(val);
    }
  }
  // Fallback: legacy single 'images' input for backward compatibility
  if (images.length === 0) {
    let legacy = inputs.images || [];
    if (typeof legacy === 'string') legacy = [legacy];
    images = Array.isArray(legacy) ? legacy.flat().filter(Boolean) : [];
  }
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
    watermark: false, // For new API standard
    logo_info: { add_logo: false } // For legacy backward compatibility
  };

  if (images.length > 0) {
    const base64Images = [];
    for (const url of images) {
      if (!url) continue;
      if (url.startsWith('data:image')) {
        base64Images.push(url);
      } else {
        try {
          const resp = await fetchWithRetry(url, { signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
          if (!resp.ok) continue;
          const arrayBuffer = await resp.arrayBuffer();
          let buffer = Buffer.from(arrayBuffer);
          try {
            const sharp = (await import('sharp')).default;
            buffer = await sharp(buffer)
              .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 95 })
              .toBuffer();
          } catch (sharpErr) {
            console.warn(`[Pipeline] sharp unavailable, skipping resize: ${sharpErr.message}`);
          }
          const base64 = buffer.toString('base64');
          const mime = buffer[0] === 0xFF ? 'image/jpeg' : 'image/png';
          base64Images.push(`data:${mime};base64,${base64}`);
        } catch (imgErr) {
          console.warn(`[Pipeline] Failed to process image ${url.substring(0, 100)} for Seedream:`, imgErr.message);
        }
      }
    }
    if (base64Images.length > 0) payload.image = base64Images;
  }

  console.log(`[Pipeline] Seedream executing... model: ${endpointId}, size: ${apiSize}`);
  const res = await fetchWithRetry("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
    method: 'POST',
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
    signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000)
  }, { noRetry: true }); // NEVER retry paid image generation API calls

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Volcengine API Error [${res.status}]: ${errText}`);
  }

  const data = await res.json();
  const outputImages = [];
  if (data.data && data.data.length > 0) {
    for (const item of data.data) {
      if (item.url) outputImages.push(item.url);
      else if (item.b64_json) outputImages.push(`data:image/png;base64,${item.b64_json}`);
    }
  }

  if (outputImages.length === 0) throw new Error('Seedream returned no images');
  return { output_images: outputImages, output: outputImages, images: outputImages };
}

export async function executeOpenRouterPreset(node, inputs, env, pool, orderContext, abortSignal) {
  const configuredEndpoint = env.OPENROUTER_API_ENDPOINT || await getSetting(pool, 'OPENROUTER_API_ENDPOINT') || 'https://openrouter.ai/api/v1/chat/completions';
  const endpoint = configuredEndpoint.includes('/chat/completions') ? configuredEndpoint : `${configuredEndpoint.replace(/\/$/, '')}/chat/completions`;
  const apiKey = env.OPENROUTER_API_KEY || await getSetting(pool, 'OPENROUTER_API_KEY');

  if (!apiKey) throw new Error('OpenRouter API Key not configured');

  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) prompt = prompt.filter(Boolean).join('\n');
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) prompt = 'a beautiful image';
  const modelId = node.data.modelId || 'openai/gpt-5.4-image-2';
  const aspectRatio = node.data.aspectRatio || '';
  const imageResolution = node.data.imageResolution || '';

  let combined_images = [
    inputs.ref_image_1 || node.data.ref_image_1,
    inputs.ref_image_2 || node.data.ref_image_2,
    inputs.ref_image_3 || node.data.ref_image_3,
    inputs.ref_images || node.data.ref_images || []
  ].flat().filter(img => typeof img === 'string' && img.trim() !== '');

  const RATIO_TO_SIZE = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', '4:3': '1536x1024', '3:4': '1024x1536', '16:9': '1792x1024', '9:16': '1024x1792' };
  const RATIO_TO_SIZE_2K = { '1:1': '2048x2048', '3:2': '2048x1536', '2:3': '1536x2048', '4:3': '2048x1536', '3:4': '1536x2048', '16:9': '2048x1152', '9:16': '1152x2048' };
  const RATIO_TO_SIZE_4K = { '1:1': '4096x4096', '3:4': '3520x4704', '4:3': '4704x3520', '16:9': '5504x3040', '9:16': '3040x5504', '2:3': '3328x4992', '3:2': '4992x3328', '21:9': '6240x2656' };

  let mappedSize = RATIO_TO_SIZE;
  if (imageResolution === '2K') mappedSize = RATIO_TO_SIZE_2K;
  else if (imageResolution === '4K') mappedSize = RATIO_TO_SIZE_4K;
  const resolvedSize = aspectRatio ? mappedSize[aspectRatio] || '1024x1024' : '';

  let messageContent;
  if (combined_images.length > 0) {
    messageContent = [{ type: "text", text: prompt }];
    combined_images.forEach(imgUrl => messageContent.push({ type: "image_url", image_url: { url: imgUrl } }));
  } else {
    messageContent = prompt;
  }

  const payload = { model: modelId, messages: [{ role: "user", content: messageContent }], modalities: ["image", "text"] };
  if (aspectRatio || imageResolution) {
    payload.image_config = {};
    if (aspectRatio) payload.image_config.aspect_ratio = aspectRatio;
    if (imageResolution) payload.image_config.image_size = imageResolution;
  }
  if (resolvedSize) payload.size = resolvedSize;

  const res = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey.trim()}` },
    body: JSON.stringify(payload),
    signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000)
  }, { noRetry: true }); // NEVER retry paid image generation API calls

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API error: [${res.status}] ${errText.substring(0, 500)}`);
  }

  const data = await res.json();
  let imageUrls = [];

  if (data.data && Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item.b64_json) imageUrls.push(`data:image/png;base64,${item.b64_json}`);
      else if (item.url) imageUrls.push(item.url);
    }
  }

  if (imageUrls.length === 0 && data.choices && data.choices[0] && data.choices[0].message) {
    const message = data.choices[0].message;
    if (message.images && Array.isArray(message.images)) {
      for (const img of message.images) {
        if (typeof img === 'string') imageUrls.push(img);
        else if (img && typeof img === 'object') {
          const url = img.image_url?.url || img.url || img.b64_json || img.data;
          if (url) imageUrls.push(url);
        }
      }
    }
    if (imageUrls.length === 0 && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item && item.type === 'image_url' && item.image_url?.url) imageUrls.push(item.image_url.url);
      }
    }
    if (imageUrls.length === 0 && typeof message.content === 'string') {
      const mdRegex = /!\[.*?\]\((.*?)\)/g;
      let match;
      while ((match = mdRegex.exec(message.content)) !== null) if (match[1]) imageUrls.push(match[1]);
      if (imageUrls.length === 0) {
        const urlRegex = /(https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp|gif)[^\s"'<>]*)/gi;
        while ((match = urlRegex.exec(message.content)) !== null) imageUrls.push(match[1]);
      }
      if (imageUrls.length === 0 && (message.content.startsWith('http') || message.content.startsWith('data:image'))) {
        imageUrls.push(message.content.trim());
      }
    }
  }

  imageUrls = imageUrls.map(url => {
    if (typeof url === 'string' && !url.startsWith('http') && !url.startsWith('data:')) return `data:image/png;base64,${url.trim()}`;
    return url;
  });

  if (imageUrls.length === 0) throw new Error(`OpenRouter did not return any generated images.`);
  return { output_images: imageUrls, output: imageUrls, images: imageUrls };
}

export async function executeApiyiPreset(node, inputs, env, pool, orderContext, abortSignal) {
  const endpointBase = env.APIYI_API_ENDPOINT || await getSetting(pool, 'APIYI_API_ENDPOINT') || 'https://api.apiyi.com/v1';
  const apiKey = env.APIYI_API_KEY || await getSetting(pool, 'APIYI_API_KEY');

  if (!apiKey) throw new Error('ApiYi API Key not configured');

  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) {
    prompt = prompt.map(p => typeof p === 'string' ? p : JSON.stringify(p)).filter(Boolean).join('\n');
  } else if (typeof prompt === 'object') {
    prompt = JSON.stringify(prompt);
  }
  prompt = String(prompt).trim();
  if (!prompt) prompt = 'a beautiful image';
  const modelId = node.data.modelId || 'gpt-image-2-vip';
  const size = node.data.imageResolution || '1024x1024';

  let combined_images = [
    inputs.ref_image_1 || node.data.ref_image_1,
    inputs.ref_image_2 || node.data.ref_image_2,
    inputs.ref_image_3 || node.data.ref_image_3,
    inputs.ref_images || node.data.ref_images || []
  ].flat().filter(img => typeof img === 'string' && img.trim() !== '');

  const hasReferenceImages = combined_images.length > 0;
  let endpointUrl;
  let reqBody;
  let headers = { 'Authorization': `Bearer ${apiKey.trim()}` };

  if (hasReferenceImages) {
    endpointUrl = `${endpointBase.replace(/\/$/, '')}/images/edits`;
    const fd = new FormData();
    fd.append('model', modelId);
    fd.append('prompt', prompt);
    if (size && size !== 'auto') fd.append('size', size);

    // Log all reference image URLs for debugging
    console.log(`[ApiYi] Reference images to fetch (${combined_images.length}):`, combined_images);

    for (let i = 0; i < combined_images.length; i++) {
      const imgUrl = combined_images[i];
      const displayUrl = imgUrl.length > 100 ? imgUrl.substring(0, 100) + '...[truncated]' : imgUrl;
      console.log(`[ApiYi] Fetching ref image ${i+1}/${combined_images.length}: ${displayUrl}`);
      try {
        const imgRes = await fetchWithRetry(imgUrl, { signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status} for URL: ${displayUrl}`);
        const imgBlob = await imgRes.blob();
        let ext = 'png';
        if (imgBlob.type) {
           if (imgBlob.type.includes('jpeg') || imgBlob.type.includes('jpg')) ext = 'jpg';
           else if (imgBlob.type.includes('webp')) ext = 'webp';
        }
        fd.append('image', imgBlob, `image_${i}.${ext}`);
      } catch (e) {
        throw new Error(`ApiYi failed to fetch reference image ${i+1}/${combined_images.length} — URL: ${displayUrl} — Error: ${e.message}`);
      }
    }
    reqBody = fd;
  } else {
    endpointUrl = `${endpointBase.replace(/\/$/, '')}/images/generations`;
    const payload = { model: modelId, prompt: prompt };
    if (size && size !== 'auto') payload.size = size;
    reqBody = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json';
  }

  console.log(`[ApiYi] Request: endpoint=${endpointUrl} | model=${modelId} | size=${size} | images=${combined_images.length} | hasRefImages=${hasReferenceImages}`);
  console.log(`[ApiYi] Prompt (preview): ${String(prompt).substring(0, 200)}`);
  console.log(`[ApiYi] size from node.data.imageResolution = "${node.data.imageResolution}"`);

  const res = await fetchWithRetry(endpointUrl, {
    method: 'POST',
    headers: headers,
    body: reqBody,
    signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(360000)]) : AbortSignal.timeout(360000)
  }, { noRetry: true }); // NEVER retry paid image generation API calls

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[ApiYi] API Error Detail. Status: ${res.status}, Body: ${errText}, Prompt sent: ${prompt}`);
    throw new Error(`ApiYi API error: [${res.status}] ${errText.substring(0, 1000)} (Prompt sent: ${String(prompt).substring(0, 50)}...)`);
  }

  const data = await res.json();
  const imageUrls = data.data?.map(img => {
    if (img.url) return img.url;
    if (img.b64_json) {
      // APIYi b64_json already includes 'data:image/png;base64,' prefix
      if (img.b64_json.startsWith('data:')) return img.b64_json;
      return `data:image/png;base64,${img.b64_json}`;
    }
    return null;
  }).filter(Boolean) || [];

  if (imageUrls.length === 0) throw new Error(`ApiYi did not return any generated images.`);
  return { output_images: imageUrls, output: imageUrls, images: imageUrls };
}

export async function executeGrsaiPreset(node, inputs, env, pool, orderContext, abortSignal) {
  const endpoint = env.GRSAI_API_ENDPOINT || await getSetting(pool, 'GRSAI_API_ENDPOINT');
  const apiKey = env.GRSAI_API_KEY || await getSetting(pool, 'GRSAI_API_KEY');

  if (!endpoint || !apiKey) throw new Error('Grsai API Key or Endpoint not configured');

  let baseUrl = endpoint.trim();
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  const generateUrl = baseUrl.endsWith('/generate') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/generate`;
  const resultUrl = generateUrl.replace(/\/generate$/, '/result');
  const token = apiKey.trim().replace(/^Bearer\s+/i, '');

  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) prompt = prompt.filter(Boolean).join('\n');
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) prompt = 'a beautiful image';
  
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
    aspectRatio: node.data.genSize || '1024x1024',
    quality: node.data.genQuality || 'standard',
    replyType: 'async'
  };

  const res = await fetchWithRetry(generateUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Grsai API error: [${res.status}] ${errText}`);
  }

  const data = await res.json();
  if (!data.id) throw new Error('Grsai API did not return a task ID');
  const taskId = data.id;

  try {
    let consecutiveErrors = 0;
    const intervals = [3000, 3000, 3000, 3000, 3000, 5000, 5000, 5000, 5000, 10000];
    let pollIdx = 0;

    for (let i = 0; i < 300; i++) {
      const currentInterval = intervals[Math.min(pollIdx++, intervals.length - 1)];
      await sleep(currentInterval);
      
      let pollRes;
      try {
        pollRes = await fetchWithRetry(`${resultUrl}?id=${encodeURIComponent(taskId)}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
        });
      } catch (fetchErr) {
        consecutiveErrors++;
        if (consecutiveErrors >= 10) throw new Error(`Poll failed after ${consecutiveErrors} consecutive network errors: ${fetchErr.message}`);
        continue;
      }
      
      if (!pollRes.ok) {
        if (pollRes.status === 401 || pollRes.status === 403) throw new Error(`Grsai API Authentication failed (${pollRes.status}), aborting poll.`);
        consecutiveErrors++;
        if (consecutiveErrors >= 10) throw new Error(`Poll failed after ${consecutiveErrors} consecutive HTTP errors (last: ${pollRes.status})`);
        continue;
      }
      
      consecutiveErrors = 0;
      const pollData = await pollRes.json();
      
      if (pollData.status === 'succeeded' && pollData.results && pollData.results.length > 0) {
        const urls = pollData.results.map(r => r.url);
        return { output_images: urls, output: urls };
      } else if (pollData.status === 'failed') {
        const errorDetail = pollData.error || pollData.message || 'Task failed internally';
        throw new Error(`Grsai Task ${taskId} failed: ${errorDetail}`);
      }
    }
    throw new Error(`Grsai Task ${taskId} timed out after 3000s`);
  } catch (pipelineErr) {
    throw pipelineErr;
  }
}

export async function executeGrokImagine(node, inputs, env, pool, abortSignal) {
  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) prompt = prompt.filter(Boolean).join('\n');
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) prompt = 'a beautiful image';

  // ── API Key Resolution with diagnostics ──
  const envAk = env.GROK_API_KEY;
  const dbAk1 = await getSetting(pool, 'GROK_API_KEY');
  const dbAk2 = await getSetting(pool, 'GROK_API_KEY_2');
  const globalAk1 = envAk || dbAk1;
  const globalAk2 = env.GROK_API_KEY_2 || dbAk2;

  const akArr = [];
  if (globalAk1) {
    if (globalAk1.includes(',')) akArr.push(...globalAk1.split(',').map(s => s.trim()).filter(Boolean));
    else akArr.push(globalAk1.trim());
  }
  if (globalAk2) {
    if (globalAk2.includes(',')) akArr.push(...globalAk2.split(',').map(s => s.trim()).filter(Boolean));
    else akArr.push(globalAk2.trim());
  }

  // Diagnostic: log key source and masked preview
  const maskKey = k => k ? `${k.substring(0, 6)}...${k.substring(k.length - 4)} (len=${k.length})` : '(empty)';
  console.log(`[Grok] Key pool: ${akArr.length} keys loaded. Sources: env=${envAk ? 'YES' : 'NO'}, db1=${dbAk1 ? 'YES' : 'NO'}, db2=${dbAk2 ? 'YES' : 'NO'}`);
  akArr.forEach((k, i) => console.log(`[Grok]   key[${i}]: ${maskKey(k)}`));

  if (akArr.length === 0) throw new Error('GROK_API_KEY is not configured. env.GROK_API_KEY is empty and getSetting returned empty.');

  const resolution = node.data.resolution || '2k';
  const aspectRatio = node.data.aspectRatio || '16:9';
  const n = parseInt(node.data.n) || 1;

  let images = [];
  for (let i = 1; i <= 3; i++) {
    const val = inputs[`image_${i}`];
    if (val !== undefined) {
      if (Array.isArray(val)) images = images.concat(val.flat().filter(Boolean));
      else if (val) images.push(val);
    }
  }
  if (images.length === 0) {
    let legacy = inputs.images || inputs.ref_images || inputs.ref_image_1 || [];
    if (typeof legacy === 'string') legacy = [legacy];
    images = Array.isArray(legacy) ? legacy.flat().filter(Boolean) : [];
  }

  const base64Images = [];
  if (images.length > 0) {
    for (const url of images) {
      if (!url) continue;
      if (url.startsWith('data:image')) {
        base64Images.push(url);
      } else {
        try {
          const resp = await fetchWithRetry(url, { signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
          if (!resp.ok) continue;
          const arrayBuffer = await resp.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const base64 = buffer.toString('base64');
          const mime = buffer[0] === 0xFF ? 'image/jpeg' : 'image/png';
          base64Images.push(`data:${mime};base64,${base64}`);
        } catch (imgErr) {
          console.warn(`[Grok] Failed to process image ${url.substring(0, 100)}:`, imgErr.message);
        }
      }
    }
  }

  let endpoint = 'https://api.x.ai/v1/images/generations';
  const payload = {
    model: node.data.modelId || 'grok-imagine-image-quality',
    prompt: prompt,
    resolution: resolution,
    response_format: 'b64_json'
  };

  
  if (aspectRatio && aspectRatio !== 'auto') {
    payload.aspect_ratio = aspectRatio;
  }

  if (base64Images.length === 0) {
    payload.n = n;
  } else if (base64Images.length === 1) {
    endpoint = 'https://api.x.ai/v1/images/edits';
    payload.image = { type: 'image_url', url: base64Images[0] };
  } else if (base64Images.length >= 2) {
    endpoint = 'https://api.x.ai/v1/images/edits';
    payload.images = base64Images.slice(0, 3).map(url => ({ type: 'image_url', url }));
  }

  // Log payload (without base64 content for brevity)
  const debugPayload = { ...payload };
  if (debugPayload.image) debugPayload.image = { type: 'image_url', url: '(base64 omitted)' };
  if (debugPayload.images) debugPayload.images = debugPayload.images.map(() => '(base64 omitted)');
  console.log(`[Grok] Payload: ${JSON.stringify(debugPayload)}`);

  let lastError = null;
  const maxAttempts = Math.min(akArr.length + 1, 4); // At most 4 attempts, at least try each key once
  let keyIndex = Math.floor(Math.random() * akArr.length); // Start random, then rotate

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Round-robin: use a different key on each retry attempt
    const apiKey = akArr[keyIndex % akArr.length];
    keyIndex++;

    try {
      console.log(`[Grok] Attempt ${attempt}/${maxAttempts} | key=${maskKey(apiKey)} | endpoint=${endpoint}`);
      const res = await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000)
      }, { noRetry: true });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Grok] HTTP ${res.status} response: ${errText.substring(0, 500)}`);

        // xAI returns 400 "Incorrect API key" on concurrent rate-limit-like conditions
        // Retry with a DIFFERENT key on these errors
        const isRetryable = (res.status === 400 && errText.includes('Incorrect API key'))
                         || res.status === 429
                         || res.status >= 500;

        if (isRetryable && attempt < maxAttempts) {
          // Exponential backoff with jitter: 2s, 4s, 6s + random
          const delay = 2000 * attempt + Math.floor(Math.random() * 2000);
          console.warn(`[Grok] Retryable error (${res.status}). Switching to next key. Retry in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        throw new Error(`Grok API Error [${res.status}]: ${errText}`);
      }

      const data = await res.json();
      const outputImages = [];
      if (data.data && data.data.length > 0) {
        for (const item of data.data) {
          if (item.url) outputImages.push(item.url);
          else if (item.b64_json) outputImages.push(`data:image/png;base64,${item.b64_json}`);
        }
      }

      if (outputImages.length === 0) throw new Error('Grok API returned no images');
      console.log(`[Grok] Success: ${outputImages.length} images generated`);
      return { output_images: outputImages, output: outputImages, images: outputImages };
      
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError' || (err.message && err.message.includes('timeout'))) throw err;
      if (attempt < maxAttempts) {
        const delay = 2000 * attempt + Math.floor(Math.random() * 2000);
        console.warn(`[Grok] Fetch failed (${err.message}). Retry in ${delay}ms with next key...`);
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError || new Error('Grok API failed after max retries');
}


export async function executeNanobananaPreset(node, inputs, env, pool, orderContext, abortSignal) {
  const endpointBase = env.APIYI_API_ENDPOINT || await getSetting(pool, 'APIYI_API_ENDPOINT') || 'https://api.apiyi.com/v1';
  const apiKey = env.APIYI_API_KEY || await getSetting(pool, 'APIYI_API_KEY');

  if (!apiKey) throw new Error('ApiYi API Key not configured');

  let prompt = inputs.prompt || inputs.input || node.data.prompt || '';
  if (Array.isArray(prompt)) {
    prompt = prompt.map(p => typeof p === 'string' ? p : JSON.stringify(p)).filter(Boolean).join('\n');
  } else if (typeof prompt === 'object') {
    prompt = JSON.stringify(prompt);
  }
  prompt = String(prompt).trim();
  if (!prompt) prompt = 'a beautiful image';
  const modelId = node.data.modelId || 'gemini-3-pro-image-preview';
  
  let geminiSize;
  // If the node data already contains the modern separate fields (from updated Vue component or Toolkit)
  if (node.data.aspectRatio && ['1K', '2K', '4K'].includes(node.data.imageResolution)) {
    geminiSize = {
      imageSize: node.data.imageResolution,
      aspectRatio: node.data.aspectRatio
    };
  } else {
    // Graceful fallback for legacy workflows where imageResolution was saved as 'WxH' (e.g. '2752x1536')
    const sizeStr = node.data.imageResolution || 'auto';
    const getGeminiSize = (sizeStr) => {
      if (sizeStr === 'auto') return { aspectRatio: '1:1', imageSize: '1K' };
      const [w, h] = sizeStr.split('x').map(Number);
      if (!w || !h) return { aspectRatio: '1:1', imageSize: '1K' };
      const pixels = w * h;
      let imageSize = '1K';
      if (pixels > 12000000) imageSize = '4K';
      else if (pixels > 3000000) imageSize = '2K';
      const ratio = w / h;
      const ratios = [
        { name: '1:1', val: 1 }, { name: '16:9', val: 16/9 }, { name: '9:16', val: 9/16 },
        { name: '4:3', val: 4/3 }, { name: '3:4', val: 3/4 }, { name: '3:2', val: 3/2 },
        { name: '2:3', val: 2/3 }, { name: '5:4', val: 5/4 }, { name: '4:5', val: 4/5 },
        { name: '21:9', val: 21/9 }
      ];
      let closest = ratios[0];
      let minDiff = Math.abs(ratio - closest.val);
      for (let i = 1; i < ratios.length; i++) {
        const diff = Math.abs(ratio - ratios[i].val);
        if (diff < minDiff) { minDiff = diff; closest = ratios[i]; }
      }
      return { aspectRatio: closest.name, imageSize };
    };
    geminiSize = getGeminiSize(sizeStr);
  }

  let combined_images = [
    inputs.ref_image_1 || node.data.ref_image_1,
    inputs.ref_image_2 || node.data.ref_image_2,
    inputs.ref_image_3 || node.data.ref_image_3,
    inputs.ref_images || node.data.ref_images || []
  ].flat().filter(img => typeof img === 'string' && img.trim() !== '');

  let base = endpointBase.replace(/\/v1(beta)?\/?$/, '');
  let endpointUrl = `${base}/v1beta/models/${modelId}:generateContent`;

  let parts = [{ text: prompt }];

  if (combined_images.length > 0) {
    for (let i = 0; i < combined_images.length; i++) {
      const imgUrl = combined_images[i];
      const displayUrl = imgUrl.length > 100 ? imgUrl.substring(0, 100) + '...[truncated]' : imgUrl;
      console.log(`[NanoBanana] Fetching ref image ${i+1}/${combined_images.length}: ${displayUrl}`);
      try {
        const imgRes = await fetchWithRetry(imgUrl, { signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) });
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status} for URL: ${displayUrl}`);
        
        let mimeType = 'image/jpeg';
        const typeStr = imgRes.headers.get('content-type') || '';
        if (typeStr.includes('png')) mimeType = 'image/png';
        else if (typeStr.includes('webp')) mimeType = 'image/webp';

        const arrayBuffer = await imgRes.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString('base64');
        parts.push({ inlineData: { mimeType, data: base64Data } });
      } catch (e) {
        throw new Error(`ApiYi failed to fetch reference image ${i+1}/${combined_images.length} — URL: ${displayUrl} — Error: ${e.message}`);
      }
    }
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: geminiSize
    }
  };

  console.log(`[NanoBanana] Request: endpoint=${endpointUrl} | model=${modelId} | imageConfig=${JSON.stringify(geminiSize)} | images=${combined_images.length}`);
  console.log(`[NanoBanana] Prompt (preview): ${String(prompt).substring(0, 200)}`);

  const headers = {
    'Authorization': `Bearer ${apiKey.trim()}`,
    'Content-Type': 'application/json'
  };

  const res = await fetchWithRetry(endpointUrl, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload),
    signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(360000)]) : AbortSignal.timeout(360000)
  }, { noRetry: true });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[NanoBanana] API Error Detail. Status: ${res.status}, Body: ${errText}, Prompt sent: ${prompt}`);
    throw new Error(`ApiYi NanoBanana API error: [${res.status}] ${errText.substring(0, 1000)} (Prompt sent: ${String(prompt).substring(0, 50)}...)`);
  }

  const data = await res.json();
  const imageUrls = [];
  if (data.candidates && data.candidates.length > 0) {
    for (const cand of data.candidates) {
      if (cand.content && cand.content.parts) {
        for (const part of cand.content.parts) {
          if (part.inlineData && part.inlineData.data) {
            let mime = part.inlineData.mimeType || 'image/png';
            imageUrls.push(`data:${mime};base64,${part.inlineData.data}`);
          }
        }
      }
    }
  }

  if (imageUrls.length === 0) throw new Error(`NanoBanana (Gemini) did not return any generated images.`);
  return { output_images: imageUrls, output: imageUrls, images: imageUrls };
}
