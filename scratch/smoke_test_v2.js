import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const server = 'http://localhost:9000';

async function runTests() {
  console.log('=== Starting Integration Smoke Test ===\n');

  // Step 1: Admin Login (to get token for admin/rpc endpoints)
  console.log('1. Admin Login...');
  const loginRes = await fetch(`${server}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: '123456' })
  }).then(r => r.json());
  
  if (loginRes.msg !== 'ok') {
    throw new Error('Admin login failed: ' + loginRes.info);
  }
  const token = loginRes.result.token;
  console.log('   Admin token acquired.');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // Step 2: Test front_sku_settings get and reset
  console.log('\n2. Testing yizi_front_sku_settings...');
  const getSkuSettings = await fetch(`${server}/admin/front_sku_settings/get`, {
    method: 'POST',
    headers,
    body: JSON.stringify({})
  }).then(r => r.json());
  console.log('   Get Result:', getSkuSettings);
  if (getSkuSettings.msg !== 'ok') throw new Error('Get sku settings failed');

  const resetSkuSettings = await fetch(`${server}/admin/front_sku_settings/reset`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: { front_sku_settings: ['model_test_1', 'model_test_2'] } })
  }).then(r => r.json());
  console.log('   Reset Result:', resetSkuSettings);
  if (resetSkuSettings.msg !== 'ok') throw new Error('Reset sku settings failed');

  // Step 3: Test vip_settings CRUD
  console.log('\n3. Testing yizi_vip_settings CRUD...');
  const testVipPhone = '139' + Math.floor(Math.random() * 90000000 + 10000000);
  
  // Add VIP
  const addVip = await fetch(`${server}/admin/vip_settings/add`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mobi: testVipPhone, data: { model_ids: ['model_1'] } })
  }).then(r => r.json());
  console.log('   Add VIP Result:', addVip);
  if (addVip.msg !== 'ok') throw new Error('Add VIP failed');

  // List VIPs
  const listVips = await fetch(`${server}/admin/vip_settings/list`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conditions: { type: 'my_models' } })
  }).then(r => r.json());
  console.log('   List VIPs Count:', listVips.result?.list?.length);
  if (listVips.msg !== 'ok') throw new Error('List VIPs failed');

  // Reset VIP
  const resetVip = await fetch(`${server}/admin/vip_settings/reset`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mobi: testVipPhone, data: { model_ids: ['model_1', 'model_2'] } })
  }).then(r => r.json());
  console.log('   Reset VIP Result:', resetVip);
  if (resetVip.msg !== 'ok') throw new Error('Reset VIP failed');

  // Delete VIP
  const delVip = await fetch(`${server}/admin/vip_settings/del`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mobi: testVipPhone })
  }).then(r => r.json());
  console.log('   Delete VIP Result:', delVip);
  if (delVip.msg !== 'ok') throw new Error('Delete VIP failed');

  // Step 4: Test user points/ticket
  console.log('\n4. Testing user points/ticket...');
  // Create user first
  const testUserPhone = '135' + Math.floor(Math.random() * 90000000 + 10000000);
  const userLogin = await fetch(`${server}/client/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: testUserPhone, password: 'password123' })
  }).then(r => r.json());
  const userUnionid = userLogin.result.unionid;

  // Add 500 points to user
  const pointsTicket = await fetch(`${server}/admin/user/points/ticket`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: { openid: userUnionid, amount: 500 } })
  }).then(r => r.json());
  console.log('   Points Ticket Result:', pointsTicket);
  if (pointsTicket.msg !== 'ok' || pointsTicket.result?.points !== 1500) {
    throw new Error('Points ticket failed or incorrect final balance');
  }

  // Step 5: Test STS Credentials
  console.log('\n5. Testing Aliyun OSS STS endpoints...');
  const stsToken = await fetch(`${server}/admin/sts`, {
    method: 'POST',
    headers
  }).then(r => r.json());
  console.log('   STS General Result:', stsToken.msg);
  if (stsToken.msg !== 'ok') throw new Error('Get general STS token failed');

  const deliveryStsToken = await fetch(`${server}/admin/oss_delivery_imgs/upload/sts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ openid: 'usr_test', order_id: 'ord_test' })
  }).then(r => r.json());
  console.log('   STS Delivery Result:', deliveryStsToken.msg);
  if (deliveryStsToken.msg !== 'ok') throw new Error('Get delivery STS token failed');

  // Step 6: Test client user STS endpoint
  console.log('\n6. Testing /client/user/sts endpoint...');
  const clientStsToken = await fetch(`${server}/client/user/sts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userLogin.result.token}`
    },
    body: JSON.stringify({})
  }).then(r => r.json());
  console.log('   Client STS Result:', clientStsToken);
  if (clientStsToken.msg !== 'ok') throw new Error('Get client STS token failed');

  console.log('\n✅ All integration smoke tests PASSED successfully!');
}

runTests().catch(err => {
  console.error('\n❌ Smoke test failed:', err);
  process.exit(1);
});
