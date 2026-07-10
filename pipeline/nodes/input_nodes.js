import OSS from 'ali-oss';

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
  } else if (outputs.model_uuid) {
    try {
      const ossConfig = {
        region: env.OSS_REGION,
        accessKeyId: env.OSS_ACCESS_KEY_ID,
        accessKeySecret: env.OSS_ACCESS_KEY_SECRET,
        bucket: env.OSS_BUCKET,
        secure: true,
        timeout: 10000
      };
      
      if (env.OSS_ENDPOINT) {
        ossConfig.endpoint = env.OSS_ENDPOINT;
      }
      
      const ossClient = new OSS(ossConfig);
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
          const randomIndex = Math.floor(Math.random() * files.length);
          const randomFile = files[randomIndex];
          outputs.random_pose_image = randomFile.url;
          console.log(`[Pipeline] Randomly picked pose image for ${outputs.model_uuid}:`, outputs.random_pose_image);
        } else {
          console.warn(`[Pipeline] No pose images found for model ${outputs.model_uuid} in folder ${poseFolder}`);
        }
      }
    } catch (err) {
      console.warn(`[Pipeline] Failed to fetch random pose from OSS for model ${outputs.model_uuid}:`, err.message);
    }
  }
  return outputs;
}
