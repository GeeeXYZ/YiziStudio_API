import { pool } from './config/db.js';

async function checkRoles() {
  try {
    const res = await pool.query('SELECT id, role_name, permissions FROM yizi_roles');
    console.log(res.rows);
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
checkRoles();
