const pg = require('pg');
const pool = new pg.Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5432/yizi' });
pool.query('SELECT * FROM yizi_orders ORDER BY "refunded" ASC NULLS FIRST, "has_comments" DESC NULLS LAST LIMIT 1')
  .then(res => { console.log('SQL SUCCESS'); pool.end(); })
  .catch(e => { console.log('SQL ERROR', e.message); pool.end(); });
