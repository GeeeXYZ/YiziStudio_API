import crypto from 'crypto';
import { fetchWithRetry } from './fetch_helper.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function uploadToOSS(ossClient, url, openid, order_id, set_index, filenamePrefix) {
  let buffer;
  let ext = 'png';

  if (url.startsWith('data:image')) {
    const matches = url.match(/^data:image\/(\w+);base64,(.+)$/);
    if (matches) {
      ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      throw new Error('Invalid base64 image string');
    }
  }

  const MAX_RETRIES = 4;
  const DOWNLOAD_TIMEOUT_MS = 60000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (!buffer) {
        const response = await fetchWithRetry(url, {
          headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://x.ai/'
          },
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText} (URL: ${url.substring(0,80)})`);
        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);

        const extMatch = url.split('.').pop().split('?')[0].match(/^(jpg|jpeg|png|webp|gif)$/i);
        if (extMatch) ext = extMatch[1];
      }

      const filename = `${filenamePrefix}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const ossPath = `delivery_imgs/${openid}/${order_id}/set${set_index}/${filename}`;

      const result = await ossClient.put(ossPath, buffer);
      return result.url;
    } catch (err) {
      console.warn(`[OSS Upload] Attempt ${attempt}/${MAX_RETRIES} failed for ${url.substring(0, 120)}: ${err.message}`);
      if (attempt === MAX_RETRIES) {
        console.error(`[OSS Upload] All ${MAX_RETRIES} attempts exhausted, giving up.`);
        throw err;
      }
      await sleep(2000 * attempt); // exponential backoff: 2s, 4s, 6s
    }
  }
}
