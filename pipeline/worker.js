import { _runPipelineInternal } from './index.js';

let activeWorkers = 0;
let isProcessing = false;
let listenClient = null;

async function getConcurrencyLimit(pool) {
    try {
        const res = await pool.query(`SELECT value FROM yizi_settings WHERE key = 'PIPELINE_CONCURRENCY'`);
        if (res.rows.length > 0) {
            const limit = parseInt(res.rows[0].value, 10);
            if (!isNaN(limit) && limit > 0) return limit;
        }
    } catch (e) {
        console.warn('[Queue Worker] Failed to fetch concurrency limit, using default: 2');
    }
    return 2; // Default to 2
}

// In-flight task IDs — prevents the same task from being picked up twice
// due to race conditions between NOTIFY, 60s poller, and post-completion re-trigger.
const inflightTaskIds = new Set();

async function processQueue(pool) {
    // Mutex: only one invocation of the scheduling loop at a time.
    // This flag guards the while-loop itself, NOT the long-running pipeline execution.
    if (isProcessing) return;
    isProcessing = true;

    try {
        const concurrencyLimit = await getConcurrencyLimit(pool);

        // Keep trying to fill available worker slots
        while (activeWorkers < concurrencyLimit) {
            const pgClient = await pool.connect();
            let task = null;
            try {
                await pgClient.query('BEGIN');
                // Atomically lock and claim the next pending task
                const res = await pgClient.query(`
                    UPDATE yizi_pipeline_queue 
                    SET status = 'processing', updated_at = NOW() 
                    WHERE id = (
                        SELECT id FROM yizi_pipeline_queue 
                        WHERE status = 'pending' 
                        ORDER BY created_at ASC 
                        FOR UPDATE SKIP LOCKED 
                        LIMIT 1
                    ) RETURNING *;
                `);
                if (res.rows.length > 0) {
                    task = res.rows[0];
                }
                await pgClient.query('COMMIT');
            } catch (err) {
                await pgClient.query('ROLLBACK');
                console.error('[Queue Worker] DB Lock Error:', err.message);
                break;
            } finally {
                pgClient.release();
            }

            if (!task) {
                break; // Queue empty — exit the while loop
            }

            // Double-check: avoid running a task we already have in-flight (safety net)
            if (inflightTaskIds.has(task.id)) {
                console.warn(`[Queue Worker] Task ${task.id} already in-flight, skipping.`);
                break;
            }

            // Reserve this slot BEFORE releasing isProcessing
            activeWorkers++;
            inflightTaskIds.add(task.id);
            console.log(`[Queue Worker] 🚀 Started Task ${task.id}. Active Workers: ${activeWorkers}/${concurrencyLimit}`);

            // Execute in background — this IIFE returns immediately
            (async () => {
                let status = 'completed';
                let errorMsg = null;
                try {
                    let workflowJson = task.workflow_json;
                    try { workflowJson = JSON.parse(workflowJson); } catch (e) {}
                    
                    let orderContext = task.order_context;
                    try { orderContext = JSON.parse(orderContext); } catch (e) {}

                    const result = await _runPipelineInternal(workflowJson, orderContext, pool, {});
                    
                    if (result && !result.success) {
                        status = 'failed';
                        errorMsg = result.error || 'Pipeline execution failed internally';
                    }
                } catch (execErr) {
                    status = 'failed';
                    errorMsg = execErr.message;
                    console.error(`[Queue Worker] ❌ Task ${task.id} Failed:`, errorMsg);
                } finally {
                    activeWorkers--;
                    inflightTaskIds.delete(task.id);
                    console.log(`[Queue Worker] 🏁 Task ${task.id} Finished (${status}). Active Workers: ${activeWorkers}/${concurrencyLimit}`);
                    
                    // Persist final status
                    try {
                        await pool.query(
                            `UPDATE yizi_pipeline_queue SET status = $1, error_msg = $2, updated_at = NOW() WHERE id = $3`,
                            [status, errorMsg, task.id]
                        );
                    } catch (dbErr) {
                        console.error(`[Queue Worker] Failed to update task ${task.id} status:`, dbErr.message);
                    }
                    
                    // Re-trigger scheduler to pick up any remaining pending tasks.
                    // Use setImmediate to yield first, ensuring isProcessing has been released
                    // before we attempt to re-enter the scheduling loop.
                    setImmediate(() => processQueue(pool));
                }
            })();
        }
    } catch (err) {
        console.error('[Queue Worker] Error processing queue:', err);
    } finally {
        // Release the scheduling lock. The long-running pipelines above
        // are already running independently — this only guards the while-loop.
        isProcessing = false;
    }
}


export async function startQueueWorker(pool) {
    console.log('[Queue Worker] 🟢 Initializing PostgreSQL LISTEN/NOTIFY daemon...');

    // BUG FIX: Recover orphan tasks stuck in 'processing' from a previous crash/restart.
    // Any task that has been 'processing' for more than 15 minutes is considered abandoned.
    try {
        const staleResult = await pool.query(
            `UPDATE yizi_pipeline_queue SET status = 'pending', error_msg = 'Auto-recovered from stale processing state', updated_at = NOW()
             WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '15 minutes'
             RETURNING id`
        );
        if (staleResult.rows.length > 0) {
            console.log(`[Queue Worker] ♻️ Recovered ${staleResult.rows.length} orphan task(s): ${staleResult.rows.map(r => r.id).join(', ')}`);
        }
    } catch (e) {
        console.warn('[Queue Worker] Failed to recover stale tasks:', e.message);
    }

    // Safety fallback poller (every 60 seconds)
    setInterval(() => processQueue(pool), 60000);

    // Initial check on startup
    processQueue(pool);

    // Setup LISTEN client
    const setupListener = async () => {
        try {
            if (listenClient) {
                listenClient.release();
                listenClient = null;
            }
            listenClient = await pool.connect();
            await listenClient.query('LISTEN new_pipeline_task');
            console.log('[Queue Worker] 👂 Listening for "new_pipeline_task" events on PG connection');
            
            listenClient.on('notification', (msg) => {
                if (msg.channel === 'new_pipeline_task') {
                    console.log(`[Queue Worker] 🔔 Received task notification: ${msg.payload}`);
                    processQueue(pool);
                }
            });

            // Handle connection loss and auto-reconnect
            listenClient.on('error', (err) => {
                console.error('[Queue Worker] LISTEN client error:', err.message);
                setTimeout(setupListener, 5000); // Reconnect after 5s
            });

        } catch (err) {
            console.error('[Queue Worker] Failed to setup LISTEN client:', err.message);
            setTimeout(setupListener, 5000); // Retry
        }
    };

    setupListener();
}
