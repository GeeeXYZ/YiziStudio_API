import { pool } from './config/db.js';

async function investigate() {
  // Get the last 5 pipeline logs
  const logRes = await pool.query(
    `SELECT id, order_id, status, progress, error_msg, 
            result_images,
            created_at, updated_at
     FROM yizi_api_logs
     ORDER BY created_at DESC LIMIT 5`
  );
  
  console.log(`=== Last 5 API Logs ===\n`);
  for (const row of logRes.rows) {
    console.log(`--- ${row.id} ---`);
    console.log(`  order_id:   ${row.order_id}`);
    console.log(`  status:     ${row.status}`);
    console.log(`  progress:   ${row.progress}`);
    console.log(`  error_msg:  ${row.error_msg || '(none)'}`);
    console.log(`  created_at: ${row.created_at}`);
    console.log(`  updated_at: ${row.updated_at}`);
    
    let ri = row.result_images;
    if (typeof ri === 'string') { try { ri = JSON.parse(ri); } catch(e){} }
    if (ri && ri.final_images) {
      console.log(`  final_images count: ${ri.final_images.length}`);
      if (ri.final_images.length > 0) console.log(`  first image: ${ri.final_images[0]?.substring(0, 120)}`);
    } else {
      console.log(`  result_images: ${ri ? JSON.stringify(ri).substring(0, 200) : 'NULL'}`);
    }
    console.log('');
  }

  // Check the specific order's delivery_imgs
  const orderRes = await pool.query(
    `SELECT id, openid, completed, wait_delivery, data 
     FROM yizi_orders 
     WHERE id = 'ord_64b284ea764435aa'`
  );
  if (orderRes.rows.length > 0) {
    const o = orderRes.rows[0];
    const d = o.data || {};
    console.log(`=== Order ord_64b284ea764435aa ===`);
    console.log(`  openid: ${o.openid}, completed: ${o.completed}, wait_delivery: ${o.wait_delivery}`);
    console.log(`  data.workflow: ${d.workflow}`);
    if (d.sets) {
      for (let i = 0; i < d.sets.length; i++) {
        const s = d.sets[i];
        console.log(`  sets[${i}].delivery_imgs count: ${s.delivery_imgs?.length || 0}`);
        console.log(`  sets[${i}].upload_errors: ${JSON.stringify(s.upload_errors || null)?.substring(0, 300)}`);
        if (s.delivery_imgs && s.delivery_imgs.length > 0) {
          console.log(`    first delivery: ${s.delivery_imgs[0].img?.substring(0, 120)}`);
        }
      }
    } else {
      console.log(`  data.sets: undefined`);
    }
  }

  process.exit(0);
}

investigate().catch(e => { console.error(e); process.exit(1); });
