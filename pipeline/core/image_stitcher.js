/**
 * image_stitcher.js — 通用图片拼接工具
 * 
 * 将多张图片拼接为一张带序号标注的合成图。
 * - 若单张图最大边 > maxEdge，先等比缩放到 maxEdge
 * - 在每张图左上角叠加绿色序号标签
 * - 自动选择像素总量最小的网格布局
 */

import { fetchWithRetry } from './fetch_helper.js';

const MAX_EDGE_DEFAULT = 2560;

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
 * 生成绿色序号标签的 SVG overlay
 */
function createNumberSvg(num, scale = 1) {
  const fontSize = Math.round(28 * scale);
  const padX = Math.round(12 * scale);
  const padY = Math.round(8 * scale);
  const radius = Math.round(8 * scale);
  const marginX = Math.round(12 * scale);
  const marginY = Math.round(12 * scale);

  // Measure approximate text width (monospace-ish)
  const textWidth = String(num).length * fontSize * 0.65;
  const boxW = Math.round(textWidth + padX * 2);
  const boxH = Math.round(fontSize + padY * 2);
  const svgW = boxW + marginX;
  const svgH = boxH + marginY;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">
    <rect x="${marginX}" y="${marginY}" width="${boxW}" height="${boxH}" rx="${radius}" ry="${radius}" fill="rgba(0,0,0,0.55)" />
    <text x="${marginX + boxW / 2}" y="${marginY + padY + fontSize * 0.82}" 
          font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="bold" 
          fill="#22c55e" text-anchor="middle">${num}</text>
  </svg>`;
  return { svg, width: svgW, height: svgH };
}


/**
 * 主拼接函数
 * 
 * @param {string[]} imageUrls — 图片 URL 列表
 * @param {object} options
 * @param {number} options.maxEdge — 单张图最大边限制，默认 2560
 * @param {number} options.gap — 图片间距（像素），默认 8
 * @param {string[]} options.labels — 每张图的标注文字，与 imageUrls 一一对应。若不提供则按顺序 1,2,3...
 * @returns {{ buffer: Buffer, width: number, height: number }}
 */
export async function stitchImages(imageUrls, options = {}) {
  const sharp = (await import('sharp')).default;
  const maxEdge = options.maxEdge ?? MAX_EDGE_DEFAULT;
  const gap = options.gap ?? 8;
  const labels = options.labels || imageUrls.map((_, i) => String(i + 1));

  if (!imageUrls || imageUrls.length === 0) {
    throw new Error('stitchImages: No image URLs provided');
  }

  // 1. Download all images in parallel
  const buffers = await Promise.all(imageUrls.map(url => downloadImage(url)));

  // 2. Resize if max edge > maxEdge, and collect metadata
  const processedImages = [];
  for (let i = 0; i < buffers.length; i++) {
    let img = sharp(buffers[i]);
    const meta = await img.metadata();
    let w = meta.width;
    let h = meta.height;

    // Resize if max edge exceeds limit
    const longestEdge = Math.max(w, h);
    if (longestEdge > maxEdge) {
      const scale = maxEdge / longestEdge;
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      img = img.resize(w, h, { fit: 'inside', withoutEnlargement: true });
    }

    // Flatten to ensure no alpha issues, convert to PNG buffer
    const resizedBuf = await img.flatten({ background: { r: 255, g: 255, b: 255 } }).png().toBuffer();

    // 3. Add number overlay (fixed size, do not scale with image)
    const labelScale = 1.5;
    const { svg } = createNumberSvg(labels[i] || (i + 1), labelScale);
    const numberedBuf = await sharp(resizedBuf)
      .composite([{
        input: Buffer.from(svg),
        top: 0,
        left: 0,
      }])
      .png()
      .toBuffer();

    processedImages.push({ buffer: numberedBuf, width: w, height: h });
  }

  // 4. Layout: Adaptive Column Layout based on labels
  //    - '0', '1', '4' -> full columns
  //    - '2' and '3' -> stacked in one column
  //    - others -> their own columns

  const columnsData = new Map();
  let extraColIndex = 100;
  
  for (let i = 0; i < processedImages.length; i++) {
    const img = processedImages[i];
    const label = labels[i] || String(i + 1);
    
    let colKey;
    if (label === '0' || label.startsWith('0.')) colKey = 'col_0';
    else if (label === '1' || label.startsWith('1.')) colKey = 'col_1';
    else if (label === '2' || label.startsWith('2.') || label === '3' || label.startsWith('3.')) colKey = 'col_2_3';
    else if (label === '4' || label.startsWith('4.')) colKey = 'col_4';
    else {
      colKey = `col_extra_${extraColIndex++}`;
    }
    
    if (!columnsData.has(colKey)) columnsData.set(colKey, []);
    columnsData.get(colKey).push(img);
  }

  // Ensure stable ordering
  const orderedKeys = ['col_0', 'col_1', 'col_2_3', 'col_4'];
  const finalColumns = [];
  
  for (const key of orderedKeys) {
    if (columnsData.has(key)) finalColumns.push(columnsData.get(key));
  }
  
  // Add any extra columns
  for (const [key, imgs] of columnsData.entries()) {
    if (!orderedKeys.includes(key)) {
      finalColumns.push(imgs);
    }
  }

  // Determine target canvas height
  let maxSingleH = 0;
  for (const col of finalColumns) {
    if (col.length === 1) {
      maxSingleH = Math.max(maxSingleH, col[0].height);
    }
  }
  
  // Fallback if all columns are stacked
  if (maxSingleH === 0) {
    for (const col of finalColumns) {
      const naturalH = col.reduce((sum, img) => sum + img.height, 0) + gap * (col.length - 1);
      maxSingleH = Math.max(maxSingleH, naturalH);
    }
  }
  
  const targetH = maxSingleH > 0 ? maxSingleH : 1000;

  // Build composites and determine canvas width
  const composites = [];
  let xCursor = 0;

  for (const colImages of finalColumns) {
    if (colImages.length === 1) {
      // Single image in column -> scale to targetH
      const img = colImages[0];
      const scale = targetH / img.height;
      const colW = Math.round(img.width * scale);
      const buf = await sharp(img.buffer).resize(colW, targetH, { fit: 'fill' }).png().toBuffer();
      
      composites.push({ input: buf, top: 0, left: xCursor });
      xCursor += colW + gap;
    } else {
      // Multiple images in column -> stack them, scaling uniformly to match targetH
      const totalImageHTarget = targetH - gap * (colImages.length - 1);
      let sumInvAspect = 0;
      for (const img of colImages) {
        sumInvAspect += img.height / img.width;
      }
      
      const colW = Math.max(1, Math.round(totalImageHTarget / sumInvAspect));
      
      let yCursor = 0;
      for (let j = 0; j < colImages.length; j++) {
        const img = colImages[j];
        // For the last image, absorb any rounding errors to make the column exactly targetH
        let imgH;
        if (j === colImages.length - 1) {
          imgH = Math.max(1, targetH - yCursor);
        } else {
          imgH = Math.round(colW * (img.height / img.width));
        }
        
        const buf = await sharp(img.buffer).resize(colW, imgH, { fit: 'fill' }).png().toBuffer();
        composites.push({ input: buf, top: yCursor, left: xCursor });
        yCursor += imgH + gap;
      }
      xCursor += colW + gap;
    }
  }

  const canvasW = Math.max(1, xCursor - gap);
  const canvasH = targetH;

  const resultBuffer = await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    }
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();

  return { buffer: resultBuffer, width: canvasW, height: canvasH };
}
