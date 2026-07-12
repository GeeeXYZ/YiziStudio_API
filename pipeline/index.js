import crypto from 'crypto';
import { orderEventEmitter } from '../events.js';
import { buildGraph, topoSort, resolveInputs } from './core/dag_resolver.js';
import { executeToolkitInput, executeOrderInput, executeFloatInput } from './nodes/input_nodes.js';
import { executeTextInput, executePromptBoard, executeStringConcat, executeLlmCall, executePromptLibrary } from './nodes/llm_nodes.js';
import { executeComfyRemote } from './nodes/comfyui_nodes.js';
import { executeSeedream, executeApiyiPreset, executeGrsaiPreset, executeOpenRouterPreset, executeGrokImagine } from './nodes/image_api_nodes.js';
import { executeOssOutput } from './nodes/output_nodes.js';
import { executeImagePreview, executeTextPreview, executeHttpRequest } from './nodes/misc_nodes.js';
import { executeColorGrading } from './nodes/color_grading_node.js';
import { uploadToOSS } from './core/oss_helper.js';

// Re-export for compatibility with other files (e.g. routes/toolkit.js)
export { uploadToOSS };

// ============================================================
// PIPELINE PER-ORDER DEDUPLICATION
// ============================================================
export async function runPipeline(workflowJson, orderContext, pool, options = {}) {
  const orderId = orderContext?.order_id || 'unknown';
  const setIndex = orderContext?.set_index ?? 0;
  
  if (options.simulate) {
    // If simulate mode, we must run it immediately and wait for results
    return _runPipelineInternal(workflowJson, orderContext, pool, options);
  }

  const taskId = crypto.randomUUID();
  console.log(`[Pipeline] ▶ Starting asynchronous pipeline execution ${taskId} for ${orderId}_${setIndex} in-memory...`);
  
  // Fire and forget - execute asynchronously without waiting
  _runPipelineInternal(workflowJson, orderContext, pool, options)
    .then(result => {
       console.log(`[Pipeline] 🏁 In-memory execution ${taskId} finished:`, result && result.success ? 'Success' : 'Failed');
    })
    .catch(err => {
       console.error(`[Pipeline] ❌ In-memory execution ${taskId} failed:`, err.message);
    });

  return { success: true, queued: false, taskId, message: 'Pipeline started asynchronously' };
}

// Export queue status for monitoring (deprecated/stubbed for backwards compatibility)
export function getPipelineQueueStatus() {
  return { inflight: [] };
}

export async function runSingleNode(node, inputs, env, pool, orderContext, executionState = null) {
  switch (node.type) {
    case 'toolkit_input': return await executeToolkitInput(node, inputs, orderContext, env, pool);
    case 'order_input': return await executeOrderInput(node, inputs, orderContext, env, pool);
    
    case 'preset_seedream':
    case 'seedream': return await executeSeedream(node, inputs, env, pool);
    
    case 'preset_apiyi': return await executeApiyiPreset(node, inputs, env, pool, orderContext);
    case 'preset_grsai': return await executeGrsaiPreset(node, inputs, env, pool, orderContext);
    case 'preset_openrouter': return await executeOpenRouterPreset(node, inputs, env, pool, orderContext);
    case 'grok_imagine': return await executeGrokImagine(node, inputs, env, pool);
    
    case 'text_input': return await executeTextInput(node, inputs);
    case 'float_input': return await executeFloatInput(node, inputs);
    case 'prompt_board': return await executePromptBoard(node, inputs, orderContext);
    case 'string_concat': return await executeStringConcat(node, inputs);
    case 'llm_call': return await executeLlmCall(node, inputs, env, pool);
    case 'prompt_library': return await executePromptLibrary(node, inputs, pool, executionState);
    
    case 'image_preview': return await executeImagePreview(node, inputs);
    case 'text_preview': return await executeTextPreview(node, inputs);
    case 'comfy_remote': return await executeComfyRemote(node, inputs, orderContext, env, pool);
    case 'oss_output': return await executeOssOutput(node, inputs, orderContext, env);
    case 'http_request': return await executeHttpRequest(node, inputs);
    case 'color_grading': return await executeColorGrading(node, inputs);
    
    default:
      console.log(`[Pipeline] Unrecognized node type: ${node.type}, skipping execution.`);
      return { output: inputs };
  }
}

