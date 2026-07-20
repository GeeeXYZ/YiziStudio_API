/**
 * image_splitter.js — 通用图片分割工具
 * 
 * 将单张图片按照网格切分为多张独立图片。
 * 支持 1x2、2x2、3x3 三种模式。
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
 * 将网格图等分切割
 * 
 * @param {string} imageUrl 图片下载地址或 base64
 * @param {object} options 
 * @param {string} options.gridMode '1x2', '2x2', '3x3'
 * @returns {Promise<Buffer[]>} 切割后的图片数组（按从左到右、从上到下的顺序）
 */
export async function splitImageGrid(imageUrl, options = {}) {
  const sharp = (await import('sharp')).default;
  const gridMode = options.gridMode || '2x2';

  const buffer = await downloadImage(imageUrl);
  const meta = await sharp(buffer).metadata();
  
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

  console.log(`[Image Splitter] Source: ${w}x${h}, Grid: ${gridMode} (${cols}cols x ${rows}rows), Slice: ${Math.floor(w / cols)}x${Math.floor(h / rows)}`);

  const extractPromises = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const extractLeft = c * Math.floor(w / cols);
      const extractTop = r * Math.floor(h / rows);
      // 最后一列/行取到图片右/下边缘，防止取整丢像素
      const extractWidth = (c === cols - 1) ? (w - extractLeft) : Math.floor(w / cols);
      const extractHeight = (r === rows - 1) ? (h - extractTop) : Math.floor(h / rows);

      const p = sharp(buffer)
        .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
        .png()
        .toBuffer();

      extractPromises.push(p);
    }
  }

  const buffers = await Promise.all(extractPromises);
  console.log(`[Image Splitter] Split complete: ${buffers.length} pieces`);
  return buffers;
}
