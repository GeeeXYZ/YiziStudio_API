import { pool } from './config/db.js';

async function checkLog() {
  try {
    const res = await pool.query('SELECT order_id, error_msg FROM yizi_api_logs ORDER BY created_at DESC LIMIT 3');
    for (const row of res.rows) {
       console.log('Order:', row.order_id);
       console.log('Error/Log:', row.error_msg ? row.error_msg.substring(0, 1000) : 'No error');
       console.log('-------------------------');
    }
    
    // Also check the specific case's workflow_json just to be sure it matches
    const caseRes = await pool.query('SELECT data FROM yizi_cases WHERE engine_type = $1 ORDER BY datetime DESC LIMIT 1', ['api_pipeline_node']);
    if (caseRes.rows.length > 0) {
        // console.log(JSON.stringify(caseRes.rows[0].data, null, 2).substring(0, 500));
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkLog();
