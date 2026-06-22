import { pool } from './config/db.js';

async function check() {
  const res = await pool.query(`SELECT * FROM "yizi_orders" LIMIT 1`);
  console.log("DB columns:", Object.keys(res.rows[0]));
  const data = typeof res.rows[0].data === 'string' ? JSON.parse(res.rows[0].data) : res.rows[0].data;
  console.log("data JSON keys:", Object.keys(data));
  process.exit(0);
}
check();
