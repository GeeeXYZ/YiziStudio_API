const { Pool } = require('pg');
require('dotenv').config({path: './.env'});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  try {
    const res = await pool.query(`SELECT id, data FROM yizi_orders WHERE data::text LIKE '%cs.com%' OR data::text LIKE '%w_100%' OR data::text LIKE '%zhe%';`);
    console.log(`Found ${res.rows.length} orders with potential data corruption.`);
    
    let updatedCount = 0;

    for (const row of res.rows) {
      let isModified = false;
      const data = row.data;

      if (data && Array.isArray(data.sets)) {
        for (let i = 0; i < data.sets.length; i++) {
          const set = data.sets[i];
          if (set.delivery_imgs && Array.isArray(set.delivery_imgs)) {
            const originalLength = set.delivery_imgs.length;
            // Filter out corrupted strings. Valid ones must start with http or data: and be reasonably long.
            set.delivery_imgs = set.delivery_imgs.filter(di => {
              if (!di || typeof di.img !== 'string') return false;
              const img = di.img;
              return (img.startsWith('http') && img.includes('aliyuncs.com')) || img.startsWith('data:image/');
            });

            if (set.delivery_imgs.length !== originalLength) {
              isModified = true;
            }
          }
        }
      }

      if (isModified) {
        await pool.query('UPDATE yizi_orders SET data = $1 WHERE id = $2', [data, row.id]);
        updatedCount++;
        console.log(`Cleaned up order: ${row.id}`);
      }
    }

    console.log(`Successfully cleaned up ${updatedCount} orders.`);
  } catch (err) {
    console.error('Error during cleanup:', err);
  } finally {
    pool.end();
  }
}

run();
