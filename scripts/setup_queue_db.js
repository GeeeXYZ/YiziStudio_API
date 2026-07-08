import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: dbUrl && dbUrl.includes('supabase.com') ? undefined : (dbUrl && dbUrl.includes('vercel-storage') ? { rejectUnauthorized: false } : undefined)
});

async function run() {
    try {
        console.log('Creating yizi_pipeline_queue table...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS yizi_pipeline_queue (
                id VARCHAR(100) PRIMARY KEY,
                workflow_json TEXT NOT NULL,
                order_context TEXT NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                retry_count INT DEFAULT 0,
                error_msg TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('Creating yizi_settings defaults for PIPELINE_CONCURRENCY...');
        // Insert default concurrency if not exists
        await pool.query(`
            INSERT INTO yizi_settings (key, value)
            VALUES ('PIPELINE_CONCURRENCY', '2')
            ON CONFLICT (key) DO NOTHING;
        `);

        console.log('Creating notify_pipeline_task function...');
        await pool.query(`
            CREATE OR REPLACE FUNCTION notify_pipeline_task()
            RETURNS trigger AS $$
            BEGIN
                PERFORM pg_notify('new_pipeline_task', NEW.id::text);
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        console.log('Creating trigger for yizi_pipeline_queue...');
        // Drop trigger if exists
        await pool.query(`DROP TRIGGER IF EXISTS trigger_pipeline_queue_notify ON yizi_pipeline_queue;`);
        await pool.query(`
            CREATE TRIGGER trigger_pipeline_queue_notify
            AFTER INSERT ON yizi_pipeline_queue
            FOR EACH ROW
            EXECUTE FUNCTION notify_pipeline_task();
        `);

        console.log('Database setup for pipeline queue completed successfully!');
    } catch (e) {
        console.error('Error setting up database:', e);
    } finally {
        await pool.end();
    }
}

run();
