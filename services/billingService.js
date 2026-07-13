import { pool } from '../config/db.js';

/**
 * Perform billing calculation and deduction for a completed pipeline execution.
 * @param {Object} executionLedgers - Map of ledger entries: { "nodeType": { node_type, count } }
 * @param {Object} contextInfo - { task_id, run_by_admin_id, run_by_user_id }
 */
export async function finalizePipelineBilling(executionLedgers, contextInfo) {
  const ledgerValues = Object.values(executionLedgers);
  if (ledgerValues.length === 0) return; // No nodes were executed

  try {
    // 1. Fetch current pricing for the executed nodes
    const { rows: pricingRows } = await pool.query(`SELECT node_type, cost FROM yizi_node_costs`);
    
    // Convert to quick lookup map
    const pricingMap = {};
    for (const row of pricingRows) {
      pricingMap[row.node_type] = row;
    }

    let totalCost = 0;
    const finalDetails = [];

    // 2. Calculate totals
    for (const entry of ledgerValues) {
      let price = pricingMap[entry.node_type];
      
      const costPerRun = price ? parseFloat(price.cost) : 0;
      const totalNodeCost = costPerRun * entry.count;

      totalCost += totalNodeCost;

      finalDetails.push({
        node_type: entry.node_type,
        count: entry.count,
        cost_per_run: costPerRun,
        total_cost: totalNodeCost
      });
    }

    // 3. Begin Transaction to deduct and record
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 注：业务逻辑上 API 开销（Cost）属于内部记账，不从用户的点数（前端已按照 SKU 零售价扣除）或管理员余额中直接扣减，仅做 Ledger 纯记账。

      // Record Ledger
      await client.query(
        `INSERT INTO yizi_execution_ledgers (task_id, run_by_admin_id, run_by_user_id, total_cost, node_execution_details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          contextInfo.task_id,
          contextInfo.run_by_admin_id || null,
          contextInfo.run_by_user_id || null,
          totalCost,
          JSON.stringify(finalDetails)
        ]
      );

      await client.query('COMMIT');
      console.log(`[Billing] Task ${contextInfo.task_id}: Recorded Ledger for ${totalCost} api cost`);
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`[Billing] Failed to process billing for task ${contextInfo.task_id}:`, err);
  }
}
