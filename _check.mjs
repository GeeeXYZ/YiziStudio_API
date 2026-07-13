import { pool } from './config/db.js';
import OSS from 'ali-oss';

(async () => {
  try {
    // Simulate exactly what the gallery listing API does
    const openid = 'usr_0d3bdd84d1b70a3a';
    const orderId = 'ord_98027c86f51d47ce';
    
    const ossConfig = {
      region: process.env.OSS_REGION,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      bucket: process.env.OSS_BUCKET,
      secure: true
    };
    const client = new OSS(ossConfig);
    
    const prefix = `delivery_imgs/${openid}/${orderId}/`;
    const response = await client.listV2({ prefix, 'max-keys': 1000 });
    
    // This is exactly what rpc.js line 140-141 does:
    const list = (response.objects || []).map(obj => {
      return `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${obj.name}`;
    });
    
    console.log('=== GALLERY LIST API SIMULATION ===');
    console.log('Total URLs:', list.length);
    
    // Filter for set0 like the frontend does
    const setDir = '/set0/';
    const filtered = list.filter(url => url.includes(setDir)).sort((a, b) => b.localeCompare(a));
    console.log('After /set0/ filter:', filtered.length);
    filtered.forEach(url => console.log('  ', url));
    
    // Now check: do the 3 wmj6p images appear?
    const wmj6pImages = [
      'del_1783877438382_0_e533f210.png',
      'del_1783877444129_0_60f529a9.png', 
      'del_1783877448702_0_44ee9e67.png'
    ];
    console.log('\n=== CHECK IF WMJ6P IMAGES IN GALLERY LIST ===');
    for (const img of wmj6pImages) {
      const found = filtered.some(u => u.includes(img));
      console.log(`  ${img}: ${found ? '✅ FOUND' : '❌ NOT FOUND'}`);
    }
    
    // Show what pipeline says vs what gallery returns
    console.log('\n=== URL FORMAT COMPARISON ===');
    console.log('Pipeline saves URLs as:');
    console.log('  https://yizistudio-ai.oss-accelerate.aliyuncs.com/delivery_imgs/...');
    console.log('Gallery API returns URLs as:');
    console.log(`  https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/delivery_imgs/...`);
    console.log('Are they the same domain?', 
      `oss-accelerate.aliyuncs.com` === `${process.env.OSS_REGION}.aliyuncs.com` ? 'YES' : 'NO - DIFFERENT DOMAINS');
    
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
})();
