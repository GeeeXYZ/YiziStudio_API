const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres.wcnzcvfsorsdoqwmlgtz:C6KwVFcEYIuBLtlz@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres' });
pool.query("SELECT data FROM yizi_orders LIMIT 5").then(res => {
  res.rows.forEach(r => console.log(JSON.stringify(r.data)));
  process.exit();
}).catch(console.error);
