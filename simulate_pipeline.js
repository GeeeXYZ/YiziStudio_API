import { pool } from './config/db.js';

async function simulatePipeline() {
  try {
    const workflowId = 'case_5c28e16188f99fed'; // The one with node 1422
    
    // 1. Fetch workflow JSON
    const caseRes = await pool.query(`SELECT * FROM "yizi_cases" WHERE "uuid" = $1`, [workflowId]);
    if (caseRes.rows.length === 0) throw new Error('Workflow not found');
    const caseData = caseRes.rows[0];
    const comfyWorkflowJsonStr = caseData.workflow_json || (typeof caseData.data === 'string' ? caseData.data : JSON.stringify(caseData.data));
    let comfyJson = JSON.parse(comfyWorkflowJsonStr);
    
    // 2. Fetch lora_prompt
    const model_uuid = 'mod_b5c2a4edc55e7b97'; // Example model
    let loraPrompt = '';
    const modelRes = await pool.query('SELECT data FROM "yizi_model" WHERE uuid = $1', [model_uuid]);
    if (modelRes.rows.length > 0) {
      const mData = modelRes.rows[0].data;
      const modelData = typeof mData === 'string' ? JSON.parse(mData) : mData;
      loraPrompt = modelData.lora_prompt || '';
    }
    
    console.log("Simulating with lora_prompt:", loraPrompt);
    
    // 3. Inject
    let foundFetchNode = false;
    for (const key in comfyJson) {
      const comfyNode = comfyJson[key];
      if (comfyNode.class_type === 'FetchImgbyURL_secured') {
        foundFetchNode = true;
        if (!comfyNode.inputs) comfyNode.inputs = {};
        comfyNode.inputs.image_url = "http://example.com/image.png";
        comfyNode.inputs.order_id = `user1.ord123`;
        comfyNode.inputs.index = 0;
        
        // Inject lora_prompt instead of model_name
        comfyNode.inputs.lora_prompt = loraPrompt;
        
        comfyNode.inputs.prompt = 'Test prompt';
        comfyNode.inputs.auto_delivery = false;
        comfyNode.inputs.api_url = 'http://127.0.0.1:3000'; 
        comfyNode.inputs.token = 'YIZI_STUDIO';
        console.log(`Node ${key} injected!`);
      }
    }
    
    if (!foundFetchNode) {
       console.log("Failed to find FetchImgbyURL_secured");
    } else {
       console.log("Node 1422 inputs after injection:");
       console.log(JSON.stringify(comfyJson['1422'].inputs, null, 2));
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
simulatePipeline();
