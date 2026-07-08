import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  try {
    const r = await pool.query('SELECT id, title, data FROM yizi_sku LIMIT 5');
    r.rows.forEach(row => {
      const d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      console.log(`SKU ${row.id} (${row.title}):`);
      console.log(`  auto_delivery = ${JSON.stringify(d?.auto_delivery)} (type: ${typeof d?.auto_delivery})`);
      console.log(`  auto_trigger  = ${JSON.stringify(d?.auto_trigger)} (type: ${typeof d?.auto_trigger})`);
    });
  } catch (e) {
    console.error(e.message);
  } finally {
    pool.end();
  }
}
check();
