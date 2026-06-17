import { pool } from './config/db.js';

async function checkSpaces() {
  try {
    const res = await pool.query('SELECT data FROM yizi_orders ORDER BY datetime DESC LIMIT 3');
    for (const row of res.rows) {
       const mData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
       console.log(`model_uuid: '${mData.model_uuid}' length: ${mData.model_uuid ? mData.model_uuid.length : 0}`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkSpaces();
