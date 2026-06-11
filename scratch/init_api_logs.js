import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' }); // or just .env if run from backend
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  const q = `
  CREATE TABLE IF NOT EXISTS yizi_api_logs (
      id VARCHAR PRIMARY KEY,
      order_id VARCHAR,
      model VARCHAR,
      status VARCHAR,
      progress INTEGER DEFAULT 0,
      result_images JSONB,
      error_msg TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  `;
  try {
    await pool.query(q);
    console.log('Table created successfully');
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

run();