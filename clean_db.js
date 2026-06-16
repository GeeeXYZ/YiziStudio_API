import { pool } from './config/db.js';

async function clean() {
  console.log('Starting database cleanup...');
  try {
    const res = await pool.query(`
      UPDATE yizi_api_logs 
      SET result_images = '[]' 
      WHERE result_images IS NOT NULL AND length(result_images::text) > 10000
      RETURNING id
    `);
    console.log(`Cleaned ${res.rowCount} rows containing massive Base64 data.`);
  } catch (err) {
    console.error('Cleanup error:', err);
  } finally {
    pool.end();
  }
}

clean();
