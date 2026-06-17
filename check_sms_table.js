import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    const res = await pool.query('SELECT * FROM yizi_sms_codes');
    console.log('✅ 表存在！当前数据条数:', res.rows.length);
  } catch(e) {
    console.error('❌ 表不存在或查询报错:', e.message);
    
    // 如果表不存在，立刻帮用户建表
    if (e.message.includes('does not exist')) {
       console.log('正在紧急建表...');
       await pool.query(`
          CREATE TABLE IF NOT EXISTS yizi_sms_codes (
              phone VARCHAR(20) PRIMARY KEY,
              code VARCHAR(10) NOT NULL,
              created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
       `);
       console.log('建表成功！');
    }
  } finally {
    process.exit(0);
  }
}
run();
