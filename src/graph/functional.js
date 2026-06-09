/**
 * Functional API — entrypoint + task
 *
 * An alternative to the Graph API that lets you add LangGraph features
 * (persistence, human-in-the-loop, streaming) to ordinary async functions
 * with minimal changes to existing code.
 *
 * Two building blocks:
 *   entrypoint — wraps a function as a workflow with full LangGraph features
 *   task       — wraps a function so its result is cached in the checkpoint on resume
 *
 * Key difference from Graph API:
 *   - No explicit graph structure (nodes, edges)
 *   - Use ordinary if/for/while control flow
 *   - State is function-scoped, not shared across steps
 *   - interrupt() still works inside tasks
 *
 * Usage:
 *
 *   import { entrypoint, task } from './graph/functional.js';
 *   import { interrupt }         from './graph/interrupt.js';
 *   import { MemoryCheckpointer } from './graph/checkpointer/memory-checkpointer.js';
 *
 *   const checkpointer = new MemoryCheckpointer();
 *
 *   const callLLM = task('callLLM', async (prompt) => {
 *     return await llm.invoke(prompt);
 *   });
 *
 *   const reviewStep = task('review', async (draft) => {
 *     return interrupt({ message: 'Please review', draft });
 *   });
 *
 *   const pipeline = entrypoint({ checkpointer, name: 'pipeline' }, async (input) => {
 *     const draft    = await callLLM(input.prompt);
 *     const decision = await reviewStep(draft);
 *     if (decision === 'revise') {
 *       const revised = await callLLM(`Revise: ${draft}`);
 *       return revised;
 *     }
 *     return draft;
 *   });
 *
 *   // Invoke
 *   const config = { configurable: { threadId: 'run-1' } };
 *   try {
 *     const result = await pipeline.invoke({ prompt: 'Write a poem' }, config);
 *   } catch (err) {
 *     if (err.name === 'GraphInterrupt') {
 *       // Prompt human, then resume:
 *       const result = await pipeline.resume('run-1', new Command({ resume: 'approve' }));
 *     }
 *   }
 *
 * @module src/graph/functional.js
 */

import { AsyncLocalStorage } from 'async_hooks';
import { Checkpoint }         from './checkpoint.js';
import { Command }            from './command.js';
import { GraphInterrupt }     from './compiled-graph.js';
import {
  InterruptContext,
  GraphInterruptSignal,
  interruptStorage,
} from './interrupt.js';

// ── FunctionalContext — per-execution state ───────────────────────────────────

/**
 * Holds the execution context for a single entrypoint invocation.
 * Tracks task result cache and interrupt index for consistent replay.
 *
 * @internal
 */
class FunctionalContext {
  /**
   * @param {object}         options
   * @param {object}         [options.taskCache={}]     - Prior task results from checkpoint
   * @param {Array}          [options.resumeValues=[]]  - Values for interrupt() replay
   * @param {string}         options.threadId
   * @param {BaseCheckpointer|null} options.checkpointer
   */
  constructor({ taskCache = {}, resumeValues = [], threadId, checkpointer }) {
    this.taskCache    = { ...taskCache };
    this._taskCounts  = {};       // call-count per task name (for cache key generation)
    this.checkpointer = checkpointer;
    this.threadId     = threadId;
    this.interruptCtx = new InterruptContext(resumeValues);
  }

  /**
   * Run a named task, returning a cached result if available.
   * Results are cached by (name, call-count) so multiple calls to the same
   * task name are each cached independently.
   *
   * @param {string}   name - Task name
   * @param {Function} fn   - The task implementation
   * @param {Array}    args - Arguments to pass to fn
   * @returns {Promise<*>}
   */
  async runTask(name, fn, args) {
    this._taskCounts[name] = (this._taskCounts[name] ?? 0) + 1;
    const cacheKey = `${name}#${this._taskCounts[name]}`;

    if (Object.prototype.hasOwnProperty.call(this.taskCache, cacheKey)) {
      return this.taskCache[cacheKey];
    }

    const result = await fn(...args);
    this.taskCache[cacheKey] = result;
    return result;
  }
}

// ── Async-local storage for functional context ───────────────────────────────

const functionalStorage = new AsyncLocalStorage();

// ── task() ───────────────────────────────────────────────────────────────────

/**
 * Wrap a function as a task.
 *
 * A task's result is automatically memoized in the current entrypoint's
 * checkpoint. If the entrypoint is interrupted and resumed, completed task
 * results are loaded from the checkpoint rather than re-executed.
 *
 * Can also be used as a decorator pattern (call task once, use the result
 * as the wrapped function anywhere).
 *
 * @param {string}   name - Task name (used as cache key; must be unique per call site)
 * @param {Function} fn   - The async function to wrap
 * @returns {Function} A wrapped function that integrates with entrypoint checkpointing.
 *   Outside of an entrypoint context, it calls fn directly with no caching.
 */
export function task(name, fn) {
  function wrappedTask(...args) {
    const ctx = functionalStorage.getStore();
    if (!ctx) {
      // Called outside entrypoint — execute directly, no caching
      return fn(...args);
    }
    return ctx.runTask(name, fn, args);
  }
  wrappedTask.taskName = name;
  return wrappedTask;
}

