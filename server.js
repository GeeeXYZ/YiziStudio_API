import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import Core from '@alicloud/pop-core';
import OSS from 'ali-oss';
import { EventEmitter } from 'events';
import { runPipeline } from './pipeline_executor.js';

export const orderEventEmitter = new EventEmitter();
orderEventEmitter.setMaxListeners(100);

dotenv.config();

const app = express();
app.use(cors({
  origin: [/localhost/, /zeabur\.app$/, /yizistudio/],
  credentials: true
}));
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

pool.query(`
  CREATE TABLE IF NOT EXISTS yizi_settings (
      key VARCHAR PRIMARY KEY,
      value TEXT,
      is_secret BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`).then(() => console.log('yizi_settings verified')).catch(e => console.error('DB Init Error:', e.message));

// Middleware for auth
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  // Support Bearer token OR token in query string (useful for SSE EventSource)
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  
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
        let permissions = [];
        let visible_projects = [];
        if (adminUser.role_id) {
          const roleRes = await pool.query('SELECT permissions, visible_projects FROM "yizi_roles" WHERE id = $1', [adminUser.role_id]);
          if (roleRes.rows.length > 0) {
            permissions = typeof roleRes.rows[0].permissions === 'string' ? JSON.parse(roleRes.rows[0].permissions || '[]') : (roleRes.rows[0].permissions || []);
            visible_projects = typeof roleRes.rows[0].visible_projects === 'string' ? JSON.parse(roleRes.rows[0].visible_projects || '[]') : (roleRes.rows[0].visible_projects || []);
          }
        }
        const token = jwt.sign({ account, is_super: adminUser.is_super, role_id: adminUser.role_id }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d' });
        return res.json({ msg: 'ok', result: { token, account, is_super: adminUser.is_super, role_id: adminUser.role_id, permissions, visible_projects } });
      }
    }
    res.json({ msg: 'err', info: '用户名或密码错误' });
  } catch (error) {
    console.error('[Login Error]', error);
    res.json({ msg: 'err', info: '数据库连接或查询失败，请检查是否已在 Supabase 运行 SQL 创建 yizi_admins 表' });
  }
});

