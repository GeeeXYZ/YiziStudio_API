require('dotenv').config();
const {Pool} = require('pg');
const pool = new Pool({connectionString: process.env.DATABASE_URL});
const q = `EXPLAIN ANALYZE SELECT id, order_id, model, status, progress, error_msg, created_at, updated_at, (CASE WHEN jsonb_typeof(result_images) = 'array' THEN (jsonb_array_length(result_images) > 0)::int ELSE 0 END) as has_images FROM yizi_api_logs ORDER BY created_at DESC LIMIT 50`;
pool.query(q).then(res => {
  res.rows.forEach(row => console.log(row['QUERY PLAN']));
  pool.end();
}).catch(console.error);
