import jwt from 'jsonwebtoken';

// Middleware for auth
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  // Support Bearer token OR token in query string (useful for SSE EventSource)
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  
  if (!token) return res.status(401).json({ msg: 'err', info: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) return res.status(403).json({ msg: 'err', info: 'Invalid token' });
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
