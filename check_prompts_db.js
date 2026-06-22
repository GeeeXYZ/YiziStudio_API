import { pool } from './config/db.js';

async function check() {
  const res1 = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'yizi_prompts'`);
  console.log('yizi_prompts cols:', res1.rows.map(r => r.column_name));
  
  const res2 = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'yizi_prompt_sets'`);
  console.log('yizi_prompt_sets cols:', res2.rows.map(r => r.column_name));
  
  const sample = await pool.query(`SELECT * FROM yizi_prompts LIMIT 1`);
  console.log('sample prompt:', sample.rows[0]);
  process.exit(0);
}

check();
