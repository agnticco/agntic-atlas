/**
 * Dynamic interrupt() — pause graph execution from anywhere inside a node.
 *
 * Unlike static interruptBefore/interruptAfter (compile-time breakpoints),
 * interrupt() is called at runtime and can be conditional, carry a payload,
 * and appear multiple times in a single node.
 *
 * How it works:
 *   1. Node code calls interrupt(payload)
 *   2. CompiledGraph catches the thrown GraphInterruptSignal
 *   3. Graph saves a checkpoint and surfaces the payload as __interrupt__
 *   4. Caller resumes with graph.resume(threadId, new Command({ resume: value }))
 *   5. Node re-runs from the top; interrupt() returns the resume value this time
 *      (matching is strictly index-based — don't reorder interrupt() calls)
 *
 * Usage inside a node:
 *
 *   import { interrupt } from '../graph/interrupt.js';
 *
 *   async function reviewNode(state) {
 *     const decision = interrupt({
 *       message: 'Please review the plan before execution',
 *       plan:    state.plan,
 *     });
 *     // On resume, `decision` is whatever was passed to Command({ resume: ... })
 *     return { approved: decision === 'approve' };
 *   }
 *
 * Rules (same as LangGraph spec):
 *   ✅ Keep interrupt() calls consistent across node executions
 *   🔴 Do NOT conditionally skip interrupt() calls within a node
 *   🔴 Do NOT loop interrupt() calls with non-deterministic logic
 *   (Matching is strictly index-based per node execution)
 *
 * @module src/graph/interrupt.js
 */

import { AsyncLocalStorage } from 'async_hooks';

// ── Shared async-local storage for interrupt context ────────────────────────

/** @type {AsyncLocalStorage<InterruptContext>} */
export const interruptStorage = new AsyncLocalStorage();

// ── GraphInterruptSignal — thrown internally by interrupt() ─────────────────

/**
 * Internal sentinel thrown by interrupt() to pause graph execution.
 * Caught by CompiledGraph — never surfaces to user code.
 */
export class GraphInterruptSignal extends Error {
  /**
   * @param {*}      value - The payload passed to interrupt()
   * @param {number} index - The interrupt index within this node execution
   */
  constructor(value, index) {
    super('GraphInterruptSignal');
    this.name  = 'GraphInterruptSignal';
    this.value = value;
    this.index = index;
  }
}

// ── InterruptContext ─────────────────────────────────────────────────────────

/**
 * Tracks interrupt state for a single node execution.
 *
 * Two modes:
 *   - Collecting: interrupt() throws GraphInterruptSignal (first run through node)
 *   - Replaying:  interrupt() returns the resume value (re-run after resume)
 *
 * @internal
 */
export class InterruptContext {
  /**
   * @param {Array} [resumeValues=[]]  - Values from Command({ resume: ... })
   *   Normalised to an array — a single scalar is wrapped in [scalar].
   */
  constructor(resumeValues = []) {
    this._resumeValues = Array.isArray(resumeValues) ? resumeValues : [resumeValues];
    this._index = 0;
  }

  /**
   * Called by interrupt(value).
   *
   * @param {*} value - The payload to surface to the caller
   * @returns {*} The resume value (only in replay mode)
   * @throws {GraphInterruptSignal} In collecting mode (first run)
   */
  handleInterrupt(value) {
    const idx = this._index++;
    if (idx < this._resumeValues.length) {
      return this._resumeValues[idx];
    }
    throw new GraphInterruptSignal(value, idx);
  }

  /** @returns {number} How many interrupts have been handled so far */
  get index() {
    return this._index;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Pause graph execution and wait for human input.
 *
 * Must be called inside a graph node that is running within CompiledGraph.
 * Returns the resume value when the graph is continued via
 * graph.resume(threadId, new Command({ resume: value })).
 *
 * @param {*} [value] - JSON-serialisable payload to surface to the caller.
 *   Appears in GraphInterrupt.interruptValue and in the __interrupt__ stream event.
 * @returns {*} The value passed to Command({ resume: ... }) on resume.
 * @throws {GraphInterruptSignal} Internally (caught by CompiledGraph)
 */
export function interrupt(value) {
  const ctx = interruptStorage.getStore();
  if (!ctx) {
    throw new Error(
      'interrupt() was called outside of a CompiledGraph node execution. ' +
      'Ensure the node is running inside graph.invoke() or graph.stream().'
    );
  }
  return ctx.handleInterrupt(value);
}

/**
 * Run a function within a given InterruptContext.
 * Used internally by CompiledGraph to set up the async-local context
 * before invoking each node.
 *
 * @param {InterruptContext} ctx
 * @param {Function}         fn
 * @returns {Promise<*>}
 */
export function runWithInterruptContext(ctx, fn) {
  return interruptStorage.run(ctx, fn);
}
