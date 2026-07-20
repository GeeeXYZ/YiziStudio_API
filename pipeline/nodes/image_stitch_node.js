/**
 * image_stitch_node.js — Pipeline 拼接节点
 * 
 * 接受多张图片输入，调用 stitchImages 拼接后上传 OSS，输出 URL
 */

import { stitchImages } from '../core/image_stitcher.js';
import OSS from 'ali-oss';

export async function executeImageStitch(node, inputs, orderContext, env) {
  // Collect all image inputs
  const images = [];
  for (let i = 1; i <= 4; i++) {
    const img = inputs[`image_${i}`] || node.data?.[`image_${i}`];
    if (img) {
      if (Array.isArray(img)) {
        img.flat().forEach(u => { if (typeof u === 'string' && u.trim()) images.push(u.trim()); });
      } else if (typeof img === 'string' && img.trim()) {
        images.push(img.trim());
      }
    }
  }

  // Also accept array input
  let arrayInput = inputs.images || node.data?.images || [];
  if (typeof arrayInput === 'string') arrayInput = [arrayInput];
  if (Array.isArray(arrayInput)) {
    arrayInput.flat().forEach(u => {
      if (typeof u === 'string' && u.trim()) images.push(u.trim());
    });
  }

  if (images.length === 0) {
    throw new Error('ImageStitch: 没有收到任何图片输入');
  }

  const maxEdge = parseInt(inputs.maxEdge || node.data?.maxEdge) || 2560;

  console.log(`[ImageStitch Node] Stitching ${images.length} images (maxEdge=${maxEdge})...`);
  const { buffer } = await stitchImages(images, { maxEdge });

  // Upload to OSS
  const ossClient = new OSS({
    region: env.OSS_REGION,
    accessKeyId: env.OSS_ACCESS_KEY_ID,
    accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
    bucket: env.OSS_BUCKET,
    secure: true,
    timeout: 30000,
    ...(env.OSS_ENDPOINT ? { endpoint: env.OSS_ENDPOINT } : {})
  });

  const orderId = orderContext?.order_id || 'pipeline';
  const openid = orderContext?.openid || 'unknown';
  const ossPath = `pipeline_outputs/${openid}/${orderId}/stitch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.jpg`;
  
  const putResult = await ossClient.put(ossPath, buffer);
  let ossUrl = putResult.url;
  if (ossUrl.startsWith('http://')) ossUrl = ossUrl.replace('http://', 'https://');

  console.log(`[ImageStitch Node] Result uploaded → ${ossUrl.substring(0, 80)}...`);

  return { output: ossUrl };
}
