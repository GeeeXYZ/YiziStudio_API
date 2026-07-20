/**
 * image_split_node.js — Pipeline 图像分割节点
 * 
 * 接受单张图片输入，根据网格模式切分并去白边，然后将切片上传 OSS 并输出。
 */

import { splitImageGrid } from '../core/image_splitter.js';
import OSS from 'ali-oss';

export async function executeImageSplit(node, inputs, orderContext, env) {
  const image = inputs.image || node.data?.image;
  const gridMode = inputs.gridMode || node.data?.gridMode || '2x2';

  if (!image || typeof image !== 'string' || !image.trim()) {
    throw new Error('ImageSplit: 没有收到有效的图片输入');
  }

  console.log(`[ImageSplit Node] Splitting image in ${gridMode} mode...`);
  
  // 1. 调用核心分割逻辑
  const buffers = await splitImageGrid(image, { gridMode });
  
  console.log(`[ImageSplit Node] Successfully split into ${buffers.length} pieces. Uploading to OSS...`);

  // 2. 准备 OSS 客户端
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
  
  // 3. 并发上传所有切片
  const uploadPromises = buffers.map(async (buf, idx) => {
    const ossPath = `pipeline_outputs/${openid}/${orderId}/split_${Date.now()}_${Math.random().toString(36).substring(2, 6)}_${idx + 1}.png`;
    const putResult = await ossClient.put(ossPath, buf);
    let ossUrl = putResult.url;
    if (ossUrl.startsWith('http://')) ossUrl = ossUrl.replace('http://', 'https://');
    return ossUrl;
  });

  const uploadedUrls = await Promise.all(uploadPromises);

  // 4. 组装输出
  const result = {
    images: uploadedUrls
  };
  
  // 提供前 4 张独立输出端点（兼容 1x2, 2x2 以及 3x3 的前四张）
  for (let i = 0; i < Math.min(uploadedUrls.length, 4); i++) {
    result[`image_${i + 1}`] = uploadedUrls[i];
  }

  console.log(`[ImageSplit Node] Upload complete. Outputting ${uploadedUrls.length} images.`);

  return result;
}
