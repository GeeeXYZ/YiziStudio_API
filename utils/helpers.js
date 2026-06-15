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
    'prompt': 'yizi_prompt',
    'vip_settings': 'yizi_vip_settings',
    'comments': 'yizi_comments',
    'front_sku_settings': 'yizi_front_sku_settings',
    'oss_delivery_imgs': 'yizi_oss_delivery_imgs'
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
      } catch (e) {}
    } else if (typeof row.data === 'object') {
      Object.assign(row, row.data);
    }
    delete row.data;
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
      if (Array.isArray(s.delivery_imgs) && s.delivery_imgs.length > 0) {
        deliveryCount++;
        if (s.delivery_imgs.some(d => d.confirmed_at)) {
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
