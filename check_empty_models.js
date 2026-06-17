import { pool } from './config/db.js';

async function checkEmptyModels() {
  try {
    const res = await pool.query('SELECT uuid, data FROM yizi_model');
    for (const row of res.rows) {
       const mData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
       if (!mData.main_img || !mData.lora_prompt) {
          console.log(`Model ${row.uuid} is missing fields! main_img: ${!!mData.main_img}, lora_prompt: ${!!mData.lora_prompt}`);
       }
    }
    console.log("Done checking models.");
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkEmptyModels();
