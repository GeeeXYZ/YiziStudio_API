import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const res = await pool.query(`SELECT id, data FROM yizi_orders ORDER BY updated_at DESC LIMIT 1`);
  if (res.rows.length > 0) {
    const data = res.rows[0].data;
    console.log("Latest Order ID:", res.rows[0].id);
    if (data && data.workflow) {
      console.log("Workflow nodes:", JSON.stringify(data.workflow.nodes, null, 2));
    }
  }
  pool.end();
}
run();
