import pg from 'pg';
import dotenv from 'dotenv';
import Core from '@alicloud/pop-core';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function test() {
  const phone = '13600408635';
  const code = '123456';
  try {
    const accessKeyId = process.env.SMS_ACCESS_KEY_ID || process.env.OSS_ACCESS_KEY_ID;
    const accessKeySecret = process.env.SMS_ACCESS_KEY_SECRET || process.env.OSS_ACCESS_KEY_SECRET;
    
    let signName = process.env.SMS_SIGN_NAME;
    let templateCode = process.env.SMS_TEMPLATE_CODE;

    const settingsRes = await pool.query('SELECT key, value FROM "yizi_settings" WHERE key IN ($1, $2)', ['SMS_SIGN_NAME', 'SMS_TEMPLATE_CODE']);
    settingsRes.rows.forEach(r => {
      if (r.key === 'SMS_SIGN_NAME') signName = r.value;
      if (r.key === 'SMS_TEMPLATE_CODE') templateCode = r.value;
    });

    console.log('Sending to:', phone);
    console.log('Sign Name:', signName);
    console.log('Template:', templateCode);

    const client = new Core({
      accessKeyId,
      accessKeySecret,
      endpoint: 'https://dysmsapi.aliyuncs.com',
      apiVersion: '2017-05-25'
    });

    const params = {
      "RegionId": "cn-hangzhou",
      "PhoneNumbers": phone,
      "SignName": signName,
      "TemplateCode": templateCode,
      "TemplateParam": JSON.stringify({ code })
    };

    const requestOption = {
      method: 'POST',
      formatParams: false
    };

    const result = await client.request('SendSms', params, requestOption);
    console.log('✅ Success Result:', result);
  } catch(e) {
    console.error('❌ Failed!');
    console.error('Message:', e.message);
    if (e.data) {
      console.error('Aliyun Data:', JSON.stringify(e.data, null, 2));
    }
  } finally {
    process.exit(0);
  }
}

test();
