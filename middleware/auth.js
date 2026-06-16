import jwt from 'jsonwebtoken';

// Middleware for auth
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  
  const isPublic = req.path.includes('/client/model/list') || req.path.includes('/client/template/list') || req.path.includes('/client/tag/list');

  if (!token) {
    if (isPublic) {
      req.user = null;
      return next();
    }
    return res.status(401).json({ msg: 'err', info: 'No token provided' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) {
      if (isPublic) {
        req.user = null;
        return next();
      }
      return res.status(403).json({ msg: 'err', info: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user || !req.user.is_super) {
    return res.status(403).json({ msg: 'err', info: 'Forbidden: 仅超级管理员可操作' });
  }
  next();
};

export { authenticateToken, requireSuperAdmin };
