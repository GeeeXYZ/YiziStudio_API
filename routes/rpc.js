import express from 'express';
import crypto from 'crypto';
import OSS from 'ali-oss';
import { pool, getPrimaryKeyColumn, getTableColumns } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { checkRbacPermission, checkLogicalModule } from '../middleware/rbac.js';
import { getActualTableName, unpackRow, prepareQueryValue } from '../utils/helpers.js';
import { getOSSToken, extractOSSKeys, deleteOSSObjects } from '../utils/oss.js';
import { orderEventEmitter } from '../events.js';

const router = express.Router();

// 2. RPC Main Handler Core
const rpcHandler = async (req, res) => {
  // If invoked via generic route, module is from params, otherwise default to admin for explicit routes
  const module = req.params.module || (req.path.startsWith('/client/') ? 'client' : 'admin');
  
  // If db_name is not provided in params (i.e., explicit route), infer it from the path
  let rawDbName = req.params.db_name;
  if (!rawDbName) {
    const segments = req.path.split('/');
    // e.g. /admin/yizi_cases/list -> segments: ['', 'admin', 'yizi_cases', 'list']
    rawDbName = segments[2];
  }
  const db_name = getActualTableName(rawDbName);
  
  // Action is always from params because of :action(*)
  const action = req.params.action;
  const params = req.body;

  try {
    // ----------------------------------------------------
    // Custom Handlers for Special Table / Action overrides
    // ----------------------------------------------------

    if (db_name === 'yizi_users' && action === 'topup') {
      const { user_id, amount, remark, actual_payment } = params;
      const numAmount = parseFloat(amount);
      const paymentAmount = parseInt(actual_payment) || 0;
      
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
          operator: req.user.account,
          actual_payment: paymentAmount
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

      if (module === 'client' && db_name === 'yizi_model') {
        let userModels = [];
        if (req.user) {
          try {
            const userRes = await pool.query('SELECT * FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $1', [req.user.unionid || req.user.phone]);
            if (userRes.rows.length > 0) {
              const u = userRes.rows[0];
              let uData = {};
              if (typeof u.data === 'string') {
                try { uData = JSON.parse(u.data); } catch(e) {}
              } else if (u.data) {
                uData = u.data;
              }
              const exclusiveStr = u.exclusive_models || uData.exclusive_models;
              if (exclusiveStr) {
                userModels = exclusiveStr.split(',').filter(Boolean);
              }
            }
          } catch(e) {
            console.error('[Client Model List Filter Error]', e);
          }
        }
        
        const validCols = await getTableColumns(db_name);
        let exclusiveCondition = '';
        if (validCols.includes('is_exclusive')) {
          exclusiveCondition = `("is_exclusive" IS NULL OR "is_exclusive" = false OR "is_exclusive"::text = 'false' OR "is_exclusive"::text = '0')`;
        } else {
          exclusiveCondition = `(data->>'is_exclusive' IS NULL OR data->>'is_exclusive' = 'false' OR data->>'is_exclusive' = '0')`;
        }

        if (userModels.length > 0) {
          const inPlaceholders = userModels.map((_, i) => `$${placeholderIdx + i}`).join(', ');
          let idChecks = [];
          if (validCols.includes('uuid')) idChecks.push(`"uuid" IN (${inPlaceholders})`);
          if (validCols.includes('id')) idChecks.push(`"id" IN (${inPlaceholders})`);
          if (idChecks.length === 0) idChecks.push(`data->>'uuid' IN (${inPlaceholders})`);
          
          exclusiveCondition = `(${exclusiveCondition} OR ${idChecks.join(' OR ')})`;
          values.push(...userModels);
          placeholderIdx += userModels.length;
        }
        
        whereClauses.push(exclusiveCondition);
      }

      if (module === 'client' && db_name === 'yizi_sku') {
        let userTemplates = [];
        if (req.user) {
          try {
            const userRes = await pool.query('SELECT * FROM "yizi_users" WHERE "user_id" = $1 OR "phone_number" = $1', [req.user.unionid || req.user.phone]);
            if (userRes.rows.length > 0) {
              const u = userRes.rows[0];
              let uData = {};
              if (typeof u.data === 'string') {
                try { uData = JSON.parse(u.data); } catch(e) {}
              } else if (u.data) {
                uData = u.data;
              }
              const exclusiveStr = u.exclusive_templates || uData.exclusive_templates;
              if (exclusiveStr) {
                userTemplates = exclusiveStr.split(',').filter(Boolean);
              }
            }
          } catch(e) {
            console.error('[Client SKU List Filter Error]', e);
          }
        }
        
        const validCols = await getTableColumns(db_name);
        let exclusiveCondition = '';
        if (validCols.includes('is_exclusive')) {
          exclusiveCondition = `("is_exclusive" IS NULL OR "is_exclusive" = false OR "is_exclusive"::text = 'false' OR "is_exclusive"::text = '0')`;
        } else {
          exclusiveCondition = `(data->>'is_exclusive' IS NULL OR data->>'is_exclusive' = 'false' OR data->>'is_exclusive' = '0')`;
        }

        if (userTemplates.length > 0) {
          const inPlaceholders = userTemplates.map((_, i) => `$${placeholderIdx + i}`).join(', ');
          let idChecks = [];
          if (validCols.includes('uuid')) idChecks.push(`"uuid" IN (${inPlaceholders})`);
          if (validCols.includes('id')) idChecks.push(`"id" IN (${inPlaceholders})`);
          if (idChecks.length === 0) idChecks.push(`data->>'uuid' IN (${inPlaceholders})`);
          
          exclusiveCondition = `(${exclusiveCondition} OR ${idChecks.join(' OR ')})`;
          values.push(...userTemplates);
          placeholderIdx += userTemplates.length;
        }
        
        whereClauses.push(exclusiveCondition);
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      
      // Get total count
      const countQuery = `SELECT COUNT(*) FROM "${db_name}" ${whereSql}`;
      const countResult = await pool.query(countQuery, values);
      const total = parseInt(countResult.rows[0].count, 10);

      // Get page rows
      const pk = await getPrimaryKeyColumn(db_name);
      // Allow caller to specify sort column; fallback to pk
      let orderBySql = `"${pk}" DESC NULLS LAST`;
      if (Array.isArray(params.sort_by)) {
        const validCols = await getTableColumns(db_name);
        const parts = [];
        for (const s of params.sort_by) {
          if (validCols.includes(s.column)) {
            let dirStr = 'DESC NULLS LAST';
            if (s.dir) {
              const upperDir = s.dir.toUpperCase();
              if (upperDir === 'ASC NULLS FIRST') dirStr = 'ASC NULLS FIRST';
              else if (upperDir === 'ASC') dirStr = 'ASC';
              else if (upperDir === 'DESC NULLS FIRST') dirStr = 'DESC NULLS FIRST';
            }
            parts.push(`"${s.column}" ${dirStr}`);
          }
        }
        if (parts.length > 0) orderBySql = parts.join(', ');
      } else if (params.sort_by) {
        const sortDir = (params.sort_dir && params.sort_dir.toUpperCase() === 'ASC') ? 'ASC' : 'DESC NULLS LAST';
        orderBySql = `"${params.sort_by}" ${sortDir}`;
      }
      
      const limitIdx = placeholderIdx;
      const offsetIdx = placeholderIdx + 1;
      const listQuery = `SELECT * FROM "${db_name}" ${whereSql} ORDER BY ${orderBySql} LIMIT $${limitIdx} OFFSET $${offsetIdx}`;
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
        
        if (db_name === 'yizi_comments' && rawData.type === 'admin') {
            rawData.name = req.user?.account || 'Admin';
        }

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
        
        // --- yizi_comments SSE injection ---
        if (db_name === 'yizi_comments' && result.rows.length > 0) {
            const row = result.rows[0];
            if (row.type === 'admin' && row.delivery_uuid) {
                try {
                    const orderRes = await pool.query(`SELECT id, openid FROM "yizi_orders" WHERE data::text LIKE $1 LIMIT 1`, [`%${row.delivery_uuid}%`]);
                    if (orderRes.rows.length > 0) {
                        const orderOpenid = orderRes.rows[0].openid;
                        const orderId = orderRes.rows[0].id;
                        if (orderOpenid) {
                            orderEventEmitter.emit(`orderUpdate:${orderOpenid}`, { 
                                orderId: orderId, 
                                event: 'ADMIN_REPLY',
                                comment: row
                            });
                        }
                    }
                } catch (err) {
                    console.error('[Post-insert hook] yizi_comments SSE error:', err);
                }
            }
        }
        
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
        let oldRowData = null;
        try {
          const oldResult = await pool.query(`SELECT * FROM "${db_name}" WHERE "${pk}" = $1`, [id]);
          if (oldResult.rows.length > 0) {
            oldRowData = oldResult.rows[0];
            oldKeys = extractOSSKeys(oldRowData);
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
            const newCompleted = result.rows[0].completed === '1';
            const oldCompleted = oldRowData ? (oldRowData.completed === '1' || oldRowData.completed === 1) : false;

            if (rowOpenid) {
                // Find new delivery_imgs IDs
                const freshDeliveryIds = [];
                try {
                    const oldData = typeof oldRowData?.data === 'string' ? JSON.parse(oldRowData.data) : (oldRowData?.data || {});
                    const newData = typeof result.rows[0].data === 'string' ? JSON.parse(result.rows[0].data) : (result.rows[0].data || {});
                    
                    const oldIds = new Set();
                    (oldData.sets || []).forEach(s => (s.delivery_imgs || []).forEach(d => d.id && oldIds.add(d.id)));
                    
                    (newData.sets || []).forEach(s => (s.delivery_imgs || []).forEach(d => {
                        if (d.id && !oldIds.has(d.id)) freshDeliveryIds.push(d.id);
                    }));
                } catch(e) {}

                orderEventEmitter.emit(`orderUpdate:${rowOpenid}`, { 
                    orderId: id, 
                    event: 'ADMIN_UPDATE',
                    completed: newCompleted,
                    freshDeliveryIds
                });

                if (newCompleted && !oldCompleted) {
                    orderEventEmitter.emit('NOTIFY_DELIVERY_COMPLETE', {
                        orderId: id
                    });
                }
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
  } catch (err) {
    console.error(`[RPC Error] ${db_name}/${action}`, err);
    res.json({ msg: 'err', info: 'Server internal error', error: err.message });
  }
};

// ----------------------------------------------------
// Route Registrations
// ----------------------------------------------------

// Explicit Domain Overrides (Intercepted before generic RPC to map logical permissions)
router.post('/admin/yizi_cases/:action(*)', authenticateToken, checkLogicalModule('workflow'), rpcHandler);
router.post('/admin/yizi_prompt_sets/:action(*)', authenticateToken, checkLogicalModule('prompts'), rpcHandler);
router.post('/admin/yizi_prompt_groups/:action(*)', authenticateToken, checkLogicalModule('prompts'), rpcHandler);
router.post('/admin/yizi_prompts/:action(*)', authenticateToken, checkLogicalModule('prompts'), rpcHandler);
router.post('/admin/yizi_oss_delivery_imgs/:action(*)', authenticateToken, checkLogicalModule('workspace'), rpcHandler);

// Shared Tables across multiple logical modules
router.post('/admin/yizi_orders/:action(*)', authenticateToken, checkLogicalModule(['orders', 'workspace']), rpcHandler);
router.post('/admin/yizi_comments/:action(*)', authenticateToken, checkLogicalModule(['orders', 'workspace']), rpcHandler);
router.post('/admin/yizi_model/:action(*)', authenticateToken, checkLogicalModule(['model', 'workspace']), rpcHandler);
// Generic RPC Fallback (Requires exact table permission)
router.post(['/rpc/:module/:db_name/:action(*)', '/admin/:db_name/:action(*)', '/client/:db_name/:action(*)'], authenticateToken, checkRbacPermission, rpcHandler);

export default router;
