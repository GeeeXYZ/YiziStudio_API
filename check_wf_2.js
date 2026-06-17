import { pool } from './config/db.js';

async function checkWorkflow() {
  try {
    const res = await pool.query("SELECT data FROM yizi_cases WHERE data->>'engine_type' = 'api_pipeline_node' ORDER BY created_time DESC LIMIT 1");
    if (res.rows.length > 0) {
      const data = res.rows[0].data;
      const wfJson = typeof data.workflow_json === 'string' ? JSON.parse(data.workflow_json) : data.workflow_json;
      let found = false;
      for (const key in wfJson) {
        const node = wfJson[key];
        if (node.inputs && ('lora_prompt' in node.inputs || 'model_name' in node.inputs || 'api_url' in node.inputs)) {
           console.log(`Found node at key ${key} with class_type: ${node.class_type}`);
           console.log(JSON.stringify(node, null, 2));
           found = true;
        }
      }
      if (!found) {
        console.log('No node found containing lora_prompt or api_url in inputs!');
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkWorkflow();
