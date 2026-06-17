import { pool } from './config/db.js';

async function check() {
  try {
    const res = await pool.query(`
      SELECT id, status, 
             length(result_images::text) as images_len, 
             length(error_msg) as error_len,
             length(t::text) as total_len
      FROM yizi_api_logs t
      ORDER BY total_len DESC
      LIMIT 10
    `);
    console.table(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
check();