const requireSuperAdmin = (req, res, next) => {
  if (!req.user || !req.user.is_super) {
    return res.status(403).json({ msg: 'err', info: 'Forbidden: 仅超级管理员可操作' });
  }
  next();
};

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
app.post('/admin_list', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, account, email, is_super, role_id, data, created_at FROM "yizi_admins" ORDER BY id ASC');
    res.json({ msg: 'ok', result: result.rows });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

app.post('/admin_add', authenticateToken, requireSuperAdmin, async (req, res) => {
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

app.post('/admin_delete', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('DELETE FROM "yizi_admins" WHERE email = $1', [email]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

app.post('/admin_reset_secret', authenticateToken, requireSuperAdmin, async (req, res) => {
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

app.post('/admin_toggle_super', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { email, is_super } = req.body;
  try {
    await pool.query('UPDATE "yizi_admins" SET is_super = $1 WHERE email = $2', [is_super, email]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

app.post('/admin_update_role', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { email, role_id } = req.body;
  try {
    await pool.query('UPDATE "yizi_admins" SET role_id = $1 WHERE email = $2', [role_id, email]);
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
  if (row.data) {
    if (typeof row.data === 'string') {
      try {
        const parsed = JSON.parse(row.data);
        Object.assign(row, parsed);
      } catch (e) {}
    } else if (typeof row.data === 'object') {
      Object.assign(row, row.data);
    }
    delete row.data;
  }
  return row;
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

  // Security Hardening: Direct connection is disabled.
  throw new Error('出于安全考虑，直连模式已被禁用。请在环境变量中配置 OSS_ROLE_ARN 以启用 STS 模式。');
}

// Helper to extract OSS object keys from string, object, or array
function extractOSSKeys(record) {
  let keys = [];
  if (!record) return keys;

  const bucketName = process.env.OSS_BUCKET;
  const region = process.env.OSS_REGION;
  if (!bucketName || !region) return keys;
  
  const ossDomain = `${bucketName}.${region}.aliyuncs.com/`;

  function searchKeys(obj) {
    if (typeof obj === 'string') {
      if (obj.includes(ossDomain)) {
        const parts = obj.split(ossDomain);
        if (parts.length > 1) {
          let key = parts[1].split('?')[0]; // remove query params if any
          if (key) keys.push(key);
        }
      }
    } else if (Array.isArray(obj)) {
      obj.forEach(searchKeys);
    } else if (typeof obj === 'object' && obj !== null) {
      Object.values(obj).forEach(searchKeys);
    }
  }

  // search top level fields
  searchKeys(record);
  
  // search parsed JSONB data if needed
  if (record.data) {
    let parsedData = null;
    if (typeof record.data === 'string') {
      try { parsedData = JSON.parse(record.data); } catch (e) {}
    } else if (typeof record.data === 'object') {
      parsedData = record.data;
    }
    if (parsedData) searchKeys(parsedData);
  }
  
  return [...new Set(keys)];
}

// Helper to delete OSS objects
async function deleteOSSObjects(keys) {
  if (!keys || keys.length === 0) return;
  try {
    // --- GC Protection (Gallery) ---
    const safeKeys = [];
    const protectedKeys = [];
    for (const key of keys) {
      const res = await pool.query('SELECT id FROM "yizi_gallery" WHERE oss_url LIKE $1 LIMIT 1', ['%' + key]);
      if (res.rows.length > 0) {
        protectedKeys.push(key);
      } else {
        safeKeys.push(key);
      }
    }
    
    if (protectedKeys.length > 0) {
      console.log(`[OSS GC] Protected keys (in gallery):`, protectedKeys);
    }
    
    if (safeKeys.length === 0) return;

    const ossConfig = {
      region: process.env.OSS_REGION,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      bucket: process.env.OSS_BUCKET,
      secure: true
    };
    if (!ossConfig.accessKeyId) return;
    const client = new OSS(ossConfig);
    
    // deleteMulti max is 1000, usually we have a few
    await client.deleteMulti(safeKeys);
    console.log(`[OSS GC] Deleted safe keys:`, safeKeys);
  } catch (error) {
    console.error('[OSS GC Error]', error);
  }
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

// Synchronous OSS delete from frontend
app.post('/admin/oss/delete', authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.json({ msg: 'err', info: 'URL is required' });
  
  try {
    const bucketName = process.env.OSS_BUCKET;
    const region = process.env.OSS_REGION;
    if (!bucketName || !region) return res.json({ msg: 'err', info: 'OSS not configured' });
    
    const ossDomain = `${bucketName}.${region}.aliyuncs.com/`;
    let keyToDelete = null;
    
    if (url.includes(ossDomain)) {
      const parts = url.split(ossDomain);
      if (parts.length > 1) {
        keyToDelete = parts[1].split('?')[0];
      }
    }
    
    if (keyToDelete) {
      await deleteOSSObjects([keyToDelete]);
      return res.json({ msg: 'ok' });
    }
    return res.json({ msg: 'err', info: 'Invalid OSS URL' });
  } catch (error) {
    console.error('[OSS Delete Error]', error);
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
    // 1) Fetch true template pricing from database
    const skuPk = await getPrimaryKeyColumn('yizi_sku');
    const skuRes = await pool.query(`SELECT data FROM "yizi_sku" WHERE "${skuPk}" = $1`, [data.planId]);
    if (skuRes.rows.length === 0) {
      return res.json({ msg: 'err', info: '商品模板不存在' });
    }
    
    let skuData = {};
    try {
      skuData = typeof skuRes.rows[0].data === 'string' ? JSON.parse(skuRes.rows[0].data) : (skuRes.rows[0].data || {});
    } catch (e) {}

    const realServerPrice = parseFloat(skuData.price) || 0;

    if (isNaN(realServerPrice) || realServerPrice < 0) {
      return res.json({ msg: 'err', info: '商品模板价格异常' });
    }

    // 2) Calculate total cost and override frontend inputs
    let totalCost = 0;
    if (Array.isArray(data.sets)) {
      for (const s of data.sets) {
        s.selectedPrice = realServerPrice; // Override with server truth
        totalCost += realServerPrice;
      }
    }
    
    // Explicitly cache the consumed points on the order for accurate future refunds
    data.total_cost = totalCost;

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

    // 5) Auto Trigger API Pipeline — start BEFORE responding
    //    runPipeline() creates setTimeout timers internally, keeping the event loop
    //    active so Vercel won't kill the function after res.json() is sent.
    const isAutoTrigger = skuData.auto_trigger === true || skuData.auto_trigger === 'true' || skuData.auto_trigger === 1 || skuData.auto_trigger === '1';
    console.log(`[Auto Trigger Check] Order ${orderId} | auto_trigger=${skuData.auto_trigger} (resolved: ${isAutoTrigger}) | workflow=${skuData.workflow} | workflow_type=${skuData.workflow_type}`);
    
    if (isAutoTrigger && skuData.workflow && skuData.workflow_type === 'api_pipeline') {
      try {
        const caseRes = await pool.query('SELECT data FROM "yizi_cases" WHERE uuid = $1', [skuData.workflow]);
        console.log(`[Auto Trigger] Found ${caseRes.rows.length} workflow(s) for uuid=${skuData.workflow}`);
        
        if (caseRes.rows.length > 0) {
          const workflowData = typeof caseRes.rows[0].data === 'string' ? JSON.parse(caseRes.rows[0].data) : (caseRes.rows[0].data || {});
          
          let resolvedPoseFolder = 'poses';
          if (skuData.body_type === '半身') resolvedPoseFolder = 'half_poses';
          if (skuData.body_type === '特殊') resolvedPoseFolder = 'special_poses';
          if (skuData.pose_folder) resolvedPoseFolder = skuData.pose_folder;

          const pipelineInput = workflowData.workflow_json || workflowData;

          if (Array.isArray(data.sets)) {
            data.sets.forEach((set, index) => {
              const orderContext = {
                isRealOrder: true,
                openid: unionid,
                order_id: orderId,
                set_index: index,
                sku_pose_folder: resolvedPoseFolder,
                model_uuid: data.model_uuid,
                images: set.images || [],
                prompt: set.extra_prompt || '',
                model_name: data.model_name || '',
                auto_delivery: skuData.auto_delivery === true || skuData.auto_delivery === 'true' || skuData.auto_delivery === 1 || skuData.auto_delivery === '1',
                eventEmitter: orderEventEmitter
              };
              
              console.log(`[Auto Trigger] Starting pipeline for Order ${orderId} Set ${index}`);
              // Fire-and-forget: starts immediately, creating event loop timers
              // that keep the Vercel function alive after res.json()
              runPipeline(pipelineInput, orderContext, pool).catch(err => {
                console.error(`[Auto Pipeline Error] Order ${orderId} Set ${index}:`, err.message);
              });
            });
          }
        } else {
          console.warn(`[Auto Trigger] No workflow found for uuid=${skuData.workflow}`);
        }
      } catch (triggerErr) {
        console.error('[Auto Trigger Error]', triggerErr.message);
      }
    }

    // 6) Respond to client AFTER pipelines are started
    res.json({ msg: 'ok', result: { id: orderId } });

  } catch (error) {
    console.error('[Order Create Error]', error);
    res.json({ msg: 'err', info: error.message });
  }
});

// SSE Notifications Endpoint
app.get('/client/order/events', authenticateToken, (req, res) => {
  const unionid = req.user.unionid;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Prevent Nginx buffering
  });

  // Send an initial connected event
  res.write(`data: ${JSON.stringify({ event: 'CONNECTED', unionid })}\n\n`);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ event: 'PING', time: Date.now() })}\n\n`);
  }, 15000);

  // Setup listener
  const listener = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const eventName = `orderUpdate:${unionid}`;
  orderEventEmitter.on(eventName, listener);

  req.on('close', () => {
    clearInterval(heartbeat);
    orderEventEmitter.off(eventName, listener);
  });
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

// 7.6 ComfyUI Dedicated API: STS token for ImagesUploader node
app.post('/comfyui/order/sts', authenticateToken, async (req, res) => {
  const { order_id } = req.body;
  try {
    // If order_id is provided (e.g. "openid.order_id"), scope the STS token
    let openid = null;
    let orderId = null;
    if (order_id && order_id.includes('.')) {
      const parts = order_id.split('.');
      openid = parts[0];
      orderId = parts.slice(1).join('.');
    }
    const token = await getOSSToken(openid, orderId);
    // Add targetFolder for the ImagesUploader node to know where to upload
    token.targetFolder = 'delivery_imgs';
    res.json({ msg: 'ok', result: token });
  } catch (error) {
    console.error('[ComfyUI STS Error]', error);
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

    orderEventEmitter.emit(`orderUpdate:${req.user.unionid}`, { orderId: id, event: 'COMMENT_ADDED' });

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
    let totalDeliveryImages = 0;
    let confirmedCount = 0;
    
    let confirmedImagesToInsert = [];
    
    if (Array.isArray(orderData.sets)) {
      orderData.sets.forEach(s => {
        if (Array.isArray(s.delivery_imgs)) {
          s.delivery_imgs.forEach(d => {
            if (d.id === delivery_id) {
              if (!d.confirmed_at) {
                d.confirmed_at = new Date().toISOString();
                if (d.img) confirmedImagesToInsert.push(d.img);
              }
            }
            // Only count slots that have actual images
            if (d.img) {
              totalDeliveryImages++;
              if (d.confirmed_at) {
                confirmedCount++;
              }
            }
          });
        }
      });
    }

    // Insert into gallery
    if (confirmedImagesToInsert.length > 0) {
      const orderOpenidRes = await pool.query('SELECT openid FROM "yizi_orders" WHERE id = $1', [id]);
      const openid = orderOpenidRes.rows[0]?.openid || req.user.openid;
      
      for (const imgUrl of confirmedImagesToInsert) {
        const galleryId = 'gal_' + crypto.randomBytes(8).toString('hex');
        await pool.query(
            `INSERT INTO "yizi_gallery" (id, openid, oss_url, order_id) VALUES ($1, $2, $3, $4)`,
            [galleryId, openid, imgUrl, id]
        );
      }
    }

    // 3) Save updated data and check if completed
    // completed = ALL delivery images with content have been confirmed by the user
    const completed = (totalDeliveryImages > 0 && confirmedCount >= totalDeliveryImages) ? '1' : '0';
    await pool.query(
      'UPDATE "yizi_orders" SET data = $1, completed = $2 WHERE id = $3',
      [JSON.stringify(orderData), completed, id]
    );

    orderEventEmitter.emit(`orderUpdate:${req.user.unionid}`, { 
        orderId: id, 
        event: 'ORDER_CONFIRMED',
        completed: completed === '1'
    });

    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

app.post('/client/gallery/list', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT g.id, g.oss_url as url, g.order_id, g.created_at, o.data as order_data 
      FROM "yizi_gallery" g 
      LEFT JOIN "yizi_orders" o ON g.order_id = o.id 
      WHERE g.openid = $1 
      ORDER BY g.created_at DESC
    `, [req.user.openid || req.user.unionid]);
    
    const list = result.rows.map(row => {
        let orderData = {};
        if (typeof row.order_data === 'string') {
            try { orderData = JSON.parse(row.order_data); } catch(e){}
        } else {
            orderData = row.order_data || {};
        }
        return {
            id: row.id,
            url: row.url,
            orderId: row.order_id,
            date: row.created_at,
            model: orderData.model_uuid || 'Unknown',
            template: orderData.planTitle || 'Unknown',
            sourceImages: orderData.sets?.[0]?.images?.filter(i=>i) || []
        };
    });
    res.json({ msg: 'ok', result: list });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 2. RPC Main Channel
// Action path example: /admin/orders/list, /admin/sku/add
app.post(['/rpc/:module/:db_name/:action(*)', '/admin/:db_name/:action(*)', '/client/:db_name/:action(*)'], authenticateToken, async (req, res) => {
  const module = req.params.module || (req.path.startsWith('/client/') ? 'client' : 'admin');
  const db_name = getActualTableName(req.params.db_name);
  const action = req.params.action;
  const params = req.body;

  // --- BEGIN RBAC PERMISSION CHECK ---
  if (module === 'admin' && !req.user.is_super) {
    let requiredPermission = null;
    const short_db_name = db_name.replace('yizi_', '');
    if (action.includes('list') || action.includes('get') || action === 'assets/list') {
      requiredPermission = `${short_db_name}:read`;
    } else if (action === 'add' || action === 'reset' || action === 'del' || action === 'trigger' || action === 'sts' || action === 'oss/delete') {
      requiredPermission = `${short_db_name}:write`;
    }

    if (requiredPermission) {
      if (!req.user.role_id) {
        return res.status(403).json({ msg: 'err', info: 'Forbidden: 账号未分配任何角色权限' });
      }
      const roleRes = await pool.query('SELECT permissions FROM "yizi_roles" WHERE id = $1', [req.user.role_id]);
      let userPerms = [];
      if (roleRes.rows.length > 0 && roleRes.rows[0].permissions) {
        userPerms = typeof roleRes.rows[0].permissions === 'string' ? JSON.parse(roleRes.rows[0].permissions) : roleRes.rows[0].permissions;
      }
      if (!userPerms.includes(requiredPermission)) {
        return res.status(403).json({ msg: 'err', info: `Forbidden: 缺少必需权限 [${requiredPermission}]` });
      }
    }
  }
  // --- END RBAC PERMISSION CHECK ---

  try {
    // ----------------------------------------------------
    // Custom Handlers for Special Table / Action overrides
    // ----------------------------------------------------

    if (db_name === 'yizi_users' && action === 'topup') {
      const { user_id, amount, remark } = params;
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount === 0) return res.json({ msg: 'err', info: '充值金额无效' });
      if (!remark) return res.json({ msg: 'err', info: '充值备注不能为空' });

      const userRes = await pool.query('SELECT "_id", "points", "phone_number" FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $1 OR "_id" = $1', [user_id]);
      if (userRes.rows.length === 0) return res.json({ msg: 'err', info: '用户不存在' });
      
      const user = userRes.rows[0];
      const currentPoints = parseFloat(user.points) || 0;
      const newPoints = currentPoints + numAmount;
      
      const orderId = 'topup_' + crypto.randomBytes(6).toString('hex');
      const orderData = {
          total_cost: numAmount,
          planTitle: "Admin Manual Top-up",
          type: "topup",
          remark: remark,
          operator: req.user.account
      };

      await pool.query('UPDATE "yizi_users" SET "points" = $1 WHERE "_id" = $2', [newPoints.toString(), user._id]);
      await pool.query(
          'INSERT INTO "yizi_recharge_orders" (id, user_id, amount, operator, remark, datetime, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [orderId, user._id, numAmount, req.user.account, remark, new Date().toISOString(), JSON.stringify(orderData)]
      );

      return res.json({ msg: 'ok', info: `成功为用户操作 ${numAmount} coz` });
    }
    
    if (db_name === 'yizi_orders' && action === 'refund') {
      const order_id = params.id;
      if (!order_id) return res.json({ msg: 'err', info: '缺少订单ID' });
      
      const orderRes = await pool.query('SELECT * FROM "yizi_orders" WHERE "id" = $1', [order_id]);
      if (orderRes.rows.length === 0) return res.json({ msg: 'err', info: '订单不存在' });
      
      const order = orderRes.rows[0];
      const orderData = typeof order.data === 'string' ? JSON.parse(order.data) : (order.data || {});
      
      if (orderData.refunded === '1') {
        return res.json({ msg: 'err', info: '该订单已退回，无法重复退回' });
      }

      // Use the cached total_cost if available, else fallback for legacy orders
      let totalCost = parseFloat(orderData.total_cost);
      if (isNaN(totalCost)) {
        totalCost = 0;
        if (Array.isArray(orderData.sets)) {
          orderData.sets.forEach(s => {
            totalCost += parseFloat(s.selectedPrice) || 0;
          });
        }
      }

      // Refund user points securely on backend
      const openid = order.openid;
      if (openid) {
        const userRes = await pool.query('SELECT "_id", "points" FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $1 OR "_id" = $1', [openid]);
        if (userRes.rows.length > 0) {
          const user = userRes.rows[0];
          const currentPoints = parseFloat(user.points) || 0;
          const newPoints = currentPoints + totalCost;
          await pool.query('UPDATE "yizi_users" SET "points" = $1 WHERE "_id" = $2', [newPoints.toString(), user._id]);
        }
      }

      // Mark order as refunded and hide from pending workflows
      orderData.refunded = '1';
      await pool.query('UPDATE "yizi_orders" SET "data" = $1, "completed" = $2, "wait_delivery" = $3 WHERE "id" = $4', [JSON.stringify(orderData), '0', '0', order_id]);

      orderEventEmitter.emit(`orderUpdate:${openid}`, { 
          orderId: order_id, 
          event: 'ORDER_REFUNDED'
      });

      return res.json({ msg: 'ok', info: `已退回，并返还 ${totalCost} coz 积分` });
    }

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

    // E. Custom handler for yizi_users (sts)
    if (db_name === 'yizi_users' && action === 'sts') {
      try {
        const token = await getOSSToken();
        return res.json({ msg: 'ok', result: token });
      } catch (error) {
        console.error('[STS User Error]', error);
        return res.json({ msg: 'err', info: error.message });
      }
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

      // Get page rows
      const pk = await getPrimaryKeyColumn(db_name);
      // Allow caller to specify sort column; fallback to pk
      const orderByCol = params.sort_by || pk;
      
      const limitIdx = placeholderIdx;
      const offsetIdx = placeholderIdx + 1;
      const listQuery = `SELECT * FROM "${db_name}" ${whereSql} ORDER BY "${orderByCol}" DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
      const result = await pool.query(listQuery, [...values, pageSize, (page - 1) * pageSize]);
      
      let listData = result.rows.map(unpackRow);

      // Custom enrich for orders: append user remark
      if (db_name === 'yizi_orders' && listData.length > 0) {
        const openids = [...new Set(listData.map(r => r.openid).filter(Boolean))];
        if (openids.length > 0) {
           const n = openids.length;
          const ph1 = openids.map((_, i) => `$${i + 1}`).join(', ');
          const ph2 = openids.map((_, i) => `$${n + i + 1}`).join(', ');
          const ph3 = openids.map((_, i) => `$${2 * n + i + 1}`).join(', ');
          const usersRes = await pool.query(
            `SELECT "user_id", "_id", "phone_number", "remark" FROM "yizi_users" WHERE "user_id" IN (${ph1}) OR "_id" IN (${ph2}) OR "phone_number" IN (${ph3})`, 
            [...openids, ...openids, ...openids]
          );
          const userMap = {};
          usersRes.rows.forEach(u => {
            if (u.user_id) userMap[u.user_id] = u.remark;
            if (u._id) userMap[u._id] = u.remark;
            if (u.phone_number) userMap[u.phone_number] = u.remark;
          });
          listData = listData.map(r => ({
            ...r,
            user_remark: userMap[r.openid] || ''
          }));
        }
      }

      return res.json({
        msg: 'ok',
        result: {
          list: listData,
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

        // --- OSS GC (Update) ---
        let oldKeys = [];
        try {
          const oldResult = await pool.query(`SELECT * FROM "${db_name}" WHERE "${pk}" = $1`, [id]);
          if (oldResult.rows.length > 0) {
            oldKeys = extractOSSKeys(oldResult.rows[0]);
          }
        } catch (err) {
          console.error('[OSS GC] Failed to fetch old record for update', err);
        }
        // -----------------------

        const rawData = params.data || {};
        
        if (db_name === 'yizi_users' && 'points' in rawData) {
            delete rawData.points;
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

        if (db_name === 'yizi_orders' && result.rows.length > 0) {
            const rowOpenid = result.rows[0].openid;
            if (rowOpenid) {
                orderEventEmitter.emit(`orderUpdate:${rowOpenid}`, { 
                    orderId: id, 
                    event: 'ADMIN_UPDATE',
                    completed: result.rows[0].completed === '1'
                });
            }
        }

        // --- OSS GC (Update Cleanup) ---
        try {
          // Fix: Disable automatic OSS GC for yizi_orders on update.
          // In the workspace, removing an image from the delivery slot (JSON) 
          // should NOT physically delete the file from OSS, because it still 
          // belongs to the global gallery pool. Explicit deletions use /admin/oss/delete.
          if (result.rows.length > 0 && db_name !== 'yizi_orders') {
            const newKeys = extractOSSKeys(result.rows[0]);
            const keysToDelete = oldKeys.filter(k => !newKeys.includes(k));
            if (keysToDelete.length > 0) {
              deleteOSSObjects(keysToDelete);
            }
          }
        } catch (err) {
          console.error('[OSS GC] Failed to GC after update', err);
        }
        // -------------------------------

        return res.json({ msg: 'ok', result: unpackRow(result.rows[0]) });
    }

    // 5) Delete Record(s) Action
    if (action === 'del') {
        const pk = await getPrimaryKeyColumn(db_name);
        const ids = params.ids || [];

        // --- OSS GC (Delete) ---
        let oldKeys = [];
        try {
          if (!Array.isArray(ids) || ids.length === 0) {
            const singleId = params.id || params.uuid || params._id;
            if (singleId) {
              const oldResult = await pool.query(`SELECT * FROM "${db_name}" WHERE "${pk}" = $1`, [singleId]);
              if (oldResult.rows.length > 0) {
                oldKeys = extractOSSKeys(oldResult.rows[0]);
              }
            }
          } else {
            const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
            const oldResult = await pool.query(`SELECT * FROM "${db_name}" WHERE "${pk}" IN (${placeholders})`, ids);
            oldResult.rows.forEach(r => {
              oldKeys = oldKeys.concat(extractOSSKeys(r));
            });
          }
        } catch (err) {
          console.error('[OSS GC] Failed to fetch old records for delete', err);
        }
        // -----------------------

        if (!Array.isArray(ids) || ids.length === 0) {
          const singleId = params.id || params.uuid || params._id;
          if (singleId) {
            await pool.query(`DELETE FROM "${db_name}" WHERE "${pk}" = $1`, [singleId]);
            if (oldKeys.length > 0) deleteOSSObjects(oldKeys);
            return res.json({ msg: 'ok' });
          }
          return res.json({ msg: 'err', info: 'No IDs provided for deletion' });
        }

        const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
        const query = `DELETE FROM "${db_name}" WHERE "${pk}" IN (${placeholders})`;
        await pool.query(query, ids);

        if (oldKeys.length > 0) deleteOSSObjects(oldKeys);

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

// API Pipeline Execution Endpoint (manual trigger from Dashboard)
app.post('/api_pipeline/trigger', authenticateToken, async (req, res) => {
  let { workflow_json, mock_order } = req.body;
  
  if (!workflow_json && mock_order?.order_id) {
    try {
      // Lookup the order's planId (SKU) to find the default workflow
      const orderRes = await pool.query('SELECT data FROM "yizi_orders" WHERE id = $1', [mock_order.order_id]);
      if (orderRes.rows.length > 0) {
        const orderData = typeof orderRes.rows[0].data === 'string' ? JSON.parse(orderRes.rows[0].data) : (orderRes.rows[0].data || {});
        if (orderData.planId) {
          const skuPk = await getTableColumns('yizi_sku').then(cols => cols.includes('uuid') ? 'uuid' : 'id');
          const skuRes = await pool.query(`SELECT data FROM "yizi_sku" WHERE "${skuPk}" = $1`, [orderData.planId]);
          if (skuRes.rows.length > 0) {
            const skuData = typeof skuRes.rows[0].data === 'string' ? JSON.parse(skuRes.rows[0].data) : (skuRes.rows[0].data || {});
            if (skuData.workflow) {
              const casePk = await getTableColumns('yizi_cases').then(cols => cols.includes('uuid') ? 'uuid' : 'id');
              const caseRes = await pool.query(`SELECT data FROM "yizi_cases" WHERE "${casePk}" = $1`, [skuData.workflow]);
              if (caseRes.rows.length > 0) {
                 const caseData = typeof caseRes.rows[0].data === 'string' ? JSON.parse(caseRes.rows[0].data) : (caseRes.rows[0].data || {});
                 workflow_json = caseData.workflow_json || caseData;
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[API Pipeline] Auto-resolve workflow error:', e.message);
      return res.json({ msg: 'err', info: `Auto-resolve failed: ${e.message}` });
    }
  }

  if (!workflow_json) return res.json({ msg: 'err', info: 'workflow_json is required or could not be inferred from order.' });
  
  // Inject the workflow_override_prompt into the prompt_board node if present
  if (mock_order?.workflow_override_prompt) {
    try {
      let wObj = typeof workflow_json === 'string' ? JSON.parse(workflow_json) : workflow_json;
      if (wObj && Array.isArray(wObj.nodes)) {
        const boardNode = wObj.nodes.find(n => n.type === 'prompt_board');
        if (boardNode) {
          if (!boardNode.data) boardNode.data = {};
          boardNode.data.prompt = mock_order.workflow_override_prompt;
        }
      }
      workflow_json = typeof workflow_json === 'string' ? JSON.stringify(wObj) : wObj;
    } catch(e) {
      console.error('[Pipeline Override Prompt Error]', e);
    }
  }

  // Respond immediately, then await pipeline to keep function alive
  res.json({ msg: 'ok', info: 'Pipeline started' });

  try {
    await runPipeline(workflow_json, mock_order, pool);
  } catch (err) {
    console.error('[Pipeline Trigger Error]', err.message);
  }
});

// GET /api_pipeline/logs
// Fetch the latest 50 API execution logs
app.get('/api_pipeline/logs', authenticateToken, async (req, res) => {
  try {
    const query = 'SELECT * FROM yizi_api_logs ORDER BY created_at DESC LIMIT 50';
    const result = await pool.query(query);
    res.json({ msg: 'ok', data: result.rows });
  } catch (err) {
    console.error('[Logs Error]', err);
    res.status(500).json({ msg: 'err', info: err.message });
  }
});

// POST /api_pipeline/fallback_oss
// Manually upload raw generated images from a log to OSS and attach to the order
app.post('/api_pipeline/fallback_oss', authenticateToken, async (req, res) => {
  const { log_id } = req.body;
  if (!log_id) return res.json({ msg: 'err', info: 'Missing log_id' });
  
  try {
    const logRes = await pool.query('SELECT * FROM yizi_api_logs WHERE id = $1', [log_id]);
    if (logRes.rows.length === 0) return res.json({ msg: 'err', info: 'Log not found' });
    
    const log = logRes.rows[0];
    if (!log.order_id || log.order_id === 'toolkit_run' || log.order_id === 'unknown') {
      return res.json({ msg: 'err', info: '该日志未关联有效订单，无法自动入库' });
    }

    let images = log.result_images;
    if (typeof images === 'string') {
      try { images = JSON.parse(images); } catch (e) { images = []; }
    }
    if (!Array.isArray(images) || images.length === 0) {
      return res.json({ msg: 'err', info: '日志中没有可上传的图片' });
    }

    // Filter out already uploaded ones (assuming OSS URL format, e.g. aliyuncs.com or our delivery_imgs folder)
    const pendingImages = images.filter(img => !img.includes('aliyuncs.com') && !img.includes('delivery_imgs')); 
    if (pendingImages.length === 0) {
      return res.json({ msg: 'err', info: '所有图片已经成功在 OSS 上了，无需重复上传。' });
    }

    // Fetch order info
    const orderRes = await pool.query('SELECT * FROM yizi_orders WHERE id = $1', [log.order_id]);
    if (orderRes.rows.length === 0) return res.json({ msg: 'err', info: '订单已不存在' });
    const orderInfo = orderRes.rows[0];

    // Initialize OSS Client
    const OSS = (await import('ali-oss')).default;
    const ossConfig = {
      region: process.env.OSS_REGION,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      bucket: process.env.OSS_BUCKET,
      secure: true
    };
    const ossClient = new OSS(ossConfig);

    // Upload pending images
    const { uploadToOSS } = await import('./pipeline_executor.js');
    const uploadedUrls = [];
    for (const img of pendingImages) {
       try {
         const secureUrl = await uploadToOSS(ossClient, img, orderInfo.openid, orderInfo.id, 0, `del_${Date.now()}`);
         uploadedUrls.push(secureUrl.replace('http://', 'https://'));
       } catch (err) {
         console.error('Fallback OSS upload failed for', img, err.message);
       }
    }

    if (uploadedUrls.length > 0) {
       let orderData = orderInfo.data || {};
       if (!orderData.sets) orderData.sets = [{}];
       // Use set_index from the log's request body, or default to 0
       const setIdx = parseInt(req.body.set_index) || 0;
       if (!orderData.sets[setIdx]) orderData.sets[setIdx] = {};
       if (!orderData.sets[setIdx].delivery_imgs) orderData.sets[setIdx].delivery_imgs = [];
       
       for (const url of uploadedUrls) {
         orderData.sets[setIdx].delivery_imgs.push({
           id: `del_${Date.now()}_${Math.random().toString(36).substring(2,7)}`,
           img: url,
           confirmed_at: null
         });
       }
       
       await pool.query('UPDATE yizi_orders SET data = $1, wait_delivery = $2 WHERE id = $3', [JSON.stringify(orderData), '1', orderInfo.id]);
       
       // Update log result_images
       const newResultImages = images.map(img => pendingImages.includes(img) ? (uploadedUrls.shift() || img) : img);
       await pool.query(`UPDATE yizi_api_logs SET result_images = $1, error_msg = '兜底手动上传成功' WHERE id = $2`, [JSON.stringify(newResultImages), log_id]);

       return res.json({ msg: 'ok', info: `成功补传 ${newResultImages.length} 张图片到订单交付池！` });
    } else {
       return res.json({ msg: 'err', info: '图片上传全部失败，可能由于原始生图链接已过期。' });
    }
  } catch (err) {
    console.error(err);
    return res.json({ msg: 'err', info: err.message });
  }
});

// POST /toolkit/upload_to_oss_direct — Manually upload URLs to OSS for a specific order
app.post('/toolkit/upload_to_oss_direct', authenticateToken, async (req, res) => {
  let { urls, openid, order_id, set_index } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) return res.json({ msg: 'err', info: 'Missing urls' });
  if (!openid || !order_id) return res.json({ msg: 'err', info: 'Missing order info' });

  try {
    const OSS = (await import('ali-oss')).default;
    const ossConfig = {
      region: process.env.OSS_REGION,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      bucket: process.env.OSS_BUCKET,
      secure: true
    };
    if (!ossConfig.accessKeyId) return res.json({ msg: 'err', info: 'OSS Not Configured' });
    const ossClient = new OSS(ossConfig);

    const { uploadToOSS } = await import('./pipeline_executor.js');
    const uploadedUrls = [];
    const setIdx = parseInt(set_index) || 0;

    for (const img of urls) {
       try {
         const secureUrl = await uploadToOSS(ossClient, img, openid, order_id, setIdx, `del_${Date.now()}`);
         uploadedUrls.push(secureUrl.replace('http://', 'https://'));
       } catch (err) {
         console.error('Direct OSS upload failed for', img, err.message);
       }
    }

    if (uploadedUrls.length > 0) {
      return res.json({ msg: 'ok', uploaded: uploadedUrls });
    } else {
      return res.json({ msg: 'err', info: 'All uploads failed' });
    }
  } catch (err) {
    console.error('[Upload OSS Direct Error]', err);
    return res.json({ msg: 'err', info: err.message });
  }
});

// POST /toolkit/grsai — Direct Grsai API call from Toolkit (no pipeline, synchronous polling)
app.post('/toolkit/prompts/sync', authenticateToken, async (req, res) => {
  const { prompts } = req.body;
  if (!Array.isArray(prompts)) return res.json({ msg: 'err', info: 'Invalid data format. Expected prompts array.' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Ensure table exists
    await client.query(`CREATE TABLE IF NOT EXISTS "yizi_prompts" (
      id VARCHAR(50) PRIMARY KEY,
      group_id VARCHAR(50),
      content TEXT,
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    for (const p of prompts) {
      if (!p.id || !p.content || !p.group_id) continue;
      
      const insertQuery = `
        INSERT INTO "yizi_prompts" (id, group_id, content, data)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE 
        SET content = EXCLUDED.content, group_id = EXCLUDED.group_id, data = EXCLUDED.data
      `;
      await client.query(insertQuery, [p.id, p.group_id, p.content, p.data || {}]);
    }
    await client.query('COMMIT');
    res.json({ msg: 'ok', info: `Synced ${prompts.length} prompts successfully.` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Prompt Sync]', err);
    res.json({ msg: 'err', info: err.message });
  } finally {
    client.release();
  }
});

app.post('/toolkit/grsai', authenticateToken, async (req, res) => {
  const { images, prompt, model, aspectRatio, quality } = req.body;

  const { getSetting } = await import('./config_manager.js');
  const endpoint = process.env.GRSAI_API_ENDPOINT || await getSetting(pool, 'GRSAI_API_ENDPOINT');
  const apiKey = process.env.GRSAI_API_KEY || await getSetting(pool, 'GRSAI_API_KEY');

  if (!endpoint || !apiKey) {
    return res.json({ msg: 'err', info: 'Grsai API not configured in settings' });
  }

  let baseUrl = endpoint.trim();
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  const generateUrl = baseUrl.endsWith('/generate') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/generate`;
  const resultUrl = generateUrl.replace(/\/generate$/, '/result');
  const token = apiKey.trim().replace(/^Bearer\s+/i, '');

  const payload = {
    model: model || 'gpt-image-2',
    prompt: prompt || '',
    images: Array.isArray(images) ? images : (images ? [images] : []),
    aspectRatio: aspectRatio || '1024x1024',
    quality: quality || 'standard',
    replyType: 'async'
  };

  try {
    console.log(`[Toolkit Grsai] Submitting to ${generateUrl}`);
    const submitRes = await fetch(generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      return res.json({ msg: 'err', info: `Grsai API [${submitRes.status}]: ${errText}` });
    }

    const data = await submitRes.json();
    if (!data.id) {
      return res.json({ msg: 'err', info: 'Grsai did not return a task ID' });
    }

    const taskId = data.id;
    console.log(`[Toolkit Grsai] Task ${taskId} submitted, polling...`);

    // Poll for result (max 5 minutes = 30 polls * 10s)
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let consecutiveErrors = 0;

    for (let i = 0; i < 30; i++) {
      await sleep(10000);

      let pollRes;
      try {
        pollRes = await fetch(`${resultUrl}?id=${encodeURIComponent(taskId)}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(15000)
        });
      } catch (fetchErr) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          return res.json({ msg: 'err', info: `Poll network error after ${consecutiveErrors} retries: ${fetchErr.message}` });
        }
        continue;
      }

      if (!pollRes.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          return res.json({ msg: 'err', info: `Poll HTTP error after ${consecutiveErrors} retries (last: ${pollRes.status})` });
        }
        continue;
      }

      consecutiveErrors = 0;
      const pollData = await pollRes.json();

      if (pollData.status === 'succeeded' && pollData.results && pollData.results.length > 0) {
        const urls = pollData.results.map(r => r.url);
        console.log(`[Toolkit Grsai] Task ${taskId} succeeded: ${urls.length} images`);
        return res.json({ msg: 'ok', images: urls, task_id: taskId });
      } else if (pollData.status === 'failed') {
        return res.json({ msg: 'err', info: pollData.error || pollData.message || 'Task failed', task_id: taskId });
      }
      // else still processing, continue polling
    }

    return res.json({ msg: 'err', info: `Task ${taskId} timed out after 300s` });

  } catch (err) {
    console.error('[Toolkit Grsai Error]', err);
    return res.json({ msg: 'err', info: err.message });
  }
});

// GET /admin/settings
app.get('/admin/settings', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value, is_secret, updated_at FROM yizi_settings');
    const settings = result.rows.map(row => {
      // Mask secret values for frontend
      if (row.is_secret && row.value) {
        return { ...row, value: 'sk-****' + crypto.createHash('md5').update(row.value).digest('hex').substring(0, 4) };
      }
      return row;
    });
    res.json({ msg: 'ok', data: settings });
  } catch (err) {
    console.error(err);
    res.json({ msg: 'err', info: err.message });
  }
});

// POST /admin/settings
app.post('/admin/settings', authenticateToken, async (req, res) => {
  const { settings } = req.body; // Array of {key, value, is_secret}
  if (!Array.isArray(settings)) return res.json({ msg: 'err', info: 'Invalid data' });

  try {
    const { encrypt } = await import('./config_manager.js');
    for (const item of settings) {
      // If it's a masked secret, it means user didn't change it, skip.
      if (item.is_secret && typeof item.value === 'string' && item.value.startsWith('sk-****')) {
        continue; 
      }
      
      let finalValue = item.value;
      if (item.is_secret && finalValue) {
        finalValue = encrypt(finalValue);
      }

      await pool.query(`
        INSERT INTO yizi_settings (key, value, is_secret, updated_at) 
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, is_secret = $3, updated_at = NOW()
      `, [item.key, finalValue, item.is_secret ? true : false]);
    }
    res.json({ msg: 'ok', info: 'Settings saved successfully' });
  } catch (err) {
    console.error(err);
    res.json({ msg: 'err', info: err.message });
  }
});

const PORT = process.env.PORT || 9000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Yizi Backend API is running on http://localhost:${PORT}`);
  });
}

export default app;
