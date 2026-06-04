import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import Core from '@alicloud/pop-core';
import OSS from 'ali-oss';

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

// Cache for table columns to avoid repetitive schema queries
const tableColumnsCache = {};

// Helper to get all valid column names of a table dynamically
async function getTableColumns(tableName) {
  if (tableColumnsCache[tableName]) return tableColumnsCache[tableName];
  try {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [tableName]
    );
    const cols = res.rows.map(r => r.column_name);
    tableColumnsCache[tableName] = cols;
    return cols;
  } catch (e) {
    return [];
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

// Helper to unpack JSONB data back to top-level for frontend backward compatibility
function unpackRow(row) {
  if (!row) return row;
  let parsedData = {};
  if (row.data) {
    if (typeof row.data === 'string') {
      try { parsedData = JSON.parse(row.data); } catch(e) {}
    } else if (typeof row.data === 'object') {
      parsedData = row.data;
    }
  }
  return { ...parsedData, ...row };
}

// Helper to format values for PG query (serialize objects/arrays to JSON string to prevent syntax error)
function prepareQueryValue(val) {
  if (val !== null && typeof val === 'object' && !Buffer.isBuffer(val) && !(val instanceof Date)) {
    return JSON.stringify(val);
  }
  return val;
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

// ==========================================
// CLIENT-SIDE /WX/... API CHANNELS
// ==========================================

// Helper to format order row to support legacy client count and format fields
function formatOrderRow(row) {
  let parsedData = {};
  try {
    parsedData = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  } catch (e) {}

  let groupCount = 0;
  let deliveryCount = 0;
  let confirmGroupCount = 0;

  if (Array.isArray(parsedData.sets)) {
    groupCount = parsedData.sets.length;
    parsedData.sets.forEach(s => {
      if (Array.isArray(s.delivery_imgs) && s.delivery_imgs.length > 0) {
        deliveryCount++;
        if (s.delivery_imgs.some(d => d.confirmed_at)) {
          confirmGroupCount++;
        }
      }
    });
  }

  return {
    ...row,
    datetime: row.datetime ? new Date(row.datetime).getTime().toString() : null,
    data: parsedData,
    group_count: groupCount,
    delivery_count: deliveryCount.toString(),
    confirm_group_count: confirmGroupCount
  };
}

// 1. User login (No token needed, phone & password, auto-register on first login)
app.post('/client/login', async (req, res) => {
  const { phone, password } = req.body;
  if (typeof phone !== 'string' || typeof password !== 'string' || !phone || !password) {
    return res.json({ msg: 'err', info: '手机号和密码格式错误' });
  }

  // Prevent absurdly long inputs
  if (phone.length > 20 || password.length > 100) {
    return res.json({ msg: 'err', info: '输入过长' });
  }

  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  try {
    const userQuery = await pool.query('SELECT * FROM "yizi_users" WHERE "phone_number" = $1', [phone]);
    if (userQuery.rows.length > 0) {
      const user = userQuery.rows[0];
      if (user.password === hashedPassword) {
        const token = jwt.sign({ unionid: user.user_id, phone }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '30d' });
        return res.json({ msg: 'ok', result: { token, unionid: user.user_id, phone } });
      } else {
        return res.json({ msg: 'err', info: '密码错误' });
      }
    } else {
      // Auto-register new user
      const newUserId = 'usr_' + crypto.randomBytes(8).toString('hex');
      const defaultPoints = '1000'; // Default test points
      await pool.query(
        'INSERT INTO "yizi_users" ("_id", "user_id", "phone_number", "points", "password") VALUES ($1, $2, $3, $4, $5)',
        [newUserId, phone, phone, defaultPoints, hashedPassword]
      );
      const token = jwt.sign({ unionid: phone, phone }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '30d' });
      return res.json({ msg: 'ok', result: { token, unionid: phone, phone } });
    }
  } catch (error) {
    console.error('[User Login Error]', error);
    res.json({ msg: 'err', info: '登录或自动注册失败' });
  }
});

