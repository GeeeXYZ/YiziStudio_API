// Helper to map route db_name to actual database table name
function getActualTableName(db_name) {
  if (!db_name) return db_name;
  if (db_name.startsWith('yizi_')) {
    return db_name;
  }
  
  const mapping = {
    'orders': 'yizi_orders',
    'workflow_logs': 'yizi_workflow_logs',
    'workflow': 'yizi_workflow',
    'sku': 'yizi_sku',
    'user': 'yizi_users',      // user -> yizi_users
    'case': 'yizi_cases',      // case -> yizi_cases
    'model': 'yizi_model',
    'prompt': 'yizi_prompts',
    'vip_settings': 'yizi_vip_settings',
    'comments': 'yizi_comments',
    'front_sku_settings': 'yizi_front_sku_settings',
    'oss_delivery_imgs': 'yizi_oss_delivery_imgs',
    'comfyui_workflows': 'yizi_comfyui_workflows'
  };
  
  return mapping[db_name] || `yizi_${db_name}`;
}

// Helper to unpack JSONB data back to top-level for frontend backward compatibility
function unpackRow(row) {
  if (!row) return row;
  if (row.data) {
    if (typeof row.data === 'string') {
      try {
        const parsed = JSON.parse(row.data);
        Object.assign(row, parsed);
        row.data = parsed; // Retain the nested object
      } catch (e) {}
    } else if (typeof row.data === 'object') {
      Object.assign(row, row.data);
      // Retain the nested object
    }
    // We intentionally DO NOT delete row.data here anymore so frontend can use item.data.*
  }
  return row;
}

// Helper to format values for PG query (serialize objects/arrays to JSON string to prevent syntax error)
function prepareQueryValue(val) {
  if (val !== null && typeof val === 'object' && !Buffer.isBuffer(val) && !(val instanceof Date)) {
    return JSON.stringify(val);
  }
  return val;
}

// Helper to format order row to support legacy client count and format fields
function formatOrderRow(row) {
  let parsedData = {};
  try {
    parsedData = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  } catch (e) {}

  let groupCount = 0;
  let deliveryCount = 0;
  let confirmGroupCount = 0;

  if (Array.isArray(parsedData.sets)) {
    groupCount = parsedData.sets.length;
    parsedData.sets.forEach(s => {
      // If the order is waiting for admin delivery, hide the delivery_imgs from the client
      if (row.wait_delivery === '1') {
        s.delivery_imgs = [];
      } else if (Array.isArray(s.delivery_imgs) && s.delivery_imgs.length > 0) {
        deliveryCount++;
        const imgsWithContent = s.delivery_imgs.filter(d => d.img);
        if (imgsWithContent.length > 0 && imgsWithContent.every(d => d.confirmed_at)) {
          confirmGroupCount++;
        }
      }
    });
  }

  return {
    ...row,
    datetime: row.datetime ? new Date(row.datetime).getTime().toString() : null,
    data: parsedData,
    group_count: groupCount,
    delivery_count: deliveryCount.toString(),
    confirm_group_count: confirmGroupCount
  };
}

export { getActualTableName, unpackRow, prepareQueryValue, formatOrderRow };
