import express from 'express';
import OSS from 'ali-oss';
import { pool } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// POST /toolkit/upload_to_oss_direct — Manually upload URLs to OSS for a specific order
router.post('/toolkit/upload_to_oss_direct', authenticateToken, async (req, res) => {
  let { urls, openid, order_id, set_index } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) return res.json({ msg: 'err', info: 'Missing urls' });
  if (!openid || !order_id) return res.json({ msg: 'err', info: 'Missing order info' });

  try {
    const OSS = (await import('ali-oss')).default;
    const ossConfig = {
      region: process.env.OSS_REGION,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      bucket: process.env.OSS_BUCKET,
      secure: true
    };
    if (!ossConfig.accessKeyId) return res.json({ msg: 'err', info: 'OSS Not Configured' });
    const ossClient = new OSS(ossConfig);

    const { uploadToOSS } = await import('./pipeline_executor.js');
    const uploadedUrls = [];
    const setIdx = parseInt(set_index) || 0;

    for (const img of urls) {
       try {
         const secureUrl = await uploadToOSS(ossClient, img, openid, order_id, setIdx, `del_${Date.now()}`);
         uploadedUrls.push(secureUrl.replace('http://', 'https://'));
       } catch (err) {
         console.error('Direct OSS upload failed for', img, err.message);
       }
    }

    if (uploadedUrls.length > 0) {
      return res.json({ msg: 'ok', uploaded: uploadedUrls });
    } else {
      return res.json({ msg: 'err', info: 'All uploads failed' });
    }
  } catch (err) {
    console.error('[Upload OSS Direct Error]', err);
    return res.json({ msg: 'err', info: err.message });
  }
});

// POST /toolkit/grsai — Direct Grsai API call from Toolkit (no pipeline, synchronous polling)
router.post('/toolkit/prompts/sync', authenticateToken, async (req, res) => {
  const { prompts, groups } = req.body;
  if (!Array.isArray(prompts)) return res.json({ msg: 'err', info: 'Invalid data format. Expected prompts array.' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Ensure tables exist
    await client.query(`CREATE TABLE IF NOT EXISTS "yizi_prompt_groups" (
      id VARCHAR(50) PRIMARY KEY,
      title VARCHAR(100),
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    
    await client.query(`CREATE TABLE IF NOT EXISTS "yizi_prompts" (
      id VARCHAR(50) PRIMARY KEY,
      group_id VARCHAR(50),
      content TEXT,
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    let groupsSynced = 0;
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (!g.id || !g.title) continue;

        if (g.data && typeof g.data.cover_img === 'string' && g.data.cover_img.startsWith('data:image')) {
          try {
            const ossConfig = {
              region: process.env.OSS_REGION,
              accessKeyId: process.env.OSS_ACCESS_KEY_ID,
              accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
              bucket: process.env.OSS_BUCKET
            };
            const ossClient = new OSS(ossConfig);
            const base64Data = g.data.cover_img.replace(/^data:image\/\w+;base64,/, "");
            let buffer = Buffer.from(base64Data, 'base64');
            
            const sharp = (await import('sharp')).default;
            buffer = await sharp(buffer)
              .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 85 })
              .toBuffer();
            
            const ossPath = `prompts/group_cover_${g.id}_${Date.now()}.jpg`;
            const result = await ossClient.put(ossPath, buffer);
            g.data.cover_img = result.url.replace('http://', 'https://');
          } catch (ossErr) {
            console.error(`[Prompt Sync] Failed to upload cover image for group ${g.id}:`, ossErr.message);
            g.data.cover_img = ''; // Remove massive base64 string on failure
          }
        }

        const insertQuery = `
          INSERT INTO "yizi_prompt_groups" (id, title, data)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE 
          SET title = EXCLUDED.title, data = EXCLUDED.data
        `;
        await client.query(insertQuery, [g.id, g.title, g.data || {}]);
        groupsSynced++;
      }
    }

    for (const p of prompts) {
      if (!p.id || !p.content || !p.group_id) continue;
      
      // Upload base64 preview images to OSS
      if (p.data && typeof p.data.preview_img === 'string' && p.data.preview_img.startsWith('data:image')) {
        try {
          const ossConfig = {
            region: process.env.OSS_REGION,
            accessKeyId: process.env.OSS_ACCESS_KEY_ID,
            accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
            bucket: process.env.OSS_BUCKET
          };
          const ossClient = new OSS(ossConfig);
          const base64Data = p.data.preview_img.replace(/^data:image\/\w+;base64,/, "");
          let buffer = Buffer.from(base64Data, 'base64');
          
          // Resize: max edge 600px, JPEG 85% quality
          const sharp = (await import('sharp')).default;
          buffer = await sharp(buffer)
            .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          
          const ossPath = `prompts/preview_${p.id}_${Date.now()}.jpg`;
          const result = await ossClient.put(ossPath, buffer);
          p.data.preview_img = result.url.replace('http://', 'https://');
        } catch (ossErr) {
          console.error(`[Prompt Sync] Failed to upload preview image for prompt ${p.id}:`, ossErr.message);
          p.data.preview_img = ''; // Remove massive base64 string on failure
        }
      }

      const insertQuery = `
        INSERT INTO "yizi_prompts" (id, group_id, content, data)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE 
        SET content = EXCLUDED.content, group_id = EXCLUDED.group_id, data = EXCLUDED.data
      `;
      await client.query(insertQuery, [p.id, p.group_id, p.content, p.data || {}]);
    }
    await client.query('COMMIT');
    res.json({ 
      msg: 'ok', 
      info: `Synced ${prompts.length} prompts and ${groupsSynced} groups successfully.`,
      result: { prompts: prompts.length, groups: groupsSynced }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Prompt Sync]', err);
    res.json({ msg: 'err', info: err.message });
  } finally {
    client.release();
  }
});

