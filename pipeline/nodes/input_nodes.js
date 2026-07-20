// Pose images are fetched by scanning OSS directory (single source of truth — only physically existing files are selected)

export async function executeToolkitInput(node, inputs, orderContext, env, pool) {
  const imgArray = orderContext.toolkit_images || [];
  const idx = parseInt(node.data?.image_index) || 0;
  return {
    images: imgArray,
    prompt: orderContext.toolkit_prompt || '',
    toolkit_user: orderContext.openid || 'unknown',
    single_image: imgArray[idx] || ''
  };
}

export async function executeOrderInput(node, inputs, orderContext, env, pool) {
  const outputs = {
    user_prompt: orderContext.prompt || '',
    user_images: orderContext.images || [],
    order_info: {
      openid: orderContext.openid,
      order_id: orderContext.order_id,
      set_index: orderContext.set_index || 0
    },
    model_name: orderContext.model_name || '',
    model_uuid: orderContext.model_uuid || '',
    prompt_slot_1: orderContext.prompt_slot_1 || '',
    prompt_slot_2: orderContext.prompt_slot_2 || '',
    prompt_slot_3: orderContext.prompt_slot_3 || '',
    prompt_slot_4: orderContext.prompt_slot_4 || '',
    stitched_image: orderContext.stitched_image || ''
  };
  
  // Random Pose Image Fetching — OSS directory is the single source of truth
  outputs.random_pose_image = '';
  if (orderContext.selectedPoseUrl) {
    outputs.random_pose_image = orderContext.selectedPoseUrl;
  } else if (outputs.model_uuid) {
    try {
      const ossClient = new (await import('ali-oss')).default({
        region: env.OSS_REGION,
        accessKeyId: env.OSS_ACCESS_KEY_ID,
        accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
        bucket: env.OSS_BUCKET,
        secure: true,
        timeout: 10000,
        ...(env.OSS_ENDPOINT ? { endpoint: env.OSS_ENDPOINT } : {})
      });

      const poseControl = node.data?.poseSourceControl || 'template';
      let poseFolder = 'poses';
      if (poseControl === 'node') {
        poseFolder = node.data?.nodePoseFolder || 'poses';
      } else {
        poseFolder = orderContext.sku_pose_folder || 'poses';
      }

      const prefix = `models/${outputs.model_uuid}/${poseFolder}/`;
      const listResult = await ossClient.list({ prefix, 'max-keys': 1000 });
      if (listResult && listResult.objects) {
        const files = listResult.objects.filter(obj => !obj.name.endsWith('/'));
        if (files.length > 0) {
          // Build public URLs from object keys
          const ossDomain = `https://${env.OSS_BUCKET}.${env.OSS_REGION}.aliyuncs.com`;
          const poseUrls = files.map(f => `${ossDomain}/${f.name}`);

          orderContext._usedPoses = orderContext._usedPoses || new Set();
          let available = poseUrls.filter(u => !orderContext._usedPoses.has(u));
          if (available.length === 0) {
            console.warn(`[Pipeline] All ${poseUrls.length} poses in ${poseFolder} used, resetting for model ${outputs.model_uuid}`);
            available = poseUrls;
          }

          const randomIndex = Math.floor(Math.random() * available.length);
          outputs.random_pose_image = available[randomIndex];
          orderContext._usedPoses.add(outputs.random_pose_image);

          console.log(`[Pipeline] Randomly picked pose image for ${outputs.model_uuid} from OSS (${poseFolder}):`, outputs.random_pose_image);
        } else {
          console.warn(`[Pipeline] No pose images found in OSS for model ${outputs.model_uuid} in folder ${poseFolder}`);
        }
      }
    } catch (err) {
      console.warn(`[Pipeline] Failed to fetch random pose for model ${outputs.model_uuid}:`, err.message);
    }
  }

  // --- Auto Stitch: combine pose(#1) + user images(#2,#3...) after pose is determined ---
  if (!orderContext.stitched_image) {
    try {
      const stitchSources = [
        outputs.random_pose_image,
        ...(outputs.user_images || [])
      ].filter(u => typeof u === 'string' && u.trim() !== '');

      if (stitchSources.length >= 2) {
        const { stitchImages } = await import('../core/image_stitcher.js');
        console.log(`[Auto Stitch] Stitching ${stitchSources.length} images for Order ${orderContext.order_id} Set ${orderContext.set_index}`);
        const { buffer: stitchedBuf } = await stitchImages(stitchSources);

        // Upload to OSS
        const OSS = (await import('ali-oss')).default;
        const ossClient = new OSS({
          region: env.OSS_REGION,
          accessKeyId: env.OSS_ACCESS_KEY_ID,
          accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
          bucket: env.OSS_BUCKET,
          secure: true,
          timeout: 30000,
          ...(env.OSS_ENDPOINT ? { endpoint: env.OSS_ENDPOINT } : {})
        });
        const ossPath = `pipeline_outputs/${orderContext.openid || 'unknown'}/${orderContext.order_id || 'test'}/stitched_set${orderContext.set_index || 0}_${Date.now()}.jpg`;
        const putResult = await ossClient.put(ossPath, stitchedBuf);
        let stitchedUrl = putResult.url;
        if (stitchedUrl.startsWith('http://')) stitchedUrl = stitchedUrl.replace('http://', 'https://');

        outputs.stitched_image = stitchedUrl;
        orderContext.stitched_image = stitchedUrl;
        console.log(`[Auto Stitch] Result → ${stitchedUrl.substring(0, 80)}...`);

        // Persist to database so workspace can display it
        if (pool && orderContext.isRealOrder && orderContext.order_id) {
          try {
            const dbRes = await pool.query('SELECT data FROM "yizi_orders" WHERE id = $1', [orderContext.order_id]);
            if (dbRes.rows.length > 0) {
              const orderData = typeof dbRes.rows[0].data === 'string' ? JSON.parse(dbRes.rows[0].data) : (dbRes.rows[0].data || {});
              const setIdx = orderContext.set_index || 0;
              if (orderData.sets && orderData.sets[setIdx]) {
                orderData.sets[setIdx].stitched_image = stitchedUrl;
                await pool.query('UPDATE "yizi_orders" SET data = $1 WHERE id = $2', [JSON.stringify(orderData), orderContext.order_id]);
                console.log(`[Auto Stitch] Persisted stitched_image to DB for order ${orderContext.order_id} set ${setIdx}`);
              }
            }
          } catch (dbErr) {
            console.warn(`[Auto Stitch] DB persist failed (non-fatal):`, dbErr.message);
          }
        }
      } else {
        console.log(`[Auto Stitch] Not enough images to stitch (${stitchSources.length})`);
      }
    } catch (stitchErr) {
      console.warn(`[Auto Stitch] Failed for Order ${orderContext.order_id}:`, stitchErr.message);
      // Non-fatal: pipeline continues without stitched image
    }
  }

  return outputs;
}

export async function executeFloatInput(node, inputs) {
  let val = parseFloat(node.data?.value);
  if (isNaN(val)) val = 0.00;
  return {
    output: Number(val.toFixed(2))
  };
}

export async function executeImageInput(node, inputs) {
  let url = node.data?.imageUrl || '';
  if (Array.isArray(url)) {
    url = url[0] || '';
  }
  return {
    output: url
  };
}
