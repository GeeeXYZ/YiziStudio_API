import { pool } from './config/db.js';

async function checkAdmins() {
  try {
    const res = await pool.query('SELECT account, is_super, role_id FROM yizi_users WHERE account IS NOT NULL');
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkAdmins();
