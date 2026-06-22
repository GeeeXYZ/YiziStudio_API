const https = require('https');

https.get('https://yizistudio-ai.yizistudio-ai.oss-cn-shenzhen.aliyuncs.com', (res) => {
  console.log('STATUS:', res.statusCode);
  res.on('data', d => console.log(d.toString()));
}).on('error', (e) => {
  console.error('ERROR:', e.message);
});

https.get('https://yizistudio-ai.oss-cn-shenzhen.aliyuncs.com', (res) => {
  console.log('STATUS 2:', res.statusCode);
}).on('error', (e) => {
  console.error('ERROR 2:', e.message);
});
