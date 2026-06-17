import { pool } from './config/db.js';
import { unpackRow } from './utils/helpers.js';

async function testRPC() {
  try {
    const db_name = 'yizi_model';
    const uuid = 'mod_b5c2a4edc55e7b97';
    
    // Simulate exactly what RPC list does
    const listQuery = `SELECT * FROM "${db_name}" WHERE "uuid" = $1 ORDER BY "uuid" DESC LIMIT $2 OFFSET $3`;
    const result = await pool.query(listQuery, [uuid, 1, 0]);
    
    let listData = result.rows.map(unpackRow);
    
    console.log("RPC returned:", listData.length, "rows");
    if(listData.length > 0) {
       console.log("main_img:", listData[0].main_img);
       console.log("lora_prompt:", listData[0].lora_prompt);
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
testRPC();
