import http from 'http';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const token = jwt.sign({ account: 'admin', is_super: true, role_id: 1 }, process.env.JWT_SECRET || 'fallback_secret');

const req = http.request({
  hostname: '127.0.0.1',
  port: 3000,
  path: '/admin/yizi_orders/list',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      if (parsed.result && parsed.result.list && parsed.result.list.length > 0) {
        const firstOrder = parsed.result.list[0];
        console.log(`Latest Order ID: ${firstOrder.id}`);
        console.log(`Has model_uuid: ${!!firstOrder.model_uuid}`);
        console.log(`model_uuid value: ${firstOrder.model_uuid}`);
        console.log(`Has sets: ${!!firstOrder.sets}`);
      } else {
        console.log("Empty list");
      }
    } catch(e) {
      console.log(`Failed to parse: ${e.message}`);
    }
  });
});

req.on('error', error => {
  console.error(error);
});

req.write(JSON.stringify({
  page: 1,
  limit: 1,
  sort_by: 'datetime'
}));
req.end();
