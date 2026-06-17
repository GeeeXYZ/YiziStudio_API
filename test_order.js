import { pool } from './config/db.js';

async function testFetch() {
  try {
    const res = await pool.query('SELECT id, model_uuid, data FROM yizi_orders ORDER BY datetime DESC LIMIT 5');
    console.log(JSON.stringify(res.rows, null, 2));
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
testFetch();
