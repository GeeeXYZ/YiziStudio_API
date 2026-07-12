import OSS from 'ali-oss';
import { uploadToOSS } from '../core/oss_helper.js';

export async function executeOssOutput(node, inputs, orderContext, env) {
  let rawImages = inputs.images || inputs.output_images || inputs.output || [];
  if (Array.isArray(inputs.images) && inputs.images.length > 0) rawImages = inputs.images;
  else if (Array.isArray(inputs.output_images) && inputs.output_images.length > 0) rawImages = inputs.output_images;
  
  const imagesToUpload = (Array.isArray(rawImages) ? rawImages : [rawImages]).flat(Infinity);
  const filteredImages = imagesToUpload.filter(u => typeof u === 'string' && (u.startsWith('http') || u.startsWith('data:image')));
  const orderInfo = inputs.order_info || orderContext;
  
  console.log(`[Pipeline] OSS Output: Received ${filteredImages.length} images from inputs keys: ${Object.keys(inputs).join(', ')}`);
  console.log(`[Pipeline] OSS Output: orderInfo =`, orderInfo, `orderContext =`, orderContext);
  console.log(`[Pipeline] OSS Output: inputs.order_info type =`, typeof inputs.order_info, `isArray =`, Array.isArray(inputs.order_info));
  
  if (!filteredImages.length) {
     const debugInfo = `inputs.images=${JSON.stringify(inputs.images)}, inputs.output_images=${JSON.stringify(inputs.output_images)}, inputs.output=${JSON.stringify(inputs.output)?.substring(0,200)}`;
     console.error(`[Pipeline] OSS Output: No valid images to upload. ${debugInfo}`);
     throw new Error(`OSS Output 节点未收到任何有效图片。请检查上游生图节点的连线是否正确。Debug: ${debugInfo}`);
  }

  if (!orderInfo || !orderInfo.openid || !orderInfo.order_id) {
     console.error(`[Pipeline] OSS Output Node missing valid order_info! inputs.order_info=`, inputs.order_info, `orderContext=`, orderContext);
     throw new Error(`OSS Output Node missing valid order_info (openid, order_id)`);
  }

  const ossConfig = {
    region: env.OSS_REGION,
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    bucket: env.OSS_BUCKET,
    secure: true,
    timeout: 300000
  };

  // Allow overriding endpoint for Transfer Acceleration (e.g. oss-accelerate.aliyuncs.com)
  if (env.OSS_ENDPOINT) {
    ossConfig.endpoint = env.OSS_ENDPOINT;
  }

  if (!ossConfig.accessKeyId) {
     throw new Error('OSS configuration missing in backend .env');
  }

  const ossClient = new OSS(ossConfig);
  const uploadedUrls = [];
  const failedUploads = [];

  const uploadPromises = filteredImages.map(async (imgUrl, i) => {
    try {
      console.log(`[Pipeline] Uploading image ${i+1}/${filteredImages.length} to OSS...`);
      const url = await uploadToOSS(
        ossClient, 
        imgUrl, 
        orderInfo.openid, 
        orderInfo.order_id, 
        orderInfo.set_index || 0,
        `del_${Date.now()}_${i}`
      );
      const secureUrl = url.replace('http://', 'https://');
      console.log(`[Pipeline] ✅ Uploaded ${i+1}/${filteredImages.length}: ${secureUrl}`);
      return { success: true, url: secureUrl };
    } catch (uploadErr) {
      console.error(`[Pipeline] ❌ Image ${i+1}/${filteredImages.length} failed after retries: ${uploadErr.message}`);
      return { success: false, index: i, sourceUrl: imgUrl, error: uploadErr.message };
    }
  });

  const uploadResults = await Promise.all(uploadPromises);
  
  for (const res of uploadResults) {
    if (res.success) {
      uploadedUrls.push(res.url);
    } else {
      failedUploads.push(res);
    }
  }

  console.log(`[Pipeline] OSS Upload Summary: ${uploadedUrls.length} succeeded, ${failedUploads.length} failed out of ${filteredImages.length} total.`);
  return {
    uploaded_urls: uploadedUrls,
    failed_uploads: failedUploads,
    auto_delivery: node.data.auto_delivery === true
  };
}
