import { pool } from './config/db.js';
import { unpackRow } from './utils/helpers.js';

async function dumpList() {
  try {
    const listQuery = `SELECT * FROM "yizi_orders" ORDER BY "datetime" DESC LIMIT 1 OFFSET 0`;
    const result = await pool.query(listQuery);
    let listData = result.rows.map(unpackRow);
    console.log(JSON.stringify(listData, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
dumpList();
