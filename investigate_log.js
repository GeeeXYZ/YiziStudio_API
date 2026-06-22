import { pool } from './config/db.js';

async function investigate() {
  // Find the workflow for this order's SKU
  const orderRes = await pool.query(`SELECT data FROM yizi_orders WHERE id = 'ord_3803a67cdcb21d58'`);
  if (orderRes.rows.length === 0) { console.log('Order not found'); process.exit(1); }
  const orderData = orderRes.rows[0].data || {};
  console.log(`planId: ${orderData.planId}`);

  // Get SKU
  const skuRes = await pool.query(`SELECT data FROM yizi_sku WHERE id = $1`, [orderData.planId]);
  if (skuRes.rows.length === 0) { console.log('SKU not found'); process.exit(1); }
  const skuData = skuRes.rows[0].data || {};
  console.log(`workflow uuid: ${skuData.workflow}`);
  console.log(`workflow_type: ${skuData.workflow_type}`);
  console.log(`auto_trigger: ${skuData.auto_trigger}`);

  if (!skuData.workflow) { console.log('No workflow assigned'); process.exit(0); }

  // Get workflow
  const caseRes = await pool.query(`SELECT uuid, title, data FROM yizi_cases WHERE uuid = $1`, [skuData.workflow]);
  if (caseRes.rows.length === 0) { console.log('Workflow not found'); process.exit(1); }
  const c = caseRes.rows[0];
  const cData = typeof c.data === 'string' ? JSON.parse(c.data) : (c.data || {});
  const wfJson = cData.workflow_json || cData;
  
  console.log(`\nWorkflow: ${c.title} (${c.uuid})`);
  
  let wf;
  try { wf = typeof wfJson === 'string' ? JSON.parse(wfJson) : wfJson; } 
  catch(e) { console.log('Failed to parse workflow_json'); process.exit(1); }
  
  if (!wf || !wf.nodes) { console.log('No nodes in workflow'); process.exit(1); }

  console.log(`\n=== Workflow Nodes (${wf.nodes.length} total) ===`);
  for (const n of wf.nodes) {
    const dataKeys = Object.keys(n.data || {}).join(', ');
    console.log(`  [${n.id}] type=${n.type} | data keys: ${dataKeys}`);
  }

  console.log(`\n=== Edges (${wf.edges.length} total) ===`);
  for (const e of wf.edges) {
    console.log(`  ${e.source} (${e.sourceHandle || 'output'}) --> ${e.target} (${e.targetHandle || 'input'})`);
  }

  // Now simulate topoSort to see execution order
  const nodeMap = {};
  const inEdges = {};
  const outEdges = {};
  for (const n of wf.nodes) {
    nodeMap[n.id] = n;
    inEdges[n.id] = [];
    outEdges[n.id] = [];
  }
  for (const e of wf.edges) {
    if (nodeMap[e.source] && nodeMap[e.target]) {
      outEdges[e.source].push(e);
      inEdges[e.target].push(e);
    }
  }
  
  const sorted = [];
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('Cycle at ' + id);
    visiting.add(id);
    for (const e of outEdges[id]) visit(e.target);
    visiting.delete(id);
    visited.add(id);
    sorted.unshift(id);
  }
  for (const id of Object.keys(nodeMap)) visit(id);

  console.log(`\n=== Topo-sorted execution order ===`);
  sorted.forEach((id, i) => {
    const n = nodeMap[id];
    const deps = [...new Set(inEdges[id].map(e => e.source))];
    console.log(`  Step ${i+1}: [${n.type}] id=${id} | depends on: ${deps.length > 0 ? deps.map(d => nodeMap[d]?.type + '(' + d + ')').join(', ') : 'none'}`);
  });

  process.exit(0);
}

investigate().catch(e => { console.error(e); process.exit(1); });
