export async function executeImagePreview(node, inputs) {
  return { output: inputs.image_url || inputs.output || node.data.preview_url || '' };
}

export async function executeTextPreview(node, inputs) {
  return { output: inputs.text || inputs.output || node.data.preview_text || '' };
}

export async function executeHttpRequest(node, inputs) {
  const method = node.data.method || 'GET';
  const reqUrl = inputs.url || node.data.url;
  if (!reqUrl) throw new Error('HTTP Request Node missing URL');
  
  const options = { method };
  if (method !== 'GET' && inputs.body) {
     options.body = typeof inputs.body === 'string' ? inputs.body : JSON.stringify(inputs.body);
     options.headers = { 'Content-Type': 'application/json' };
  }

  console.log(`[Pipeline] HTTP ${method} to ${reqUrl}`);
  options.signal = AbortSignal.timeout(60000); // Prevent pipeline queue hanging
  const httpRes = await fetch(reqUrl, options);
  const httpData = await httpRes.json();
  return { response: httpData };
}
