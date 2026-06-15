async function runTests() {
  const baseUrl = 'http://127.0.0.1:9000';
  let passed = 0;
  let failed = 0;

  console.log('🚀 开始执行接口自动回归测试 (第一级：健康与鉴权拦截检查)...\n');

  const testCases = [
    {
      name: '1. 健康检查 (GET /)',
      url: '/',
      method: 'GET',
      expectStatusCode: 200,
      expectBodySnippet: '"status":"ok"'
    },
    {
      name: '2. 管理端登录失败拦截 (POST /admin/login)',
      url: '/admin/login',
      method: 'POST',
      body: { account: 'invalid_user', password: 'wrong_password' },
      expectStatusCode: 200, // The legacy API always returns 200 but msg='err'
      expectBodySnippet: '"msg":"err"'
    },
    {
      name: '3. 客户端自动注册拦截 (POST /client/login)',
      url: '/client/login',
      method: 'POST',
      body: { phone: '', password: '' },
      expectStatusCode: 200,
      expectBodySnippet: '"msg":"err"'
    },
    {
      name: '4. 通用 RPC 未授权拦截 (POST /admin/sku/list)',
      url: '/admin/sku/list',
      method: 'POST',
      body: { page: 1 },
      expectStatusCode: 401,
      expectBodySnippet: 'No token provided'
    },
    {
      name: '5. Pipeline 未授权拦截 (POST /api_pipeline/trigger)',
      url: '/api_pipeline/trigger',
      method: 'POST',
      body: {},
      expectStatusCode: 401,
      expectBodySnippet: 'No token provided'
    }
  ];

  for (const tc of testCases) {
    try {
      const options = {
        method: tc.method,
        headers: { 'Content-Type': 'application/json' }
      };
      if (tc.body) options.body = JSON.stringify(tc.body);

      const res = await fetch(baseUrl + tc.url, options);
      const text = await res.text();

      let isSuccess = res.status === tc.expectStatusCode;
      if (tc.expectBodySnippet) {
        isSuccess = isSuccess && text.includes(tc.expectBodySnippet);
      }

      if (isSuccess) {
        console.log(`✅ [通过] ${tc.name}`);
        passed++;
      } else {
        console.log(`❌ [失败] ${tc.name}`);
        console.log(`   期待状态码: ${tc.expectStatusCode}, 实际: ${res.status}`);
        console.log(`   实际返回值: ${text.substring(0, 100)}...`);
        failed++;
      }
    } catch (e) {
      console.log(`❌ [崩溃] ${tc.name} - ${e.message}`);
      failed++;
    }
  }

  console.log('\n==================================');
  console.log(`📊 统计: 总计 ${testCases.length} | 通过: ${passed} | 失败: ${failed}`);
  if (failed === 0) {
    console.log('🎉 结论: 所有的提取路由文件均已正确挂载，基础结构健康！');
  } else {
    console.log('⚠️ 结论: 存在异常路由，请检查修复！');
  }
}

runTests();
