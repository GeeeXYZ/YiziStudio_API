import OSS from 'ali-oss';
import crypto from 'crypto';

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
 * Helper to upload image buffer or url to OSS
 */
async function uploadToOSS(ossClient, url, openid, order_id, set_index, filenamePrefix) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);
    const buffer = await response.buffer();
    
    const ext = url.split('.').pop().split('?')[0].match(/^(jpg|jpeg|png|webp|gif)$/i) ? RegExp.$1 : 'png';
    const filename = `${filenamePrefix}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    const ossPath = `delivery_imgs/${openid}/${order_id}/set${set_index}/${filename}`;

    const result = await ossClient.put(ossPath, buffer);
    return result.url; // This is usually http... we should convert to https if needed
  } catch (err) {
    console.error(`[OSS Upload Error]`, err);
    throw err;
  }
}

/**
 * Executes a single Grsai API Call with polling
 */
async function executeGrsaiPreset(node, inputs, env, pool, orderContext) {
  const endpoint = process.env.GRSAI_API_ENDPOINT || env.GRSAI_API_ENDPOINT;
  const apiKey = process.env.GRSAI_API_KEY || env.GRSAI_API_KEY;

  if (!endpoint || !apiKey) {
    throw new Error('Grsai API Key or Endpoint not configured in .env');
  }

  let baseUrl = endpoint.trim();
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  const generateUrl = baseUrl.endsWith('/generate') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/generate`;
  const resultUrl = generateUrl.replace(/\/generate$/, '/result');
  
  const token = apiKey.trim().replace(/^Bearer\s+/i, '');

  const prompt = inputs.prompt || node.data.prompt || '';
  
  // Combine ordered image inputs
  let combined_images = [
    inputs.ref_image_1 || node.data.ref_image_1,
    inputs.ref_image_2 || node.data.ref_image_2,
    inputs.ref_image_3 || node.data.ref_image_3,
    inputs.ref_images || node.data.ref_image || []
  ].flat().filter(img => typeof img === 'string' && img.trim() !== '');

  const payload = {
    model: node.data.model || 'gpt-image-2',
    prompt: prompt,
    images: combined_images,
    aspectRatio: node.data.resolution || '1024x1024',
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
    throw new Error(`Grsai API error: [${res.status}] ${await res.text()}`);
  }

  const data = await res.json();
  if (!data.id) {
    throw new Error('Grsai API did not return a task ID');
  }

  const taskId = data.id;
  console.log(`[Grsai Execute] Task ID ${taskId} received. Polling results...`);

  // DB Logging: Insert Task
  if (pool && orderContext) {
    try {
      const q = `
        INSERT INTO yizi_api_logs (id, order_id, model, status, progress, created_at, updated_at) 
        VALUES ($1, $2, $3, 'pending', 0, NOW(), NOW())
      `;
      await pool.query(q, [taskId, orderContext.order_id || 'unknown', payload.model]);

      // Lazy Cleanup: Delete logs older than 7 days
      pool.query(`DELETE FROM yizi_api_logs WHERE created_at < NOW() - INTERVAL '7 days'`).catch(err => {
        console.warn('[DB] Failed to cleanup old logs:', err.message);
      });
    } catch (err) {
      console.warn(`[DB] Failed to insert api log for ${taskId}:`, err.message);
    }
  }

  // Polling loop
  for (let i = 0; i < 300; i++) { // Max 300 * 5s = 1500s (25 minutes)
    await sleep(5000);
    const pollRes = await fetch(`${resultUrl}?id=${encodeURIComponent(taskId)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    });
    
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    
    if (pollData.status === 'succeeded' && pollData.results && pollData.results.length > 0) {
      console.log(`[Grsai Execute] Task ${taskId} succeeded!`);
      const urls = pollData.results.map(r => r.url);
      
      // DB Logging: Success
      if (pool) {
        pool.query(`UPDATE yizi_api_logs SET status = 'succeeded', progress = 100, result_images = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(urls), taskId]).catch(e => console.warn(e.message));
      }

      return { output_images: urls };
    } else if (pollData.status === 'failed') {
      // DB Logging: Failed
      if (pool) {
        pool.query(`UPDATE yizi_api_logs SET status = 'failed', error_msg = 'Task failed internally', updated_at = NOW() WHERE id = $1`, [taskId]).catch(e => console.warn(e.message));
      }
      throw new Error(`Grsai Task ${taskId} failed.`);
    } else {
      console.log(`[Grsai Execute] Task ${taskId} status: ${pollData.status} (${pollData.progress || 0}%)`);
      // DB Logging: Progress
      if (pool) {
        pool.query(`UPDATE yizi_api_logs SET status = $1, progress = $2, updated_at = NOW() WHERE id = $3`, [pollData.status || 'processing', pollData.progress || 0, taskId]).catch(e => console.warn(e.message));
      }
    }
  }

  // Timeout failure logging
  if (pool) {
    pool.query(`UPDATE yizi_api_logs SET status = 'failed', error_msg = 'Polling timeout 1500s', updated_at = NOW() WHERE id = $1`, [taskId]).catch(e => console.warn(e.message));
  }
  throw new Error(`Grsai Task ${taskId} timed out after 1500s`);
}

/**
 * Main execution function
 */
