import express from 'express';
import crypto from 'crypto';
import { pool } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// GET /admin/settings
router.get('/admin/settings', authenticateToken, async (req, res) => {
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
router.post('/admin/settings', authenticateToken, async (req, res) => {
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

export default router;
