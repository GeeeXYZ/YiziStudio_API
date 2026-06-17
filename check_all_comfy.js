import { pool } from './config/db.js';

async function checkAllComfy() {
  try {
    const res = await pool.query("SELECT * FROM yizi_cases");
    for (const row of res.rows) {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
      const wfJsonStr = row.workflow_json || data.workflow_json || data;
      let wfJson;
      try {
         wfJson = typeof wfJsonStr === 'string' ? JSON.parse(wfJsonStr) : wfJsonStr;
      } catch(e) { continue; }
      
      if (!wfJson) continue;

      let found = false;
      for (const key in wfJson) {
        const node = wfJson[key];
        if (node && node.class_type === 'FetchImgbyURL_secured') {
           console.log(`[${row.title || data.title} - ${row.uuid || row.id}] Found FetchImgbyURL_secured at node ID: ${key}`);
           console.log("Keys in this node's inputs:", Object.keys(node.inputs || {}));
           found = true;
        }
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkAllComfy();
