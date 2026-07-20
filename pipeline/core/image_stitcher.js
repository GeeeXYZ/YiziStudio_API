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
 * @param {string[]} imageUrls — 图片 URL 列表（按顺序编号 1, 2, 3...）
 * @param {object} options
 * @param {number} options.maxEdge — 单张图最大边限制，默认 2560
 * @param {number} options.gap — 图片间距（像素），默认 8
 * @returns {{ buffer: Buffer, width: number, height: number }}
 */
export async function stitchImages(imageUrls, options = {}) {
  const sharp = (await import('sharp')).default;
  const maxEdge = options.maxEdge ?? MAX_EDGE_DEFAULT;
  const gap = options.gap ?? 8;

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

    // 3. Add number overlay
    const labelScale = Math.max(0.8, Math.min(2.0, Math.min(w, h) / 400));
    const { svg } = createNumberSvg(i + 1, labelScale);
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

  // 4. Layout: 3-column fixed layout
  //    Col 1 = image #1 (pose), full canvas height
  //    Col 2 = image #2 (first user image), full canvas height
  //    Col 3 = images #3+ stacked vertically, scaled to fit
  //    For ≤2 images: side-by-side

  const composites = [];
  let canvasW, canvasH;

  if (processedImages.length <= 2) {
    // Simple side-by-side layout
    const targetH = Math.max(...processedImages.map(p => p.height));
    let xCursor = 0;
    for (const img of processedImages) {
      const scale = targetH / img.height;
      const scaledW = Math.round(img.width * scale);
      const scaledBuf = await sharp(img.buffer).resize(scaledW, targetH, { fit: 'fill' }).png().toBuffer();
      composites.push({ input: scaledBuf, top: 0, left: xCursor });
      xCursor += scaledW + gap;
    }
    canvasW = xCursor - gap;
    canvasH = targetH;

  } else {
    // 3-column layout
    const imgA = processedImages[0]; // pose
    const imgB = processedImages[1]; // first user image
    const rest = processedImages.slice(2); // remaining images

    // Determine canvas height: use the taller of Col1 / Col2 at their native sizes
    const targetH = Math.max(imgA.height, imgB.height);

    // Scale Col1 and Col2 to targetH, preserving aspect ratio
    const scaleA = targetH / imgA.height;
    const col1W = Math.round(imgA.width * scaleA);
    const bufA = await sharp(imgA.buffer).resize(col1W, targetH, { fit: 'fill' }).png().toBuffer();

    const scaleB = targetH / imgB.height;
    const col2W = Math.round(imgB.width * scaleB);
    const bufB = await sharp(imgB.buffer).resize(col2W, targetH, { fit: 'fill' }).png().toBuffer();

    // Col3: stack remaining images vertically
    // First, pick a col3 width = average width of the remaining images (capped to col1W)
    const avgRestW = Math.round(rest.reduce((s, r) => s + r.width, 0) / rest.length);
    const col3W = Math.min(avgRestW, Math.max(col1W, col2W));

    // Scale each remaining image to col3W, preserving aspect ratio
    const col3Images = [];
    for (const img of rest) {
      const s = col3W / img.width;
      const sH = Math.round(img.height * s);
      col3Images.push({ width: col3W, height: sH, buffer: img.buffer });
    }

    // Total natural stacked height of col3
    const col3NaturalH = col3Images.reduce((s, r) => s + r.height, 0) + gap * (col3Images.length - 1);

    // If col3 stacked height differs from targetH, scale all col3 images uniformly to fit
    const col3Scale = (col3NaturalH > 0) ? targetH / col3NaturalH : 1;

    const col3Bufs = [];
    for (const ci of col3Images) {
      const finalW = Math.round(ci.width * col3Scale);
      const finalH = Math.round(ci.height * col3Scale);
      const buf = await sharp(ci.buffer).resize(finalW, finalH, { fit: 'fill' }).png().toBuffer();
      col3Bufs.push({ buffer: buf, width: finalW, height: finalH });
    }

    // Recalculate actual col3 width after scaling
    const actualCol3W = col3Bufs.length > 0 ? Math.max(...col3Bufs.map(b => b.width)) : 0;

    // Place Col1
    const col1X = 0;
    composites.push({ input: bufA, top: 0, left: col1X });

    // Place Col2
    const col2X = col1W + gap;
    composites.push({ input: bufB, top: 0, left: col2X });

    // Place Col3 images stacked
    const col3X = col2X + col2W + gap;
    let yCursor = 0;
    for (const ci of col3Bufs) {
      composites.push({ input: ci.buffer, top: yCursor, left: col3X });
      yCursor += ci.height + gap;
    }

    canvasW = col3X + actualCol3W;
    canvasH = targetH;
  }

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