export async function runPipeline(workflowJson, orderContext, pool) {
  try {
    const parsedData = typeof workflowJson === 'string' ? JSON.parse(workflowJson) : workflowJson;
    const { nodes, edges } = parsedData;
    
    if (!nodes || !edges) {
      throw new Error("Invalid workflow data: Missing 'nodes' or 'edges' arrays");
    }

    const graph = buildGraph(nodes, edges);
    const sortedNodeIds = topoSort(graph);

    // Node output context: nodeId -> { outputKey: value }
    const context = {};

    console.log(`[Pipeline] Starting execution of ${sortedNodeIds.length} nodes...`);

    for (const nodeId of sortedNodeIds) {
      const node = graph.nodes[nodeId];
      console.log(`[Pipeline] Executing node: ${node.type} (${node.id})`);

      // Resolve inputs based on incoming edges
      const inputs = {};
      const incoming = graph.inEdges[nodeId];
      for (const edge of incoming) {
        const sourceOutputs = context[edge.source] || {};
        // sourceHandle usually determines which output variable we are taking
        const val = sourceOutputs[edge.sourceHandle || 'output'];
        if (val !== undefined) {
          inputs[edge.targetHandle || 'input'] = val;
        }
      }

      // Execute Node
      let outputs = {};
      switch (node.type) {
        case 'order_input':
          // We map orderContext to outputs
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
                // filter out directory itself if returned
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

          // Also map generic 'output' for backward compatibility
          outputs.output = outputs;
          break;

        case 'preset_grsai':
          outputs = await executeGrsaiPreset(node, inputs, process.env, pool, orderContext);
          break;

        case 'text_input':
          outputs.output = node.data.text || '';
          break;

        case 'string_concat':
          const s1 = inputs.str1 || '';
          const s2 = inputs.str2 || '';
          const s3 = inputs.str3 || '';
          const s4 = inputs.str4 || '';
          // filter out empty strings and join with newline
          outputs.output = [s1, s2, s3, s4].filter(s => typeof s === 'string' && s.trim() !== '').join('\n');
          break;

        case 'llm_call':
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
            signal: AbortSignal.timeout(30000)
          });

          if (!chatRes.ok) {
            throw new Error(`LLM Call failed: [${chatRes.status}] ${await chatRes.text()}`);
          }

          const chatData = await chatRes.json();
          outputs.output = chatData.choices?.[0]?.message?.content || '';
          break;

        case 'prompt_library':
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
              // Order by RANDOM() to pick one random prompt from the group
              const res = await pool.query('SELECT content, data FROM "yizi_prompts" WHERE group_id = $1 ORDER BY RANDOM() LIMIT 1', [groupId]);
              if (res.rows.length > 0) {
                selectedPromptContent = res.rows[0].content;
                selectedPreviewImg = res.rows[0].data?.preview_img || '';
              } else {
                throw new Error(`No prompts found in group ${groupId}.`);
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

        case 'image_preview':
          // Passthrough the image url
          outputs.output = inputs.image_url || inputs.output || node.data.preview_url || '';
          break;

        case 'oss_output':
          // inputs.images should be an array of URLs, inputs.order_info has oss path details
          const imagesToUpload = inputs.images || [];
          const orderInfo = inputs.order_info || orderContext;
          
          if (!imagesToUpload.length) {
             console.log(`[Pipeline] OSS Output: No images to upload.`);
             break;
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

          const client = new OSS(ossConfig);
          const uploadedUrls = [];

          for (let i = 0; i < imagesToUpload.length; i++) {
             console.log(`[Pipeline] Uploading image ${i+1}/${imagesToUpload.length} to OSS...`);
             const url = await uploadToOSS(
               client, 
               imagesToUpload[i], 
               orderInfo.openid, 
               orderInfo.order_id, 
               orderInfo.set_index || 0,
               `del_${Date.now()}`
             );
             // Ensure it's https
             const secureUrl = url.replace('http://', 'https://');
             uploadedUrls.push(secureUrl);
          }

          outputs.uploaded_urls = uploadedUrls;

          // Finally, push to yizi_orders delivery pool if requested
          if (pool && orderContext.isRealOrder) {
            console.log(`[Pipeline] Updating yizi_orders Delivery Pool for Order ${orderInfo.order_id}`);
            const selectRes = await pool.query('SELECT data FROM "yizi_orders" WHERE id = $1', [orderInfo.order_id]);
            if (selectRes.rows.length > 0) {
              const orderData = selectRes.rows[0].data || {};
              if (!orderData.sets) orderData.sets = [{}];
              const setIndex = orderInfo.set_index || 0;
              if (!orderData.sets[setIndex]) orderData.sets[setIndex] = {};
              if (!orderData.sets[setIndex].delivery_imgs) orderData.sets[setIndex].delivery_imgs = [];
              
              for (const url of uploadedUrls) {
                orderData.sets[setIndex].delivery_imgs.push({
                  id: `del_${crypto.randomBytes(4).toString('hex')}`,
                  img: url,
                  confirmed_at: null
                });
              }

              await pool.query(
                'UPDATE "yizi_orders" SET data = $1, wait_delivery = $2 WHERE id = $3', 
                [JSON.stringify(orderData), '1', orderInfo.order_id]
              );
            }
          }
          break;

        case 'http_request':
          // basic http request implementation
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

        default:
          console.log(`[Pipeline] Unrecognized node type: ${node.type}, skipping execution.`);
          outputs.output = inputs; // Passthrough
          break;
      }

      context[node.id] = outputs;
      console.log(`[Pipeline] Node ${node.id} finished. Outputs:`, Object.keys(outputs));
    }

    console.log(`[Pipeline] Execution completed successfully.`);
    return { success: true, context };

  } catch (err) {
    console.error(`[Pipeline Error]`, err);
    return { success: false, error: err.message };
  }
}