router.post('/toolkit/grsai', authenticateToken, async (req, res) => {
  const { images, prompt, model, aspectRatio, quality } = req.body;

  const { getSetting } = await import('./config_manager.js');
  const endpoint = process.env.GRSAI_API_ENDPOINT || await getSetting(pool, 'GRSAI_API_ENDPOINT');
  const apiKey = process.env.GRSAI_API_KEY || await getSetting(pool, 'GRSAI_API_KEY');

  if (!endpoint || !apiKey) {
    return res.json({ msg: 'err', info: 'Grsai API not configured in settings' });
  }

  let baseUrl = endpoint.trim();
  if (!baseUrl.startsWith('http')) baseUrl = 'https://' + baseUrl;
  const generateUrl = baseUrl.endsWith('/generate') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/api/generate`;
  const resultUrl = generateUrl.replace(/\/generate$/, '/result');
  const token = apiKey.trim().replace(/^Bearer\s+/i, '');

  const payload = {
    model: model || 'gpt-image-2',
    prompt: prompt || '',
    images: Array.isArray(images) ? images : (images ? [images] : []),
    aspectRatio: aspectRatio || '1024x1024',
    quality: quality || 'standard',
    replyType: 'async'
  };

  try {
    console.log(`[Toolkit Grsai] Submitting to ${generateUrl}`);
    const submitRes = await fetch(generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });

    if (!submitRes.ok) {
      const errText = await submitRes.text();
      return res.json({ msg: 'err', info: `Grsai API [${submitRes.status}]: ${errText}` });
    }

    const data = await submitRes.json();
    if (!data.id) {
      return res.json({ msg: 'err', info: 'Grsai did not return a task ID' });
    }

    const taskId = data.id;
    console.log(`[Toolkit Grsai] Task ${taskId} submitted, polling...`);

    // Poll for result (max 5 minutes = 30 polls * 10s)
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let consecutiveErrors = 0;

    for (let i = 0; i < 30; i++) {
      await sleep(10000);

      let pollRes;
      try {
        pollRes = await fetch(`${resultUrl}?id=${encodeURIComponent(taskId)}`, {
          headers: { 'Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(15000)
        });
      } catch (fetchErr) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          return res.json({ msg: 'err', info: `Poll network error after ${consecutiveErrors} retries: ${fetchErr.message}` });
        }
        continue;
      }

      if (!pollRes.ok) {
        consecutiveErrors++;
        if (consecutiveErrors >= 5) {
          return res.json({ msg: 'err', info: `Poll HTTP error after ${consecutiveErrors} retries (last: ${pollRes.status})` });
        }
        continue;
      }

      consecutiveErrors = 0;
      const pollData = await pollRes.json();

      if (pollData.status === 'succeeded' && pollData.results && pollData.results.length > 0) {
        const urls = pollData.results.map(r => r.url);
        console.log(`[Toolkit Grsai] Task ${taskId} succeeded: ${urls.length} images`);
        return res.json({ msg: 'ok', images: urls, task_id: taskId });
      } else if (pollData.status === 'failed') {
        return res.json({ msg: 'err', info: pollData.error || pollData.message || 'Task failed', task_id: taskId });
      }
      // else still processing, continue polling
    }

    return res.json({ msg: 'err', info: `Task ${taskId} timed out after 300s` });

  } catch (err) {
    console.error('[Toolkit Grsai Error]', err);
    return res.json({ msg: 'err', info: err.message });
  }
});

export default router;
