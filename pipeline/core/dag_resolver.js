/**
 * Parses nodes and edges into an execution graph
 */
export function buildGraph(nodes, edges) {
  const graph = {
    nodes: {},
    inEdges: {},
    outEdges: {}
  };

  for (const node of nodes) {
    graph.nodes[node.id] = node;
    graph.inEdges[node.id] = [];
    graph.outEdges[node.id] = [];
  }

  for (const edge of edges) {
    if (graph.nodes[edge.source] && graph.nodes[edge.target]) {
      graph.outEdges[edge.source].push(edge);
      graph.inEdges[edge.target].push(edge);
    }
  }

  return graph;
}

/**
 * Topologically sort nodes
 */
export function topoSort(graph) {
  const sorted = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(nodeId) {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new Error(`Cycle detected at node ${nodeId}`);
    
    visiting.add(nodeId);
    for (const edge of graph.outEdges[nodeId]) {
      visit(edge.target);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    sorted.unshift(nodeId); // prepend
  }

  for (const nodeId of Object.keys(graph.nodes)) {
    visit(nodeId);
  }
  return sorted;
}

/**
 * Resolve node inputs from upstream context based on incoming edges
 */
export function resolveInputs(incomingEdges, context) {
  const inputs = {};
  for (const edge of incomingEdges) {
    const sourceOutputs = context[edge.source] || {};
    const val = sourceOutputs[edge.sourceHandle || 'output'];
    if (val !== undefined) {
      // Append array if multiple edges connect to the same target handle
      if (inputs[edge.targetHandle] !== undefined) {
        if (!Array.isArray(inputs[edge.targetHandle])) {
          inputs[edge.targetHandle] = [inputs[edge.targetHandle]];
        }
        // BUG FIX: Flatten array values instead of nesting them.
        // Before: push(['url1']) → [['url1'], ['url2']] (nested, downstream filters silently drop)
        // After:  push(...['url1']) → ['url1', 'url2'] (flat, all images preserved)
        if (Array.isArray(val)) {
          inputs[edge.targetHandle].push(...val);
        } else {
          inputs[edge.targetHandle].push(val);
        }
      } else {
        inputs[edge.targetHandle] = val;
      }
    }
  }
  return inputs;
}
