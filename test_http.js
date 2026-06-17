import http from 'http';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const token = jwt.sign({ account: 'admin', is_super: true, role_id: 1 }, process.env.JWT_SECRET || 'fallback_secret');

const req = http.request({
  hostname: '127.0.0.1',
  port: 3000,
  path: '/admin/yizi_model/list',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Response: ${data}`);
  });
});

req.on('error', error => {
  console.error(error);
});

req.write(JSON.stringify({
  page: 1,
  limit: 1,
  conditions: { uuid: 'mod_b5c2a4edc55e7b97' }
}));
req.end();
