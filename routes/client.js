import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool, getPrimaryKeyColumn } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { formatOrderRow } from '../utils/helpers.js';
import { getOSSToken } from '../utils/oss.js';
import { runPipeline } from '../pipeline/index.js';
import { orderEventEmitter } from '../events.js';
import OSS from 'ali-oss';
import Core from '@alicloud/pop-core';

const router = express.Router();

// 1. User login (No token needed, phone & password, auto-register on first login)
router.post('/client/login', async (req, res) => {
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
      // Block unregistered users from logging in via password
      return res.json({ msg: 'err', info: '账号不存在，请先使用验证码登录/注册' });
    }
  } catch (error) {
    console.error('[User Login Error]', error);
    res.json({ msg: 'err', info: '登录或自动注册失败' });
  }
});

// 1.5 Send SMS Verification Code
router.post('/client/sms/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1\d{10}$/.test(phone)) {
    return res.json({ msg: 'err', info: '手机号格式错误' });
  }

  // Generate 6 digit code
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    await pool.query(
      `INSERT INTO "yizi_sms_codes" (phone, code, created_at) 
       VALUES ($1, $2, CURRENT_TIMESTAMP) 
       ON CONFLICT (phone) DO UPDATE SET code = EXCLUDED.code, created_at = CURRENT_TIMESTAMP`,
      [phone, code]
    );

    const accessKeyId = process.env.SMS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.SMS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET;
    
    // Fetch SMS_SIGN_NAME and SMS_TEMPLATE_CODE from yizi_settings if not in env
    let signName = process.env.SMS_SIGN_NAME;
    let templateCode = process.env.SMS_TEMPLATE_CODE;

    if (!signName || !templateCode) {
      const settingsRes = await pool.query('SELECT key, value FROM "yizi_settings" WHERE key IN ($1, $2)', ['SMS_SIGN_NAME', 'SMS_TEMPLATE_CODE']);
      settingsRes.rows.forEach(r => {
        if (r.key === 'SMS_SIGN_NAME') signName = r.value;
        if (r.key === 'SMS_TEMPLATE_CODE') templateCode = r.value;
      });
    }

    if (!signName || !templateCode || !accessKeyId || !accessKeySecret) {
      console.log(`[Mock SMS] Sending to ${phone}: ${code}`);
      return res.json({ msg: 'ok', info: 'Mock: 短信发送成功' });
    }

    // Call Aliyun SMS API
    const client = new Core({
      accessKeyId,
      accessKeySecret,
      endpoint: 'https://dysmsapi.aliyuncs.com',
      apiVersion: '2017-05-25'
    });

    const params = {
      "RegionId": "cn-hangzhou",
      "PhoneNumbers": phone,
      "SignName": signName,
      "TemplateCode": templateCode,
      "TemplateParam": JSON.stringify({ code })
    };

    const requestOption = {
      method: 'POST',
      formatParams: false
    };

    await client.request('SendSms', params, requestOption);
    res.json({ msg: 'ok', info: '短信发送成功' });
  } catch (error) {
    console.error('[SMS Send Error]', error);
    res.json({ msg: 'err', info: '发送报错: ' + (error.data ? JSON.stringify(error.data) : error.message) });
  }
});

