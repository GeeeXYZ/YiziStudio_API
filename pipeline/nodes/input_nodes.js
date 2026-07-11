// Pose images are now fetched from database (yizi_model table) as single source of truth

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
    prompt_slot_4: orderContext.prompt_slot_4 || ''
  };
  
  // Random Pose Image Fetching
  outputs.random_pose_image = '';
  if (orderContext.selectedPoseUrl) {
    outputs.random_pose_image = orderContext.selectedPoseUrl;
  } else if (outputs.model_uuid && pool) {
    try {
      const poseControl = node.data?.poseSourceControl || 'template';
      let poseFolder = 'poses';
      if (poseControl === 'node') {
        poseFolder = node.data?.nodePoseFolder || 'poses';
      } else {
        poseFolder = orderContext.sku_pose_folder || 'poses';
      }

      // Query the database for the model's pose URLs (single source of truth)
      const modelResult = await pool.query('SELECT poses, half_poses, special_poses FROM "yizi_model" WHERE uuid = $1', [outputs.model_uuid]);
      if (modelResult.rows.length > 0) {
        const modelRow = modelResult.rows[0];
        
        // Map folder name to the correct DB column
        let poseUrls = [];
        if (poseFolder === 'poses') {
          poseUrls = modelRow.poses || [];
        } else if (poseFolder === 'half_poses') {
          poseUrls = modelRow.half_poses || [];
        } else if (poseFolder === 'special_poses') {
          poseUrls = modelRow.special_poses || [];
        }

        // Parse if stored as JSON string
        if (typeof poseUrls === 'string') {
          try { poseUrls = JSON.parse(poseUrls); } catch(e) { poseUrls = []; }
        }

        // Filter to only valid URLs
        poseUrls = (Array.isArray(poseUrls) ? poseUrls : []).filter(u => typeof u === 'string' && u.trim() !== '');

        if (poseUrls.length > 0) {
          orderContext._usedPoses = orderContext._usedPoses || new Set();
          
          let available = poseUrls.filter(u => !orderContext._usedPoses.has(u));
          if (available.length === 0) {
            console.warn(`[Pipeline] All poses in ${poseFolder} used, resetting for model ${outputs.model_uuid}`);
            available = poseUrls;
          }

          const randomIndex = Math.floor(Math.random() * available.length);
          outputs.random_pose_image = available[randomIndex];
          orderContext._usedPoses.add(outputs.random_pose_image);
          
          console.log(`[Pipeline] Randomly picked pose image for ${outputs.model_uuid} from DB (${poseFolder}):`, outputs.random_pose_image);
        } else {
          console.warn(`[Pipeline] No pose images found in DB for model ${outputs.model_uuid} in column ${poseFolder}`);
        }
      } else {
        console.warn(`[Pipeline] Model ${outputs.model_uuid} not found in database`);
      }
    } catch (err) {
      console.warn(`[Pipeline] Failed to fetch random pose for model ${outputs.model_uuid}:`, err.message);
    }
  }
  return outputs;
}
