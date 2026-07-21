/**
 * image_stitch_node.js — Pipeline 拼接节点
 * 
 * 接受多张图片输入，调用 stitchImages 拼接后上传 OSS，输出 URL
 * 标号严格对应输入端口编号（image_1 → #1, image_2 → #2...），而非顺序排列
 */

import { stitchImages } from '../core/image_stitcher.js';
import OSS from 'ali-oss';

export async function executeImageStitch(node, inputs, orderContext, env) {
  // Collect all image inputs WITH their port labels
  // Each entry: { url: string, label: string }
  const labeledImages = [];

  for (let i = 1; i <= 4; i++) {
    const img = inputs[`image_${i}`] || node.data?.[`image_${i}`];
    if (img) {
      if (Array.isArray(img)) {
        img.flat().forEach((u, arrIdx) => {
          if (typeof u === 'string' && u.trim()) {
            // Array on a single port: label as "portNum.subIndex" (e.g. "1.1", "1.2")
            const label = img.flat().filter(x => typeof x === 'string' && x.trim()).length > 1
              ? `${i}.${arrIdx + 1}`
              : `${i}`;
            labeledImages.push({ url: u.trim(), label });
          }
        });
      } else if (typeof img === 'string' && img.trim()) {
        labeledImages.push({ url: img.trim(), label: `${i}` });
      }
    }
  }

  // Also accept array input (images port) — label sequentially starting from 'A1', 'A2'...
  let arrayInput = inputs.images || node.data?.images || [];
  if (typeof arrayInput === 'string') arrayInput = [arrayInput];
  if (Array.isArray(arrayInput)) {
    let arrIdx = 1;
    arrayInput.flat().forEach(u => {
      if (typeof u === 'string' && u.trim()) {
        labeledImages.push({ url: u.trim(), label: `A${arrIdx}` });
        arrIdx++;
      }
    });
  }

  if (labeledImages.length === 0) {
    throw new Error('ImageStitch: 没有收到任何图片输入');
  }

  const maxEdge = parseInt(inputs.maxEdge || node.data?.maxEdge) || 2560;
  const imageUrls = labeledImages.map(li => li.url);
  const labels = labeledImages.map(li => li.label);

  console.log(`[ImageStitch Node] Stitching ${labeledImages.length} images (maxEdge=${maxEdge}), labels: [${labels.join(', ')}]`);
  const { buffer } = await stitchImages(imageUrls, { maxEdge, labels });

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
