import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { Pool } = pg;

// Read page_api.ts
const pageApiFile = path.join(__dirname, '..', '..', 'YiziBG', 'src', 'api', 'page_api.ts');
const serverFile = path.join(__dirname, '..', 'server.js');

async function audit() {
  console.log('=== Starting API and Database Audit ===\n');

  if (!fs.existsSync(pageApiFile)) {
    console.error(`Error: page_api.ts not found at ${pageApiFile}`);
    process.exit(1);
  }

  // 1. Parse rpc calls from page_api.ts
  const pageApiContent = fs.readFileSync(pageApiFile, 'utf-8');
  const rpcRegex = /rpc\(\s*["']([^"']+)["']/g;
  const rpcCalls = new Set();
  let match;
  while ((match = rpcRegex.exec(pageApiContent)) !== null) {
    rpcCalls.add(match[1]);
  }

  console.log(`Parsed ${rpcCalls.size} unique RPC endpoints from page_api.ts:`);
  const rpcArray = Array.from(rpcCalls).sort();
  rpcArray.forEach(p => console.log(`  - ${p}`));
  console.log('');

  // 2. Fetch tables from live database
  console.log('Connecting to database to fetch existing tables...');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  let existingTables = [];
  try {
    const res = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    existingTables = res.rows.map(r => r.table_name);
    console.log(`Found ${existingTables.length} tables in public schema:`);
    existingTables.forEach(t => console.log(`  - ${t}`));
    console.log('');
  } catch (error) {
    console.error('Failed to query database tables:', error.message);
  } finally {
    await pool.end();
  }

  // 3. Analyze mapping of RPC endpoints to tables
  console.log('=== Analyzing Route / Table Compatibility ===');
  const report = [];
  const requiredTables = new Set();

  for (const rpcPath of rpcArray) {
    // Expected format: /admin/:db_name/:action
    const parts = rpcPath.split('/').filter(Boolean);
    
    // Check if it is a standard RPC path or a custom static path
    if (parts[0] === 'admin' && parts.length >= 3) {
      const db_name = parts[1];
      const action = parts.slice(2).join('/');
      
      // Get table mapping
      let actualTable = `yizi_${db_name}`;
      if (db_name === 'user') actualTable = 'yizi_users';
      else if (db_name === 'case') actualTable = 'yizi_cases';
      
      requiredTables.add(actualTable);
      const tableExists = existingTables.includes(actualTable);

      report.push({
        path: rpcPath,
        type: 'RPC Wildcard',
        db_name,
        targetTable: actualTable,
        tableExists,
        status: tableExists ? 'OK' : 'MISSING_TABLE'
      });
    } else {
      // Special path
      let status = 'CHECK_NEEDED';
      if (rpcPath === '/admin/sts' || rpcPath === '/admin/oss_delivery_imgs/upload/sts') {
        status = 'OK (Implemented)';
      }
      report.push({
        path: rpcPath,
        type: 'Custom Static',
        db_name: 'N/A',
        targetTable: 'N/A',
        tableExists: true,
        status
      });
    }
  }

  console.table(report);

  console.log('\n=== Missing Database Tables Checklist ===');
  let missingCount = 0;
  for (const table of requiredTables) {
    if (!existingTables.includes(table)) {
      console.log(`[ ] ${table} (MISSING)`);
      missingCount++;
    } else {
      console.log(`[x] ${table} (Present)`);
    }
  }

  if (missingCount === 0) {
    console.log('\nAll required tables are present in the database!');
  } else {
    console.log(`\nFound ${missingCount} missing tables that need to be created.`);
  }
}

audit();
