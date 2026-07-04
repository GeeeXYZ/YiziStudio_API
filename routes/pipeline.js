import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, getPrimaryKeyColumn, getTableColumns } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { runPipeline } from '../pipeline/index.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fetch default prompt from an order's workflow
router.get('/api_pipeline/order_prompt/:order_id', authenticateToken, async (req, res) => {
  try {
    const { order_id } = req.params;
    let workflow_json = null;
    console.log(`[order_prompt] Fetching prompt for order: ${order_id}`);

    const orderRes = await pool.query('SELECT data FROM "yizi_orders" WHERE id = $1', [order_id]);
    if (orderRes.rows.length > 0) {
      const orderData = typeof orderRes.rows[0].data === 'string' ? JSON.parse(orderRes.rows[0].data) : (orderRes.rows[0].data || {});
      console.log(`[order_prompt] orderData.workflow =`, orderData.workflow, `orderData.planId =`, orderData.planId);
      
      let workflow_uuid = orderData.workflow;
      
      if (!workflow_uuid && orderData.planId) {
        const skuPk = await getTableColumns('yizi_sku').then(cols => cols.includes('uuid') ? 'uuid' : 'id');
        const skuRes = await pool.query(`SELECT data FROM "yizi_sku" WHERE "${skuPk}" = $1`, [orderData.planId]);
        if (skuRes.rows.length > 0) {
          const skuData = typeof skuRes.rows[0].data === 'string' ? JSON.parse(skuRes.rows[0].data) : (skuRes.rows[0].data || {});
          console.log(`[order_prompt] skuData.workflow =`, skuData.workflow);
          workflow_uuid = skuData.workflow;
        } else {
           console.log(`[order_prompt] No SKU found for planId:`, orderData.planId);
        }
      }

      if (workflow_uuid) {
        const casePk = await getTableColumns('yizi_cases').then(cols => cols.includes('uuid') ? 'uuid' : 'id');
        const caseRes = await pool.query(`SELECT * FROM "yizi_cases" WHERE "${casePk}" = $1`, [workflow_uuid]);
        if (caseRes.rows.length > 0) {
           const row = caseRes.rows[0];
           const caseData = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
           workflow_json = row.workflow_json || caseData.workflow_json || caseData;
           console.log(`[order_prompt] Found workflow_json?`, !!workflow_json);
        } else {
           console.log(`[order_prompt] No case found for workflow UUID:`, workflow_uuid);
        }
      }
    } else {
       console.log(`[order_prompt] No order found for id:`, order_id);
    }

    if (!workflow_json) {
      console.log(`[order_prompt] Exiting early, no workflow_json`);
      return res.json({ msg: 'ok', result: { prompt: '' } });
    }

    let extractedPrompt = '';
    let wObj = typeof workflow_json === 'string' ? JSON.parse(workflow_json) : workflow_json;
    if (wObj && Array.isArray(wObj.nodes)) {
      const boardNode = wObj.nodes.find(n => n.type === 'prompt_board');
      if (boardNode) extractedPrompt = boardNode.data?.prompt || '';
      console.log(`[order_prompt] extractedPrompt length:`, extractedPrompt.length);
    } else {
      console.log(`[order_prompt] wObj.nodes is missing or not an array`);
    }

    res.json({ msg: 'ok', result: { prompt: extractedPrompt } });
  } catch (e) {
    console.error('[API Pipeline] Fetch order prompt error:', e.message);
    res.json({ msg: 'err', info: e.message });
  }
});

