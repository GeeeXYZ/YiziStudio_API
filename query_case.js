import { pool } from './config/db.js';
async function queryCase() {
  const res = await pool.query(`SELECT * FROM yizi_cases WHERE uuid = 'case_5c28e16188f99fed'`);
  const row = res.rows[0];
  console.log('headers:', row.headers);
  console.log('data.headers:', row.data.headers);
  process.exit(0);
}
queryCase();
