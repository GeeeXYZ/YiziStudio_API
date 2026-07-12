import { fetchWithRetry } from '../core/fetch_helper.js';

export async function executeColorGrading(node, inputs) {
  const sharp = (await import('sharp')).default;

  // 1. Get input image (URL or Base64)
  let rawImage = inputs.image || node.data.image || inputs.input || '';
  if (Array.isArray(rawImage)) rawImage = rawImage.flat().filter(Boolean)[0];
  const imageUrl = rawImage || '';
  
  if (typeof imageUrl !== 'string' || !imageUrl) {
    throw new Error('ColorGrading: Missing or invalid input image');
  }

  // 2. Get adjustment parameters (with defaults)
  const brightness = parseFloat(inputs.brightness ?? node.data.brightness ?? 1.0); // 0.5 - 2.0
  const contrast = parseFloat(inputs.contrast ?? node.data.contrast ?? 1.0);       // 0.5 - 2.0
  const temperature = parseFloat(inputs.temperature ?? node.data.temperature ?? 0); // -100 to 100
  const noise = parseFloat(inputs.noise ?? node.data.noise ?? 0);                 // 0 to 100
  const sharpen = parseFloat(inputs.sharpen ?? node.data.sharpen ?? 0);             // 0 to 10

  // 3. Fetch the image buffer
  let buffer;
  if (imageUrl.startsWith('data:image')) {
    buffer = Buffer.from(imageUrl.split(',')[1], 'base64');
  } else {
    const resp = await fetchWithRetry(imageUrl, { 
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(60000) 
    });
    if (!resp.ok) throw new Error(`ColorGrading: Failed to fetch image from ${imageUrl} (Status: ${resp.status})`);
    buffer = Buffer.from(await resp.arrayBuffer());
  }

  let imgInstance = sharp(buffer);
  const metadata = await imgInstance.metadata();

  // A. Brightness (using modulate)
  if (brightness !== 1.0) {
    imgInstance = imgInstance.modulate({ brightness });
  }

  // B. Contrast (using linear transformation)
  // Formula: Output = slope * Input + intercept
  // intercept ensures the middle gray (128) remains unchanged
  if (contrast !== 1.0) {
    const slope = contrast;
    const intercept = 128 * (1 - contrast);
    imgInstance = imgInstance.linear(slope, intercept);
  }

  // C. Color Temperature (using recomb matrix)
  if (temperature !== 0) {
    const temp = temperature / 100; // normalize to -1 to 1
    // Warm: increase red/green, decrease blue
    // Cool: decrease red/green, increase blue
    const rGain = 1 + (temp > 0 ? temp * 0.08 : temp * 0.04);
    const gGain = 1 + (temp > 0 ? temp * 0.02 : -temp * 0.02);
    const bGain = 1 + (temp > 0 ? -temp * 0.08 : -temp * 0.12);

    imgInstance = imgInstance.recomb([
      [rGain, 0, 0],
      [0, gGain, 0],
      [0, 0, bGain]
    ]);
  }

  // D. Sharpening
  if (sharpen > 0) {
    imgInstance = imgInstance.sharpen({ sigma: sharpen });
  }

  // E. Noise (Raw Buffer Overlay)
  if (noise > 0) {
    const noiseSize = 256;
    const noiseBuffer = Buffer.alloc(noiseSize * noiseSize * 3);
    const amplitude = (noise / 100) * 127;
    
    for (let i = 0; i < noiseBuffer.length; i += 3) {
      const val = Math.floor(128 + (Math.random() * 2 - 1) * amplitude);
      noiseBuffer[i] = val;
      noiseBuffer[i+1] = val;
      noiseBuffer[i+2] = val;
    }

    imgInstance = imgInstance.composite([{ 
      input: noiseBuffer, 
      raw: { width: noiseSize, height: noiseSize, channels: 3 },
      tile: true,
      blend: 'overlay' 
    }]);
  }

  // 4. Output processed image as Base64
  const outBuffer = await imgInstance.jpeg({ quality: 95 }).toBuffer();
  const outputBase64 = `data:image/jpeg;base64,${outBuffer.toString('base64')}`;

  return { output: outputBase64 };
}
