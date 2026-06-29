import express from 'express';
import OSS from 'ali-oss';
import { pool } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { checkPermission } from '../middleware/rbac.js';

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
      secure: true,
      timeout: 300000
    };
    if (!ossConfig.accessKeyId) return res.json({ msg: 'err', info: 'OSS Not Configured' });
    const ossClient = new OSS(ossConfig);

    const { uploadToOSS } = await import('../pipeline/index.js');
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
router.post('/toolkit/prompts/sync', authenticateToken, checkPermission('prompts:write'), async (req, res) => {
  const { groups, sets, prompts } = req.body;
  if (!Array.isArray(prompts)) return res.json({ msg: 'err', info: 'Invalid data format. Expected prompts array.' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Database schema migration
    // Step 1: Check if old yizi_prompt_groups exists and needs renaming to yizi_prompt_sets
    const tableCheckRes = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'yizi_prompt_groups'
      ) as exists
    `);
    
    const setsCheckRes = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'yizi_prompt_sets'
      ) as exists
    `);
    
    if (tableCheckRes.rows[0].exists && !setsCheckRes.rows[0].exists) {
      console.log('[Prompt Sync] Performing schema migration: renaming yizi_prompt_groups to yizi_prompt_sets');
      await client.query(`ALTER TABLE "yizi_prompt_groups" RENAME TO "yizi_prompt_sets"`);
      await client.query(`ALTER TABLE "yizi_prompt_sets" ADD COLUMN IF NOT EXISTS group_id VARCHAR(50)`);
      
      const promptsCheckRes = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='yizi_prompts' and column_name='group_id'
      `);
      if (promptsCheckRes.rows.length > 0) {
        await client.query(`ALTER TABLE "yizi_prompts" RENAME COLUMN group_id TO set_id`);
      }
    }
    
    // Ensure tables exist
    await client.query(`CREATE TABLE IF NOT EXISTS "yizi_prompt_groups" (
      id VARCHAR(255) PRIMARY KEY,
      name VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    
    await client.query(`CREATE TABLE IF NOT EXISTS "yizi_prompt_sets" (
      id VARCHAR(255) PRIMARY KEY,
      group_id VARCHAR(255),
      title VARCHAR(255),
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    
    await client.query(`CREATE TABLE IF NOT EXISTS "yizi_prompts" (
      id VARCHAR(255) PRIMARY KEY,
      set_id VARCHAR(255),
      content TEXT,
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Phase 1: UPSERT Groups
    let groupsSynced = 0;
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (!g.id || !g.name) continue;
        const insertGroupQuery = `
          INSERT INTO "yizi_prompt_groups" (id, name)
          VALUES ($1, $2)
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
        `;
        await client.query(insertGroupQuery, [g.id, g.name]);
        groupsSynced++;
      }
    }

    // Phase 2: UPSERT Sets
    let setsSynced = 0;
    if (Array.isArray(sets)) {
      for (const s of sets) {
        if (!s.id || !s.name) continue;

        if (s.data && typeof s.data.cover_img === 'string' && s.data.cover_img.startsWith('data:image')) {
          const base64Data = s.data.cover_img.replace(/^data:image\/\w+;base64,/, "");
          let buffer = Buffer.from(base64Data, 'base64');
          
          const sharp = (await import('sharp')).default;
          const metadata = await sharp(buffer).metadata();
          if (metadata.width > 600 || metadata.height > 600) {
            throw new Error(`图集 [${s.name || s.id}] 的封面图尺寸过大 (${metadata.width}x${metadata.height})，请在前端将其压缩至最大边不大于600px后再同步。`);
          }

          try {
            const ossConfig = {
              region: process.env.OSS_REGION,
              accessKeyId: process.env.OSS_ACCESS_KEY_ID,
              accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
              bucket: process.env.OSS_BUCKET,
              timeout: 300000
            };
            const ossClient = new OSS(ossConfig);
            
            // Clean up id for filename to prevent folder structure issues in OSS
            const safeId = s.id.replace(/[^a-zA-Z0-9_\-]/g, '_');
            const ossPath = `prompts/set_cover_${safeId}_${Date.now()}.${metadata.format || 'jpg'}`;
            const result = await ossClient.put(ossPath, buffer);
            s.data.cover_img = result.url.replace('http://', 'https://');
          } catch (ossErr) {
            console.error(`[Prompt Sync] Failed to upload cover image for set ${s.id}:`, ossErr.message);
            s.data.cover_img = ''; 
          }
        }

        const insertSetQuery = `
          INSERT INTO "yizi_prompt_sets" (id, group_id, title, data)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE 
          SET group_id = EXCLUDED.group_id, title = EXCLUDED.title, data = EXCLUDED.data
        `;
        const groupId = s.group_id || "";
        await client.query(insertSetQuery, [s.id, groupId, s.name, s.data || {}]);
        setsSynced++;
      }
    }

    // Phase 3: UPSERT Prompts
    for (const p of prompts) {
      if (!p.id || !p.content || !p.set_id) continue;
      
      // Upload base64 preview images to OSS
      if (p.data && typeof p.data.preview_img === 'string' && p.data.preview_img.startsWith('data:image')) {
        const base64Data = p.data.preview_img.replace(/^data:image\/\w+;base64,/, "");
        let buffer = Buffer.from(base64Data, 'base64');
        
        const sharp = (await import('sharp')).default;
        const metadata = await sharp(buffer).metadata();
        if (metadata.width > 600 || metadata.height > 600) {
          throw new Error(`提示词 [${p.data?.title || p.id}] 的预览图尺寸过大 (${metadata.width}x${metadata.height})，请在前端将其压缩至最大边不大于600px后再同步。`);
        }

        try {
          const ossConfig = {
            region: process.env.OSS_REGION,
            accessKeyId: process.env.OSS_ACCESS_KEY_ID,
            accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
            bucket: process.env.OSS_BUCKET,
            timeout: 300000
          };
          const ossClient = new OSS(ossConfig);
          
          const ossPath = `prompts/preview_${p.id}_${Date.now()}.${metadata.format || 'jpg'}`;
          const result = await ossClient.put(ossPath, buffer);
          p.data.preview_img = result.url.replace('http://', 'https://');
        } catch (ossErr) {
          console.error(`[Prompt Sync] Failed to upload preview image for prompt ${p.id}:`, ossErr.message);
          p.data.preview_img = '';
        }
      }

      const insertPromptQuery = `
        INSERT INTO "yizi_prompts" (id, set_id, content, data)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE 
        SET content = EXCLUDED.content, set_id = EXCLUDED.set_id, data = EXCLUDED.data
      `;
      await client.query(insertPromptQuery, [p.id, p.set_id, p.content, p.data || {}]);
    }
    
    await client.query('COMMIT');
    res.json({ 
      msg: 'ok', 
      info: `Synced ${groupsSynced} groups, ${setsSynced} sets, and ${prompts.length} prompts successfully.`,
      result: { groups: groupsSynced, sets: setsSynced, prompts: prompts.length }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Prompt Sync]', err);
    res.json({ msg: 'err', info: err.message });
  } finally {
    client.release();
  }
});
// GET /toolkit/vision_api/registry
router.get('/toolkit/vision_api/registry', authenticateToken, async (req, res) => {
  const apiyiSizes = [
    { value: '1024x1024', label: '1024x1024 (1:1)' },
    { value: '1280x720', label: '1280x720 (16:9)' },
    { value: '720x1280', label: '720x1280 (9:16)' },
    { value: '1152x864', label: '1152x864 (4:3)' },
    { value: '864x1152', label: '864x1152 (3:4)' },
    { value: '2048x2048', label: '2048x2048 (1:1 HD)' },
    { value: '2048x1152', label: '2048x1152 (16:9 HD)' },
    { value: '1152x2048', label: '1152x2048 (9:16 HD)' },
    { value: '2048x1536', label: '2048x1536 (4:3 HD)' },
    { value: '1536x2048', label: '1536x2048 (3:4 HD)' }
  ];

  const registry = [
    { 
      id: 'preset_grsai', 
      name: 'Grsai 引擎', 
      models: [
        { 
          id: 'gpt-image-2', 
          name: 'GPT Image 2',
          sizes: [
            { value: '1024x1024', label: '1024x1024 (方形)' },
            { value: '1792x1024', label: '1792x1024 (横版)' },
            { value: '1024x1792', label: '1024x1792 (竖版)' }
          ]
        },
        { 
          id: 'gpt-image-2-vip', 
          name: 'GPT Image 2 VIP',
          sizes: apiyiSizes
        },
        { 
          id: 'nano-banana-2', 
          name: 'Nano Banana 2',
          sizes: [
            { value: '1:1',  label: '1:1 方形' },
            { value: '16:9', label: '16:9 横版' },
            { value: '9:16', label: '9:16 竖版' }
          ]
        }
      ]
    },
    { 
      id: 'preset_apiyi', 
      name: 'ApiYi 引擎', 
      models: [
        { id: 'gpt-image-2-vip', name: 'gpt-image-2-vip', sizes: apiyiSizes },
        { id: 'gpt-image-2-all', name: 'gpt-image-2-all', sizes: apiyiSizes }
      ]
    },
    { 
      id: 'seedream', 
      name: 'Seedream', 
      models: [
        { 
          id: 'default', 
          name: '全局端点 (Default)',
          sizes: [
            { value: '2k (Origin)', label: '2k (Origin)' },
            { value: '4k (Origin)', label: '4k (Origin)' },
            { value: '2048x2048 (1:1)', label: '2048x2048 (1:1)' },
            { value: '2496x1664 (3:2)', label: '2496x1664 (3:2)' },
            { value: '1664x2496 (2:3)', label: '1664x2496 (2:3)' },
            { value: '2304x1728 (4:3)', label: '2304x1728 (4:3)' },
            { value: '1728x2304 (3:4)', label: '1728x2304 (3:4)' }
          ]
        }
      ]
    }
  ];
  return res.json({ msg: 'ok', data: registry });
});

// POST /toolkit/vision_api/execute
router.post('/toolkit/vision_api/execute', authenticateToken, async (req, res) => {
  const { nodeType, model, prompt, images, aspectRatio, quality } = req.body;
  if (!nodeType) return res.json({ msg: 'err', info: 'Missing nodeType' });

  try {
    const { runSingleNode } = await import('../pipeline/index.js');
    
    // Construct virtual node and inputs to simulate pipeline environment
    const virtualNode = {
      id: 'toolkit_vision_api',
      type: nodeType,
      data: {
        modelId: model,
        model: model,
        prompt: prompt,
        genSize: aspectRatio,
        resolution: aspectRatio,
        aspectRatio: aspectRatio,
        genQuality: quality,
        size: aspectRatio // For Seedream
      }
    };
    
    const virtualInputs = {
      prompt: prompt,
      input: prompt,
      images: images, // For Seedream backward compatibility
      ref_images: images,
      ref_image_1: Array.isArray(images) ? images[0] : images // OpenRouter & ApiYi compatibility
    };

    const mockOrderContext = { order_id: 'toolkit_vision_direct' };
    
    const outputs = await runSingleNode(virtualNode, virtualInputs, process.env, pool, mockOrderContext, null);
    
    if (outputs && (outputs.output_images || outputs.output || outputs.images)) {
      let urls = outputs.output_images || outputs.output || outputs.images;
      if (!Array.isArray(urls)) urls = [urls];
      // Filter out empty entries
      urls = urls.filter(u => u && typeof u === 'string' && u.trim() !== '');
      if (urls.length === 0) return res.json({ msg: 'err', info: 'Node returned empty images list' });
      return res.json({ msg: 'ok', images: urls });
    } else {
      return res.json({ msg: 'err', info: 'No images generated by the node' });
    }
  } catch (err) {
    console.error(`[Toolkit Vision API Error]`, err);
    return res.json({ msg: 'err', info: err.message });
  }
});

export default router;