// 1.6 Login with SMS Verification Code
router.post('/client/sms/login', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.json({ msg: 'err', info: '手机号和验证码不能为空' });

  try {
    const codeRes = await pool.query('SELECT code, created_at FROM "yizi_sms_codes" WHERE phone = $1', [phone]);
    if (codeRes.rows.length === 0) return res.json({ msg: 'err', info: '请先获取验证码' });

    const record = codeRes.rows[0];
    if (record.code !== code) return res.json({ msg: 'err', info: '验证码错误' });

    // Check expiration (5 minutes = 300000 ms)
    const now = new Date();
    const createdAt = new Date(record.created_at);
    if (now - createdAt > 300000) {
      return res.json({ msg: 'err', info: '验证码已过期' });
    }

    // Code is valid, delete it
    await pool.query('DELETE FROM "yizi_sms_codes" WHERE phone = $1', [phone]);

    // Check if user exists
    const userRes = await pool.query('SELECT * FROM "yizi_users" WHERE "phone_number" = $1', [phone]);
    let user;
    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
    } else {
      // Auto-register
      const newUserId = 'usr_' + crypto.randomBytes(8).toString('hex');
      const randomPassword = crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex');
      const defaultPoints = '240';
      await pool.query(
        'INSERT INTO "yizi_users" ("_id", "user_id", "phone_number", "points", "password", "has_password") VALUES ($1, $2, $3, $4, $5, $6)',
        [newUserId, newUserId, phone, defaultPoints, randomPassword, false]
      );
      user = { user_id: newUserId, phone_number: phone };
    }

    const token = jwt.sign({ unionid: user.user_id, phone }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '30d' });
    return res.json({ msg: 'ok', result: { token, unionid: user.user_id, phone } });
  } catch (error) {
    console.error('[SMS Login Error]', error);
    res.json({ msg: 'err', info: '登录失败，请稍后重试' });
  }
});

