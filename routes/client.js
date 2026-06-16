import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool, getPrimaryKeyColumn } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { formatOrderRow } from '../utils/helpers.js';
import { getOSSToken } from '../utils/oss.js';
import { runPipeline } from '../pipeline/index.js';
import { orderEventEmitter } from '../events.js';

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
                prompt: set.prompt || data.prompt || set.extra_prompt || '',
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

    // We removed the self-notification:
    // orderEventEmitter.emit(`orderUpdate:${req.user.unionid}`, { orderId: id, event: 'COMMENT_ADDED' });

    // Trigger Feishu Notification
    orderEventEmitter.emit('NOTIFY_NEW_COMMENT', {
      orderId: id,
      openid: req.user.unionid,
      phone: req.user.phone || '',
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

    // 5) Trigger SSE to refresh the user's view
    orderEventEmitter.emit(`orderUpdate:${req.user.unionid}`, { 
      orderId: id, 
      event: 'ORDER_CONFIRMED' 
    });

    // Trigger Feishu Notification
    orderEventEmitter.emit('NOTIFY_ORDER_CONFIRMED', {
      orderId: id,
      openid: req.user.unionid,
      phone: req.user.phone || ''
    });

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
            model: modelMap[orderData.model_uuid] || orderData.model_uuid || 'Unknown',
            template: orderData.planTitle || 'Unknown',
            sourceImages: orderData.sets?.[0]?.images?.filter(i=>i) || []
        };
    });
    res.json({ msg: 'ok', result: list });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

export default router;
