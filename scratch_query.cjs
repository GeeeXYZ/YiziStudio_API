const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres.wcnzcvfsorsdoqwmlgtz:C6KwVFcEYIuBLtlz@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres' });

async function main() {
  const res = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'yizi_cases'");
  console.log('Schema:', res.rows);
  const data = await pool.query("SELECT * FROM yizi_cases LIMIT 1");
  console.log('Sample:', JSON.stringify(data.rows, null, 2));
  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
