/**
 * image_splitter.js — 通用图片分割工具
 * 
 * 将单张图片按照网格切分为多张独立图片，并自动去除边缘白边。
 */

import { fetchWithRetry } from './fetch_helper.js';

/**
 * 下载图片 URL 到 Buffer
 */
async function downloadImage(url) {
  if (url.startsWith('data:image')) {
    const matches = url.replace(/[\n\r]/g, '').match(/^data:image\/\w+;base64,(.+)$/);
    if (matches) return Buffer.from(matches[1], 'base64');
    throw new Error('Invalid base64 image string');
  }

  const resp = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status} — ${url.substring(0, 120)}`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * 将网格图等分切割并自动去边
 * 
 * @param {string} imageUrl 图片下载地址或 base64
 * @param {object} options 
 * @param {string} options.gridMode '1x2', '2x2', '3x3'
 * @returns {Promise<Buffer[]>} 切割后的纯净图片数组
 */
export async function splitImageGrid(imageUrl, options = {}) {
  const sharp = (await import('sharp')).default;
  const gridMode = options.gridMode || '2x2';

  const buffer = await downloadImage(imageUrl);
  const img = sharp(buffer);
  const meta = await img.metadata();
  
  const w = meta.width;
  const h = meta.height;

  let rows = 2;
  let cols = 2;

  if (gridMode === '1x2') {
    rows = 1;
    cols = 2;
  } else if (gridMode === '3x3') {
    rows = 3;
    cols = 3;
  }

  const sliceW = Math.floor(w / cols);
  const sliceH = Math.floor(h / rows);

  const extractPromises = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let extractLeft = Math.floor(c * sliceW);
      let extractTop = Math.floor(r * sliceH);
      let extractWidth = sliceW;
      let extractHeight = sliceH;

      // 修正右下边缘像素可能因除法取整丢失的问题
      if (c === cols - 1) extractWidth = w - extractLeft;
      if (r === rows - 1) extractHeight = h - extractTop;

      const p = sharp(buffer)
        .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
        .trim({ background: { r: 255, g: 255, b: 255, alpha: 1 }, threshold: 25 }) // 智能去白边/相近背景
        .png() // 使用 PNG 以防透明度
        .toBuffer()
        .catch(err => {
          console.warn(`[Image Splitter] Trim failed or resulted in empty image: ${err.message}. Retrying without trim.`);
          // 如果 trim 失败（例如没有找到边），则返回原切片
          return sharp(buffer)
            .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
            .png()
            .toBuffer();
        });

      extractPromises.push(p);
    }
  }

  const buffers = await Promise.all(extractPromises);
  return buffers;
}
