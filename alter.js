import 'dotenv/config';
import { pool } from './config/db.js';

async function run() {
  try {
    await pool.query('ALTER TABLE "yizi_sku" ADD COLUMN IF NOT EXISTS "sort_weight" NUMERIC DEFAULT 0;');
    console.log('ALTER DONE');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

run();