// ── entrypoint() ─────────────────────────────────────────────────────────────

/**
 * Wrap a function as a persistent, interruptible workflow entrypoint.
 *
 * Returns a runner object with invoke(), stream(), and resume() methods.
 * The runner is NOT a StateGraph — it has no nodes or edges. Control flow
 * is expressed with ordinary JavaScript (if/for/while).
 *
 * @param {object|Function} options
 *   If a function is passed directly, it's treated as `fn` with no options.
 *   Otherwise:
 *   @param {BaseCheckpointer|null} [options.checkpointer=null]
 *   @param {string}               [options.name]   - Workflow name (used in checkpoints)
 * @param {Function} fn - async (input) => result
 * @returns {{ invoke, stream, resume, name }}
 */
export function entrypoint(options, fn) {
  if (typeof options === 'function') {
    fn      = options;
    options = {};
  }

  const {
    checkpointer = null,
    name         = fn.name || 'entrypoint',
  } = options;

  const runner = {
    name,

    // ── invoke ────────────────────────────────────────────────────────────────

    /**
     * Run the workflow to completion.
     *
     * @param {*}      input
     * @param {object} [config]
     * @param {object} [config.configurable]
     * @param {string} [config.configurable.threadId='default']
     * @returns {Promise<*>}
     * @throws {GraphInterrupt} if interrupt() is called inside a task
     */
    async invoke(input, config = {}) {
      const threadId = config?.configurable?.threadId ?? 'default';

      // Load prior checkpoint for resume
      let taskCache    = {};
      let resumeValues = [];

      if (checkpointer) {
        const ckpt = await checkpointer.load(threadId);
        if (ckpt) {
          taskCache    = ckpt.state.__taskCache    ?? {};
          resumeValues = ckpt.state.__resumeValues ?? [];
        }
      }

      const ctx = new FunctionalContext({ taskCache, resumeValues, threadId, checkpointer });

      let result;
      try {
        // Run both the functional context and interrupt context together
        result = await functionalStorage.run(ctx, () =>
          interruptStorage.run(ctx.interruptCtx, () => fn(input))
        );
      } catch (err) {
        if (err instanceof GraphInterruptSignal) {
          // Save checkpoint: task cache + interrupt position
          if (checkpointer) {
            await checkpointer.save(threadId, new Checkpoint({
              state: {
                __taskCache:    ctx.taskCache,
                __resumeValues: [],
                __interruptIndex: err.index,
              },
              node:     name,
              step:     0,
              metadata: {
                resumeFrom:     name,
                __interruptValue: err.value,
              },
            }));
          }
          const interruptErr = new GraphInterrupt({
            threadId,
            node:           name,
            state:          { __taskCache: ctx.taskCache },
            resumeFrom:     name,
            step:           0,
            interruptValue: err.value,
          });
          throw interruptErr;
        }
        throw err;
      }

      // Save final checkpoint
      if (checkpointer) {
        await checkpointer.save(threadId, new Checkpoint({
          state: {
            __taskCache:    ctx.taskCache,
            __resumeValues: [],
            __result:       result,
          },
          node: name,
          step: 1,
        }));
      }

      return result;
    },

    // ── stream ────────────────────────────────────────────────────────────────

    /**
     * Run the workflow and yield the final result as a single chunk.
     * (Full token-by-token streaming requires tasks to call config.streamTokens.)
     *
     * @param {*}      input
     * @param {object} [config]
     */
    async *stream(input, config = {}) {
      const result = await this.invoke(input, config);
      yield result;
    },

    // ── resume ────────────────────────────────────────────────────────────────

    /**
     * Resume a workflow that was paused by interrupt().
     *
     * @param {string}  threadId
     * @param {Command} command  - new Command({ resume: value })
     * @param {object}  [config]
     * @returns {Promise<*>}
     */
    async resume(threadId, command, config = {}) {
      if (!checkpointer) {
        throw new Error(
          `entrypoint("${name}").resume() requires a checkpointer. ` +
          `Pass checkpointer: new MemoryCheckpointer() to entrypoint().`
        );
      }

      const ckpt = await checkpointer.load(threadId);
      if (!ckpt) {
        throw new Error(
          `entrypoint.resume(): no checkpoint found for thread "${threadId}"`
        );
      }

      // Extract resume value — normalise to array for InterruptContext
      const resumeValue  = command instanceof Command ? command.resume : command;
      const resumeValues = Array.isArray(resumeValue) ? resumeValue : [resumeValue];

      // Update checkpoint with resume values
      await checkpointer.save(threadId, new Checkpoint({
        state: {
          ...ckpt.state,
          __resumeValues: resumeValues,
        },
        node:     name,
        step:     ckpt.step,
        metadata: { ...ckpt.metadata, resumeFrom: name },
      }));

      // Re-invoke with the updated checkpoint (invoke will load it)
      return this.invoke(null, {
        ...config,
        configurable: { threadId, ...(config?.configurable ?? {}) },
      });
    },
  };

  return runner;
}
