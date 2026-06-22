import { pool } from './config/db.js';

async function investigate() {
  // Find logs for this specific order
  const logRes = await pool.query(
    `SELECT id, order_id, model, status, progress, error_msg, result_images, created_at, updated_at
     FROM yizi_api_logs 
     WHERE order_id = 'ord_64b284ea764435aa'
     ORDER BY created_at DESC LIMIT 5`
  );
  
  console.log(`=== Found ${logRes.rows.length} logs for ord_64b284ea764435aa ===`);
  for (const row of logRes.rows) {
    console.log(`\n--- Log ID: ${row.id} ---`);
    console.log(`  status: ${row.status}`);
    console.log(`  progress: ${row.progress}`);
    console.log(`  error_msg: ${row.error_msg || '(none)'}`);
    console.log(`  created_at: ${row.created_at}`);
    console.log(`  updated_at: ${row.updated_at}`);
    
    let images = row.result_images;
    if (typeof images === 'string') {
      try { images = JSON.parse(images); } catch(e) {}
    }
    console.log(`  result_images type: ${typeof images}, isArray: ${Array.isArray(images)}`);
    if (images) console.log(`  result_images: ${JSON.stringify(images).substring(0, 800)}`);
    else console.log(`  result_images: NULL`);
  }
  
  // Also check the order to see if data has delivery_imgs
  const orderRes = await pool.query(
    `SELECT id, openid, completed, wait_delivery, data FROM yizi_orders WHERE id = 'ord_64b284ea764435aa'`
  );
  if (orderRes.rows.length > 0) {
    const order = orderRes.rows[0];
    const data = order.data || {};
    console.log('\n=== Order ===');
    console.log(`  openid: ${order.openid}`);
    console.log(`  completed: ${order.completed}`);
    console.log(`  wait_delivery: ${order.wait_delivery}`);
    if (data.sets && data.sets[0]) {
      const set0 = data.sets[0];
      console.log(`  sets[0] delivery_imgs count: ${set0.delivery_imgs?.length || 0}`);
      console.log(`  sets[0] upload_errors: ${JSON.stringify(set0.upload_errors)?.substring(0, 500)}`);
    }
  } else {
    console.log('\n=== Order NOT FOUND ===');
  }

  process.exit(0);
}

investigate().catch(e => { console.error(e); process.exit(1); });
