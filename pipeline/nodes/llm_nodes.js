export async function executeTextInput(node, inputs) {
  return { output: node.data.text || '' };
}

export async function executePromptBoard(node, inputs, orderContext) {
  const incomingTextArr = [inputs.text_in, inputs.input].flat().filter(Boolean);
  const incomingText = incomingTextArr.join('\n');
  const basePrompt = node.data.prompt || '';
  let prompt = [incomingText, basePrompt].filter(s => typeof s === 'string' && s.trim() !== '').join('\n');
  
  if (orderContext && orderContext.workflow_override_prompt) {
    prompt = [prompt, orderContext.workflow_override_prompt].filter(s => typeof s === 'string' && s.trim() !== '').join(', ');
  }
  return { prompt: prompt, output: prompt };
}

export async function executeStringConcat(node, inputs) {
  const s1 = inputs.str1 || '';
  const s2 = inputs.str2 || '';
  const s3 = inputs.str3 || '';
  const s4 = inputs.str4 || '';
  const s5 = inputs.str5 || '';
  const s6 = inputs.str6 || '';
  return { output: [s1, s2, s3, s4, s5, s6].filter(s => typeof s === 'string' && s.trim() !== '').join('\n') };
}

export async function executeLlmCall(node, inputs, env, pool, abortSignal) {
  const { getSetting } = await import('../../config_manager.js');
  
  const useGlobal = node.data.use_global_config === true;
  
  const llmUrl = (!useGlobal && node.data.api_url) || (env?.LLM_API_URL) || await getSetting(pool, 'LLM_API_URL') || 'https://api.openai.com/v1';
  const llmKey = (!useGlobal && node.data.api_key) || (env?.LLM_API_KEY) || await getSetting(pool, 'LLM_API_KEY') || '';
  const llmModel = (!useGlobal && node.data.model_name) || (env?.LLM_API_MODEL) || await getSetting(pool, 'LLM_API_MODEL') || 'gpt-4o-mini';
  const systemPrompt = inputs.system_prompt || node.data.system_prompt || '';
  const llmPrompt = inputs.prompt || inputs.input || '';
  
  // Determine API format: 'openai' (default) or 'doubao'
  // Auto-detect from URL if not explicitly set
  let apiFormat = node.data.api_format || 'auto';
  if (apiFormat === 'auto') {
    apiFormat = (llmUrl.includes('volces.com') || llmUrl.includes('volcengine')) ? 'doubao' : 'openai';
  }
  
  if (!llmKey) throw new Error(`LLM Node missing API Key. Set it in node data, env LLM_API_KEY, or global settings.`);

  // Collect ordered image inputs: image_1, image_2, image_3, ... (preserves order)
  let images = [];
  for (let i = 1; i <= 20; i++) {
    const val = inputs[`image_${i}`];
    if (val !== undefined) {
      if (Array.isArray(val)) images = images.concat(val.flat().filter(Boolean));
      else if (val) images.push(val);
    }
  }
  // Fallback: legacy single 'images' input for backward compatibility
  if (images.length === 0) {
    let legacy = inputs.images || inputs.image || [];
    if (typeof legacy === 'string') legacy = legacy.split(',').map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(legacy)) legacy = [legacy];
    images = legacy.flat().filter(Boolean);
  }

  if (apiFormat === 'doubao') {
    // ========== 豆包 / 火山引擎 Responses API ==========
    const inputContent = [];
    
    // Add image parts first (doubao format)
    for (const url of images) {
      if (!url) continue;
      inputContent.push({ type: 'input_image', image_url: url });
    }
    
    // Add text part
    if (llmPrompt) {
      inputContent.push({ type: 'input_text', text: llmPrompt });
    }

    const inputMessages = [];
    if (systemPrompt) {
      inputMessages.push({ role: 'system', content: [{ type: 'input_text', text: systemPrompt }] });
    }
    inputMessages.push({
      role: 'user',
      content: images.length > 0 ? inputContent : llmPrompt
    });

    // Build endpoint: if URL already ends with /responses, use as-is; otherwise append
    let endpoint = llmUrl;
    if (!endpoint.endsWith('/responses')) {
      endpoint = endpoint.replace(/\/+$/, '') + '/responses';
    }

    console.log(`[Pipeline] LLM Doubao Call to ${endpoint}, model: ${llmModel}, images: ${images.length}`);

    const chatRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llmKey}` },
      body: JSON.stringify({ model: llmModel, input: inputMessages }),
      signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
    });

    if (!chatRes.ok) throw new Error(`LLM Call failed: [${chatRes.status}] ${await chatRes.text()}`);

    const chatData = await chatRes.json();
    
    // Parse doubao response: output[].content[].text
    let resultText = '';
    if (chatData.output && Array.isArray(chatData.output)) {
      for (const item of chatData.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) {
              resultText += part.text;
            }
          }
        }
      }
    }
    // Fallback: try OpenAI-style response in case doubao returns compatible format
    if (!resultText && chatData.choices) {
      resultText = chatData.choices?.[0]?.message?.content || '';
    }
    return { output: resultText };

  } else {
    // ========== OpenAI Chat Completions API ==========
    let userContent;
    if (images.length > 0) {
      const contentParts = [];
      if (llmPrompt) {
        contentParts.push({ type: 'text', text: llmPrompt });
      }
      for (const url of images) {
        if (!url) continue;
        if (url.startsWith('data:image')) {
          contentParts.push({ type: 'image_url', image_url: { url } });
        } else {
          try {
            const resp = await fetch(url, { signal: AbortSignal.any([abortSignal, AbortSignal.timeout(30000)].filter(Boolean)) });
            if (!resp.ok) { console.warn(`[LLM Vision] Failed to fetch image: ${url.substring(0, 80)}`); continue; }
            const arrayBuffer = await resp.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const base64 = buffer.toString('base64');
            const mime = buffer[0] === 0x89 ? 'image/png' : buffer[0] === 0xFF ? 'image/jpeg' : buffer[0] === 0x52 ? 'image/webp' : 'image/jpeg';
            contentParts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
          } catch (imgErr) {
            console.warn(`[LLM Vision] Failed to process image ${url.substring(0, 80)}:`, imgErr.message);
          }
        }
      }
      userContent = contentParts;
      console.log(`[Pipeline] LLM Vision Call to ${llmUrl}/chat/completions, model: ${llmModel}, images: ${images.length}`);
    } else {
      userContent = llmPrompt;
      console.log(`[Pipeline] LLM Call to ${llmUrl}/chat/completions, model: ${llmModel}`);
    }

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userContent });

    const chatRes = await fetch(`${llmUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llmKey}` },
      body: JSON.stringify({ model: llmModel, messages }),
      signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
    });

    if (!chatRes.ok) throw new Error(`LLM Call failed: [${chatRes.status}] ${await chatRes.text()}`);

    const chatData = await chatRes.json();
    return { output: chatData.choices?.[0]?.message?.content || '' };
  }
}

export async function executePromptLibrary(node, inputs, pool, executionState) {
  const mode = node.data.mode || (inputs.prompt_id ? 'direct' : 'random');
  let selectedPromptContent = '';
  let selectedPreviewImg = '';

  if (mode === 'direct') {
    const promptId = inputs.prompt_id || node.data.prompt_id;
    if (!promptId) throw new Error('prompt_library node missing prompt_id for direct mode');
    if (!pool) throw new Error('Database pool not available for prompt_library node execution');
    
    const res = await pool.query('SELECT content, data FROM "yizi_prompts" WHERE id = $1', [promptId]);
    if (res.rows.length > 0) {
      selectedPromptContent = res.rows[0].content;
      selectedPreviewImg = res.rows[0].data?.preview_img || '';
    } else {
      throw new Error(`Prompt with ID ${promptId} not found in database.`);
    }
  } else if (mode === 'random') {
    // Fallback to group_id for backward compatibility with old workflows
    const setId = inputs.set_id || node.data.set_id || inputs.group_id || node.data.group_id;
    if (!setId) throw new Error('prompt_library node missing set_id for random mode');
    if (!pool) throw new Error('Database pool not available for prompt_library node execution');

    const unlock = await executionState.promptLibraryMutex.lock();
    try {
      let query = 'SELECT id, content, data FROM "yizi_prompts" WHERE set_id = $1';
      let params = [setId];
      
      if (executionState.usedPromptIds.length > 0) {
        const placeholders = executionState.usedPromptIds.map((_, i) => `$${i + 2}`).join(',');
        query += ` AND id NOT IN (${placeholders})`;
        params = params.concat(executionState.usedPromptIds);
      }
      
      query += ' ORDER BY RANDOM() LIMIT 1';
      const res = await pool.query(query, params);
      
      if (res.rows.length > 0) {
        selectedPromptContent = res.rows[0].content;
        selectedPreviewImg = res.rows[0].data?.preview_img || '';
        executionState.usedPromptIds.push(res.rows[0].id);
      } else {
        console.warn(`[Pipeline] All unused prompts in set ${setId} exhausted. Allowing repeats as fallback.`);
        const fallbackRes = await pool.query('SELECT id, content, data FROM "yizi_prompts" WHERE set_id = $1 ORDER BY RANDOM() LIMIT 1', [setId]);
        if (fallbackRes.rows.length > 0) {
          selectedPromptContent = fallbackRes.rows[0].content;
          selectedPreviewImg = fallbackRes.rows[0].data?.preview_img || '';
          executionState.usedPromptIds.push(fallbackRes.rows[0].id);
        } else {
          throw new Error(`No prompts found in set ${setId}.`);
        }
      }
    } finally {
      const resolveFn = await unlock();
      resolveFn();
    }
  } else {
    throw new Error(`Unknown mode ${mode} for prompt_library node`);
  }

  return { 
    prompt: selectedPromptContent, 
    output: selectedPromptContent, 
    preview_img: selectedPreviewImg 
  };
}

export async function executeLlmPromptFission(node, inputs, env, pool, abortSignal) {
  const { getSetting } = await import('../../config_manager.js');
  
  const llmUrl = env?.LLM_API_URL || await getSetting(pool, 'LLM_API_URL') || 'https://api.openai.com/v1';
  const llmKey = env?.LLM_API_KEY || await getSetting(pool, 'LLM_API_KEY') || '';
  const llmModel = env?.LLM_API_MODEL || await getSetting(pool, 'LLM_API_MODEL') || 'gpt-4o-mini';
  
  if (!llmKey) throw new Error('LLM Node missing API Key.');

  const fissionCount = parseInt(node.data.fission_count) || 4;
  const constraints = node.data.constraints || '';
  const basePrompt = inputs.prompt || inputs.input || '';

  if (!basePrompt) {
    throw new Error('LLM Skill Node requires a base prompt (prompt) to perform fission.');
  }

  // User-provided system prompt from upstream node, merged with fission instructions
  const userSystemPrompt = inputs.system_prompt || '';
  const diversityPrompt = node.data.diversity_prompt || 'Each variation must be radically different in concept, angle, style, or composition. DO NOT just change a few words. Maximize the creative variance between each option!';
  
  const fissionInstruction = `\nYou MUST generate exactly ${fissionCount} HIGHLY DISTINCT variations.
