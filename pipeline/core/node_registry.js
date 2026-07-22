/**
 * node_registry.js — 端口类型注册表
 * 
 * 为 DAG 的每个节点类型声明其输入/输出端口的数据类型。
 * 用于 resolveInputs 阶段的类型校验，以及前端连线时的类型约束。
 */

export const PORT_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',           // Single image URL string (http:// or data:image/...)
  IMAGE_ARRAY: 'image_array', // Array of image URL strings
  NUMBER: 'number',
  JSON: 'json',
  ANY: 'any',
};

// Type compatibility matrix: can source type flow into target type?
// Rules:
// - ANY accepts everything
// - IMAGE can flow into IMAGE_ARRAY (auto-wrapped)
// - IMAGE_ARRAY can flow into IMAGE (first element extracted)
// - TEXT cannot flow into IMAGE/IMAGE_ARRAY and vice versa (THIS IS THE KEY RULE)
// - NUMBER is only compatible with NUMBER and ANY
export function isTypeCompatible(sourceType, targetType) {
  if (targetType === PORT_TYPES.ANY || sourceType === PORT_TYPES.ANY) return true;
  if (sourceType === targetType) return true;
  // IMAGE <-> IMAGE_ARRAY are compatible (auto-coercion)
  if ((sourceType === PORT_TYPES.IMAGE && targetType === PORT_TYPES.IMAGE_ARRAY) ||
      (sourceType === PORT_TYPES.IMAGE_ARRAY && targetType === PORT_TYPES.IMAGE)) return true;
  return false;
}

export const NODE_PORT_SCHEMA = {
  'toolkit_input': {
    inputs: {},
    outputs: { images: 'image_array', prompt: 'text', toolkit_user: 'text', single_image: 'image' }
  },
  'order_input': {
    inputs: {},
    outputs: {
      user_prompt: 'text', user_images: 'image_array',
      user_image_1: 'image', user_image_2: 'image', user_image_3: 'image', user_image_4: 'image',
      order_info: 'json', model_name: 'text', model_uuid: 'text',
      prompt_slot_1: 'text', prompt_slot_2: 'text', prompt_slot_3: 'text', prompt_slot_4: 'text',
      stitched_image: 'image', random_pose_image: 'image'
    }
  },
  'preset_seedream': {
    inputs: { prompt: 'text', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image', images: 'image_array' },
    outputs: { output: 'image_array' }
  },
  'seedream': {
    inputs: { prompt: 'text', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image', images: 'image_array' },
    outputs: { output: 'image_array' }
  },
  'preset_apiyi': {
    inputs: { prompt: 'text', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image', images_array: 'image_array' },
    outputs: { output: 'image_array', _debug: 'json' }
  },
  'apiyi_gpt_image2': {
    inputs: { prompt: 'text', quality: 'text', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image', images_array: 'image_array', mask: 'image' },
    outputs: { output: 'image_array' }
  },
  'preset_nanobanana': {
    inputs: { prompt: 'text', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image', images_array: 'image_array' },
    outputs: { output: 'image_array' }
  },
  'preset_grsai': {
    inputs: { prompt: 'text', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image', images_array: 'image_array' },
    outputs: { output: 'image_array' }
  },
  'preset_openrouter': {
    inputs: { prompt: 'text', quality: 'text', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image', images_array: 'image_array' },
    outputs: { output: 'image_array' }
  },
  'grok_imagine': {
    inputs: { prompt: 'text', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image', images_array: 'image_array', images: 'image_array' },
    outputs: { output: 'image_array' }
  },
  'text_input': {
    inputs: {},
    outputs: { output: 'text' }
  },
  'image_input': {
    inputs: {},
    outputs: { output: 'image' }
  },
  'float_input': {
    inputs: {},
    outputs: { output: 'number' }
  },
  'prompt_board': {
    inputs: { text_in: 'text' },
    outputs: { prompt: 'text', output: 'text' }
  },
  'string_concat': {
    inputs: { str1: 'text', str2: 'text', str3: 'text', str4: 'text', str5: 'text', str6: 'text' },
    outputs: { output: 'text' }
  },
  'llm_call': {
    inputs: { system_prompt: 'text', prompt: 'text', images: 'image_array', image: 'image', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image' },
    outputs: { output: 'text' }
  },
  'llm_prompt_fission': {
    inputs: { prompt: 'text', system_prompt: 'text', diversity_prompt: 'text' },
    outputs: { output_1: 'text', output_2: 'text', output_3: 'text', output_4: 'text', output_5: 'text', output_6: 'text' }
  },
  'prompt_library': {
    inputs: {},
    outputs: { prompt: 'text', output: 'text', preview_img: 'image' }
  },
  'image_preview': {
    inputs: { image_url: 'image' },
    outputs: { output: 'image' }
  },
  'text_preview': {
    inputs: { text: 'text' },
    outputs: { output: 'text' }
  },
  'comfy_remote': {
    inputs: { image_url: 'image', prompt_override: 'text', float_val_1: 'number', float_val_2: 'number' },
    outputs: { output: 'json' }
  },
  'oss_output': {
    inputs: { images: 'image_array', output: 'any', order_info: 'json' },
    outputs: { uploaded_urls: 'image_array' }
  },
  'http_request': {
    inputs: { url: 'text', body: 'json' },
    outputs: { response: 'json' }
  },
  'color_grading': {
    inputs: { image: 'image', brightness: 'number', contrast: 'number', temperature: 'number' },
    outputs: { output: 'image' }
  },
  'image_stitch': {
    inputs: { image_0: 'image', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image', images: 'image_array' },
    outputs: { output: 'image' }
  },
  'image_split': {
    inputs: { image: 'image', gridMode: 'text' },
    outputs: { images: 'image_array', image_1: 'image', image_2: 'image', image_3: 'image', image_4: 'image' }
  },
};

/**
 * Look up the expected port type for a specific node type + port name.
 * Returns PORT_TYPES.ANY if the node type or port is not registered.
 */
export function getPortType(nodeType, portName, direction) {
  const schema = NODE_PORT_SCHEMA[nodeType];
  if (!schema) return PORT_TYPES.ANY;
  const ports = direction === 'output' ? schema.outputs : schema.inputs;
  return ports?.[portName] || PORT_TYPES.ANY;
}
