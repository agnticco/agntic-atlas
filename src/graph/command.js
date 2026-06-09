/**
 * Command — combines state update + routing control in a single node return.
 *
 * Returning a Command from a node lets you both update state AND decide the
 * next node to go to, without needing a separate conditional edge. It is also
 * the standard way to resume a graph after a dynamic interrupt().
 *
 * Usage — routing + state update:
 *
 *   async function reviewNode(state) {
 *     const decision = await askHuman(state.plan);
 *     return new Command({
 *       goto:   decision === 'approve' ? 'execute' : 'revise',
 *       update: { approved: decision === 'approve' },
 *     });
 *   }
 *
 * Usage — resuming an interrupt():
 *
 *   // After catching GraphInterrupt, resume with:
 *   await graph.resume(threadId, new Command({ resume: 'approved' }));
 *
 * Usage — multi-agent handoff:
 *
 *   return new Command({
 *     goto:   'billing_agent',
 *     update: { context: 'Transfer from support agent' },
 *   });
 *
 * @module src/graph/command.js
 */

export class Command {
  /**
   * @param {object} options
   * @param {string|string[]|import('./send.js').Send[]} [options.goto]
   *   Next node(s) to route to. Accepts:
   *   - A single node name string
   *   - An array of node name strings (parallel routing)
   *   - An array of Send instances (parallel fan-out with per-branch state)
   *   Omit to let the graph resolve routing via edges as normal.
   *
   * @param {object} [options.update]
   *   Partial state update to apply before routing. Merged the same way
   *   node return values are merged (reducer-aware).
   *
   * @param {*} [options.resume]
   *   Value to pass back to the interrupt() call that paused the graph.
   *   Used exclusively when resuming after a dynamic interrupt().
   *   Can be any JSON-serialisable value.
   */
  constructor({ goto, update, resume } = {}) {
    /** @type {string|string[]|import('./send.js').Send[]|undefined} */
    this.goto   = goto;
    /** @type {object|undefined} */
    this.update = update;
    /** @type {*} */
    this.resume = resume;
  }

  /** @returns {boolean} */
  get isResume() {
    return this.resume !== undefined;
  }

  /** @returns {boolean} */
  get hasGoto() {
    return this.goto !== undefined && this.goto !== null;
  }

  /** @returns {boolean} */
  get hasUpdate() {
    return this.update !== undefined && this.update !== null;
  }
}

export default Command;
