import { pool } from '../config/db.js';
async function run() {
  const tables = ['yizi_users', 'yizi_admins', 'yizi_workflow_logs', 'yizi_api_logs', 'yizi_model'];
  for (const t of tables) {
    const res = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`, [t]);
    console.log(`\n--- ${t} ---`);
    console.log(res.rows.map(r => `${r.column_name}: ${r.data_type}`).join('\n'));
  }
  process.exit(0);
}
run();
