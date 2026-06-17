import { pool } from './config/db.js';
async function run() {
  const r = await pool.query(`SELECT * FROM yizi_cases WHERE uuid = 'case_5c28e16188f99fed'`);
  const w = JSON.parse(r.rows[0].data.workflow_json);
  for(let k in w) { 
    if (w[k].class_type.toLowerCase().includes('upload') || w[k].class_type.toLowerCase().includes('recv') || w[k].class_type.toLowerCase().includes('img')) {
      console.log(w[k].class_type);
    }
  }
  process.exit(0);
}
run();
