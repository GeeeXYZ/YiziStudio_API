import Core from '@alicloud/pop-core';
import OSS from 'ali-oss';
import { pool } from '../config/db.js';

// Helper to get Aliyun OSS STS Token or fallback to primary credentials
async function getOSSToken(openid = null, order_id = null) {
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  const roleArn = process.env.OSS_ROLE_ARN;
  const bucket = process.env.OSS_BUCKET;
  const region = process.env.OSS_REGION; // e.g. oss-cn-hangzhou

  if (!accessKeyId || !accessKeySecret || !bucket || !region) {
    throw new Error('后端未配置 OSS 环境变量 (OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_REGION)');
  }

  if (roleArn) {
    const client = new Core({
      accessKeyId,
      accessKeySecret,
      endpoint: 'https://sts.aliyuncs.com',
      apiVersion: '2015-04-01'
    });

    const params = {
      "RegionId": region.replace('oss-', ''), // e.g. cn-hangzhou
      "RoleArn": roleArn,
      "RoleSessionName": "yizi_studio_session",
      "DurationSeconds": 3600
    };

    if (openid && order_id) {
      const policy = {
        Version: '1',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['oss:PutObject', 'oss:GetObject'],
            Resource: [
              `acs:oss:*:*:${bucket}/delivery_imgs/${openid}/${order_id}/*`,
              `acs:oss:*:*:${bucket}/delivery_imgs/${openid}.${order_id}/*`,
              `acs:oss:*:*:${bucket}/delivery_imgs/*`
            ]
          }
        ]
      };
      params.Policy = JSON.stringify(policy);
    }

    const response = await client.request('AssumeRole', params, { method: 'POST' });
    if (response && response.Credentials) {
      return {
        region,
        bucket,
        accessKeyId: response.Credentials.AccessKeyId,
        accessKeySecret: response.Credentials.AccessKeySecret,
        stsToken: response.Credentials.SecurityToken
      };
    }
    throw new Error('获取阿里云 STS 凭证失败');
  }

  // Security Hardening: Direct connection is disabled.
  throw new Error('出于安全考虑，直连模式已被禁用。请在环境变量中配置 OSS_ROLE_ARN 以启用 STS 模式。');
}

// Helper to extract OSS object keys from string, object, or array
function extractOSSKeys(record) {
  let keys = [];
  if (!record) return keys;

  const bucketName = process.env.OSS_BUCKET;
  const region = process.env.OSS_REGION;
  if (!bucketName || !region) return keys;
  
  const ossDomain = process.env.OSS_ENDPOINT ? `${bucketName}.${process.env.OSS_ENDPOINT.replace('https://', '').replace('http://', '')}/` : `${bucketName}.${region}.aliyuncs.com/`;

  function searchKeys(obj) {
    if (typeof obj === 'string') {
      if (obj.includes(ossDomain)) {
        const parts = obj.split(ossDomain);
        if (parts.length > 1) {
          let key = parts[1].split('?')[0]; // remove query params if any
          if (key) keys.push(key);
        }
      }
    } else if (Array.isArray(obj)) {
      obj.forEach(searchKeys);
    } else if (typeof obj === 'object' && obj !== null) {
      Object.values(obj).forEach(searchKeys);
    }
  }

  // search top level fields
  searchKeys(record);
  
  // search parsed JSONB data if needed
  if (record.data) {
    let parsedData = null;
    if (typeof record.data === 'string') {
      try { parsedData = JSON.parse(record.data); } catch (e) {}
    } else if (typeof record.data === 'object') {
      parsedData = record.data;
    }
    if (parsedData) searchKeys(parsedData);
  }
  
  return [...new Set(keys)];
}

// Helper to delete OSS objects
async function deleteOSSObjects(keys) {
  if (!keys || keys.length === 0) return;
  try {
    // --- GC Protection (Gallery) ---
    const safeKeys = [];
    const protectedKeys = [];
    for (const key of keys) {
      const res = await pool.query('SELECT id FROM "yizi_gallery" WHERE oss_url LIKE $1 LIMIT 1', ['%' + key]);
      if (res.rows.length > 0) {
        protectedKeys.push(key);
      } else {
        safeKeys.push(key);
      }
    }
    
    if (protectedKeys.length > 0) {
      console.log(`[OSS GC] Protected keys (in gallery):`, protectedKeys);
    }
    
    if (safeKeys.length === 0) return;

    const ossConfig = {
      region: process.env.OSS_REGION,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      bucket: process.env.OSS_BUCKET,
      secure: true
    };
    if (!ossConfig.accessKeyId) return;
    const client = new OSS(ossConfig);
    
    // deleteMulti max is 1000, usually we have a few
    await client.deleteMulti(safeKeys);
    console.log(`[OSS GC] Deleted safe keys:`, safeKeys);
  } catch (error) {
    console.error('[OSS GC Error]', error);
  }
}

export { getOSSToken, extractOSSKeys, deleteOSSObjects };