CRITICAL RULE: ${diversityPrompt}
You MUST output your response strictly as a JSON array of ${fissionCount} strings. Do not use markdown wrappers like \`\`\`json.
Example output format:
["highly unique variation 1 text", "completely different variation 2 text", "another distinct variation 3 text"]`;

  const systemPrompt = userSystemPrompt
    ? `${userSystemPrompt}\n\n--- Fission Output Rules ---${fissionInstruction}`
    : `You are an expert prompt engineer.\nYour task is to take a base prompt and generate exactly ${fissionCount} distinct variations based on the user's base prompt and any constraints provided.${fissionInstruction}`;

  const userContent = `Base Prompt:\n${basePrompt}\n\nConstraints:\n${constraints || 'Ensure maximum diversity, radically different concepts, and highly detailed descriptions.'}`;

  let apiFormat = (llmUrl.includes('volces.com') || llmUrl.includes('volcengine')) ? 'doubao' : 'openai';

  let chatRes;
  if (apiFormat === 'doubao') {
    let doubaoEndpoint = llmUrl;
    if (!doubaoEndpoint.endsWith('/responses')) {
      doubaoEndpoint = doubaoEndpoint.replace(/\/+$/, '') + '/responses';
    }
    chatRes = await fetch(doubaoEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llmKey}` },
      body: JSON.stringify({
        model: llmModel,
        input: [
          { role: 'system', content: [{type: 'input_text', text: systemPrompt}] },
          { role: 'user', content: [{type: 'input_text', text: userContent}] }
        ]
      }),
      signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
    });
  } else {
    let endpoint = llmUrl;
    if (!endpoint.endsWith('/chat/completions')) {
      endpoint = endpoint.replace(/\/+$/, '') + '/chat/completions';
    }
    chatRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llmKey}` },
      body: JSON.stringify({
        model: llmModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ]
      }),
      signal: abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
    });
  }

  if (!chatRes.ok) {
    const errText = await chatRes.text();
    throw new Error(`LLM API Error ${chatRes.status}: ${errText}`);
  }

  const data = await chatRes.json();
  
  if (data.error) {
    throw new Error(`LLM API returned error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  let textOutput = '';
  if (apiFormat === 'doubao') {
    if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) {
              textOutput += part.text;
            }
          }
        }
      }
    }
    if (!textOutput && data.choices) {
      textOutput = data.choices?.[0]?.message?.content || '';
    }
  } else {
    textOutput = data.choices?.[0]?.message?.content || '';
  }

  if (!textOutput) {
    console.error(`[LLM Fission] Empty output from LLM. Raw response:`, JSON.stringify(data, null, 2));
    const finishReason = data.choices?.[0]?.finish_reason;
    if (finishReason === 'content_filter') {
      throw new Error('LLM blocked the generation due to safety/content filters.');
    }
    throw new Error(`LLM returned empty output. Raw response: ${JSON.stringify(data).substring(0, 200)}`);
  }

  textOutput = textOutput.replace(/^```json/i, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(textOutput);
    if (!Array.isArray(parsed)) {
      if (parsed.variations && Array.isArray(parsed.variations)) parsed = parsed.variations;
      else parsed = [textOutput];
    }
  } catch (e) {
    console.error('Failed to parse LLM JSON:', textOutput);
    parsed = textOutput.split('\n').map(s => s.trim().replace(/^[-*0-9.]+\s*/, '')).filter(Boolean);
  }

  const results = {};
  for (let i = 0; i < fissionCount; i++) {
    results[`output_${i + 1}`] = parsed[i] || parsed[0] || basePrompt;
  }
  
  return results;
}
