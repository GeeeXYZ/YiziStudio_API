import { pool } from '../config/db.js';

// RBAC Permission Check middleware for the generic RPC channel
const checkRbacPermission = async (req, res, next) => {
  const module = req.params.module || (req.path.startsWith('/client/') ? 'client' : 'admin');
  
  if (module === 'admin' && (!req.user || !req.user.is_super)) {
    const { getActualTableName } = await import('../utils/helpers.js');
    const db_name = getActualTableName(req.params.db_name);
    const action = req.params.action;
    
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

  next();
};

const checkPermission = (requiredPermission) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ msg: 'err', info: 'Unauthorized' });
    }
    if (req.user.is_super) {
      return next(); // Superadmin bypasses specific permission checks
    }
    if (!req.user.role_id) {
      return res.status(403).json({ msg: 'err', info: 'Forbidden: 账号未分配任何角色权限' });
    }
    try {
      const roleRes = await pool.query('SELECT permissions FROM "yizi_roles" WHERE id = $1', [req.user.role_id]);
      let userPerms = [];
      if (roleRes.rows.length > 0 && roleRes.rows[0].permissions) {
        userPerms = typeof roleRes.rows[0].permissions === 'string' ? JSON.parse(roleRes.rows[0].permissions) : roleRes.rows[0].permissions;
      }
      if (!userPerms.includes(requiredPermission)) {
        return res.status(403).json({ msg: 'err', info: `Forbidden: 缺少必需权限 [${requiredPermission}]` });
      }
      next();
    } catch (err) {
      console.error('[checkPermission Error]', err);
      return res.status(500).json({ msg: 'err', info: '内部服务器错误' });
    }
  };
};

export { checkRbacPermission, checkPermission };
