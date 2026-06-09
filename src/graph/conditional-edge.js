/**
 * ConditionalEdge — dynamic routing based on graph state.
 *
 * The condition function inspects the current state and returns the name
 * of the next node to execute. This is how the planning loop decides
 * whether to keep clarifying, propose a plan, or execute.
 *
 * Usage:
 *
 *   graph.addConditionalEdges('assess', (state) => {
 *     if (!state.hasEnoughContext) return 'clarify';
 *     if (!state.planApproved)     return 'plan';
 *     return 'execute';
 *   });
 *
 * Optional pathMap lets you map return values to node names:
 *
 *   graph.addConditionalEdges('assess',
 *     (state) => state.phase,          // returns 'needs_clarify' | 'ready' | 'approved'
 *     { needs_clarify: 'clarify', ready: 'plan', approved: 'execute' }
 *   );
 *
 * @module src/graph/conditional-edge.js
 */

export class ConditionalEdge {
  /**
   * @param {string}        from        - Source node name
   * @param {Function}      conditionFn - (state) => string — next node name or END
   * @param {object|null}   pathMap     - Optional { returnValue: nodeName } mapping
   */
  constructor(from, conditionFn, pathMap = null) {
    if (!from) {
      throw new Error('ConditionalEdge: "from" is required');
    }
    if (typeof conditionFn !== 'function') {
      throw new Error(`ConditionalEdge from "${from}": conditionFn must be a function`);
    }
    this.from         = from;
    this._conditionFn = conditionFn;
    this._pathMap     = pathMap;
  }

  /**
   * Evaluate the condition against the current state.
   * Returns the next node name (or END).
   *
   * @param {object} state
   * @returns {string}
   */
  resolve(state) {
    const result = this._conditionFn(state);
    if (this._pathMap) {
      if (!(result in this._pathMap)) {
        throw new Error(
          `ConditionalEdge from "${this.from}": condition returned "${result}" ` +
          `but pathMap has no entry for it. Valid keys: ${Object.keys(this._pathMap).join(', ')}`
        );
      }
      return this._pathMap[result];
    }
    return result;
  }
}

export default ConditionalEdge;
