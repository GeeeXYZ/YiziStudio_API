import { pool } from './config/db.js';

async function checkModel() {
  const res = await pool.query(`SELECT data FROM "yizi_model" LIMIT 1`);
  if (res.rows.length > 0) {
    const data = typeof res.rows[0].data === 'string' ? JSON.parse(res.rows[0].data) : res.rows[0].data;
    console.log(JSON.stringify(data, null, 2));
  }
  process.exit(0);
}
checkModel();
