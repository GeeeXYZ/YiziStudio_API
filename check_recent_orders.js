import { pool } from './config/db.js';

async function checkRecentOrders() {
  try {
    const res = await pool.query('SELECT id, data FROM yizi_orders ORDER BY datetime DESC LIMIT 3');
    for (const row of res.rows) {
      let data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      console.log(`Order ID: ${row.id}`);
      console.log(`  model_uuid inside data:`, data.model_uuid);
      
      // Check if this model exists
      if (data.model_uuid) {
         const modelRes = await pool.query('SELECT data FROM yizi_model WHERE uuid = $1', [data.model_uuid]);
         if (modelRes.rows.length === 0) {
            console.log(`  WARNING: Model UUID ${data.model_uuid} does NOT exist in yizi_model table!`);
         } else {
            const mData = typeof modelRes.rows[0].data === 'string' ? JSON.parse(modelRes.rows[0].data) : modelRes.rows[0].data;
            console.log(`  FOUND model in yizi_model! Lora prompt:`, mData.lora_prompt);
         }
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkRecentOrders();
