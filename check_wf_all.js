import { pool } from './config/db.js';

async function checkAllWorkflows() {
  try {
    const res = await pool.query("SELECT uuid, title, data FROM yizi_cases WHERE data->>'engine_type' = 'api_pipeline_node'");
    for (const row of res.rows) {
      const data = row.data;
      const wfJson = typeof data.workflow_json === 'string' ? JSON.parse(data.workflow_json) : data.workflow_json;
      let found = false;
      for (const key in wfJson) {
        const node = wfJson[key];
        if (node.inputs && ('lora_prompt' in node.inputs || 'model_name' in node.inputs || 'api_url' in node.inputs)) {
           console.log(`[${row.title} - ${row.uuid}] Found fetch node at key ${key} with class_type: ${node.class_type}`);
           found = true;
        }
      }
      if (!found) {
        // console.log(`[${row.title} - ${row.uuid}] No fetch node found.`);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkAllWorkflows();
