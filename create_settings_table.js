import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/yizi',
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS yizi_settings (
        key VARCHAR PRIMARY KEY,
        value TEXT,
        is_secret BOOLEAN DEFAULT false,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('yizi_settings created');
  process.exit(0);
}

init();
