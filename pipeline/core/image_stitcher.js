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
 * 找到使拼接后总像素最少的网格布局 (cols)
 * 
 * 对于 N 张图，尝试 cols = 1..N，每种 cols 计算：
 *   每行中所有图按该行最大高度对齐 → 总画布高度 = sum(rowHeights)
 *   每列中取最大宽度 → 总画布宽度 = sum(colWidths) 或 max(rowWidths)
 *   总像素 = width * height
 * 返回像素最少的 cols 值。
 */
function findOptimalCols(imageSizes) {
  const n = imageSizes.length;
  if (n <= 1) return 1;

  let bestCols = 1;
  let bestPixels = Infinity;

  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let totalH = 0;
    let maxRowW = 0;

    for (let r = 0; r < rows; r++) {
      let rowW = 0;
      let rowH = 0;
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx >= n) break;
        rowW += imageSizes[idx].width;
        rowH = Math.max(rowH, imageSizes[idx].height);
      }
      totalH += rowH;
      maxRowW = Math.max(maxRowW, rowW);
    }

    const totalPixels = maxRowW * totalH;
    if (totalPixels < bestPixels) {
      bestPixels = totalPixels;
      bestCols = cols;
    }
  }

  return bestCols;
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

  // 4. Find optimal grid layout (minimize total pixels)
  const sizes = processedImages.map(p => ({ width: p.width, height: p.height }));
  const cols = findOptimalCols(sizes);
  const rows = Math.ceil(processedImages.length / cols);

  // 5. Calculate canvas dimensions
  // For each row: height = max height of images in that row
  // For each col position across all rows: width = max width at that col
  const colWidths = new Array(cols).fill(0);
  const rowHeights = new Array(rows).fill(0);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= processedImages.length) break;
      colWidths[c] = Math.max(colWidths[c], processedImages[idx].width);
      rowHeights[r] = Math.max(rowHeights[r], processedImages[idx].height);
    }
  }

  const canvasW = colWidths.reduce((a, b) => a + b, 0) + gap * (cols - 1);
  const canvasH = rowHeights.reduce((a, b) => a + b, 0) + gap * (rows - 1);

  // 6. Compose all images onto canvas
  const composites = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= processedImages.length) break;

      // Calculate top-left position (center the image within its cell)
      let x = 0;
      for (let ci = 0; ci < c; ci++) x += colWidths[ci] + gap;
      x += Math.floor((colWidths[c] - processedImages[idx].width) / 2);

      let y = 0;
      for (let ri = 0; ri < r; ri++) y += rowHeights[ri] + gap;
      y += Math.floor((rowHeights[r] - processedImages[idx].height) / 2);

      composites.push({
        input: processedImages[idx].buffer,
        top: y,
        left: x,
      });
    }
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
