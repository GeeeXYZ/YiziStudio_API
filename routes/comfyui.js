import express from 'express';
import { pool } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { getOSSToken } from '../utils/oss.js';

const router = express.Router();

// 7.5 ComfyUI Dedicated API: Get order detail formatted for FetchOrderDataByOrderID node
router.post('/comfyui/order/get', authenticateToken, async (req, res) => {
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
router.post('/comfyui/order/sts', authenticateToken, async (req, res) => {
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

// 7.7 ComfyUI Dedicated API: Auto-delivery webhook from ImagesUploader_secured
router.post('/comfyui/order/deliver', authenticateToken, async (req, res) => {
  const { order_id, index, images } = req.body;
  if (!order_id || !images || !Array.isArray(images)) {
    return res.json({ msg: 'err', info: 'Missing required fields or invalid images format' });
  }

  // ComfyUI may pass "openid.order_id" as order_id if token generation needs it, so handle split
  let actualOrderId = order_id;
  if (order_id.includes('.')) {
    actualOrderId = order_id.split('.').slice(1).join('.');
  }

  try {
    const pgClient = await pool.connect();
    try {
      await pgClient.query('BEGIN');
      const selectRes = await pgClient.query('SELECT data FROM "yizi_orders" WHERE id = $1 FOR UPDATE', [actualOrderId]);
      
      if (selectRes.rows.length === 0) {
        throw new Error('Order not found');
      }

      const orderData = selectRes.rows[0].data || {};
      if (!orderData.sets) orderData.sets = [{}];
      const setIndex = parseInt(index) || 0;
      if (!orderData.sets[setIndex]) orderData.sets[setIndex] = {};
      
      if (!orderData.sets[setIndex].delivery_imgs) {
        orderData.sets[setIndex].delivery_imgs = [];
      }

      for (const imgUrl of images) {
        orderData.sets[setIndex].delivery_imgs.push({
          id: `del_comfy_${Date.now()}_${Math.random().toString(36).substr(2,4)}`,
          img: imgUrl
        });
      }

      await pgClient.query('UPDATE "yizi_orders" SET data = $1, wait_delivery = $2, updated_at = NOW() WHERE id = $3', [orderData, '0', actualOrderId]);
      await pgClient.query('COMMIT');
      
      console.log(`[ComfyUI Auto Delivery] Successfully saved ${images.length} images to order ${actualOrderId}`);
      
      // Notify Feishu and Frontend SSE
      import('../events.js').then(({ orderEventEmitter }) => {
        orderEventEmitter.emit('NOTIFY_DELIVERY_COMPLETE', { orderId: actualOrderId });
        orderEventEmitter.emit(`orderUpdate:${row.openid}`, { orderId: actualOrderId, event: 'DELIVERY_UPDATE' });
      }).catch(err => console.error('[Pipeline] Failed to load event emitter:', err));

      res.json({ msg: 'ok', info: 'Delivery success' });
    } catch (err) {
      await pgClient.query('ROLLBACK');
      throw err;
    } finally {
      pgClient.release();
    }
  } catch (error) {
    console.error('[ComfyUI Delivery Error]', error);
    res.json({ msg: 'err', info: error.message });
  }
});

export default router;
