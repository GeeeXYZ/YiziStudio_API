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
  return { output: [s1, s2, s3, s4].filter(s => typeof s === 'string' && s.trim() !== '').join('\n') };
}

export async function executeLlmCall(node, inputs) {
  const llmUrl = node.data.api_url || 'https://api.openai.com/v1';
  const llmKey = node.data.api_key || '';
  const llmModel = node.data.model_name || 'gpt-3.5-turbo';
  const llmPrompt = inputs.prompt || '';
  
  if (!llmKey) throw new Error(`LLM Node missing API Key`);

  console.log(`[Pipeline] LLM Call to ${llmUrl}/chat/completions`);
  const chatRes = await fetch(`${llmUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llmKey}` },
    body: JSON.stringify({ model: llmModel, messages: [{ role: 'user', content: llmPrompt }] }),
    signal: AbortSignal.timeout(120000)
  });

  if (!chatRes.ok) throw new Error(`LLM Call failed: [${chatRes.status}] ${await chatRes.text()}`);

  const chatData = await chatRes.json();
  return { output: chatData.choices?.[0]?.message?.content || '' };
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
        params.push(...executionState.usedPromptIds);
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
