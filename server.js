import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Initialize environment variables
dotenv.config();

// Global Crash Handlers for Zeabur Debugging
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Initialize database connection (runs DDL on import)
import { pool } from './config/db.js';
// Import route modules
export { orderEventEmitter } from './events.js';

// Import route modules
import adminAuthRoutes from './routes/admin.auth.js';
import adminOssRoutes from './routes/admin.oss.js';
import adminSettingsRoutes from './routes/admin.settings.js';
import clientRoutes from './routes/client.js';
import comfyuiRoutes from './routes/comfyui.js';
import toolkitRoutes from './routes/toolkit.js';
import pipelineRoutes from './routes/pipeline.js';
import rpcRoutes from './routes/rpc.js';

const app = express();
app.use(cors({
  origin: [/localhost/, /zeabur\.app$/, /yizistudio/, /yizi\.studio/],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve temporary images statically
app.use('/temp_images', express.static(path.join(__dirname, 'temp_images')));

// Health check / status route
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Yizi Studio API Middleware',
    time: new Date().toISOString()
  });
});

// Mount route modules
app.use(adminAuthRoutes);
app.use(adminOssRoutes);
app.use(adminSettingsRoutes);
app.use(clientRoutes);
app.use(comfyuiRoutes);
app.use(toolkitRoutes);
app.use(pipelineRoutes);
app.use(rpcRoutes);  // Generic RPC — must be last (catch-all dynamic routes)

// Queue Worker removed for Zeabur deployment (in-memory execution only)

const PORT = process.env.PORT || 9000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Yizi Backend API is running on http://localhost:${PORT}`);
  });
}

export default app;
