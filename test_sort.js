import { pool } from './config/db.js';

async function test() {
  try {
    const res = await pool.query('SELECT id, has_comments, wait_delivery, datetime FROM yizi_orders ORDER BY "has_comments" DESC NULLS LAST, "wait_delivery" DESC NULLS LAST, "datetime" DESC NULLS LAST LIMIT 10');
    console.log("Multi-sort result:", res.rows);
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
test();