// 2. Get user points (GET /client/user/points)
router.get('/client/user/points', authenticateToken, async (req, res) => {
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
router.post('/client/get_phone_number', authenticateToken, async (req, res) => {
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
router.post('/client/user/phone_number/set', authenticateToken, async (req, res) => {
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

// 4.1 Get has_password
router.post('/client/user/has_password', authenticateToken, async (req, res) => {
  const unionid = req.user.unionid;
  try {
    const result = await pool.query('SELECT has_password FROM "yizi_users" WHERE "user_id" = $1', [unionid]);
    if (result.rows.length > 0) {
      return res.json({ msg: 'ok', result: { has_password: !!result.rows[0].has_password } });
    }
    res.json({ msg: 'err', info: 'User not found' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 4.5 Set user password
router.post('/client/user/password/set', authenticateToken, async (req, res) => {
  const unionid = req.user.unionid;
  const { old_password, new_password } = req.body;
  
  if (!new_password || typeof new_password !== 'string' || new_password.length > 100 || new_password.length < 6) {
    return res.json({ msg: 'err', info: '新密码格式错误，长度必须在6-100位之间' });
  }

  try {
    const userQuery = await pool.query('SELECT password, has_password FROM "yizi_users" WHERE "user_id" = $1', [unionid]);
    if (userQuery.rows.length === 0) {
      return res.json({ msg: 'err', info: '用户不存在' });
    }
    
    const user = userQuery.rows[0];
    const currentPasswordHash = user.password;
    const hasPassword = user.has_password;
    
    // 如果用户设置过密码，则必须验证旧密码
    if (hasPassword) {
      if (!old_password) {
        return res.json({ msg: 'err', info: '请输入旧密码' });
      }
      
      const oldPasswordHash = crypto.createHash('sha256').update(old_password).digest('hex');
      if (oldPasswordHash !== currentPasswordHash) {
        return res.json({ msg: 'err', info: '旧密码错误' });
      }
    }

    const hashedPassword = crypto.createHash('sha256').update(new_password).digest('hex');
    await pool.query('UPDATE "yizi_users" SET "password" = $1, "has_password" = $2 WHERE "user_id" = $3', [hashedPassword, true, unionid]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 5. Create order and deduct points
router.post('/client/order/create', authenticateToken, async (req, res) => {
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
    } catch (e) {
      console.error('[API Workflow] Failed to parse order data JSON:', e.message);
    }

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

    // 2) Check user points and fetch remark
    const userRes = await pool.query('SELECT points, remark FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $2', [unionid, unionid]);
    if (userRes.rows.length === 0) {
      return res.json({ msg: 'err', info: '用户不存在' });
    }
    const currentPoints = parseFloat(userRes.rows[0].points) || 0;
    const userRemark = userRes.rows[0].remark || '';
    if (currentPoints < totalCost) {
      return res.json({ msg: 'err', info: '扣子余额不足请充值后重试' });
    }

    // Embed remark into order data
    data.user_remark = userRemark;

    // 3) Create order
    const orderId = 'ord_' + crypto.randomBytes(8).toString('hex');
    const datetime = new Date();
    await pool.query(
      `INSERT INTO "yizi_orders" (id, phone, datetime, data, delivery_count, completed, has_comments, wait_delivery, openid) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orderId, phone || req.user.phone || '', datetime, JSON.stringify(data), '0', '0', '0', '1', unionid]
    );

    // Trigger Feishu Notification
    const displayName = userRemark ? `${userRemark} (${phone || req.user.phone || ''})` : (phone || req.user.phone || unionid);
    orderEventEmitter.emit('NOTIFY_NEW_ORDER', {
      orderId,
      openid: unionid,
      phone: displayName
    });

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

          // Resolve prompt slots: use frontend selections, or randomly pick from bound prompt libraries
          const promptSetIds = String(skuData.prompt_set_ids || skuData.prompt_set_id || '').split(',').filter(Boolean).slice(0, 4);
          const resolvedSlots = promptSetIds.length > 0 ? await Promise.all(promptSetIds.map(async (setId, i) => {
              // Check both global prompt_slots and per-set prompt_slots
              const globalSlot = (data.prompt_slots || [])[i];
              if (globalSlot && globalSlot.content) {
                  return globalSlot.content;
              }
              // Random pick from this prompt library (supports both old column format and new JSONB format)
              try {
                  const randomRes = await pool.query(
                      `SELECT COALESCE(content, data->>'content') as content 
                       FROM yizi_prompts 
                       WHERE set_id = $1 OR data->>'set_id' = $1
                       ORDER BY RANDOM() LIMIT 1`, [setId]
                  );
                  return randomRes.rows[0]?.content || '';
              } catch (e) {
                  console.warn(`[Prompt Slot] Failed to random pick from set ${setId}:`, e.message);
                  return '';
              }
          })) : [];

          if (Array.isArray(data.sets)) {
            for (let index = 0; index < data.sets.length; index++) {
              const set = data.sets[index];
              const orderContext = {
                isRealOrder: true,
                openid: unionid,
                user_id: unionid,
                order_id: orderId,
                set_index: index,
                sku_pose_folder: resolvedPoseFolder,
                model_uuid: data.model_uuid,
                selectedPoseUrl: set.selectedPoseUrl || '',
                images: set.images || [],
                prompt: set.prompt || data.prompt || set.extra_prompt || '',
                prompt_slot_1: (set.prompt_slots && set.prompt_slots[0]?.content) || resolvedSlots[0] || '',
                prompt_slot_2: (set.prompt_slots && set.prompt_slots[1]?.content) || resolvedSlots[1] || '',
                prompt_slot_3: (set.prompt_slots && set.prompt_slots[2]?.content) || resolvedSlots[2] || '',
                prompt_slot_4: (set.prompt_slots && set.prompt_slots[3]?.content) || resolvedSlots[3] || '',
                model_name: data.model_name || '',
                auto_delivery: skuData.auto_delivery === true || skuData.auto_delivery === 'true' || skuData.auto_delivery === 1 || skuData.auto_delivery === '1',
                
              };
              
              console.log(`[Auto Trigger] Starting pipeline for Order ${orderId} Set ${index}`);
              // Fire-and-forget: starts immediately, creating event loop timers
              // that keep the Vercel function alive after res.json()
              runPipeline(pipelineInput, orderContext, pool).catch(err => {
                console.error(`[Auto Pipeline Error] Order ${orderId} Set ${index}:`, err.message);
              });

              // Save the resolved slots back to the order data so it persists for regeneration
              set.prompt_slots = [
                { content: orderContext.prompt_slot_1 },
                { content: orderContext.prompt_slot_2 },
                { content: orderContext.prompt_slot_3 },
                { content: orderContext.prompt_slot_4 }
              ];
            }
            // Update the global data as well
            data.prompt_slots = [
              { content: resolvedSlots[0] || '' },
              { content: resolvedSlots[1] || '' },
              { content: resolvedSlots[2] || '' },
              { content: resolvedSlots[3] || '' }
            ];
            // Persist back to database
            await pool.query('UPDATE "yizi_orders" SET data = $1 WHERE id = $2', [JSON.stringify(data), orderId]);
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
router.get('/client/order/events', authenticateToken, (req, res) => {
  const unionid = req.user.unionid;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // Prevent Nginx buffering
  });
  if (res.flushHeaders) {
    res.flushHeaders();
  }

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
router.post('/client/order/list', authenticateToken, async (req, res) => {
  const unionid = req.user.unionid;
  const page = Math.max(1, parseInt(req.body.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.body.pageSize) || 20)); // Limit page size to max 100
  const offset = (page - 1) * pageSize;

  try {
    // 1. Get total count
    const countRes = await pool.query(
      'SELECT count(*) FROM "yizi_orders" WHERE openid = $1 OR phone = $2',
      [unionid, req.user.phone || '']
    );
    const totalCount = parseInt(countRes.rows[0].count, 10);

    // 2. Fetch paginated orders
    const result = await pool.query(
      'SELECT * FROM "yizi_orders" WHERE openid = $1 OR phone = $2 ORDER BY datetime DESC LIMIT $3 OFFSET $4',
      [unionid, req.user.phone || '', pageSize, offset]
    );

    if (result.rows.length === 0) {
      return res.json({ msg: 'ok', result: { list: [], total: totalCount, page, pageSize } });
    }

    // 3. Extract unique planIds and model_uuids needed for this page
    const planIds = new Set();
    const modelUuids = new Set();
    
    result.rows.forEach(row => {
      const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
      if (data.planId && !data.planTitle) planIds.add(data.planId);
      if (data.model_uuid && !data.model_name) modelUuids.add(data.model_uuid);
    });

    const skuPk = await getPrimaryKeyColumn('yizi_sku');
    const skuMap = {};
    const modelMap = {};

    // 4. Query only the needed SKUs and Models
    const promises = [];
    if (planIds.size > 0) {
      const planIdsArr = Array.from(planIds);
      const placeholders = planIdsArr.map((_, i) => `$${i + 1}`).join(',');
      promises.push(
        pool.query(`SELECT "${skuPk}", title FROM "yizi_sku" WHERE "${skuPk}" IN (${placeholders})`, planIdsArr)
          .then(res => { res.rows.forEach(s => skuMap[s[skuPk]] = s.title); })
      );
    }
    
    if (modelUuids.size > 0) {
      const uuidsArr = Array.from(modelUuids);
      const placeholders = uuidsArr.map((_, i) => `$${i + 1}`).join(',');
      promises.push(
        pool.query(`SELECT uuid, title FROM "yizi_model" WHERE uuid IN (${placeholders})`, uuidsArr)
          .then(res => { res.rows.forEach(m => modelMap[m.uuid] = m.title); })
      );
    }

    if (promises.length > 0) await Promise.all(promises);

    // 5. Format and enrich orders
    const list = result.rows.map(row => {
      const formatted = formatOrderRow(row);
      if (formatted.data && !formatted.data.planTitle && formatted.data.planId && skuMap[formatted.data.planId]) {
        formatted.data.planTitle = skuMap[formatted.data.planId];
      }
      if (formatted.data && !formatted.data.model_name && formatted.data.model_uuid && modelMap[formatted.data.model_uuid]) {
        formatted.data.model_name = modelMap[formatted.data.model_uuid];
      }
      return formatted;
    });

    // Note: returning { list, total, page, pageSize } but legacy clients expect an array.
    // If frontend crashes, frontend must be updated to handle result.list instead of result array.
    res.json({ msg: 'ok', result: { list, total: totalCount, page, pageSize } });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 7. Get order detail
router.post('/client/order/get', authenticateToken, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ msg: 'err', info: 'Order ID is required' });
  try {
    const result = await pool.query('SELECT * FROM "yizi_orders" WHERE id = $1', [id]);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      const formatted = formatOrderRow(row);
      
      // Inject comments dynamically
      const deliveryUuids = [];
      if (Array.isArray(formatted.data.sets)) {
        formatted.data.sets.forEach((s, idx) => {
          if (Array.isArray(s.delivery_imgs)) {
            s.delivery_imgs.forEach((d, d_idx) => {
              const dId = d.id || `img_${idx}_${d_idx}`;
              deliveryUuids.push(dId);
            });
          }
        });
      }
      
      if (deliveryUuids.length > 0) {
        const commentsRes = await pool.query('SELECT * FROM "yizi_comments" WHERE delivery_uuid = ANY($1) ORDER BY created_at ASC', [deliveryUuids]);
        const commentsByUuid = {};
        commentsRes.rows.forEach(c => {
          if (!commentsByUuid[c.delivery_uuid]) commentsByUuid[c.delivery_uuid] = [];
          commentsByUuid[c.delivery_uuid].push(c);
        });
        
        formatted.data.sets.forEach((s, idx) => {
          if (Array.isArray(s.delivery_imgs)) {
            s.delivery_imgs.forEach((d, d_idx) => {
              const dId = d.id || `img_${idx}_${d_idx}`;
              if (commentsByUuid[dId]) {
                d.comments = commentsByUuid[dId];
              }
            });
          }
        });
      }

      return res.json({
        msg: 'ok',
        result: formatted
      });
    }
    res.json({ msg: 'err', info: 'Order not found' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 8. Submit feedback comment
router.post('/client/order/comment', authenticateToken, async (req, res) => {
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
    } catch(e) {
      console.error('[Order List] Failed to parse order data JSON:', e.message);
    }
    
    const deliveryImg = orderData.sets?.[index]?.delivery_imgs?.[delivery_index];
    const deliveryUuid = deliveryImg?.id || `img_${index}_${delivery_index}`;
    
    // 1.5) Calculate remake cost and check points
    const unionid = req.user.unionid;
    const commentsRes = await pool.query('SELECT type FROM "yizi_comments" WHERE delivery_uuid = $1', [deliveryUuid]);
    const previousCount = commentsRes.rows.filter(c => c.type === 'user').length;
    
    let cost = 80;
    if (previousCount === 0) cost = 0;
    else if (previousCount === 1) cost = 5;
    else if (previousCount === 2) cost = 10;
    else if (previousCount === 3) cost = 20;
    else if (previousCount === 4) cost = 40;

    const userRes = await pool.query('SELECT points FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $2', [unionid, unionid]);
    if (userRes.rows.length === 0) return res.json({ msg: 'err', info: '用户不存在' });
    
    const currentPoints = parseFloat(userRes.rows[0].points) || 0;
    if (currentPoints < cost) {
      return res.json({ msg: 'err', info: '积分余额不足以支付本次重新拍摄' });
    }

    // Deduct points
    const nextPoints = currentPoints - cost;
    await pool.query('UPDATE "yizi_users" SET points = $1 WHERE "user_id" = $2 OR "phone_number" = $3', [nextPoints.toString(), unionid, unionid]);

    // 2) Write comment
    const commentId = 'cmt_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO "yizi_comments" (id, delivery_uuid, type, comment, content) VALUES ($1, $2, $3, $4, $5)`,
      [commentId, deliveryUuid, 'user', comment, comment]
    );

    // 3) Mark order as having comments
    await pool.query('UPDATE "yizi_orders" SET has_comments = \'1\' WHERE id = $1', [id]);

    // We removed the self-notification:
    // orderEventEmitter.emit(`orderUpdate:${req.user.unionid}`, { orderId: id, event: 'COMMENT_ADDED' });

    // Trigger Feishu Notification (with user remark like order creation)
    let commentDisplayName = req.user.phone || '';
    try {
      const commentUserRes = await pool.query('SELECT remark FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $2', [req.user.unionid, req.user.unionid]);
      const commentRemark = commentUserRes.rows[0]?.remark || '';
      if (commentRemark) commentDisplayName = `${commentRemark} (${commentDisplayName})`;
    } catch(e) {
      console.error('[Order Detail] Failed to get user remark:', e.message);
    }
    orderEventEmitter.emit('NOTIFY_NEW_COMMENT', {
      orderId: id,
      openid: req.user.unionid,
      phone: commentDisplayName,
      comment
    });

    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// 9. Confirm delivery image
router.post('/client/order/confirm', authenticateToken, async (req, res) => {
  const { id, delivery_id } = req.body;
  if (!id || !delivery_id) return res.json({ msg: 'err', info: '参数错误' });
  try {
    // 1) Read current order data
    const orderRes = await pool.query('SELECT data FROM "yizi_orders" WHERE id = $1', [id]);
    if (orderRes.rows.length === 0) return res.json({ msg: 'err', info: '订单不存在' });
    
    let orderData = {};
    try {
      orderData = typeof orderRes.rows[0].data === 'string' ? JSON.parse(orderRes.rows[0].data) : (orderRes.rows[0].data || {});
    } catch(e) {
      console.error('[Order Detail] Failed to parse order data JSON:', e.message);
    }
    
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
      
      const values = [];
      const flatParams = [];
      let paramIndex = 1;
      
      for (const imgUrl of confirmedImagesToInsert) {
        const galleryId = 'gal_' + crypto.randomBytes(8).toString('hex');
        values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
        flatParams.push(galleryId, openid, imgUrl, id);
      }
      
      const query = `INSERT INTO "yizi_gallery" (id, openid, oss_url, order_id) VALUES ${values.join(', ')}`;
      await pool.query(query, flatParams);
    }

    // 3) Save updated data and check if completed
    // completed = ALL delivery images with content have been confirmed by the user
    const wasCompleted = orderRes.rows[0].completed === '1';
    const completed = (totalDeliveryImages > 0 && confirmedCount >= totalDeliveryImages) ? '1' : '0';
    await pool.query(
      'UPDATE "yizi_orders" SET data = $1, completed = $2 WHERE id = $3',
      [JSON.stringify(orderData), completed, id]
    );

    // 5) Trigger SSE to refresh the user's view
    orderEventEmitter.emit(`orderUpdate:${req.user.unionid}`, { 
      orderId: id, 
      event: 'ORDER_CONFIRMED' 
    });

    // Trigger Feishu Notification only when the entire order is fully confirmed for the first time
    if (completed === '1' && !wasCompleted) {
      // Fetch user remark for display name (like order creation notification)
      let confirmDisplayName = req.user.phone || '';
      try {
        const confirmUserRes = await pool.query('SELECT remark FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $2', [req.user.unionid, req.user.unionid]);
        const confirmRemark = confirmUserRes.rows[0]?.remark || '';
        if (confirmRemark) confirmDisplayName = `${confirmRemark} (${confirmDisplayName})`;
      } catch(e) {
        console.error('[Order Confirm] Failed to confirm user remark:', e.message);
      }
      orderEventEmitter.emit('NOTIFY_ORDER_CONFIRMED', {
        orderId: id,
        openid: req.user.unionid,
        phone: confirmDisplayName
      });
    }

    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

router.post('/client/gallery/list', authenticateToken, async (req, res) => {
  try {
    const modelsRes = await pool.query('SELECT uuid, title FROM "yizi_model"');
    const modelMap = {};
    modelsRes.rows.forEach(m => modelMap[m.uuid] = m.title);

    // Also pre-fetch template/SKU names for resolving planId -> name
    const skuPk = await getPrimaryKeyColumn('yizi_sku');
    const skuRes = await pool.query(`SELECT "${skuPk}", title FROM "yizi_sku"`);
    const skuMap = {};
    skuRes.rows.forEach(s => skuMap[s[skuPk]] = s.title);

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
            try { orderData = JSON.parse(row.order_data); } catch(e){
              console.error('[Gallery List] Failed to parse order data JSON:', e.message);
            }
        } else {
            orderData = row.order_data || {};
        }
        return {
            id: row.id,
            url: row.url,
            orderId: row.order_id,
            date: row.created_at,
            model: modelMap[orderData.model_uuid] || orderData.model_name || orderData.model_uuid || 'Unknown',
            template: orderData.planTitle || skuMap[orderData.planId] || 'Unknown',
            sourceImages: orderData.sets?.[0]?.images?.filter(i=>i) || []
        };
    });
    res.json({ msg: 'ok', result: list });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// Fetch prompts bound to a SKU (for slash commands)
router.post('/client/sku/prompts', authenticateToken, async (req, res) => {
  try {
    const { planId } = req.body;
    if (!planId) return res.json({ msg: 'err', info: 'Missing planId' });

    const skuRes = await pool.query('SELECT data FROM yizi_sku WHERE id = $1', [planId]);
    if (skuRes.rows.length === 0) return res.json({ msg: 'err', info: 'SKU not found' });
    
    const skuData = typeof skuRes.rows[0].data === 'string' ? JSON.parse(skuRes.rows[0].data) : (skuRes.rows[0].data || {});
    const promptSetIdsStr = skuData.prompt_set_ids || skuData.prompt_set_id; // backward compatible
    if (!promptSetIdsStr) return res.json({ msg: 'ok', result: [] }); // No prompt library bound
    
    const setIds = String(promptSetIdsStr).split(',').filter(Boolean);
    if (setIds.length === 0) return res.json({ msg: 'ok', result: [] });

    const resultList = (await Promise.all(setIds.map(async (setId) => {
        const [setRes, promptRes] = await Promise.all([
            pool.query('SELECT title FROM yizi_prompt_sets WHERE id = $1', [setId]),
            pool.query('SELECT id, content, data FROM yizi_prompts WHERE set_id = $1 ORDER BY id DESC', [setId])
        ]);
        if (setRes.rows.length === 0) return null;
        const setTitle = setRes.rows[0].title;
        const prompts = promptRes.rows.map(r => {
            const pData = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {});
            return {
                id: r.id,
                title: pData.title || r.id,
                description: pData.description || '',
                preview_img: pData.preview_img || '',
                content: r.content || ''
            };
        });
        if (prompts.length > 0) {
            return { set_id: setId, set_title: setTitle, prompts };
        }
        return null;
    }))).filter(Boolean);
    
    res.json({ msg: 'ok', result: resultList });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// POST /client/model/poses — Get pose images for a model+template combination
router.post('/client/model/poses', authenticateToken, async (req, res) => {
  try {
    const { model_uuid, planId } = req.body;
    if (!model_uuid) return res.json({ msg: 'ok', result: [] });

    // 1. Resolve body_type from yizi_sku.data → correct pose key inside model.data
    let poseKey = 'poses'; // default: fullbody
    if (planId) {
      try {
        const skuPk = await getPrimaryKeyColumn('yizi_sku');
        const skuRes = await pool.query(`SELECT data FROM "yizi_sku" WHERE "${skuPk}" = $1`, [planId]);
        if (skuRes.rows.length > 0) {
          const skuData = typeof skuRes.rows[0].data === 'string' ? JSON.parse(skuRes.rows[0].data) : (skuRes.rows[0].data || {});
          if (skuData.body_type === '半身') poseKey = 'half_poses';
          else if (skuData.body_type === '特殊') poseKey = 'special_poses';
          // Allow explicit pose_folder override from SKU config
          if (skuData.pose_folder) {
            const folderToKey = { 'poses': 'poses', 'half_poses': 'half_poses', 'special_poses': 'special_poses' };
            poseKey = folderToKey[skuData.pose_folder] || poseKey;
          }
        }
      } catch (e) {
        console.warn('[Pose] Failed to resolve SKU body_type, using default poses key:', e.message);
      }
    }

    // 2. Fetch model data JSON and extract the correct pose array
    const result = await pool.query('SELECT data FROM yizi_model WHERE uuid = $1', [model_uuid]);
    if (result.rows.length === 0) return res.json({ msg: 'ok', result: [] });

    const modelData = typeof result.rows[0].data === 'string' ? JSON.parse(result.rows[0].data) : (result.rows[0].data || {});

    // 3. Extract pose list from the correct key
    let list = [];
    const raw = modelData[poseKey];
    if (raw) {
      if (Array.isArray(raw)) {
        list = raw;
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('[')) {
          try { list = JSON.parse(trimmed); } catch (e) {
            list = trimmed.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
          }
        } else {
          list = trimmed.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }

    res.json({ msg: 'ok', result: list.filter(Boolean) });
  } catch (err) {
    console.error('[Pose API Error]', err);
    res.json({ msg: 'err', info: err.message });
  }
});

export default router;