// API Pipeline Execution Endpoint (manual trigger from Dashboard)
router.post('/api_pipeline/trigger', authenticateToken, async (req, res) => {
  let { workflow_json, mock_order } = req.body;
  
  if (!workflow_json && mock_order?.order_id) {
    try {
      // Lookup the order's planId (SKU) to find the default workflow and populate order context
      const orderRes = await pool.query('SELECT * FROM "yizi_orders" WHERE id = $1', [mock_order.order_id]);
      if (orderRes.rows.length > 0) {
        const row = orderRes.rows[0];
        const orderData = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
        
        // Populate missing order details into mock_order
        mock_order.openid = mock_order.openid || row.openid;
        mock_order.model_uuid = mock_order.model_uuid || orderData.model_uuid;
        mock_order.model_name = mock_order.model_name || orderData.model_name;
        mock_order.prompt = mock_order.prompt || orderData.prompt;
        
        const setIndex = mock_order.set_index || 0;
        if (orderData.sets && orderData.sets[setIndex]) {
          mock_order.images = mock_order.images || orderData.sets[setIndex].images || [];
          mock_order.selectedPoseUrl = mock_order.selectedPoseUrl || orderData.sets[setIndex].selectedPoseUrl;
        }

        if (orderData.planId) {
          const skuPk = await getTableColumns('yizi_sku').then(cols => cols.includes('uuid') ? 'uuid' : 'id');
          const skuRes = await pool.query(`SELECT data FROM "yizi_sku" WHERE "${skuPk}" = $1`, [orderData.planId]);
          if (skuRes.rows.length > 0) {
            const skuData = typeof skuRes.rows[0].data === 'string' ? JSON.parse(skuRes.rows[0].data) : (skuRes.rows[0].data || {});
            
            mock_order.sku_pose_folder = mock_order.sku_pose_folder || skuData.poseFolder || 'poses';
            
            if (skuData.workflow) {
              const casePk = await getTableColumns('yizi_cases').then(cols => cols.includes('uuid') ? 'uuid' : 'id');
              const caseRes = await pool.query(`SELECT * FROM "yizi_cases" WHERE "${casePk}" = $1`, [skuData.workflow]);
              if (caseRes.rows.length > 0) {
                 const caseRow = caseRes.rows[0];
                 const caseData = typeof caseRow.data === 'string' ? JSON.parse(caseRow.data) : (caseRow.data || {});
                 workflow_json = caseRow.workflow_json || caseData.workflow_json || caseData;
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
router.get('/api_pipeline/logs', authenticateToken, async (req, res) => {
  try {
    // With local files, the result_images column only contains short URLs, so we can fetch directly.
    const query = `
      SELECT * FROM yizi_api_logs 
      ORDER BY created_at DESC 
      LIMIT 50
    `;
    const result = await pool.query(query);
    const data = result.rows.map(row => {
      let images = row.result_images;
      if (typeof images === 'string') {
         try { images = JSON.parse(images); } catch(e) { images = []; }
      }
      return {
        ...row,
        result_images: Array.isArray(images) ? images : []
      };
    });
    res.json({ msg: 'ok', data });
  } catch (err) {
    console.error('[Logs Error]', err);
    res.status(500).json({ msg: 'err', info: err.message });
  }
});

// POST /api_pipeline/fallback_oss
// Manually upload raw generated images from a log to OSS and attach to the order
router.post('/api_pipeline/fallback_oss', authenticateToken, async (req, res) => {
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
    const { uploadToOSS } = await import('../pipeline/index.js');
    const uploadedUrls = [];
    for (const img of pendingImages) {
       try {
         let uploadPayload = img;
         // If it's a local temp image, convert to data URI for uploadToOSS
         if (img.startsWith('/temp_images/')) {
            const filepath = path.join(__dirname, '..', img);
            if (fs.existsSync(filepath)) {
               const buffer = fs.readFileSync(filepath);
               const ext = path.extname(filepath).replace('.', '') || 'png';
               uploadPayload = `data:image/${ext};base64,${buffer.toString('base64')}`;
            } else {
               console.warn(`Local file not found for fallback: ${filepath}`);
               continue;
            }
         }
         
         const secureUrl = await uploadToOSS(ossClient, uploadPayload, orderInfo.openid, orderInfo.id, 0, `del_${Date.now()}`);
         uploadedUrls.push(secureUrl.replace('http://', 'https://'));
         
         // Optionally delete local temp file after success
         if (img.startsWith('/temp_images/')) {
            const filepath = path.join(__dirname, '..', img);
            fs.unlink(filepath, (err) => { if (err) console.error(err) });
         }
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
// Simulate Pipeline Execution (Dry Run)
router.post('/admin/workflow/test_run', authenticateToken, async (req, res) => {
  try {
    const { workflow_json, sku_id, model_uuid, prompt_slots, user_prompt, user_images, model_name } = req.body;
    if (!workflow_json) return res.status(400).json({ error: 'Missing workflow_json' });

    let skuData = {};
    if (sku_id) {
      const skuPk = await getTableColumns('yizi_sku').then(cols => cols.includes('uuid') ? 'uuid' : 'id');
      const skuRes = await pool.query(`SELECT data FROM "yizi_sku" WHERE "${skuPk}" = $1`, [sku_id]);
      if (skuRes.rows.length > 0) {
        skuData = typeof skuRes.rows[0].data === 'string' ? JSON.parse(skuRes.rows[0].data) : (skuRes.rows[0].data || {});
      }
    }

    const promptSetIds = String(skuData.prompt_set_ids || skuData.prompt_set_id || '').split(',').filter(Boolean).slice(0, 4);
    const resolvedSlots = await Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        const setId = promptSetIds[i];
        if (!setId) return '';
        
        // 1. Try to use frontend mocked slot
        const mockedSlot = (prompt_slots || [])[i];
        if (mockedSlot && mockedSlot.content) {
          return mockedSlot.content;
        }
        
        // 2. Randomly pick from the library
        try {
          const randomRes = await pool.query(
            'SELECT content FROM yizi_prompts WHERE set_id = $1 ORDER BY RANDOM() LIMIT 1', [setId]
          );
          return randomRes.rows[0]?.content || '';
        } catch (e) {
          console.warn(`[Pipeline Test] Failed to random pick from set ${setId}:`, e.message);
          return '';
        }
      })
    );

    const orderContext = {
      isRealOrder: false,
      order_id: 'test_order_' + Date.now(),
      model_uuid: model_uuid || '',
      images: user_images || [],
      prompt: user_prompt || '',
      prompt_slot_1: resolvedSlots[0] || '',
      prompt_slot_2: resolvedSlots[1] || '',
      prompt_slot_3: resolvedSlots[2] || '',
      prompt_slot_4: resolvedSlots[3] || '',
      model_name: model_name || 'Test Model',
      skuData: skuData
    };

    const result = await runPipeline(workflow_json, orderContext, pool, { simulate: true });
    return res.json({ msg: 'ok', data: result });
  } catch (err) {
    console.error('[Pipeline Test Error]', err);
    return res.json({ msg: 'err', info: err.message, traceLogs: err.traceLogs || [] });
  }
});

export default router;
