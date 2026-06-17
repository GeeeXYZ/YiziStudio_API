import { pool } from './config/db.js';
async function run() {
  const r = await pool.query(`SELECT * FROM yizi_cases WHERE uuid = 'case_1781457806126'`);
  const json = typeof r.rows[0].data.workflow_json === 'string' ? JSON.parse(r.rows[0].data.workflow_json) : r.rows[0].data.workflow_json;
  const nodes = json.nodes || [];
  const comfyNode = nodes.find(n => n.type === 'comfy_remote');
  console.log('comfyNode.data:', JSON.stringify(comfyNode.data, null, 2));
  process.exit(0);
}
run();
