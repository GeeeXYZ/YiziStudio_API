import dotenv from 'dotenv';
dotenv.config();
import('./config/db.js').then(async ({ pool }) => {
  try {
    await pool.query('ALTER TABLE "yizi_admins" DROP COLUMN IF EXISTS account;');
    await pool.query('ALTER TABLE "yizi_admins" ALTER COLUMN email SET NOT NULL;');
    await pool.query('ALTER TABLE "yizi_admins" DROP CONSTRAINT IF EXISTS yizi_admins_email_key;');
    await pool.query('ALTER TABLE "yizi_admins" ADD CONSTRAINT yizi_admins_email_key UNIQUE (email);');
    console.log('DB updated');
  } catch(e) { console.error(e); }
  process.exit();
});
