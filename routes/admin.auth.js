import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from '../config/db.js';
import { authenticateToken, requireSuperAdmin } from '../middleware/auth.js';

const router = express.Router();

// 1. HTTP POST: /admin/login
router.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ msg: 'err', info: '邮箱地址和密码不能为空' });
  }

  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  try {
    const result = await pool.query('SELECT * FROM "yizi_admins" WHERE "email" = $1', [email]);
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
        const token = jwt.sign({ email: adminUser.email, is_super: adminUser.is_super, role_id: adminUser.role_id }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d' });
        return res.json({ msg: 'ok', result: { token, email: adminUser.email, is_super: adminUser.is_super, role_id: adminUser.role_id, permissions, visible_projects } });
      }
    }
    res.json({ msg: 'err', info: '用户名或密码错误' });
  } catch (error) {
    console.error('[Login Error]', error);
    res.json({ msg: 'err', info: '数据库连接或查询失败，请检查是否已在 Supabase 运行 SQL 创建 yizi_admins 表' });
  }
});

router.post('/admin/logout', (req, res) => {
  res.json({ msg: 'ok' });
});

router.post('/admin/check', authenticateToken, (req, res) => {
  res.json({ msg: 'ok', result: { valid: true } });
});

router.post('/admin/reset_psw', authenticateToken, async (req, res) => {
  const { oldpwd, newpwd } = req.body;
  const email = req.user.email || req.user.account; // fallback for older tokens
  const oldHashed = crypto.createHash('sha256').update(oldpwd).digest('hex');
  const newHashed = crypto.createHash('sha256').update(newpwd).digest('hex');
  try {
    const result = await pool.query('SELECT password FROM "yizi_admins" WHERE email = $1', [email]);
    if (result.rows.length === 0 || result.rows[0].password !== oldHashed) {
      return res.json({ msg: 'err', info: '旧密码错误' });
    }
    await pool.query('UPDATE "yizi_admins" SET password = $1 WHERE email = $2', [newHashed, email]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

// Admin management APIs
router.post('/admin_list', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, is_super, role_id, data, created_at FROM "yizi_admins" ORDER BY id ASC');
    res.json({ msg: 'ok', result: result.rows });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

router.post('/admin_add', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ msg: 'err', info: 'Email is required' });
  const account = email.split('@')[0];
  const tempPassword = '123456'; 
  const hashedPassword = crypto.createHash('sha256').update(tempPassword).digest('hex');
  try {
    await pool.query(
      'INSERT INTO "yizi_admins" (password, email, is_super) VALUES ($1, $2, $3)',
      [hashedPassword, email, false]
    );
    res.json({ msg: 'ok', info: `已成功创建管理员：${email}，默认密码为：123456` });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

router.post('/admin_delete', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('DELETE FROM "yizi_admins" WHERE email = $1', [email]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

router.post('/admin_reset_secret', authenticateToken, requireSuperAdmin, async (req, res) => {
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

router.post('/admin_toggle_super', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { email, is_super } = req.body;
  try {
    await pool.query('UPDATE "yizi_admins" SET is_super = $1 WHERE email = $2', [is_super, email]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

router.post('/admin_update_role', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { email, role_id } = req.body;
  try {
    await pool.query('UPDATE "yizi_admins" SET role_id = $1 WHERE email = $2', [role_id, email]);
    res.json({ msg: 'ok' });
  } catch (error) {
    res.json({ msg: 'err', info: error.message });
  }
});

export default router;