// 2. Get user points (GET /client/user/points)
app.get('/client/user/points', authenticateToken, async (req, res) => {
  const unionid = req.user.unionid;
  try {
    const result = await pool.query('SELECT points FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $2', [unionid, unionid]);
    if (result.rows.length > 0) {
      const points = parseFloat(result.rows[0].points) || 0;
      return res.json({ msg: 'ok', result: { points } });
    }
    res.json({ msg: 'err', info: '用户不存在' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 3. Get phone number
app.post('/client/get_phone_number', authenticateToken, async (req, res) => {
  const unionid = req.user.unionid;
  try {
    const result = await pool.query('SELECT phone_number FROM "yizi_users" WHERE "user_id" = $1', [unionid]);
    if (result.rows.length > 0) {
      return res.json({ msg: 'ok', result: { phone: result.rows[0].phone_number } });
    }
    res.json({ msg: 'ok', result: { phone: '' } });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 4. Update phone number
app.post('/client/user/phone_number/set', authenticateToken, async (req, res) => {
  const unionid = req.user.unionid;
  const { phone_number } = req.body;
  if (!phone_number) return res.json({ msg: 'err', info: 'Phone number is required' });
  try {
    await pool.query('UPDATE "yizi_users" SET "phone_number" = $1 WHERE "user_id" = $2', [phone_number, unionid]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 5. Create order and deduct points
app.post('/client/order/create', authenticateToken, async (req, res) => {
  const unionid = req.user.unionid;
  const { data, phone } = req.body;

  if (!data || typeof data !== 'object' || !data.planId || !data.model_uuid || !data.sets) {
    return res.json({ msg: 'err', info: '订单参数不完整或格式错误' });
  }

  try {
    // 1) Calculate total cost from sets with strict type and logic validation
    let totalCost = 0;
    if (Array.isArray(data.sets)) {
      for (const s of data.sets) {
        const price = parseFloat(s.selectedPrice);
        if (isNaN(price) || price < 0) {
          return res.json({ msg: 'err', info: '非法订单：包含异常金额' });
        }
        totalCost += price;
      }
    }

    // WARNING: In a final commercial state, the price should be calculated independently
    // by the backend querying the yizi_sku table based on planId and parameters,
    // rather than trusting the frontend's selectedPrice.

    // 2) Check user points
    const userRes = await pool.query('SELECT points FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $2', [unionid, unionid]);
    if (userRes.rows.length === 0) {
      return res.json({ msg: 'err', info: '用户不存在' });
    }
    const currentPoints = parseFloat(userRes.rows[0].points) || 0;
    if (currentPoints < totalCost) {
      return res.json({ msg: 'err', info: '扣子余额不足请充值后重试' });
    }

    // 3) Create order
    const orderId = 'ord_' + crypto.randomBytes(8).toString('hex');
    const datetime = new Date();
    await pool.query(
      `INSERT INTO "yizi_orders" (id, phone, datetime, data, delivery_count, completed, has_comments, wait_delivery, openid) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orderId, phone || req.user.phone || '', datetime, JSON.stringify(data), '0', '0', '0', '1', unionid]
    );

    // 4) Deduct points
    const nextPoints = currentPoints - totalCost;
    await pool.query('UPDATE "yizi_users" SET points = $1 WHERE "user_id" = $2 OR "phone_number" = $3', [nextPoints.toString(), unionid, unionid]);

    res.json({ msg: 'ok', result: { id: orderId } });
  } catch (error) {
    console.error('[Order Create Error]', error);
    res.json({ msg: 'err', info: error.message });
  }
});

// 6. List user orders (formatting datetime and data fields)
app.post('/client/order/list', authenticateToken, async (req, res) => {
  const unionid = req.user.unionid;
  try {
    const result = await pool.query(
      'SELECT * FROM "yizi_orders" WHERE openid = $1 OR phone = $2 ORDER BY datetime DESC',
      [unionid, req.user.phone || '']
    );
    const list = result.rows.map(row => formatOrderRow(row));
    res.json({ msg: 'ok', result: list });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 7. Get order detail
app.post('/client/order/get', authenticateToken, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ msg: 'err', info: 'Order ID is required' });
  try {
    const result = await pool.query('SELECT * FROM "yizi_orders" WHERE id = $1', [id]);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return res.json({
        msg: 'ok',
        result: formatOrderRow(row)
      });
    }
    res.json({ msg: 'err', info: 'Order not found' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 7.5 ComfyUI Dedicated API: Get order detail formatted for FetchOrderDataByOrderID node
app.post('/comfyui/order/get', authenticateToken, async (req, res) => {
  const { order_id, index } = req.body;
  if (!order_id) return res.json({ msg: 'err', info: 'Order ID (order_id) is required' });
  
  try {
    const result = await pool.query('SELECT * FROM "yizi_orders" WHERE id = $1', [order_id]);
    if (result.rows.length === 0) {
      return res.json({ msg: 'err', info: '订单不存在' });
    }
    
    const row = result.rows[0];
    let orderData = {};
    try {
      orderData = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
    } catch(e) {}
    
    // Extract set based on requested index (default to 0)
    const setIndex = parseInt(index) || 0;
    const sets = orderData.sets || [];
    const setInfo = sets[setIndex] || {};
    
    return res.json({
      msg: 'ok',
      result: {
        images: setInfo.images || [],                                // ComfyUI expects array of URLs
        pose: setInfo.pose_url || setInfo.pose || "",               // ComfyUI expects single string URL
        prompt: setInfo.prompt || orderData.prompt || "",           // Fallback to global prompt if set doesn't have it
        size: setInfo.size || orderData.size || 1024
      }
    });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 8. Submit feedback comment
app.post('/client/order/comment', authenticateToken, async (req, res) => {
  const { id, index, delivery_index, comment } = req.body;
  if (!id || index === undefined || delivery_index === undefined || !comment) {
    return res.json({ msg: 'err', info: '参数错误' });
  }
  try {
    // Write comment to separate yizi_comments table
    // 1) Fetch order to get the delivery image UUID
    const orderRes = await pool.query('SELECT data FROM "yizi_orders" WHERE id = $1', [id]);
    if (orderRes.rows.length === 0) return res.json({ msg: 'err', info: '订单未找到' });
    
    let orderData = {};
    try {
      orderData = typeof orderRes.rows[0].data === 'string' ? JSON.parse(orderRes.rows[0].data) : (orderRes.rows[0].data || {});
    } catch(e) {}
    
    const deliveryImg = orderData.sets?.[index]?.delivery_imgs?.[delivery_index];
    const deliveryUuid = deliveryImg?.id || `img_${index}_${delivery_index}`;
    
    // 2) Write comment
    const commentId = 'cmt_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO "yizi_comments" (id, delivery_uuid, type, comment, content) VALUES ($1, $2, $3, $4, $5)`,
      [commentId, deliveryUuid, 'user', comment, comment]
    );

    // 3) Mark order as having comments
    await pool.query('UPDATE "yizi_orders" SET has_comments = \'1\' WHERE id = $1', [id]);

    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 9. Confirm delivery image
app.post('/client/order/confirm', authenticateToken, async (req, res) => {
  const { id, delivery_id } = req.body;
  if (!id || !delivery_id) return res.json({ msg: 'err', info: '参数错误' });
  try {
    // 1) Read current order data
    const orderRes = await pool.query('SELECT data FROM "yizi_orders" WHERE id = $1', [id]);
    if (orderRes.rows.length === 0) return res.json({ msg: 'err', info: '订单不存在' });
    
    let orderData = {};
    try {
      orderData = typeof orderRes.rows[0].data === 'string' ? JSON.parse(orderRes.rows[0].data) : (orderRes.rows[0].data || {});
    } catch(e) {}
    
    // 2) Update confirmed_at timestamp inside sets.delivery_imgs
    let confirmedCount = 0;
    let totalSets = orderData.sets?.length || 0;
    
    if (Array.isArray(orderData.sets)) {
      orderData.sets.forEach(s => {
        if (Array.isArray(s.delivery_imgs)) {
          s.delivery_imgs.forEach(d => {
            if (d.id === delivery_id) {
              d.confirmed_at = new Date().toISOString();
            }
            if (d.confirmed_at) {
              confirmedCount++;
            }
          });
        }
      });
    }

    // 3) Save updated data and check if completed
    const completed = (confirmedCount >= totalSets) ? '1' : '0';
    await pool.query(
      'UPDATE "yizi_orders" SET data = $1, completed = $2 WHERE id = $3',
      [JSON.stringify(orderData), completed, id]
    );

    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 2. RPC Main Channel
// Action path example: /admin/orders/list, /admin/sku/add
app.post(['/rpc/:module/:db_name/:action(*)', '/admin/:db_name/:action(*)', '/client/:db_name/:action(*)'], authenticateToken, async (req, res) => {
  const module = req.params.module || 'admin';
  const db_name = getActualTableName(req.params.db_name);
  const action = req.params.action;
  const params = req.body;

  try {
    // ----------------------------------------------------
    // Custom Handlers for Special Table / Action overrides
    // ----------------------------------------------------
    
    // A. Custom handlers for yizi_oss_delivery_imgs (list and del)
    if (db_name === 'yizi_oss_delivery_imgs') {
      const ossConfig = {
        region: process.env.OSS_REGION,
        accessKeyId: process.env.OSS_ACCESS_KEY_ID,
        accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
        bucket: process.env.OSS_BUCKET,
        secure: true
      };
      const client = new OSS(ossConfig);

      if (action === 'list') {
        const { openid, order_id } = params;
        if (!openid || !order_id) {
          return res.json({ msg: 'err', info: 'Missing openid or order_id' });
        }
        const prefix = `delivery_imgs/${openid}/${order_id}/`;
        const response = await client.listV2({
          prefix: prefix,
          'max-keys': 1000
        });
        const list = (response.objects || []).map(obj => {
          return `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${obj.name}`;
        });
        return res.json({
          msg: 'ok',
          result: {
            list: list,
            total: list.length,
            page: 1,
            page_size: 1000
          }
        });
      }

      if (action === 'del') {
        const paths = params.paths || [];
        if (paths.length === 0) {
          return res.json({ msg: 'ok' });
        }
        const names = paths.map(p => p.startsWith('/') ? p.slice(1) : p);
        await client.deleteMulti(names);
        return res.json({ msg: 'ok' });
      }
    }

    // B. Custom handlers for yizi_vip_settings (add, reset, del)
    if (db_name === 'yizi_vip_settings') {
      if (action === 'add') {
        const mobi = params.mobi;
        const type = params.type || 'my_models';
        const data = params.data || {};
        const model_ids = data.model_ids || [];
        
        if (!mobi) {
          return res.json({ msg: 'err', info: 'Missing mobi (phone number)' });
        }

        const query = `INSERT INTO "yizi_vip_settings" (mobi, type, model_ids, data) VALUES ($1, $2, $3, $4) RETURNING *`;
        const result = await pool.query(query, [mobi, type, JSON.stringify(model_ids), JSON.stringify(data)]);
        return res.json({ msg: 'ok', result: result.rows[0] });
      }

      if (action === 'reset') {
        const mobi = params.mobi;
        const data = params.data || {};
        const model_ids = data.model_ids || [];
        
        if (!mobi) {
          return res.json({ msg: 'err', info: 'Missing mobi (phone number)' });
        }

        const query = `UPDATE "yizi_vip_settings" SET model_ids = $1, data = $2 WHERE mobi = $3 RETURNING *`;
        const result = await pool.query(query, [JSON.stringify(model_ids), JSON.stringify(data), mobi]);
        return res.json({ msg: 'ok', result: result.rows[0] });
      }

      if (action === 'del') {
        const mobi = params.mobi;
        if (!mobi) {
          return res.json({ msg: 'err', info: 'Missing mobi (phone number)' });
        }
        const query = `DELETE FROM "yizi_vip_settings" WHERE mobi = $1`;
        await pool.query(query, [mobi]);
        return res.json({ msg: 'ok' });
      }
    }

    // C. Custom handler for yizi_model (assets/list)
    if (db_name === 'yizi_model' && action === 'assets/list') {
      const uuid = params.uuid;
      const type = params.type; // poses, half_body_poses, specific_poses, gallery
      
      if (!uuid) {
        return res.json({ msg: 'err', info: 'Missing model uuid' });
      }
      
      const result = await pool.query('SELECT * FROM "yizi_model" WHERE "uuid" = $1', [uuid]);
      if (result.rows.length === 0) {
        return res.json({ msg: 'err', info: 'Model not found' });
      }
      
      const model = result.rows[0];
      let colName = 'poses';
      if (type === 'poses') colName = 'poses';
      else if (type === 'half_body_poses') colName = 'half_poses';
      else if (type === 'specific_poses') colName = 'spacial_poses';
      else if (type === 'gallery') colName = 'imgs';
      
      const rawVal = model[colName];
      let list = [];
      if (rawVal) {
        if (typeof rawVal === 'string') {
          const trimmed = rawVal.trim();
          if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
              list = JSON.parse(trimmed);
            } catch (e) {
              list = trimmed.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
            }
          } else {
            list = trimmed.split(',').map(s => s.trim()).filter(Boolean);
          }
        } else if (Array.isArray(rawVal)) {
          list = rawVal;
        }
      }
      
      return res.json({
        msg: 'ok',
        result: {
          list: list,
          total: list.length,
          page: 1,
          page_size: list.length
        }
      });
    }

    // D. Custom handler for yizi_users (points/ticket)
    if (db_name === 'yizi_users' && action === 'points/ticket') {
      const data = params.data || {};
      const openid = data.openid;
      const amount = parseFloat(data.amount) || 0;
      
      if (!openid) {
        return res.json({ msg: 'err', info: 'Missing openid' });
      }
      
      const userRes = await pool.query('SELECT * FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $2 OR "_id" = $3', [openid, openid, openid]);
      if (userRes.rows.length === 0) {
        return res.json({ msg: 'err', info: 'User not found' });
      }
      
      const user = userRes.rows[0];
      const currentPoints = parseFloat(user.points) || 0;
      const nextPoints = currentPoints + amount;
      
      await pool.query('UPDATE "yizi_users" SET points = $1 WHERE "_id" = $2', [nextPoints.toString(), user._id]);
      
      return res.json({
        msg: 'ok',
        result: {
          openid: openid,
          points: nextPoints
        }
      });
    }
    // 1) List Query Action (with proper pagination total count and simple search filters)
    if (action === 'list' || action === 'list/next_token_mode') {
      // Support for batch querying comments or orders by ids
      if (Array.isArray(params.ids) && params.ids.length > 0) {
        const pk = await getPrimaryKeyColumn(db_name);
        const targetCol = db_name === 'yizi_comments' ? 'delivery_uuid' : pk;
        const placeholders = params.ids.map((_, i) => `$${i + 1}`).join(', ');
        const listQuery = `SELECT * FROM "${db_name}" WHERE "${targetCol}" IN (${placeholders})`;
        const result = await pool.query(listQuery, params.ids);
        return res.json({
          msg: 'ok',
          result: {
            list: result.rows.map(unpackRow),
            total: result.rows.length,
            page: 1,
            page_size: result.rows.length
          }
        });
      }

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
          list: result.rows.map(unpackRow),
          total: total,
          page,
          page_size: pageSize
        }
      });
    }

    // 2) Get Single Record Action
    if (action === 'get') {
        const pk = await getPrimaryKeyColumn(db_name);
        let id = params[pk] || params.id || params.uuid || params._id;
        if (db_name === 'yizi_front_sku_settings' && !id) {
          id = '1';
        }
        const result = await pool.query(`SELECT * FROM "${db_name}" WHERE "${pk}" = $1`, [id]);
        return res.json({
            msg: 'ok',
            result: unpackRow(result.rows[0]) || null
        });
    }

    // 3) Add Record Action
    if (action === 'add') {
        const allowedCols = await getTableColumns(db_name);
        if (allowedCols.length === 0) return res.json({ msg: 'err', info: `Table ${db_name} does not exist in the database` });

        const rawData = params.data || {};
        
        // Auto-generate primary key if missing
        const pk = await getPrimaryKeyColumn(db_name);
        if (!rawData[pk] && allowedCols.includes(pk)) {
          // Generate a short ID prefixed with the table name (e.g., sku_a1b2c3d4)
          const prefix = db_name.replace('yizi_', '').substring(0, 3);
          rawData[pk] = prefix + '_' + crypto.randomBytes(8).toString('hex');
        }

        const finalData = {};
        let extraData = {};

        // Intelligent distribution
        for (const [key, val] of Object.entries(rawData)) {
          if (allowedCols.includes(key)) {
            finalData[key] = val;
          } else {
            extraData[key] = val;
          }
        }

        // Pack unknown fields into 'data' column if it exists
        if (allowedCols.includes('data') && Object.keys(extraData).length > 0) {
          let existingData = finalData['data'];
          if (typeof existingData === 'string') {
            try { existingData = JSON.parse(existingData); } catch(e) { existingData = {}; }
          } else if (typeof existingData !== 'object' || existingData === null) {
            existingData = {};
          }
          finalData['data'] = JSON.stringify({ ...existingData, ...extraData });
        } else if (Object.keys(extraData).length > 0) {
          console.warn(`[Bulletproof API] Dropped unknown fields for table ${db_name}: ${Object.keys(extraData).join(', ')}`);
        }

        const fields = Object.keys(finalData);
        const values = Object.values(finalData).map(prepareQueryValue);
        
        if (fields.length === 0) return res.json({ msg: 'err', info: 'No valid data provided for insertion' });
        
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
        const query = `INSERT INTO "${db_name}" (${fields.map(f => `"${f}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`;
        const result = await pool.query(query, values);
        
        return res.json({ msg: 'ok', result: unpackRow(result.rows[0]) });
    }

    // 4) Reset (Edit/Update) Record Action
    if (action === 'reset') {
        const pk = await getPrimaryKeyColumn(db_name);
        const id = params[pk] || params.id || params.uuid || params._id;
        
        const allowedCols = await getTableColumns(db_name);
        if (allowedCols.length === 0) return res.json({ msg: 'err', info: `Table ${db_name} does not exist in the database` });

        const rawData = params.data || {};
        const finalData = {};
        let extraData = {};

        // Intelligent distribution
        for (const [key, val] of Object.entries(rawData)) {
          if (allowedCols.includes(key)) {
            finalData[key] = val;
          } else {
            extraData[key] = val;
          }
        }

        // Pack unknown fields into 'data' column if it exists
        // Note: For 'reset' (update), we might need to merge with existing DB data JSON, but for simplicity
        // in this CMS, the frontend usually sends the entire JSON payload anyway. We will merge at the payload level.
        if (allowedCols.includes('data') && Object.keys(extraData).length > 0) {
          let existingData = finalData['data'];
          if (typeof existingData === 'string') {
            try { existingData = JSON.parse(existingData); } catch(e) { existingData = {}; }
          } else if (typeof existingData !== 'object' || existingData === null) {
            existingData = {};
          }
          finalData['data'] = JSON.stringify({ ...existingData, ...extraData });
        } else if (Object.keys(extraData).length > 0) {
          console.warn(`[Bulletproof API] Dropped unknown update fields for table ${db_name}: ${Object.keys(extraData).join(', ')}`);
        }

        const fields = Object.keys(finalData);
        const values = Object.values(finalData).map(prepareQueryValue);

        if (fields.length === 0) return res.json({ msg: 'err', info: 'No valid data to update' });

        const setClauses = fields.map((f, i) => `"${f}" = $${i + 1}`).join(', ');
        const query = `UPDATE "${db_name}" SET ${setClauses} WHERE "${pk}" = $${fields.length + 1} RETURNING *`;
        const result = await pool.query(query, [...values, id]);

        return res.json({ msg: 'ok', result: unpackRow(result.rows[0]) });
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
