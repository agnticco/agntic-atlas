/**
 * GraphEdge — a static directed connection between two nodes.
 *
 * When the CompiledGraph finishes executing `from`, it unconditionally
 * advances to `to`. Use ConditionalEdge when the destination depends on
 * the state at runtime.
 *
 * Special destination values:
 *   END   — terminates the graph run (import from compiled-graph.js)
 *   START — re-enters from the entry point (creates a loop)
 *
 * @module src/graph/edge.js
 */

export class GraphEdge {
  /**
   * @param {string} from - Source node name
   * @param {string} to   - Destination node name (or END)
   */
  constructor(from, to) {
    if (!from || !to) {
      throw new Error('GraphEdge: both "from" and "to" are required');
    }
    this.from = from;
    this.to   = to;
  }
}

export default GraphEdge;
