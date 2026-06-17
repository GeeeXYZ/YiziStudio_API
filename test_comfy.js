import { pool } from './config/db.js';

async function testComfy() {
  try {
    const caseRes = await pool.query(`SELECT * FROM yizi_cases WHERE uuid = 'case_5c28e16188f99fed'`);
    const caseData = caseRes.rows[0];
    const comfyWorkflowJsonStr = caseData.data.workflow_json;
    const comfyJson = typeof comfyWorkflowJsonStr === 'string' ? JSON.parse(comfyWorkflowJsonStr) : comfyWorkflowJsonStr;

    // Inject fake data just like comfy_remote does
    for (const key in comfyJson) {
      if (comfyJson[key].class_type === 'FetchImgbyURL_secured') {
        comfyJson[key].inputs.image_url = 'https://example.com/test.png';
        comfyJson[key].inputs.order_id = 'test_order';
        comfyJson[key].inputs.index = 0;
        comfyJson[key].inputs.lora_prompt = '';
        comfyJson[key].inputs.prompt = 'Test prompt';
        comfyJson[key].inputs.auto_delivery = false;
        comfyJson[key].inputs.api_url = 'http://127.0.0.1:3000';
        comfyJson[key].inputs.token = 'YIZI_STUDIO';
      }
    }

    const res = await fetch('https://comfy.geeex.xyz/prompt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Access-Client-Id': '0827689df2e1d2ff9d3b7f05a5f218f5.access',
        'CF-Access-Client-Secret': '742daa4fc0a5beaa3466874683ce5b25843ab56ae24dc662ec9b4a7b356a96d7'
      },
      body: JSON.stringify({ prompt: comfyJson })
    });
    console.log('Status:', res.status);
    console.log('Body:', await res.text());
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
testComfy();
