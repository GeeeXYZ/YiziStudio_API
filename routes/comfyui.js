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

export default router;
