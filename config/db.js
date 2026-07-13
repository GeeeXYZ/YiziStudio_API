import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/yizi',
});

pool.query(`
  CREATE TABLE IF NOT EXISTS yizi_settings (
      key VARCHAR PRIMARY KEY,
      value TEXT,
      is_secret BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`).then(() => console.log('yizi_settings verified')).catch(e => console.error('DB Init Error:', e.message));

// Initialize yizi_sms_codes
pool.query(`
  CREATE TABLE IF NOT EXISTS yizi_sms_codes (
      phone VARCHAR(20) PRIMARY KEY,
      code VARCHAR(10) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
`).catch(e => console.error('DB Init Error yizi_sms_codes:', e.message));

// Patch yizi_comments schema safely
pool.query(`
    ALTER TABLE "yizi_comments" ADD COLUMN IF NOT EXISTS "name" TEXT;
    ALTER TABLE "yizi_comments" ADD COLUMN IF NOT EXISTS "order_id" TEXT;
`).catch(() => {});

// Unify yizi_model schema to use uuid instead of id
pool.query(`
    ALTER TABLE "yizi_model" RENAME COLUMN "id" TO "uuid";
`).catch(() => {});

// Add balance to yizi_admins for dual-track cost accounting
pool.query(`
    ALTER TABLE "yizi_admins" ADD COLUMN IF NOT EXISTS "balance" NUMERIC(15, 4) DEFAULT 0;
`).catch(() => {});

// Initialize cost tracking tables
pool.query(`
  CREATE TABLE IF NOT EXISTS yizi_node_costs (
      id SERIAL PRIMARY KEY,
      node_type VARCHAR(50) NOT NULL,
      model VARCHAR(100) DEFAULT '*',
      cost NUMERIC(10, 4) DEFAULT 0,
      currency VARCHAR(20) DEFAULT 'points',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(node_type, model)
  );

  CREATE TABLE IF NOT EXISTS yizi_execution_ledgers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id VARCHAR(100),
      run_by_admin_id INT,
      run_by_user_id VARCHAR,
      total_cost NUMERIC(10, 4) DEFAULT 0,
      node_execution_details JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`).catch(e => console.error('DB Init Error Cost Tables:', e.message));

// Cache for table columns to avoid repetitive schema queries
const tableColumnsCache = {};

// Helper to get primary key column of a table in PostgreSQL
async function getPrimaryKeyColumn(tableName) {
  try {
    const res = await pool.query(`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
    `, [tableName]);
    return res.rows[0] ? res.rows[0].attname : 'id';
  } catch (e) {
    return 'id'; // default fallback
  }
}

// Helper to get all valid column names of a table dynamically
async function getTableColumns(tableName) {
  if (tableColumnsCache[tableName]) return tableColumnsCache[tableName];
  try {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [tableName]
    );
    const cols = res.rows.map(r => r.column_name);
    tableColumnsCache[tableName] = cols;
    return cols;
  } catch (e) {
    return [];
  }
}

export { pool, getPrimaryKeyColumn, getTableColumns };
