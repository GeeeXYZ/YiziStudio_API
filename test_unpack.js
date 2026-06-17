import { pool } from './config/db.js';
import { unpackRow } from './utils/helpers.js';

async function testUnpack() {
  try {
    const res = await pool.query('SELECT id, data FROM yizi_orders ORDER BY datetime DESC LIMIT 1');
    const row = res.rows[0];
    
    console.log("Raw row data type:", typeof row.data);
    if(typeof row.data === 'object') {
       console.log("Raw row data keys:", Object.keys(row.data));
    }
    
    const unpacked = unpackRow(row);
    console.log("Unpacked row keys:", Object.keys(unpacked));
    console.log("Unpacked model_uuid:", unpacked.model_uuid);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
testUnpack();
