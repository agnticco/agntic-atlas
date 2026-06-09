/**
 * GraphNode — a single unit of work in a StateGraph.
 *
 * Wraps an async function that receives the current graph state and returns
 * a partial state update. CompiledGraph merges the update (shallow) into
 * the running state before advancing to the next node.
 *
 * Node functions follow the pattern:
 *   async (state, config?) => ({ ...partialUpdate })
 *
 * They should only return the keys they changed — not the full state.
 * Returning null or undefined means no state change.
 * Returning a Command instance enables combined routing + state update.
 *
 * Retry policy (optional):
 *   { maxAttempts: 3, delay: 1000, backoff: 'exponential', retryOn: [Error] }
 *
 * @module src/graph/node.js
 */

import { GraphInterruptSignal } from './interrupt.js';

export class GraphNode {
  /**
   * @param {string}   name        - Unique identifier within the graph
   * @param {Function} fn          - async (state, config?) => partialStateUpdate | Command
   * @param {object|null} [retryPolicy] - Optional retry configuration
   * @param {number}  [retryPolicy.maxAttempts=3]         - Maximum total attempts
   * @param {number}  [retryPolicy.delay=1000]            - Initial delay in ms
   * @param {'fixed'|'exponential'} [retryPolicy.backoff='exponential']
   * @param {Function[]} [retryPolicy.retryOn=[Error]]    - Error classes to retry on
   */
  constructor(name, fn, retryPolicy = null) {
    if (typeof name !== 'string' || !name) {
      throw new Error('GraphNode: name must be a non-empty string');
    }
    if (typeof fn !== 'function') {
      throw new Error(`GraphNode "${name}": fn must be a function`);
    }
    this.name        = name;
    this._fn         = fn;
    this._retryPolicy = retryPolicy;
  }

  /**
   * Execute this node with the current graph state.
   * Applies retry logic if a retryPolicy is configured.
   *
   * @param {object} state  - Full current graph state
   * @param {object} config - RunnableConfig (passed through from CompiledGraph)
   * @returns {Promise<object|Command|null>} Partial state update, Command, or null
   */
  async invoke(state, config) {
    if (!this._retryPolicy) {
      return this._fn(state, config);
    }
    return this._invokeWithRetry(state, config);
  }

  /**
   * Invoke with retry/backoff logic.
   * GraphInterruptSignal is never retried — it propagates immediately.
   */
  async _invokeWithRetry(state, config) {
    const {
      maxAttempts = 3,
      delay       = 1000,
      backoff     = 'exponential',
      retryOn     = [Error],
    } = this._retryPolicy;

    let attempt = 0;

    while (true) {
      try {
        return await this._fn(state, config);
      } catch (err) {
        // Never retry a dynamic interrupt — propagate immediately
        if (err instanceof GraphInterruptSignal) throw err;

        const shouldRetry = retryOn.some(ErrClass => err instanceof ErrClass);
        if (!shouldRetry || attempt >= maxAttempts - 1) throw err;

        const waitMs = backoff === 'exponential'
          ? delay * Math.pow(2, attempt)
          : delay;

        await new Promise(resolve => setTimeout(resolve, waitMs));
        attempt++;
      }
    }
  }
}

export default GraphNode;
