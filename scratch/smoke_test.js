const test = async () => {
  const server = 'https://yizi-studio-apihub.vercel.app';
  const testPhone = '138' + Math.floor(Math.random() * 90000000 + 10000000);
  const testPassword = 'test_password_123';
  
  console.log(`\n=== 1. Testing user login/registration for phone: ${testPhone} ===`);
  const loginRes = await fetch(`${server}/wx/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: testPhone, password: testPassword })
  }).then(r => r.json());
  
  console.log('Login Result:', loginRes);
  if (loginRes.msg !== 'ok') {
    throw new Error('Login failed: ' + loginRes.info);
  }
  const { token, unionid } = loginRes.result;

  console.log(`\n=== 2. Testing get points (Expected: 1000) ===`);
  const pointsRes = await fetch(`${server}/wx/user/points`, {
    method: 'GET',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }).then(r => r.json());
  console.log('Points Result:', pointsRes);

  console.log(`\n=== 3. Testing order creation (Cost: 150 points) ===`);
  const orderPayload = {
    data: {
      planId: 'tmpl_test_sku',
      planTitle: 'Test Template SKU',
      model_uuid: 'mdl_test_model',
      sets: [
        {
          selectedPrice: 150,
          images: ['https://dummyimage.com/600x400/000/fff.png']
        }
      ]
    },
    phone: testPhone
  };
  const orderRes = await fetch(`${server}/wx/order/create`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(orderPayload)
  }).then(r => r.json());
  console.log('Create Order Result:', orderRes);
  if (orderRes.msg !== 'ok') {
    throw new Error('Order creation failed: ' + orderRes.info);
  }
  const createdOrderId = orderRes.result.id;

  console.log(`\n=== 4. Testing get points after deduction (Expected: 850) ===`);
  const pointsAfterRes = await fetch(`${server}/wx/user/points`, {
    method: 'GET',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  }).then(r => r.json());
  console.log('Points After Result:', pointsAfterRes);

  console.log(`\n=== 5. Testing order list (Expected: 1 order in list) ===`);
  const listRes = await fetch(`${server}/wx/order/list`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ page: 1, page_size: 10 })
  }).then(r => r.json());
  console.log('Order List Result:', listRes);
  if (listRes.msg === 'ok' && listRes.result.some(o => o.id === createdOrderId)) {
    console.log('\n✅ Integration test successfully PASSED!');
  } else {
    console.log('\n❌ Integration test FAILED to find the created order in order list.');
  }
};

test().catch(console.error);
