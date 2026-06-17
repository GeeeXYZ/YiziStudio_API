import { pool } from './config/db.js';

async function cleanErrorMsg() {
  try {
    const res = await pool.query(`
      UPDATE yizi_api_logs 
      SET error_msg = substring(error_msg from 1 for 500) || ' ...[TRUNCATED_OVERSIZED_ERROR]'
      WHERE length(error_msg) > 3000
      RETURNING id, length(error_msg)
    `);
    console.log(`Cleaned ${res.rowCount} rows with massively long error messages.`);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
cleanErrorMsg();
