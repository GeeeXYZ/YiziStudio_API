import { pool } from './config/db.js';

async function checkOrderSchema() {
  try {
    const colsRes = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'yizi_orders'
    `);
    console.log("yizi_orders columns:", colsRes.rows.map(r => r.column_name));
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkOrderSchema();
