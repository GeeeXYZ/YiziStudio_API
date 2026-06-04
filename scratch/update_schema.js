import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load dotenv from parent backend directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function run() {
  console.log('Connecting to database:', process.env.DATABASE_URL?.split('@')[1]);
  try {
    // 1. Add password column to yizi_users
    console.log('Adding password column to yizi_users if not exists...');
    await pool.query('ALTER TABLE "yizi_users" ADD COLUMN IF NOT EXISTS "password" TEXT;');

    // 2. Create yizi_comments table
    console.log('Creating yizi_comments table if not exists...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "yizi_comments" (
        "id" TEXT PRIMARY KEY,
        "delivery_uuid" TEXT,
        "type" TEXT,
        "comment" TEXT,
        "content" TEXT,
        "created_at" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('Database updates completed successfully!');
  } catch (error) {
    console.error('Failed to update database schema:', error);
  } finally {
    await pool.end();
  }
}

run();
