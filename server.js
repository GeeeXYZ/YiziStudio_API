import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import pg from 'pg';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Database connection
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/yizi',
});

// Middleware for auth
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ msg: 'err', info: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) return res.status(403).json({ msg: 'err', info: 'Invalid token' });
    req.user = user;
    next();
  });
};

// 1. HTTP POST: /admin/login
app.post('/admin/login', async (req, res) => {
  const { account, password } = req.body;
  
  // TODO: Verify against database admin table
  if (account === 'admin' && password === '123456') {
    const token = jwt.sign({ account }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '7d' });
    return res.json({ msg: 'ok', result: { token, account } });
  }

  res.json({ msg: 'err', info: '用户名或密码错误' });
});

app.post('/admin/check', authenticateToken, (req, res) => {
    res.json({ msg: 'ok', result: { valid: true } });
});

// 2. RPC Main Channel
// Action path example: /admin/orders/list, /admin/sku/add
app.post('/rpc/:module/:db_name/:action', authenticateToken, async (req, res) => {
  const { module, db_name, action } = req.params;
  const params = req.body;

  try {
    if (action === 'list') {
      // Mock list implementation
      const page = params.page || 1;
      const pageSize = params.page_size || 10;
      // TODO: Real database query
      const result = await pool.query(`SELECT * FROM "${db_name}" LIMIT $1 OFFSET $2`, [pageSize, (page - 1) * pageSize]);
      
      return res.json({
        msg: 'ok',
        result: {
          list: result.rows,
          total: result.rowCount,
          page,
          page_size: pageSize
        }
      });
    }

    if (action === 'get') {
        const id = params.id;
        const result = await pool.query(`SELECT * FROM "${db_name}" WHERE id = $1`, [id]);
        return res.json({
            msg: 'ok',
            result: result.rows[0] || null
        });
    }

    if (action === 'add') {
        // Mock add implementation
        const fields = Object.keys(params.data || {});
        const values = Object.values(params.data || {});
        
        if (fields.length === 0) return res.json({ msg: 'err', info: 'No data provided' });
        
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
        
        const query = `INSERT INTO "${db_name}" (${fields.map(f => `"${f}"`).join(', ')}) VALUES (${placeholders}) RETURNING *`;
        const result = await pool.query(query, values);
        
        return res.json({ msg: 'ok', result: result.rows[0] });
    }

    // Default fallback
    res.json({ msg: 'err', info: 'Not implemented action' });
  } catch (error) {
    console.error(`[RPC Error] ${module}/${db_name}/${action}`, error);
    res.json({ msg: 'err', info: error.message });
  }
});

// STS Upload Route
app.post('/admin/sts', authenticateToken, async (req, res) => {
    // Return mock STS token for now. In production, request from Aliyun
    res.json({
        msg: 'ok',
        result: {
            AccessKeyId: 'mock_ak',
            AccessKeySecret: 'mock_sk',
            SecurityToken: 'mock_token',
            Expiration: new Date(Date.now() + 3600000).toISOString()
        }
    });
});

const PORT = process.env.PORT || 9000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Yizi Backend API is running on http://localhost:${PORT}`);
  });
}

export default app;
