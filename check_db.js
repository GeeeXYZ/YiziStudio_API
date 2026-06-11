import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({path: './.env'});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

pool.query(`
  SELECT table_name, column_name, data_type 
  FROM information_schema.columns 
  WHERE table_schema = 'public' 
  ORDER BY table_name, ordinal_position;
`).then(res => {
  const tables = {};
  res.rows.forEach(r => {
    if (!tables[r.table_name]) tables[r.table_name] = [];
    tables[r.table_name].push({ column: r.column_name, type: r.data_type });
  });
  console.log(JSON.stringify(tables, null, 2));
  pool.end();
}).catch(err => {
  console.error(err);
  pool.end();
});
