import { pool } from './config/db.js';
async function run() {
  const r = await pool.query(`SELECT * FROM yizi_cases WHERE uuid = 'case_5c28e16188f99fed'`);
  const row = r.rows[0];
  console.log('workflow_json type:', typeof row.workflow_json);
  console.log('workflow_json length:', row.workflow_json ? row.workflow_json.length : 0);
  console.log('data.workflow_json type:', typeof row.data.workflow_json);
}
run();
