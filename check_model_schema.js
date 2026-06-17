import { pool } from './config/db.js';

async function checkModelDB() {
  try {
    const colsRes = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'yizi_model'
    `);
    console.log("yizi_model columns:", colsRes.rows.map(r => r.column_name));
    
    // Pick the primary key
    const pk = colsRes.rows.some(r => r.column_name === 'uuid') ? 'uuid' : 'id';
    console.log("yizi_model primary key:", pk);

    // Get latest model
    const res = await pool.query(`SELECT * FROM yizi_model ORDER BY created_at DESC LIMIT 1`);
    if(res.rows.length > 0) {
      console.log("Sample model ID:", res.rows[0][pk]);
      const data = typeof res.rows[0].data === 'string' ? JSON.parse(res.rows[0].data) : res.rows[0].data;
      console.log("Sample lora_prompt:", data.lora_prompt);
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkModelDB();
