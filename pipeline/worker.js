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

async function processQueue(pool) {
    if (isProcessing) return;
    isProcessing = true;

    try {
        const concurrencyLimit = await getConcurrencyLimit(pool);

        while (activeWorkers < concurrencyLimit) {
            const pgClient = await pool.connect();
            let task = null;
            try {
                await pgClient.query('BEGIN');
                // Lock the next pending task
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
                break; // No more pending tasks
            }

            // We have a task, execute it in background
            activeWorkers++;
            console.log(`[Queue Worker] 🚀 Started Task ${task.id}. Active Workers: ${activeWorkers}/${concurrencyLimit}`);

            (async () => {
                let status = 'completed';
                let errorMsg = null;
                try {
                    let workflowJson = task.workflow_json;
                    try { workflowJson = JSON.parse(workflowJson); } catch (e) {}
                    
                    let orderContext = task.order_context;
                    try { orderContext = JSON.parse(orderContext); } catch (e) {}

                    // Run the actual pipeline (this will take minutes)
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
                    console.log(`[Queue Worker] 🏁 Task ${task.id} Finished (${status}). Active Workers: ${activeWorkers}/${concurrencyLimit}`);
                    
                    // Update task status in DB
                    try {
                        await pool.query(
                            `UPDATE yizi_pipeline_queue SET status = $1, error_msg = $2, updated_at = NOW() WHERE id = $3`,
                            [status, errorMsg, task.id]
                        );
                    } catch (dbErr) {
                        console.error(`[Queue Worker] Failed to update task ${task.id} status:`, dbErr.message);
                    }
                    
                    // Trigger queue processing again just in case there are pending tasks
                    processQueue(pool);
                }
            })();
        }
    } catch (err) {
        console.error('[Queue Worker] Error processing queue:', err);
    } finally {
        isProcessing = false;
    }
}

export async function startQueueWorker(pool) {
    console.log('[Queue Worker] 🟢 Initializing PostgreSQL LISTEN/NOTIFY daemon...');
    
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
