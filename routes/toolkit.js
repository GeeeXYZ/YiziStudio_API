import express from 'express';
import OSS from 'ali-oss';
import { pool } from '../config/db.js';
import { authenticateToken } from '../middleware/auth.js';
import { checkPermission } from '../middleware/rbac.js';
import { finalizePipelineBilling } from '../services/billingService.js';

const router = express.Router();

global.visionTasks = global.visionTasks || {};

// GET /toolkit/prompts/history — Read logged-in admin's prompt history
router.get('/toolkit/prompts/history', authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;
    if (!email) return res.json({ msg: 'err', info: 'Unauthorized' });

    const result = await pool.query('SELECT data FROM "yizi_admins" WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ msg: 'err', info: 'User not found' });

    const data = typeof result.rows[0].data === 'string' ? JSON.parse(result.rows[0].data) : (result.rows[0].data || {});
    return res.json({ msg: 'ok', history: data.prompt_history || [] });
  } catch (err) {
    console.error('[Prompt History Read Error]', err);
    return res.json({ msg: 'err', info: err.message });
  }
});

// POST /toolkit/prompts/history — Save logged-in admin's prompt history
router.post('/toolkit/prompts/history', authenticateToken, async (req, res) => {
  const { history } = req.body;
  if (!Array.isArray(history)) return res.json({ msg: 'err', info: 'Invalid history format' });

  try {
    const email = req.user.email;
    if (!email) return res.json({ msg: 'err', info: 'Unauthorized' });

    const result = await pool.query('SELECT data FROM "yizi_admins" WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ msg: 'err', info: 'User not found' });

    const data = typeof result.rows[0].data === 'string' ? JSON.parse(result.rows[0].data) : (result.rows[0].data || {});
    data.prompt_history = history;

    await pool.query('UPDATE "yizi_admins" SET data = $1 WHERE email = $2', [JSON.stringify(data), email]);
    
    return res.json({ msg: 'ok' });
  } catch (err) {
    console.error('[Prompt History Save Error]', err);
    return res.json({ msg: 'err', info: err.message });
  }
});

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
  const { groups, sets, prompts, client_updated_at, force_override } = req.body;
  if (!Array.isArray(prompts)) return res.json({ msg: 'err', info: 'Invalid data format. Expected prompts array.' });
  
  const client = await pool.connect();
  try {
    // Check conflict BEFORE starting transaction if client_updated_at is provided
    if (client_updated_at && !force_override) {
      try {
        const maxGroupRes = await client.query('SELECT MAX(updated_at) as max_val FROM "yizi_prompt_groups"');
        const maxSetRes = await client.query('SELECT MAX(updated_at) as max_val FROM "yizi_prompt_sets"');
        const maxPromptRes = await client.query('SELECT MAX(updated_at) as max_val FROM "yizi_prompts"');
        
        const maxVals = [
          maxGroupRes.rows[0]?.max_val,
          maxSetRes.rows[0]?.max_val,
          maxPromptRes.rows[0]?.max_val
        ].map(d => d ? new Date(d).getTime() : 0);
        
        const server_updated_at = Math.max(...maxVals, 0);
        
        if (server_updated_at > client_updated_at) {
          client.release();
          return res.status(409).json({ 
            msg: 'conflict', 
            info: '云端内容已更新，请决定是否强制覆盖。',
            server_updated_at 
          });
        }
      } catch (err) {
        // Table might not exist yet during first sync, safe to ignore conflict check
      }
    }

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
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    
    await client.query(`CREATE TABLE IF NOT EXISTS "yizi_prompt_sets" (
      id VARCHAR(255) PRIMARY KEY,
      group_id VARCHAR(255),
      title VARCHAR(255),
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    
    await client.query(`CREATE TABLE IF NOT EXISTS "yizi_prompts" (
      id VARCHAR(255) PRIMARY KEY,
      set_id VARCHAR(255),
      content TEXT,
      tags VARCHAR(255),
      data JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    
    // Add updated_at to existing tables if they don't have it
    await client.query(`ALTER TABLE "yizi_prompt_groups" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await client.query(`ALTER TABLE "yizi_prompt_sets" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await client.query(`ALTER TABLE "yizi_prompts" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await client.query(`ALTER TABLE "yizi_prompts" ADD COLUMN IF NOT EXISTS tags VARCHAR(255)`);

    // Phase 1: UPSERT Groups
    let groupsSynced = 0;
    if (Array.isArray(groups)) {
      for (const g of groups) {
        if (!g.id || !g.name) continue;
        const insertGroupQuery = `
          INSERT INTO "yizi_prompt_groups" (id, name, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
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
          INSERT INTO "yizi_prompt_sets" (id, group_id, title, data, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (id) DO UPDATE 
          SET group_id = EXCLUDED.group_id, title = EXCLUDED.title, data = EXCLUDED.data, updated_at = NOW()
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
        INSERT INTO "yizi_prompts" (id, set_id, content, tags, data, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO UPDATE 
        SET content = EXCLUDED.content, set_id = EXCLUDED.set_id, tags = EXCLUDED.tags, data = EXCLUDED.data, updated_at = NOW()
      `;
      await client.query(insertPromptQuery, [p.id, p.set_id, p.content, p.tags || '', p.data || {}]);
    }
    
    await client.query('COMMIT');
    
    // Fetch latest timestamp to return
    const maxGroupRes = await client.query('SELECT MAX(updated_at) as max_val FROM "yizi_prompt_groups"');
    const maxSetRes = await client.query('SELECT MAX(updated_at) as max_val FROM "yizi_prompt_sets"');
    const maxPromptRes = await client.query('SELECT MAX(updated_at) as max_val FROM "yizi_prompts"');
    const maxVals = [maxGroupRes.rows[0]?.max_val, maxSetRes.rows[0]?.max_val, maxPromptRes.rows[0]?.max_val].map(d => d ? new Date(d).getTime() : 0);
    const new_server_updated_at = Math.max(...maxVals, 0);

    res.json({ 
      msg: 'ok', 
      info: `Synced ${groupsSynced} groups, ${setsSynced} sets, and ${prompts.length} prompts successfully.`,
      server_updated_at: new_server_updated_at,
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
    },
    { 
      id: 'grok_imagine', 
      name: 'Grok Imagine', 
      models: [
        { 
          id: 'grok-imagine-image-quality', 
          name: 'Quality (高质量)',
          sizes: [
            { value: '2k_16:9', label: '2k 16:9 (横版)' },
            { value: '2k_9:16', label: '2k 9:16 (竖版)' },
            { value: '2k_1:1', label: '2k 1:1 (方形)' },
            { value: '2k_4:3', label: '2k 4:3 (简报)' },
            { value: '2k_3:4', label: '2k 3:4 (肖像)' },
            { value: '1k_16:9', label: '1k 16:9 (横版)' },
            { value: '1k_9:16', label: '1k 9:16 (竖版)' },
            { value: '1k_1:1', label: '1k 1:1 (方形)' },
            { value: '1k_4:3', label: '1k 4:3 (简报)' },
            { value: '1k_3:4', label: '1k 3:4 (肖像)' }
          ]
        },
        { 
          id: 'grok-imagine-image', 
          name: 'Regular (普通)',
          sizes: [
            { value: '2k_16:9', label: '2k 16:9 (横版)' },
            { value: '2k_9:16', label: '2k 9:16 (竖版)' },
            { value: '2k_1:1', label: '2k 1:1 (方形)' },
            { value: '2k_4:3', label: '2k 4:3 (简报)' },
            { value: '2k_3:4', label: '2k 3:4 (肖像)' },
            { value: '1k_16:9', label: '1k 16:9 (横版)' },
            { value: '1k_9:16', label: '1k 9:16 (竖版)' },
            { value: '1k_1:1', label: '1k 1:1 (方形)' },
            { value: '1k_4:3', label: '1k 4:3 (简报)' },
            { value: '1k_3:4', label: '1k 3:4 (肖像)' }
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
        resolution: nodeType === 'grok_imagine' ? (aspectRatio.includes('_') ? aspectRatio.split('_')[0] : '2k') : aspectRatio,
        aspectRatio: nodeType === 'grok_imagine' ? (aspectRatio.includes('_') ? aspectRatio.split('_')[1] : aspectRatio) : aspectRatio,
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
    
    // Process billing
    await finalizePipelineBilling(
      { [`${virtualNode.type}::${virtualNode.data.modelId}`]: { node_type: virtualNode.type, model: virtualNode.data.modelId, count: 1 } },
      { task_id: `toolkit_direct_${Date.now()}`, run_by_admin_id: req.user?.id }
    );
    
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

// GET /toolkit/prompts/all — Pull full prompt library tree
router.get('/toolkit/prompts/all', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    // Ensure columns exist for first-time callers
    await client.query(`ALTER TABLE "yizi_prompt_groups" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await client.query(`ALTER TABLE "yizi_prompt_sets" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await client.query(`ALTER TABLE "yizi_prompts" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await client.query(`ALTER TABLE "yizi_prompts" ADD COLUMN IF NOT EXISTS tags VARCHAR(255)`);

    const groupsRes = await client.query('SELECT id, name, updated_at FROM "yizi_prompt_groups" ORDER BY created_at ASC');
    const setsRes = await client.query('SELECT id, group_id, title, data, updated_at FROM "yizi_prompt_sets" ORDER BY created_at ASC');
    const promptsRes = await client.query('SELECT id, set_id, content, tags, data, updated_at FROM "yizi_prompts" ORDER BY created_at ASC');
    
    let global_updated_at = 0;
    // Assemble the tree
    const groupsMap = {};
    const setsMap = {};
    
    const resultTree = [];
    
    groupsRes.rows.forEach(g => {
      const gTime = g.updated_at ? new Date(g.updated_at).getTime() : 0;
      if (gTime > global_updated_at) global_updated_at = gTime;
      
      const group = { id: g.id, name: g.name, updated_at: gTime, sets: [] };
      groupsMap[g.id] = group;
      resultTree.push(group);
    });
    
    setsRes.rows.forEach(s => {
      const sTime = s.updated_at ? new Date(s.updated_at).getTime() : 0;
      if (sTime > global_updated_at) global_updated_at = sTime;
      
      const set = { id: s.id, group_id: s.group_id, title: s.title, data: s.data || {}, updated_at: sTime, prompts: [] };
      setsMap[s.id] = set;
      if (groupsMap[s.group_id]) {
        groupsMap[s.group_id].sets.push(set);
      } else {
        // Handle orphaned sets if any by ignoring or we could push to a default group
      }
    });
    
    promptsRes.rows.forEach(p => {
      const pTime = p.updated_at ? new Date(p.updated_at).getTime() : 0;
      if (pTime > global_updated_at) global_updated_at = pTime;
      
      const prompt = { id: p.id, set_id: p.set_id, content: p.content, tags: p.tags, data: p.data || {}, updated_at: pTime };
      if (setsMap[p.set_id]) {
        setsMap[p.set_id].prompts.push(prompt);
      }
    });
    
    res.json({ msg: 'ok', global_updated_at, data: resultTree });
  } catch (err) {
    console.error('[Prompt Pull Error]', err);
    res.json({ msg: 'err', info: err.message });
  } finally {
    client.release();
  }
});

export default router;

// POST /toolkit/vision_api/execute_async
router.post('/toolkit/vision_api/execute_async', authenticateToken, async (req, res) => {
  const { nodeType, model, prompt, images, aspectRatio, quality } = req.body;
  if (!nodeType) return res.json({ msg: 'err', info: 'Missing nodeType' });

  const taskId = 'task_' + Date.now() + Math.random().toString(36).substring(2, 7);
  global.visionTasks[taskId] = { status: 'processing', images: [] };

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
        resolution: nodeType === 'grok_imagine' ? (aspectRatio.includes('_') ? aspectRatio.split('_')[0] : '2k') : aspectRatio,
        aspectRatio: nodeType === 'grok_imagine' ? (aspectRatio.includes('_') ? aspectRatio.split('_')[1] : aspectRatio) : aspectRatio,
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

    const mockOrderContext = { order_id: 'toolkit_vision_direct_async' };
    
    // Fire and forget (No await here)
    runSingleNode(virtualNode, virtualInputs, process.env, pool, mockOrderContext, null)
      .then(async outputs => {
        // Process billing
        await finalizePipelineBilling(
          { [`${virtualNode.type}::${virtualNode.data.modelId}`]: { node_type: virtualNode.type, model: virtualNode.data.modelId, count: 1 } },
          { task_id: `toolkit_async_${taskId}`, run_by_admin_id: req.user?.id }
        );

        if (outputs && (outputs.output_images || outputs.output || outputs.images)) {
          let urls = outputs.output_images || outputs.output || outputs.images;
          if (!Array.isArray(urls)) urls = [urls];
          urls = urls.filter(u => u && typeof u === 'string' && u.trim() !== '');
          if (urls.length === 0) {
            global.visionTasks[taskId] = { status: 'error', info: 'Node returned empty images list' };
          } else {
            global.visionTasks[taskId] = { status: 'success', images: urls };
          }
        } else {
          global.visionTasks[taskId] = { status: 'error', info: 'No images generated by the node' };
        }
      })
      .catch(err => {
        console.error(`[Toolkit Vision API Async Error]`, err);
        global.visionTasks[taskId] = { status: 'error', info: err.message };
      });
      
    // Return immediately to frontend
    return res.json({ msg: 'ok', task_id: taskId });
  } catch (err) {
    console.error(`[Toolkit Vision API Init Error]`, err);
    global.visionTasks[taskId] = { status: 'error', info: err.message };
    return res.json({ msg: 'err', info: err.message });
  }
});

// GET /toolkit/vision_api/status
router.get('/toolkit/vision_api/status', authenticateToken, async (req, res) => {
  const { task_id } = req.query;
  if (!task_id) return res.json({ msg: 'err', info: 'Missing task_id' });
  
  const task = global.visionTasks[task_id];
  if (!task) return res.json({ msg: 'err', info: 'Task not found or expired' });
  
  return res.json({ msg: 'ok', result: task });
});
