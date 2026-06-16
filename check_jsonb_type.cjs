require('dotenv').config();
const {Pool} = require('pg');
const pool = new Pool({connectionString: process.env.DATABASE_URL});
const q = `SELECT jsonb_typeof(result_images) as type, COUNT(*) FROM yizi_api_logs GROUP BY type`;
pool.query(q).then(res => {
  console.log(res.rows);
  pool.end();
}).catch(console.error);