export async function _runPipelineInternal(workflowJson, orderContext, pool, options = {}) {
  const { simulate = false } = options;
  const pipelineLogId = `pipeline_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const traceLogs = [];

  try {
    const parsedData = typeof workflowJson === 'string' ? JSON.parse(workflowJson) : workflowJson;
    const { nodes, edges } = parsedData;
    
    if (!nodes || !edges) {
      throw new Error("Invalid workflow data: Missing 'nodes' or 'edges' arrays");
    }

    if (pool && !simulate) {
      await pool.query(
        `INSERT INTO yizi_api_logs (id, order_id, model, status, progress, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, 0, NOW(), NOW())`,
        [pipelineLogId, orderContext?.order_id || 'toolkit_run', 'API Workflow', `0/${nodes.length} 任务初始化`]
      ).catch(e => console.warn('[Pipeline Log] Insert Error:', e.message));
    }

    const graph = buildGraph(nodes, edges);
    const sortedNodeIds = topoSort(graph);

    const context = {};
    const totalNodes = sortedNodeIds.length;
    let completedNodes = 0;

    // Execution State to pass to nodes that require shared state (like prompt_library)
    const executionState = {
      usedPromptIds: [],
      promptLibraryMutex: {
        promise: Promise.resolve(),
        lock: function() {
          let resolve;
          const current = this.promise;
          this.promise = new Promise(r => resolve = r);
          return async () => {
            await current;
            return resolve;
          };
        }
      }
    };

    console.log(`[Pipeline] Starting CONCURRENT execution of ${totalNodes} nodes... (Simulate: ${simulate})`);
    const nodePromises = {};

    for (const nodeId of sortedNodeIds) {
      const node = graph.nodes[nodeId];
      const incomingEdges = graph.inEdges[nodeId] || [];
      const depNodeIds = [...new Set(incomingEdges.map(e => e.source))];

      nodePromises[nodeId] = (async () => {
        if (depNodeIds.length > 0) {
          const depPromises = depNodeIds.map(dep => nodePromises[dep]).filter(Boolean);
          await Promise.all(depPromises);
        }

        console.log(`[Pipeline] Executing node: ${node.type} (${node.id})`);
        const inputs = resolveInputs(incomingEdges, context);
        let outputs = {};
        
        const nodeNames = {
          order_input: '解析订单参数', toolkit_input: '解析工作台参数',
          preset_seedream: '大模型生图推理', preset_apiyi: '大模型生图推理',
          preset_grsai: '大模型生图推理', comfy_remote: '投递到远程工作流',
          oss_output: '后处理与云端上传', prompt_library: '抽取提示词配置',
          prompt_board: '构建提示词', text_input: '读取配置', image_preview: '获取图像', text_preview: '获取文本',
          string_concat: '文本拼接', llm_call: '大模型调用', http_request: 'HTTP 请求',
          seedream: '即梦生图', preset_openrouter: '大模型绘图', grok_imagine: 'Grok Imagine 推理'
        };

        const traceLog = {
          nodeId: node.id,
          nodeType: node.type,
          friendlyName: nodeNames[node.type] || node.type,
          step: completedNodes + 1,
          inputs: inputs,
          outputs: null,
          status: 'running',
          startTime: Date.now(),
          duration: 0
        };

        // In test/simulate mode, we now execute all nodes normally so users can see real results
        try {
          outputs = await runSingleNode(node, inputs, process.env, pool, orderContext, executionState);
        } catch (nodeExecErr) {
          traceLog.status = 'error';
          traceLog.error = nodeExecErr.message;
          traceLog.outputs = { _error: nodeExecErr.message };
          traceLog.duration = Date.now() - traceLog.startTime;
          traceLogs.push(traceLog);
          throw nodeExecErr;
        }

        try {
          context[node.id] = outputs;
          completedNodes++;
          traceLog.step = completedNodes;
          traceLog.status = 'success';
          traceLog.outputs = outputs;
          traceLog.duration = Date.now() - traceLog.startTime;
          traceLogs.push(traceLog);
          
          if (pool && !simulate && completedNodes <= totalNodes) {
             const friendlyName = nodeNames[node.type] || '执行节点处理';
             pool.query(`UPDATE yizi_api_logs SET status = $1, progress = $2, updated_at = NOW() WHERE id = $3`, [`${completedNodes}/${totalNodes} ${friendlyName}`, completedNodes, pipelineLogId]).catch(() => {});
          }
          console.log(`[Pipeline] Node ${node.id} finished. Outputs:`, Object.keys(outputs));
        } catch (postExecErr) {
          throw postExecErr;
        }
      })().catch(err => {
        const errorMsg = `[节点 ${node.type}] ${err.message}`;
        const newErr = new Error(errorMsg);
        newErr.stack = err.stack;
        return Promise.reject(newErr);
      });
    }

    // Global pipeline timeout: 15 minutes. Prevents infinite hangs.
    const PIPELINE_TIMEOUT_MS = 15 * 60 * 1000;
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Pipeline 全局超时 (${PIPELINE_TIMEOUT_MS/1000}秒)未有节点响应`)), PIPELINE_TIMEOUT_MS)
    );
    
    let allResults;
    try {
      allResults = await Promise.race([
        Promise.allSettled(Object.values(nodePromises)),
        timeoutPromise.then(() => { throw new Error('timeout'); })
      ]);
    } catch (timeoutErr) {
      // Global timeout hit — treat all incomplete nodes as failed
      console.error(`[Pipeline] GLOBAL TIMEOUT after ${PIPELINE_TIMEOUT_MS/1000}s`);
      allResults = Object.values(nodePromises).map(() => ({ status: 'rejected', reason: timeoutErr }));
    }
    
    const failures = allResults.filter(r => r.status === 'rejected');
    let pipelineError = null;
    if (failures.length > 0) {
      console.error(`[Pipeline] ${failures.length} node(s) failed during concurrent execution.`);
      for (const f of failures) console.error(`  - ${f.reason?.message || f.reason}`);
      // Don't throw immediately — let post-processing collect any successful results first
      pipelineError = failures[0].reason;
    }

    if (simulate) {
      return { simulate: true, traceLogs, pipelineError: pipelineError ? pipelineError.message : null };
    }

    let finalOssImages = [];
    let autoDeliveredImages = [];
    let rawGeneratedImages = [];
    let isOssSuccess = false;

    for (const out of Object.values(context)) {
      if (out && out.uploaded_urls && Array.isArray(out.uploaded_urls)) {
        finalOssImages.push(...out.uploaded_urls);
        let shouldDeliver = out.auto_delivery === true;
        if (orderContext.auto_delivery === true) shouldDeliver = true;
        if (shouldDeliver) autoDeliveredImages.push(...out.uploaded_urls);
      }
      if (out && out.final_image_urls && Array.isArray(out.final_image_urls)) {
        finalOssImages.push(...out.final_image_urls);
        let shouldDeliver = out.auto_delivery === true;
        if (orderContext.auto_delivery === true) shouldDeliver = true;
        if (shouldDeliver) autoDeliveredImages.push(...out.final_image_urls);
      }
      if (out && out.output && Array.isArray(out.output)) rawGeneratedImages.push(...out.output.flat(Infinity).filter(u => typeof u === 'string' && (u.startsWith('http') || u.startsWith('data:image'))));
      if (out && out.output_images && Array.isArray(out.output_images)) rawGeneratedImages.push(...out.output_images.flat(Infinity).filter(u => typeof u === 'string' && (u.startsWith('http') || u.startsWith('data:image'))));
    }
    
    isOssSuccess = finalOssImages.length > 0;
    let imagesToSave = isOssSuccess ? finalOssImages : [];
    let allFailedUploads = [];
    
    if (!isOssSuccess && rawGeneratedImages.length > 0) {
       console.log(`[Pipeline] No OSS images found. Attempting fallback upload for ${rawGeneratedImages.length} raw images.`);
       try {
           const ossConfig = { region: process.env.OSS_REGION, accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, secure: true, timeout: 300000 };
           if (ossConfig.accessKeyId) {
               const OSS = (await import('ali-oss')).default;
               const ossClient = new OSS(ossConfig);
               const fbPromises = rawGeneratedImages.map(async (imgUrl, i) => {
                  try {
                    const url = await uploadToOSS(ossClient, imgUrl, orderContext.openid || 'unknown', orderContext.order_id || 'fallback', orderContext.set_index || 0, `fb_${Date.now()}_${i}`);
                    return { success: true, url: url.replace('http://', 'https://') };
                  } catch (e) {
                    return { success: false, index: i, sourceUrl: imgUrl, error: e.message };
                  }
               });
               const fbResults = await Promise.all(fbPromises);
               const fbSucceeded = fbResults.filter(r => r.success).map(r => r.url);
               allFailedUploads = fbResults.filter(r => !r.success);
               
               if (fbSucceeded.length > 0) {
                 imagesToSave = fbSucceeded;
                 finalOssImages.push(...fbSucceeded);
                 if (orderContext.auto_delivery === true) {
                     autoDeliveredImages.push(...fbSucceeded);
                 }
                 isOssSuccess = true;
               }
           }
       } catch (e) {
           console.error('[Pipeline] Fallback OSS Upload failed totally:', e);
       }
    }

    let finalStatus;
    if (isOssSuccess && !pipelineError) {
      finalStatus = `${totalNodes}/${totalNodes} 交付成功`;
    } else if (isOssSuccess && pipelineError) {
      finalStatus = `${totalNodes}/${totalNodes} 部分完成(已交付)`;
    } else {
      finalStatus = `${totalNodes}/${totalNodes} 异常中断`;
    }
    const errorMsgToSave = pipelineError ? pipelineError.message : null;
    if (pool) {
       await pool.query(
         'UPDATE "yizi_api_logs" SET status = $1, progress = $2, result_images = $3, error_msg = COALESCE($5, error_msg), updated_at = NOW() WHERE id = $4',
         [finalStatus, totalNodes, JSON.stringify({ message: "Completed", final_images: imagesToSave, auto_delivery: !!orderContext?.auto_delivery }), pipelineLogId, errorMsgToSave]
       ).catch(() => {});
    }

    const isWritebackEligible = orderContext && orderContext.order_id 
      && orderContext.order_id !== 'toolkit_run'
      && orderContext.order_id !== 'unknown'
      && !orderContext.order_id.startsWith('test_order_');
    if (isWritebackEligible) {
       // Find the resolved pose URL from pipeline context (set by order_input node)
       let resolvedPoseUrl = '';
       for (const nodeOutputs of Object.values(context)) {
         if (nodeOutputs && typeof nodeOutputs.random_pose_image === 'string' && nodeOutputs.random_pose_image) {
           resolvedPoseUrl = nodeOutputs.random_pose_image;
           break;
         }
       }
       if (finalOssImages.length > 0 || allFailedUploads.length > 0 || resolvedPoseUrl) {
         try {
           const pgClient = await pool.connect();
           try {
             await pgClient.query('BEGIN');
             const selectRes = await pgClient.query('SELECT data, wait_delivery FROM "yizi_orders" WHERE id = $1 FOR UPDATE', [orderContext.order_id]);
             
             if (selectRes.rows.length > 0) {
               const orderData = selectRes.rows[0].data || {};
               const currentWaitDelivery = selectRes.rows[0].wait_delivery;
               let nextWaitDelivery = currentWaitDelivery;

               if (!orderData.sets) orderData.sets = [{}];
               const setIndex = orderContext.set_index || 0;
               if (!orderData.sets[setIndex]) orderData.sets[setIndex] = {};
               
               if (resolvedPoseUrl) {
                 orderData.sets[setIndex].usedPoseUrl = resolvedPoseUrl;
               }

               if (allFailedUploads.length > 0) {
                 orderData.sets[setIndex].upload_errors = allFailedUploads.map(f => ({ source: f.sourceUrl?.substring(0, 200), error: f.error, time: new Date().toISOString() }));
               }

               if (finalOssImages.length > 0) {
                   console.log(`[Pipeline] Final OSS Images: ${finalOssImages.length}, Auto Delivered: ${autoDeliveredImages.length}`);
               }

               if (autoDeliveredImages.length > 0) {
                     console.log(`[Pipeline] AUTO_DELIVERY ON: Writing ${autoDeliveredImages.length} images to delivery pool for order ${orderContext.order_id} set ${setIndex}`);
                     if (!orderData.sets[setIndex].delivery_imgs) orderData.sets[setIndex].delivery_imgs = [];
                     for (const imgUrl of autoDeliveredImages) {
                       orderData.sets[setIndex].delivery_imgs.push({ id: `del_${Date.now()}_${Math.random().toString(36).substr(2,4)}`, img: imgUrl });
                     }
                     orderData.sets[setIndex].is_auto_delivered = true;
                     
                     // BUG FIX: Only set wait_delivery='0' when ALL sets have delivery images,
                     // not just the current one. This prevents premature delivery notification
                     // when multiple sets are being processed concurrently.
                     const totalSets = orderData.sets.length;
                     const deliveredSets = orderData.sets.filter(s => s && Array.isArray(s.delivery_imgs) && s.delivery_imgs.length > 0).length;
                     if (deliveredSets >= totalSets) {
                       nextWaitDelivery = '0';
                       console.log(`[Pipeline] All ${totalSets} sets delivered. Setting wait_delivery='0' for order ${orderContext.order_id}`);
                     } else {
                       console.log(`[Pipeline] Set ${setIndex} delivered (${deliveredSets}/${totalSets} sets complete). Keeping wait_delivery='1' until all sets finish.`);
                     }

                     if (orderEventEmitter) {
                       try {
                         orderEventEmitter.emit(`orderUpdate:${orderContext.openid}`, { orderId: orderContext.order_id, event: 'AUTO_DELIVERY', deliveryCount: autoDeliveredImages.length, setIndex, deliveredSets, totalSets });
                       } catch (sseErr) {}
                     }
                 } else if (finalOssImages.length > 0) {
                     console.log(`[Pipeline] Auto-delivery OFF: ${finalOssImages.length} images uploaded to OSS Gallery but NOT pushed to delivery pool for order ${orderContext.order_id}`);
                 }

                await pgClient.query('UPDATE "yizi_orders" SET data = $1, wait_delivery = $2 WHERE id = $3', [JSON.stringify(orderData), nextWaitDelivery, orderContext.order_id]);
             }
             await pgClient.query('COMMIT');
           } catch (txErr) {
             await pgClient.query('ROLLBACK');
             throw txErr;
           } finally {
             pgClient.release();
           }
         } catch (dbErr) {
           console.error('[Pipeline] Failed to update order in database:', dbErr);
         }
       }
    }

    // If some nodes failed but we still managed to collect/upload images, return partial success
    if (pipelineError && !isOssSuccess) {
      // Nothing was salvageable, treat as full failure
      console.error(`[Pipeline] All nodes failed and no images were collected. Throwing.`);
      throw pipelineError;
    }

    if (pipelineError) {
      console.warn(`[Pipeline] Partial failure: ${failures.length} node(s) failed, but ${imagesToSave.length} images were saved successfully.`);
      return { success: true, partial: true, images: imagesToSave, failed_uploads: allFailedUploads, error: pipelineError.message, traceLogs };
    }

    return { success: true, images: imagesToSave, failed_uploads: allFailedUploads, traceLogs };

  } catch (error) {
    console.error(`[Pipeline] Fatal error during pipeline execution:`, error);
    if (pool && pipelineLogId) {
       pool.query(
         'UPDATE "yizi_api_logs" SET status = $1, error_msg = $2, updated_at = NOW() WHERE id = $3',
         ['failed', error.message, pipelineLogId]
       ).catch(() => {});
    }
    return { success: false, error: error.message, traceLogs };
  }
}
