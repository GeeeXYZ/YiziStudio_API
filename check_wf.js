import { pool } from './config/db.js';

async function checkWorkflow() {
  try {
    const res = await pool.query("SELECT data FROM yizi_cases WHERE data->>'engine_type' = 'api_pipeline_node' ORDER BY created_time DESC LIMIT 1");
    if (res.rows.length > 0) {
      const data = res.rows[0].data;
      const wfJson = typeof data.workflow_json === 'string' ? JSON.parse(data.workflow_json) : data.workflow_json;
      let found = false;
      for (const key in wfJson) {
        if (wfJson[key].class_type === 'FetchImgbyURL_secured' || wfJson[key].class_type === 'FetchImageByURL') {
           console.log(`Found fetch node at key ${key}:`);
           console.log(JSON.stringify(wfJson[key], null, 2));
           found = true;
        }
      }
      if (!found) {
        console.log('No fetch node found by class_type!');
        if (wfJson['422']) {
           console.log('Node 422 exists but has class_type:', wfJson['422'].class_type);
           console.log(JSON.stringify(wfJson['422'], null, 2));
        }
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkWorkflow();
