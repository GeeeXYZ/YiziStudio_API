import { pool } from './config/db.js';

async function checkModelMainImg() {
  try {
    const model_uuid = 'mod_b5c2a4edc55e7b97';
    const modelRes = await pool.query('SELECT data FROM yizi_model WHERE uuid = $1', [model_uuid]);
    if (modelRes.rows.length > 0) {
       const mData = typeof modelRes.rows[0].data === 'string' ? JSON.parse(modelRes.rows[0].data) : modelRes.rows[0].data;
       console.log(`Model ${model_uuid} main_img:`, mData.main_img);
    } else {
       console.log(`Model ${model_uuid} not found.`);
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkModelMainImg();
