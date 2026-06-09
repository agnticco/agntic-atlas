/**
 * Send — parallel fan-out primitive for StateGraph.
 *
 * Returned as an array from a conditional edge function to dispatch
 * multiple nodes concurrently (a "superstep"). Each Send carries the
 * target node name and an optional partial state that is merged on top
 * of the shared graph state before that node executes.
 *
 * Usage in a conditional edge:
 *
 *   graph.addConditionalEdges('classify', (state) => {
 *     return state.classifications.map(c =>
 *       new Send(c.source + '_pipeline', { source_query: c.query })
 *     );
 *   });
 *
 *   // All target nodes must have static addEdge() to the same convergence node:
 *   graph.addEdge('vault_pipeline',  'synthesize');
 *   graph.addEdge('web_pipeline',    'synthesize');
 *   graph.addEdge('direct_pipeline', 'synthesize');
 *
 * Execution semantics:
 *   - All Send targets run in parallel via Promise.all (one superstep)
 *   - Each branch receives { ...sharedState, ...send.state } as input
 *   - Branch return values are merged into shared state using reducers
 *     (for accumulating fields like source_results) or last-write-wins
 *   - Execution continues at the convergence node after all branches finish
 *
 * @module src/graph/send.js
 */

export class Send {
  /**
   * @param {string} node  - Target node name (must be registered with addNode)
   * @param {object} [state={}] - Partial state override for this branch only
   */
  constructor(node, state = {}) {
    if (typeof node !== 'string' || !node) {
      throw new Error('Send: node must be a non-empty string');
    }
    this.node  = node;
    this.state = state;
  }
}

export default Send;
