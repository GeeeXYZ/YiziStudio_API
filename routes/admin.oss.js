import express from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { getOSSToken, deleteOSSObjects } from '../utils/oss.js';

const router = express.Router();

// STS Upload Route for general tmps upload
router.post('/admin/sts', authenticateToken, async (req, res) => {
  try {
    const token = await getOSSToken();
    res.json({ msg: 'ok', result: token });
  } catch (error) {
    console.error('[STS General Error]', error);
    res.json({ msg: 'err', info: error.message });
  }
});

// STS Upload Route for order delivery images upload
router.post('/admin/oss_delivery_imgs/upload/sts', authenticateToken, async (req, res) => {
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
router.post('/admin/oss/delete', authenticateToken, async (req, res) => {
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

export default router;
