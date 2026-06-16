export async function executeComfyRemote(node, inputs, orderContext, env, pool) {
  if (!pool) throw new Error('comfy_remote requires database pool to fetch workflow');
  const workflowId = node.data.workflow_uuid;
  if (!workflowId) throw new Error('comfy_remote node missing workflow_uuid');
  
  const colsRes = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'yizi_cases'`);
  const cols = colsRes.rows.map(r => r.column_name);
  const casePk = cols.includes('uuid') ? 'uuid' : 'id';
  const caseRes = await pool.query(`SELECT * FROM "yizi_cases" WHERE "${casePk}" = $1`, [workflowId]);
  if (caseRes.rows.length === 0) throw new Error(`ComfyUI workflow not found: ${workflowId}`);
  const caseData = caseRes.rows[0];
  const comfyWorkflowJsonStr = caseData.workflow_json || (typeof caseData.data === 'string' ? caseData.data : JSON.stringify(caseData.data));
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
        }
     } catch (err) {
        console.warn(`[Pipeline] Failed to query lora_prompt for model ${orderContext.model_uuid}: ${err.message}`);
     }
  }

  let foundFetchNode = false;
  for (const key in comfyJson) {
    const comfyNode = comfyJson[key];
    if (comfyNode.class_type === 'FetchImgbyURL_secured') {
      foundFetchNode = true;
      if (!comfyNode.inputs) comfyNode.inputs = {};
      comfyNode.inputs.image_url = upstreamImageUrl;
      comfyNode.inputs.order_id = `${orderContext.openid}.${orderContext.order_id}`;
      comfyNode.inputs.index = orderContext.set_index || 0;
      comfyNode.inputs.lora_prompt = loraPrompt;
      comfyNode.inputs.prompt = orderContext.prompt || '';
      comfyNode.inputs.auto_delivery = node.data.auto_delivery === true;
      comfyNode.inputs.api_url = env.API_BASE_URL || 'http://127.0.0.1:3000'; 
      comfyNode.inputs.token = env.JWT_SECRET || 'YIZI_STUDIO';
    }
  }
  
  if (!foundFetchNode) {
    console.warn(`[Pipeline] comfy_remote: FetchImgbyURL_secured node not found in workflow ${workflowId}.`);
  }

  const comfyuiServerUrl = env.COMFYUI_SERVER_URL || 'http://127.0.0.1:8188';
  console.log(`[Pipeline] Triggering ComfyUI workflow at ${comfyuiServerUrl}/prompt`);
  
  const promptPayload = { prompt: comfyJson };
  if (node.data.client_id) promptPayload.client_id = node.data.client_id;

  let response;
  try {
    response = await fetch(`${comfyuiServerUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(promptPayload)
    });
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
