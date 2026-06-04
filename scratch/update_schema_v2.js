import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log('Connecting to database:', process.env.DATABASE_URL?.split('@')[1]);
  try {
    // 1. Create yizi_vip_settings table
    console.log('Creating yizi_vip_settings table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "yizi_vip_settings" (
        "mobi" TEXT PRIMARY KEY,
        "type" TEXT DEFAULT 'my_models',
        "model_ids" JSONB DEFAULT '[]'::jsonb,
        "data" JSONB
      );
    `);

    // 2. Create yizi_front_sku_settings table
    console.log('Creating yizi_front_sku_settings table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "yizi_front_sku_settings" (
        "id" TEXT PRIMARY KEY,
        "front_sku_settings" JSONB DEFAULT '[]'::jsonb
      );
    `);

    // 3. Seed default row for yizi_front_sku_settings
    console.log('Seeding default row for yizi_front_sku_settings...');
    await pool.query(`
      INSERT INTO "yizi_front_sku_settings" ("id", "front_sku_settings")
      VALUES ('1', '[]'::jsonb)
      ON CONFLICT ("id") DO NOTHING;
    `);

    console.log('Database updates completed successfully!');
  } catch (error) {
    console.error('Failed to update database schema:', error);
  } finally {
    await pool.end();
  }
}

run();
