import { buildGraph, topoSort, resolveInputs } from './core/dag_resolver.js';
import { executeToolkitInput, executeOrderInput } from './nodes/input_nodes.js';
import { executeTextInput, executePromptBoard, executeStringConcat, executeLlmCall, executePromptLibrary } from './nodes/llm_nodes.js';
import { executeComfyRemote } from './nodes/comfyui_nodes.js';
import { executeSeedream, executeApiyiPreset, executeGrsaiPreset, executeOpenRouterPreset } from './nodes/image_api_nodes.js';
import { executeOssOutput } from './nodes/output_nodes.js';
import { executeImagePreview, executeHttpRequest } from './nodes/misc_nodes.js';
import { uploadToOSS } from './core/oss_helper.js';

// Re-export for compatibility with other files (e.g. routes/toolkit.js)
export { uploadToOSS };

export async function runPipeline(workflowJson, orderContext, pool) {
  const pipelineLogId = `pipeline_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  try {
    const parsedData = typeof workflowJson === 'string' ? JSON.parse(workflowJson) : workflowJson;
    const { nodes, edges } = parsedData;
    
    if (!nodes || !edges) {
      throw new Error("Invalid workflow data: Missing 'nodes' or 'edges' arrays");
    }

    if (pool) {
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

    console.log(`[Pipeline] Starting CONCURRENT execution of ${totalNodes} nodes...`);
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
        switch (node.type) {
          case 'toolkit_input': outputs = await executeToolkitInput(node, inputs, orderContext, process.env, pool); break;
          case 'order_input': outputs = await executeOrderInput(node, inputs, orderContext, process.env, pool); break;
          
          case 'preset_seedream':
          case 'seedream': outputs = await executeSeedream(node, inputs, process.env, pool); break;
          
          case 'preset_apiyi': outputs = await executeApiyiPreset(node, inputs, process.env, pool, orderContext); break;
          case 'preset_grsai': outputs = await executeGrsaiPreset(node, inputs, process.env, pool, orderContext); break;
          case 'preset_openrouter': outputs = await executeOpenRouterPreset(node, inputs, process.env, pool, orderContext); break;
          
          case 'text_input': outputs = await executeTextInput(node, inputs); break;
          case 'prompt_board': outputs = await executePromptBoard(node, inputs, orderContext); break;
          case 'string_concat': outputs = await executeStringConcat(node, inputs); break;
          case 'llm_call': outputs = await executeLlmCall(node, inputs); break;
          case 'prompt_library': outputs = await executePromptLibrary(node, inputs, pool, executionState); break;
          
          case 'image_preview': outputs = await executeImagePreview(node, inputs); break;
          case 'comfy_remote': outputs = await executeComfyRemote(node, inputs, orderContext, process.env, pool); break;
          case 'oss_output': outputs = await executeOssOutput(node, inputs, orderContext, process.env); break;
          case 'http_request': outputs = await executeHttpRequest(node, inputs); break;
          
          default:
            console.log(`[Pipeline] Unrecognized node type: ${node.type}, skipping execution.`);
            outputs.output = inputs;
            break;
        }

        try {
          context[node.id] = outputs;
          completedNodes++;
          
          if (pool && completedNodes <= totalNodes) {
             const nodeNames = {
               order_input: '解析订单参数', toolkit_input: '解析工作台参数',
               preset_seedream: '大模型生图推理', preset_apiyi: '大模型生图推理',
               preset_grsai: '大模型生图推理', comfy_remote: '投递到远程工作流',
               oss_output: '后处理与云端上传', prompt_library: '抽取提示词配置',
               prompt_board: '构建提示词', text_input: '读取配置', image_preview: '获取图像'
             };
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

    // Global pipeline timeout: 10 minutes. Prevents infinite hangs.
    const PIPELINE_TIMEOUT_MS = 10 * 60 * 1000;
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Pipeline 全局超时 (${PIPELINE_TIMEOUT_MS/1000}秒)，可能有节点无响应挂起。`)), PIPELINE_TIMEOUT_MS)
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

    let finalOssImages = [];
    let rawGeneratedImages = [];
    let isOssSuccess = false;

    for (const out of Object.values(context)) {
      if (out && out.uploaded_urls && Array.isArray(out.uploaded_urls)) finalOssImages.push(...out.uploaded_urls);
      if (out && out.final_image_urls && Array.isArray(out.final_image_urls)) finalOssImages.push(...out.final_image_urls);
      if (out && out.output && Array.isArray(out.output)) rawGeneratedImages.push(...out.output.filter(u => typeof u === 'string' && (u.startsWith('http') || u.startsWith('data:image'))));
      if (out && out.output_images && Array.isArray(out.output_images)) rawGeneratedImages.push(...out.output_images.filter(u => typeof u === 'string' && (u.startsWith('http') || u.startsWith('data:image'))));
    }
    
    isOssSuccess = finalOssImages.length > 0;
    let imagesToSave = isOssSuccess ? finalOssImages : [];
    let allFailedUploads = [];
    
    if (!isOssSuccess && rawGeneratedImages.length > 0) {
       console.log(`[Pipeline] No OSS images found. Attempting fallback upload for ${rawGeneratedImages.length} raw images.`);
       try {
           const ossConfig = { region: process.env.OSS_REGION, accessKeyId: process.env.OSS_ACCESS_KEY_ID, accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, secure: true, timeout: 300000 };
           if (ossConfig.accessKeyId) {
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
                 finalOssImages = fbSucceeded;
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
         [finalStatus, totalNodes, JSON.stringify({ message: "Completed", final_images: imagesToSave }), pipelineLogId, errorMsgToSave]
       ).catch(() => {});
    }

    const isWritebackEligible = orderContext && orderContext.order_id 
      && orderContext.order_id !== 'toolkit_run'
      && orderContext.order_id !== 'unknown'
      && !orderContext.order_id.startsWith('test_order_');
    if (isWritebackEligible) {
       const orderInputNode = Object.values(context).find(c => c.random_pose_image);
       if (finalOssImages.length > 0 || allFailedUploads.length > 0 || (orderInputNode && orderInputNode.random_pose_image)) {
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
               
               if (orderInputNode && orderInputNode.random_pose_image) {
                 orderData.sets[setIndex].usedPoseUrl = orderInputNode.random_pose_image;
               }

               if (allFailedUploads.length > 0) {
                 orderData.sets[setIndex].upload_errors = allFailedUploads.map(f => ({ source: f.sourceUrl?.substring(0, 200), error: f.error, time: new Date().toISOString() }));
               }

               if (finalOssImages.length > 0) {
                  if (!orderData.sets[setIndex].delivery_imgs) orderData.sets[setIndex].delivery_imgs = [];
                  for (const imgUrl of finalOssImages) {
                    orderData.sets[setIndex].delivery_imgs.push({ id: `del_${Date.now()}_${Math.random().toString(36).substr(2,4)}`, img: imgUrl });
                  }
                  console.log(`[Pipeline] Writing ${finalOssImages.length} images to order ${orderContext.order_id} set ${setIndex}`);

                  // Only flip wait_delivery and fire SSE if auto_delivery is enabled
                  if (orderContext.auto_delivery) {
                    nextWaitDelivery = '0';
                    if (orderContext.eventEmitter) {
                      try {
                        orderContext.eventEmitter.emit(`orderUpdate:${orderContext.openid}`, { orderId: orderContext.order_id, event: 'AUTO_DELIVERY', deliveryCount: finalOssImages.length });
                      } catch (sseErr) {}
                    }
                  }
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
      return { success: true, partial: true, images: imagesToSave, failed_uploads: allFailedUploads, error: pipelineError.message };
    }

    return { success: true, images: imagesToSave, failed_uploads: allFailedUploads };

  } catch (error) {
    console.error(`[Pipeline] Fatal error during pipeline execution:`, error);
    if (pool && pipelineLogId) {
       pool.query(
         'UPDATE "yizi_api_logs" SET status = $1, error_msg = $2, updated_at = NOW() WHERE id = $3',
         ['failed', error.message, pipelineLogId]
       ).catch(() => {});
    }
    return { success: false, error: error.message };
  }
}
