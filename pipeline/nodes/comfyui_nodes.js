import jwt from 'jsonwebtoken';
import { fetchWithRetry } from '../core/fetch_helper.js';

export async function executeComfyRemote(node, inputs, orderContext, env, pool, abortSignal) {
  if (!pool) throw new Error('comfy_remote requires database pool to fetch workflow');
  const workflowId = node.data.workflow_uuid;
  if (!workflowId) throw new Error('comfy_remote node missing workflow_uuid');
  
  const caseRes = await pool.query(`SELECT * FROM "yizi_comfyui_workflows" WHERE "uuid" = $1`, [workflowId]);
  if (caseRes.rows.length === 0) throw new Error(`ComfyUI workflow not found: ${workflowId}`);
  const caseData = caseRes.rows[0];
  const comfyWorkflowJsonStr = caseData.workflow_json || (caseData.data && caseData.data.workflow_json) || (typeof caseData.data === 'string' ? caseData.data : JSON.stringify(caseData.data));
  if (!comfyWorkflowJsonStr) throw new Error(`ComfyUI workflow JSON is empty for ${workflowId}`);
  
  let comfyJson;
  try { comfyJson = JSON.parse(comfyWorkflowJsonStr); } 
  catch(e) { throw new Error(`Failed to parse ComfyUI workflow JSON: ${e.message}`); }

  let upstreamImageUrl = inputs.image_url || inputs.output || (Array.isArray(inputs.images) ? inputs.images[0] : inputs.images) || (Array.isArray(inputs.output_images) ? inputs.output_images[0] : inputs.output_images) || '';
  if (Array.isArray(upstreamImageUrl)) upstreamImageUrl = upstreamImageUrl[0] || '';
  
  let loraPrompt = '';
  if (orderContext && orderContext.model_uuid) {
     try {
        const modelRes = await pool.query('SELECT data FROM "yizi_model" WHERE uuid = $1', [orderContext.model_uuid]);
        if (modelRes.rows.length > 0) {
           const mData = modelRes.rows[0].data;
           const modelData = typeof mData === 'string' ? JSON.parse(mData) : mData;
           loraPrompt = modelData.lora_prompt || '';
           orderContext.modelData = modelData;
        }
     } catch (err) {
        console.warn(`[Pipeline] Failed to query lora_prompt for model ${orderContext.model_uuid}: ${err.message}`);
     }
  }

  let foundFetchNode = false;
    const directOssAddress = `https://${env.OSS_BUCKET}.${env.OSS_REGION}.aliyuncs.com`;
    // For backend pipeline triggers, we must generate a valid JWT so that ComfyUI's callback requests pass authenticateToken middleware
    const pipelineToken = jwt.sign(
      { username: 'pipeline_bot', is_super: true, is_pipeline: true },
      env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '1d' }
    );
    const bearerToken = `Bearer ${pipelineToken}`;
    const apiUrl = env.API_BASE_URL || 'http://127.0.0.1:3000';

    for (const key in comfyJson) {
      const comfyNode = comfyJson[key];
      if (!comfyNode || !comfyNode.class_type) continue;
      if (!comfyNode.inputs) comfyNode.inputs = {};

      if (comfyNode.class_type === 'FetchImgbyURL_secured' || comfyNode.class_type === 'FetchImageByURL') {
        foundFetchNode = true;
        comfyNode.inputs.image_url = upstreamImageUrl;
        comfyNode.inputs.order_id = `${orderContext.openid}.${orderContext.order_id}`;
        comfyNode.inputs.index = orderContext.set_index || 0;
        comfyNode.inputs.lora_prompt = loraPrompt;
        if (inputs.float_val_1 !== undefined) comfyNode.inputs.float_val_1 = inputs.float_val_1;
        if (inputs.float_val_2 !== undefined) comfyNode.inputs.float_val_2 = inputs.float_val_2;
        // prompt_override input takes priority over orderContext.prompt
        const promptOverride = inputs.prompt_override;
        comfyNode.inputs.prompt = (typeof promptOverride === 'string' && promptOverride.trim()) ? promptOverride : (orderContext.prompt || '');
        // Propagate node-level auto_delivery into orderContext for backend delivery decision
        const nodeAutoDelivery = node.data.auto_delivery === true;
        const finalAutoDelivery = orderContext.auto_delivery === true || nodeAutoDelivery;
        
        // Decoupled from global auto_delivery: track specifically for comfyui webhook
        orderContext.comfy_auto_delivery = finalAutoDelivery;
        comfyNode.inputs.auto_delivery = finalAutoDelivery; // Tell ComfyUI to callback with results if true
        comfyNode.inputs.api_url = apiUrl; 
        comfyNode.inputs.token = pipelineToken;
        comfyNode.inputs.oss_address = directOssAddress;
        comfyNode.inputs.oss_token = bearerToken;
      }
      
      if (comfyNode.class_type === 'FetchImageByUUID') {
        comfyNode.inputs.api_url = apiUrl;
        comfyNode.inputs.token = pipelineToken;
      }

      if (comfyNode.class_type === 'YiziStudioReceiver') {
        if (!comfyNode._meta) comfyNode._meta = {};
        comfyNode._meta.yizi_payload = JSON.stringify({
          model_uuid: orderContext.model_uuid || '',
          model_name: orderContext.model_name || '',
          model_avatar: orderContext.modelData?.imgs?.[0] || orderContext.modelData?.main_img || '',
          model_full_body: orderContext.modelData?.imgs?.[1] || orderContext.modelData?.main_img || '',
          model_special_pose: orderContext.modelData?.special_poses?.[0] || '', // Legacy fallback; pipeline uses OSS-based pose fetching now
          order_id: `${orderContext.openid || ''}.${orderContext.order_id || ''}`,
          real_openid: orderContext.openid || 'unknown',
          real_order_id: orderContext.order_id || 'unknown',
          set_index: orderContext.set_index || 0
        });
        comfyNode.inputs.openid = orderContext.openid || 'unknown';
        comfyNode.inputs.order_id = orderContext.order_id || 'unknown';
        comfyNode.inputs.set_index = orderContext.set_index || 0;
        comfyNode.inputs.oss_address = directOssAddress;
        comfyNode.inputs.oss_token = bearerToken;
      }
    }
  
  if (!foundFetchNode) {
    console.warn(`[Pipeline] comfy_remote: FetchImgbyURL_secured node not found in workflow ${workflowId}.`);
  }

  let customServer = caseData.server || (caseData.data && caseData.data.server);
  const comfyuiServerUrl = customServer || env.COMFYUI_SERVER_URL || 'http://127.0.0.1:8188';
  console.log(`[Pipeline] Triggering ComfyUI workflow at ${comfyuiServerUrl}/prompt`);
  
  const promptPayload = { prompt: comfyJson };
  if (node.data.client_id) promptPayload.client_id = node.data.client_id;

  let fetchHeaders = { 'Content-Type': 'application/json' };
  const customHeaders = caseData.headers || (caseData.data && caseData.data.headers);
  if (Array.isArray(customHeaders)) {
    customHeaders.forEach(h => {
      if (h && h.key && h.value) {
        fetchHeaders[h.key] = h.value;
      }
    });
  }

  let response;
  try {
    response = await fetchWithRetry(`${comfyuiServerUrl}/prompt`, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(promptPayload),
      signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    }, { maxRetries: 3, baseDelayMs: 2000 });
  } catch (fetchErr) {
    throw new Error(`无法连接到 ComfyUI 服务 (${comfyuiServerUrl}): ${fetchErr.message}`);
  }

  if (!response.ok) {
     const errorText = await response.text();
     let errorDetail = errorText;
     try { const parsed = JSON.parse(errorText); errorDetail = parsed.error?.message || parsed.message || errorText; } catch(e) {}
     throw new Error(`ComfyUI 拒绝了请求 [${response.status}]: ${errorDetail}`);
  }

  const responseData = await response.json();
  console.log(`[Pipeline] ComfyUI job submitted successfully. Prompt ID: ${responseData.prompt_id}`);
  
  return {
    output: {
       status: 'submitted',
       prompt_id: responseData.prompt_id,
       message: 'Task sent to ComfyUI successfully. It will auto-deliver when done.'
    }
  };
}
