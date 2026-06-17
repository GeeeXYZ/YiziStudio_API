import { pool } from './config/db.js';

async function checkModel() {
  try {
    const uuid = 'mod_b5c2a4edc55e7b97';
    const res = await pool.query('SELECT data FROM yizi_model WHERE uuid = $1', [uuid]);
    if (res.rows.length > 0) {
      console.log(JSON.stringify(res.rows[0].data, null, 2));
    } else {
      console.log('Model not found in yizi_model table.');
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkModel();
