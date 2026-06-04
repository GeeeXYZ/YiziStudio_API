import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import Core from '@alicloud/pop-core';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Health check / status route
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Yizi Studio API Middleware',
    time: new Date().toISOString()
  });
});

// Database connection
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/yizi',
});

// Middleware for auth
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ msg: 'err', info: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) return res.status(403).json({ msg: 'err', info: 'Invalid token' });
    req.user = user;
    next();
  });
};

// 1. HTTP POST: /admin/login
app.post('/admin/login', async (req, res) => {
  const { account, password } = req.body;
  
  if (!account || !password) {
    return res.json({ msg: 'err', info: '账号和密码不能为空' });
  }

  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  try {
    const result = await pool.query('SELECT * FROM "yizi_admins" WHERE "account" = $1', [account]);
    if (result.rows.length > 0) {
      const adminUser = result.rows[0];
      if (adminUser.password === hashedPassword) {
        const token = jwt.sign({ account, is_super: adminUser.is_super }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d' });
        return res.json({ msg: 'ok', result: { token, account } });
      }
    }
    res.json({ msg: 'err', info: '用户名或密码错误' });
  } catch (error) {
    console.error('[Login Error]', error);
    res.json({ msg: 'err', info: '数据库连接或查询失败，请检查是否已在 Supabase 运行 SQL 创建 yizi_admins 表' });
  }
});

app.post('/admin/logout', (req, res) => {
  res.json({ msg: 'ok' });
});

app.post('/admin/check', authenticateToken, (req, res) => {
  res.json({ msg: 'ok', result: { valid: true } });
});

app.post('/admin/reset_psw', authenticateToken, async (req, res) => {
  const { oldpwd, newpwd } = req.body;
  const account = req.user.account;
  const oldHashed = crypto.createHash('sha256').update(oldpwd).digest('hex');
  const newHashed = crypto.createHash('sha256').update(newpwd).digest('hex');
  try {
    const result = await pool.query('SELECT password FROM "yizi_admins" WHERE account = $1', [account]);
    if (result.rows.length === 0 || result.rows[0].password !== oldHashed) {
      return res.json({ msg: 'err', info: '旧密码错误' });
    }
    await pool.query('UPDATE "yizi_admins" SET password = $1 WHERE account = $2', [newHashed, account]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// Admin management APIs
app.post('/admin_list', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, account, email, is_super, created_at FROM "yizi_admins" ORDER BY id ASC');
    res.json({ msg: 'ok', result: result.rows });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

app.post('/admin_add', authenticateToken, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ msg: 'err', info: 'Email is required' });
  const account = email.split('@')[0];
  const tempPassword = '123456'; 
  const hashedPassword = crypto.createHash('sha256').update(tempPassword).digest('hex');
  try {
    await pool.query(
      'INSERT INTO "yizi_admins" (account, password, email, is_super) VALUES ($1, $2, $3, $4)',
      [account, hashedPassword, email, false]
    );
    res.json({ msg: 'ok', info: `已成功创建管理员：${account}，默认密码为：123456` });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

app.post('/admin_delete', authenticateToken, async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('DELETE FROM "yizi_admins" WHERE email = $1', [email]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

app.post('/admin_reset_secret', authenticateToken, async (req, res) => {
  const { email } = req.body;
  const newTempPassword = '123456';
  const hashedPassword = crypto.createHash('sha256').update(newTempPassword).digest('hex');
  try {
    await pool.query('UPDATE "yizi_admins" SET password = $1 WHERE email = $2', [hashedPassword, email]);
    res.json({ msg: 'ok', info: '密码已重置为：123456' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

app.post('/admin_toggle_super', authenticateToken, async (req, res) => {
  const { email, is_super } = req.body;
  try {
    await pool.query('UPDATE "yizi_admins" SET is_super = $1 WHERE email = $2', [is_super, email]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// Helper to get primary key column of a table in PostgreSQL
async function getPrimaryKeyColumn(tableName) {
  try {
    const res = await pool.query(`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
    `, [tableName]);
    return res.rows[0] ? res.rows[0].attname : 'id';
  } catch (e) {
    return 'id'; // default fallback
  }
}

// Helper to map route db_name to actual database table name
function getActualTableName(db_name) {
  if (!db_name) return db_name;
  if (db_name.startsWith('yizi_')) {
    return db_name;
  }
  
  const mapping = {
    'orders': 'yizi_orders',
    'workflow_logs': 'yizi_workflow_logs',
    'workflow': 'yizi_workflow',
    'sku': 'yizi_sku',
    'user': 'yizi_users',      // user -> yizi_users
    'case': 'yizi_cases',      // case -> yizi_cases
    'model': 'yizi_model',
    'prompt': 'yizi_prompt',
    'vip_settings': 'yizi_vip_settings',
    'comments': 'yizi_comments',
    'front_sku_settings': 'yizi_front_sku_settings',
    'oss_delivery_imgs': 'yizi_oss_delivery_imgs'
  };
  
  return mapping[db_name] || `yizi_${db_name}`;
}

// Helper to get Aliyun OSS STS Token or fallback to primary credentials
async function getOSSToken(openid = null, order_id = null) {
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  const roleArn = process.env.OSS_ROLE_ARN;
  const bucket = process.env.OSS_BUCKET;
  const region = process.env.OSS_REGION; // e.g. oss-cn-hangzhou

  if (!accessKeyId || !accessKeySecret || !bucket || !region) {
    throw new Error('后端未配置 OSS 环境变量 (OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_REGION)');
  }

  if (roleArn) {
    const client = new Core({
      accessKeyId,
      accessKeySecret,
      endpoint: 'https://sts.aliyuncs.com',
      apiVersion: '2015-04-01'
    });

    const params = {
      "RegionId": region.replace('oss-', ''), // e.g. cn-hangzhou
      "RoleArn": roleArn,
      "RoleSessionName": "yizi_studio_session",
      "DurationSeconds": 3600
    };

    if (openid && order_id) {
      const policy = {
        Version: '1',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['oss:PutObject', 'oss:GetObject'],
            Resource: [`acs:oss:*:*:${bucket}/delivery_imgs/${openid}/${order_id}/*`]
          }
        ]
      };
      params.Policy = JSON.stringify(policy);
    }

    const response = await client.request('AssumeRole', params, { method: 'POST' });
    if (response && response.Credentials) {
      return {
        region,
        bucket,
        accessKeyId: response.Credentials.AccessKeyId,
        accessKeySecret: response.Credentials.AccessKeySecret,
        stsToken: response.Credentials.SecurityToken
      };
    }
    throw new Error('获取阿里云 STS 凭证失败');
  }

  // Fallback to primary credentials if roleArn is not configured
  return {
    region,
    bucket,
    accessKeyId,
    accessKeySecret
  };
}

// STS Upload Route for general tmps upload
app.post('/admin/sts', authenticateToken, async (req, res) => {
  try {
    const token = await getOSSToken();
    res.json({ msg: 'ok', result: token });
  } catch (error) {
    console.error('[STS General Error]', error);
    res.json({ msg: 'err', info: error.message });
  }
});

// STS Upload Route for order delivery images upload
app.post('/admin/oss_delivery_imgs/upload/sts', authenticateToken, async (req, res) => {
  const { openid, order_id } = req.body;
  try {
    const token = await getOSSToken(openid, order_id);
    res.json({ msg: 'ok', result: token });
  } catch (error) {
    console.error('[STS Order Error]', error);
    res.json({ msg: 'err', info: error.message });
  }
});

// 2. RPC Main Channel
// Action path example: /admin/orders/list, /admin/sku/add
app.post(['/rpc/:module/:db_name/:action(*)', '/admin/:db_name/:action(*)'], authenticateToken, async (req, res) => {
  const module = req.params.module || 'admin';
  const db_name = getActualTableName(req.params.db_name);
  const action = req.params.action;
  const params = req.body;

  try {
    // 1) List Query Action (with proper pagination total count and simple search filters)
    if (action === 'list' || action === 'list/next_token_mode') {
      const page = params.page || params._page || 1;
      const pageSize = params.page_size || params._page_size || 10;
      
      const conditions = params.conditions || params._conditions || {};
      const whereClauses = [];
      const values = [];
      let placeholderIdx = 1;

      Object.keys(conditions).forEach(key => {
        const val = conditions[key];
        if (val !== undefined && val !== null && val !== '' && val !== '__all__') {
          if (typeof val === 'string') {
            whereClauses.push(`"${key}" ILIKE $${placeholderIdx}`);
            values.push(`%${val}%`);
          } else {
            whereClauses.push(`"${key}" = $${placeholderIdx}`);
            values.push(val);
          }
          placeholderIdx++;
        }
      });

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      
      // Get total count
      const countQuery = `SELECT COUNT(*) FROM "${db_name}" ${whereSql}`;
      const countResult = await pool.query(countQuery, values);
      const total = parseInt(countResult.rows[0].count, 10);

      // Get page rows (order by primary key if exists to ensure consistent order)
      const pk = await getPrimaryKeyColumn(db_name);
      const limitIdx = placeholderIdx;
      const offsetIdx = placeholderIdx + 1;
      const listQuery = `SELECT * FROM "${db_name}" ${whereSql} ORDER BY "${pk}" DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
      const result = await pool.query(listQuery, [...values, pageSize, (page - 1) * pageSize]);
      
      return res.json({
        msg: 'ok',
        result: {
          list: result.rows,
          total: total,
          page,
          page_size: pageSize
        }
      });
    }

    // 2) Get Single Record Action
    if (action === 'get') {
        const pk = await getPrimaryKeyColumn(db_name);
        const id = params[pk] || params.id || params.uuid || params._id;
        const result = await pool.query(`SELECT * FROM "${db_name}" WHERE "${pk}" = $1`, [id]);
        return res.json({
            msg: 'ok',
            result: result.rows[0] || null
        });
    }

    // 3) Add Record Action
    if (action === 'add') {
        const fields = Object.keys(params.data || {});
        const values = Object.values(params.data || {});
        
        if (fields.length === 0) return res.json({ msg: 'err', info: 'No data provided' });
        
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
        const query = `INSERT INTO "${db_name}" (${fields.map(f => `"${f}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`;
        const result = await pool.query(query, values);
        
        return res.json({ msg: 'ok', result: result.rows[0] });
    }

    // 4) Reset (Edit/Update) Record Action
    if (action === 'reset') {
        const pk = await getPrimaryKeyColumn(db_name);
        const id = params[pk] || params.id || params.uuid || params._id;
        const data = params.data || {};

        const fields = Object.keys(data);
        const values = Object.values(data);

        if (fields.length === 0) return res.json({ msg: 'err', info: 'No data to update' });

        const setClauses = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ');
        const query = `UPDATE "${db_name}" SET ${setClauses} WHERE "${pk}" = $${fields.length + 1} RETURNING *`;
        const result = await pool.query(query, [...values, id]);

        return res.json({ msg: 'ok', result: result.rows[0] });
    }

    // 5) Delete Record(s) Action
    if (action === 'del') {
        const pk = await getPrimaryKeyColumn(db_name);
        const ids = params.ids || [];

        if (!Array.isArray(ids) || ids.length === 0) {
          const singleId = params.id || params.uuid || params._id;
          if (singleId) {
            await pool.query(`DELETE FROM "${db_name}" WHERE "${pk}" = $1`, [singleId]);
            return res.json({ msg: 'ok' });
          }
          return res.json({ msg: 'err', info: 'No IDs provided for deletion' });
        }

        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
        const query = `DELETE FROM "${db_name}" WHERE "${pk}" IN (${placeholders})`;
        await pool.query(query, ids);

        return res.json({ msg: 'ok' });
    }

    // 6) Custom Trigger Handler
    if (action === 'trigger') {
        return res.json({ msg: 'ok', info: 'Workflow triggered (mocked)' });
    }

    // Default fallback
    res.json({ msg: 'err', info: `Not implemented action: ${action}` });
  } catch (error) {
    console.error(`[RPC Error] ${module}/${db_name}/${action}`, error);
    res.json({ msg: 'err', info: error.message });
  }
});



const PORT = process.env.PORT || 9000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Yizi Backend API is running on http://localhost:${PORT}`);
  });
}

export default app;
