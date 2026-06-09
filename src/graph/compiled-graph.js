/**
 * CompiledGraph — the execution engine for a StateGraph.
 *
 * Produced by StateGraph.compile(). Extends Runnable so it can be
 * invoked, streamed, or composed with .pipe() like any other step.
 *
 * ── Execution model ──────────────────────────────────────────────────────────
 *   1. Start at the entry node
 *   2. Check interruptBefore list — pause if matched (throws GraphInterrupt)
 *   3. Execute the node → receive partial state update or Command
 *   4. If Command returned: apply .update, route via .goto
 *      Otherwise: merge update into state via _mergeState()
 *   5. Check for dynamic interrupt() signals (GraphInterruptSignal)
 *   6. Save checkpoint (if checkpointer is set and not stateless)
 *   7. Check interruptAfter list — pause if matched (throws GraphInterrupt)
 *   8. Resolve next step via _resolveNext():
 *      - Returns a string  → single next node (sequential)
 *      - Returns Send[]    → parallel fan-out (superstep)
 *   9. Repeat until END or recursion limit hit
 *
 * ── State merging ─────────────────────────────────────────────────────────────
 *   Plain fields:   last write wins
 *   Reducer fields: accumulated via reducer(accumulated, incoming)
 *
 * ── Human-in-the-loop ────────────────────────────────────────────────────────
 *   Static:  compile with interruptBefore/interruptAfter — pause at node boundaries
 *   Dynamic: call interrupt(payload) inside any node — pause mid-execution
 *   Both:    resume with graph.resume(threadId, new Command({ resume: value }))
 *            or graph.resume(threadId, stateUpdate) for static interrupts
 *
 * ── Streaming ────────────────────────────────────────────────────────────────
 *   'updates'  — yields { [nodeName]: update } after each node
 *   'values'   — yields full state snapshot after each node
 *   'messages' — yields [chunk, { langgraph_node }] for each LLM token
 *   'custom'   — yields events emitted via config.writer
 *   string[]   — multi-mode: yields ['mode', data] tuples
 *
 * ── Parallel execution ────────────────────────────────────────────────────────
 *   Send[] returned from a conditional edge fans out to multiple nodes concurrently.
 *   max_concurrency in config.configurable caps concurrent branches.
 *
 * ── Time travel ───────────────────────────────────────────────────────────────
 *   getHistory(threadId)             → all checkpoints for a thread
 *   replayFrom(threadId, ckptId)     → re-run from that checkpoint
 *   forkFrom(threadId, ckptId, ...)  → branch to a new thread from that checkpoint
 *
 * ── Subgraph persistence ──────────────────────────────────────────────────────
 *   stateless=true  → no checkpointing at all (set via compile({ checkpointer: false }))
 *   Otherwise:      → standard checkpointing if checkpointer is provided
 *
 * @module src/graph/compiled-graph.js
 */

import { Runnable }   from '../core/runnable.js';
import { Checkpoint } from './checkpoint.js';
import { Send }       from './send.js';
import { Command }    from './command.js';
import {
  InterruptContext,
  GraphInterruptSignal,
  runWithInterruptContext,
} from './interrupt.js';

/** Sentinel: returned by a conditional edge to stop the graph. */
export const END   = '__end__';

/** Sentinel: entry point placeholder (used in addEdge calls). */
export const START = '__start__';

// ── GraphInterrupt ────────────────────────────────────────────────────────────

/**
 * Thrown when graph execution pauses — either via a static interruptBefore/After
 * or a dynamic interrupt() call inside a node.
 *
 * To resume: call graph.resume(threadId, new Command({ resume: value }))
 * For static interrupts: graph.resume(threadId, stateUpdate) also works.
 */
export class GraphInterrupt extends Error {
  constructor({ threadId, node, state, resumeFrom, step, interruptValue }) {
    super(`Graph interrupted at node "${node}" in thread "${threadId}"`);
    this.name           = 'GraphInterrupt';
    this.threadId       = threadId;
    this.node           = node;
    this.state          = state;
    this.resumeFrom     = resumeFrom;
    this.step           = step;
    /** The payload passed to interrupt(), if this was a dynamic interrupt */
    this.interruptValue = interruptValue;
    /** Same as interruptValue — matches LangGraph's __interrupt__ field */
    this.__interrupt__  = interruptValue;
  }
}

// ── Semaphore — concurrency limiting for parallel branches ────────────────────

class Semaphore {
  constructor(max) {
    this._max   = max === Infinity ? Infinity : Math.max(1, max);
    this._count = 0;
    this._queue = [];
  }

  async acquire() {
    if (this._max === Infinity || this._count < this._max) {
      this._count++;
      return;
    }
    await new Promise(resolve => this._queue.push(resolve));
    this._count++;
  }

  release() {
    this._count--;
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    }
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ── CompiledGraph ─────────────────────────────────────────────────────────────

export class CompiledGraph extends Runnable {
  /**
   * @param {object}   options
   * @param {Map}      options.nodes
   * @param {Map}      options.edges
   * @param {Map}      options.conditionalEdges
   * @param {string}   options.entryPoint
   * @param {Set}      options.finishPoints
   * @param {import('./checkpointer/base-checkpointer.js').BaseCheckpointer|null} options.checkpointer
   * @param {string[]} [options.interruptBefore]
   * @param {string[]} [options.interruptAfter]
   * @param {object}   [options.reducers]
   * @param {boolean}  [options.stateless=false] - When true, skip all checkpointing
   */
  constructor({
    nodes, edges, conditionalEdges, entryPoint, finishPoints,
    checkpointer    = null,
    interruptBefore = [],
    interruptAfter  = [],
    reducers        = {},
    stateless       = false,
  }) {
    super();
    this._nodes            = nodes;
    this._edges            = edges;
    this._conditionalEdges = conditionalEdges;
    this._entryPoint       = entryPoint;
    this._finishPoints     = finishPoints;
    this._checkpointer     = checkpointer;
    this._interruptBefore  = new Set(interruptBefore);
    this._interruptAfter   = new Set(interruptAfter);
    this._reducers         = reducers;
    this._stateless        = stateless;
  }

  // ── State merging ──────────────────────────────────────────────────────────

  _mergeState(current, update) {
    if (!update || typeof update !== 'object') return current;
    const next = { ...current };
    for (const [key, value] of Object.entries(update)) {
      if (this._reducers[key]) {
        next[key] = this._reducers[key](current[key], value);
      } else {
        next[key] = value;
      }
    }
    return next;
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /**
   * Determine the next step after `currentNode`.
   * Returns a string (next node), Send[] (fan-out), or END.
   * Command.goto overrides this when the node returned a Command.
   */
  _resolveNext(currentNode, state) {
    const conditionals = this._conditionalEdges.get(currentNode) ?? [];
    for (const edge of conditionals) {
      const next = edge.resolve(state);
      if (next !== null && next !== undefined) return next;
    }
    const staticNext = this._edges.get(currentNode);
    if (staticNext) return staticNext;
    return END;
  }

  /**
   * Resolve the convergence node for a Send[] fan-out.
   * All Send targets must share the same static outgoing edge target.
   */
  _resolveConvergence(sends, fromNode) {
    const targets = sends.map(send => {
      const target = this._edges.get(send.node);
      if (!target) {
        throw new Error(
          `CompiledGraph: parallel node "${send.node}" (dispatched from "${fromNode}") ` +
          `has no static outgoing edge. All parallel Send targets must have an ` +
          `addEdge() pointing to a shared convergence node.`
        );
      }
      return target;
    });
    const unique = [...new Set(targets)];
    if (unique.length > 1) {
      throw new Error(
        `CompiledGraph: Send from "${fromNode}" — parallel branches point to different ` +
        `convergence nodes: ${sends.map(s => `${s.node} → ${this._edges.get(s.node)}`).join(', ')}. ` +
        `All parallel branches must share the same static outgoing edge.`
      );
    }
    return unique[0];
  }

  /**
   * Normalise a Command.goto value into the same shape _resolveNext() returns:
   * a string, a Send[], or END.
   */
  _resolveCommandGoto(goto) {
    if (!goto) return null;
    if (typeof goto === 'string') return goto;
    if (Array.isArray(goto)) {
      // Array of strings → convert to Send[] with no per-branch state
      if (goto.every(g => typeof g === 'string')) {
        return goto.map(g => new Send(g, {}));
      }
      // Already Send[]
      return goto;
    }
    return goto;
  }

  // ── Checkpointing ──────────────────────────────────────────────────────────

  async _saveCheckpoint(threadId, node, state, step, metadata = {}) {
    if (this._stateless || !this._checkpointer) return;
    await this._checkpointer.save(threadId, new Checkpoint({ state, node, step, metadata }));
  }

  async _loadCheckpoint(threadId) {
    if (this._stateless || !this._checkpointer) return null;
    return this._checkpointer.load(threadId);
  }

  // ── Node execution — handles Command + dynamic interrupt ────────────────────

  /**
   * Execute a single node, wired with an InterruptContext so that
   * interrupt() calls inside the node are handled correctly.
   *
   * Returns { update, command, interruptCtx } where:
   *   update  — the raw return value (if not a Command)
   *   command — the Command instance (if the node returned one)
   *   interruptCtx — the context after execution (for resume index tracking)
   */
  async _executeNode(node, state, config, interruptCtx) {
    const nodeTimeoutMs = config?.configurable?.nodeTimeoutMs ?? 0;
    const nodePromise   = runWithInterruptContext(interruptCtx, () => node.invoke(state, config));

    let raw;
    if (nodeTimeoutMs > 0) {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(
          `Node "${node.name ?? 'unknown'}" timed out after ${nodeTimeoutMs}ms`
        )), nodeTimeoutMs)
      );
      raw = await Promise.race([nodePromise, timeout]);
    } else {
      raw = await nodePromise;
    }

    if (raw instanceof Command) {
      return { update: raw.update ?? null, command: raw, interruptCtx };
    }
    return { update: raw, command: null, interruptCtx };
  }

  // ── Core execution loop ────────────────────────────────────────────────────

  /**
   * Internal: run the graph from startNode until END.
   *
   * @param {string} startNode
   * @param {object} initialState
   * @param {number} startStep
   * @param {object} config
   * @param {object} [resumeValues] — map of { nodeToResume: [resumeValue, ...] }
   *   Used by dynamic interrupt resume to inject values into the node's interrupt() calls.
   */
  async _runLoop(startNode, initialState, startStep, config, resumeValues = {}) {
    const recursionLimit = config?.recursionLimit ?? 25;
    const threadId       = config?.configurable?.threadId ?? 'default';
    const maxConcurrency = config?.configurable?.maxConcurrency ?? Infinity;

    let state       = { ...initialState };
    let currentNode = startNode;
    let step        = startStep;

    while (currentNode !== END) {
      if (step >= recursionLimit) {
        throw new Error(
          `CompiledGraph: recursion limit (${recursionLimit}) exceeded at node "${currentNode}". ` +
          `Increase config.recursionLimit or check for infinite loops.`
        );
      }

      // ── Static interrupt BEFORE ────────────────────────────────────────────
      if (this._interruptBefore.has(currentNode)) {
        if (!this._checkpointer) throw new Error(
          `CompiledGraph: interruptBefore requires a checkpointer (node "${currentNode}")`
        );
        await this._saveCheckpoint(threadId, currentNode, state, step, { resumeFrom: currentNode });
        throw new GraphInterrupt({
          threadId, node: currentNode, state: { ...state },
          resumeFrom: currentNode, step,
        });
      }

      const node = this._nodes.get(currentNode);
      if (!node) {
        throw new Error(`CompiledGraph: node "${currentNode}" not found in graph`);
      }

      // Build interrupt context for this node (replaying if we have resume values for it)
      const nodeResumes    = resumeValues[currentNode] ?? [];
      const interruptCtx   = new InterruptContext(nodeResumes);

      let update, command;
      try {
        ({ update, command } = await this._executeNode(node, state, config, interruptCtx));
      } catch (err) {
        if (err instanceof GraphInterruptSignal) {
          // Dynamic interrupt() fired — save checkpoint and surface to caller
          if (!this._checkpointer) throw new Error(
            `CompiledGraph: dynamic interrupt() requires a checkpointer (node "${currentNode}"). ` +
            `Compile with: graph.compile({ checkpointer: new MemoryCheckpointer() })`
          );
          await this._saveCheckpoint(threadId, currentNode, state, step, {
            resumeFrom:     currentNode,
            __interruptIndex: err.index,
            __resumeNode:   currentNode,
          });
          throw new GraphInterrupt({
            threadId, node: currentNode, state: { ...state },
            resumeFrom: currentNode, step,
            interruptValue: err.value,
          });
        }
        throw err;
      }

      // Apply state update (Command.update or plain return value)
      if (update) state = this._mergeState(state, update);
      await this._saveCheckpoint(threadId, currentNode, state, step);

      // ── Static interrupt AFTER ─────────────────────────────────────────────
      if (this._interruptAfter.has(currentNode)) {
        if (!this._checkpointer) throw new Error(
          `CompiledGraph: interruptAfter requires a checkpointer (node "${currentNode}")`
        );
        const next = command?.hasGoto
          ? this._resolveCommandGoto(command.goto)
          : this._resolveNext(currentNode, state);
        const resumeFrom = Array.isArray(next) ? currentNode : (next ?? currentNode);
        await this._saveCheckpoint(threadId, currentNode, state, step, { resumeFrom });
        throw new GraphInterrupt({
          threadId, node: currentNode, state: { ...state },
          resumeFrom, step,
        });
      }

      // ── Routing: Command.goto takes priority over edges ────────────────────
      let next;
      if (command?.hasGoto) {
        next = this._resolveCommandGoto(command.goto);
      } else {
        next = this._resolveNext(currentNode, state);
      }

      // ── Parallel fan-out (Send[]) ──────────────────────────────────────────
      if (Array.isArray(next)) {
        if (next.length === 0) { currentNode = END; continue; }

        const convergenceNode = this._resolveConvergence(next, currentNode);
        const sem = new Semaphore(maxConcurrency);

        const branchUpdates = await Promise.all(
          next.map(send => sem.run(async () => {
            const branchNode = this._nodes.get(send.node);
            if (!branchNode) throw new Error(
              `CompiledGraph: Send target "${send.node}" is not a registered node`
            );
            const branchState  = this._mergeState(state, send.state);
            const branchCtx    = new InterruptContext();
            const { update: bu } = await this._executeNode(branchNode, branchState, config, branchCtx);
            return { name: send.node, update: bu };
          }))
        );

        for (let i = 0; i < branchUpdates.length; i++) {
          const { name: bName, update: bu } = branchUpdates[i];
          state = this._mergeState(state, bu);
          await this._saveCheckpoint(threadId, bName, state, step + i);
        }

        currentNode = convergenceNode;
        step += next.length;
        continue;
      }

      // ── Sequential routing ─────────────────────────────────────────────────
      currentNode = next;
      step++;
    }

    return state;
  }

  // ── Runnable contract ──────────────────────────────────────────────────────

  async _call(initialState, config) {
    const threadId = config?.configurable?.threadId ?? 'default';

    let state = { ...initialState };
    const checkpoint = await this._loadCheckpoint(threadId);
    if (checkpoint && !checkpoint.metadata?.resumeFrom) {
      state = { ...checkpoint.state, ...initialState };
    }

    const mergedConfig = {
      ...config,
      configurable: { threadId, ...(config?.configurable ?? {}) },
    };
    return this._runLoop(this._entryPoint, state, 0, mergedConfig);
  }

  // ── Resume (static + dynamic HITL) ────────────────────────────────────────

  /**
   * Resume a graph that was paused by a GraphInterrupt.
   *
   * For dynamic interrupt() pauses:
   *   await graph.resume(threadId, new Command({ resume: 'approved' }))
   *
   * For static interruptBefore/After pauses (original behaviour):
   *   await graph.resume(threadId, { field: 'updated value' })
   *
   * @param {string}          threadId
   * @param {Command|object}  commandOrUpdate - Command with resume value, or plain state update
   * @param {object}          [config]
   */
  async resume(threadId, commandOrUpdate = {}, config = {}) {
    if (!this._checkpointer) {
      throw new Error(
        'CompiledGraph.resume() requires a checkpointer — compile with { checkpointer: new MemoryCheckpointer() }'
      );
    }
    const checkpoint = await this._checkpointer.load(threadId);
    if (!checkpoint) {
      throw new Error(`CompiledGraph.resume(): no checkpoint found for thread "${threadId}"`);
    }
    const resumeFrom = checkpoint.metadata?.resumeFrom;
    if (!resumeFrom) {
      throw new Error(
        `CompiledGraph.resume(): checkpoint for thread "${threadId}" has no resumeFrom. ` +
        `Was the graph compiled with interruptBefore/interruptAfter, or did a node call interrupt()?`
      );
    }

    const mergedConfig = {
      ...config,
      configurable: { threadId, ...(config?.configurable ?? {}) },
    };

    // Dynamic interrupt resume (Command with resume value)
    if (commandOrUpdate instanceof Command && commandOrUpdate.isResume) {
      const resumeValues = { [resumeFrom]: commandOrUpdate.resume };
      const state = { ...checkpoint.state };
      return this._runLoop(resumeFrom, state, checkpoint.step + 1, mergedConfig, resumeValues);
    }

    // Static interrupt resume (plain state update object)
    const stateUpdate = commandOrUpdate instanceof Command
      ? (commandOrUpdate.update ?? {})
      : commandOrUpdate;
    const state = this._mergeState(checkpoint.state, stateUpdate);
    return this._runLoop(resumeFrom, state, checkpoint.step + 1, mergedConfig);
  }

  // ── Time travel ────────────────────────────────────────────────────────────

  /**
   * Get the full checkpoint history for a thread, oldest first.
   *
   * @param {string} threadId
   * @returns {Promise<import('./checkpoint.js').Checkpoint[]>}
   */
  async getHistory(threadId) {
    if (!this._checkpointer) {
      throw new Error('CompiledGraph.getHistory() requires a checkpointer');
    }
    return this._checkpointer.list(threadId);
  }

  /**
   * Replay the graph from a specific checkpoint.
   * Nodes before the checkpoint are not re-executed; nodes after it are.
   *
   * @param {string} threadId     - Thread that owns the checkpoint
   * @param {string} checkpointId - The checkpoint.id to replay from
   * @param {object} [config]
   * @returns {Promise<object>} Final state
   */
  async replayFrom(threadId, checkpointId, config = {}) {
    const history = await this.getHistory(threadId);
    const ckpt    = history.find(c => c.id === checkpointId);
    if (!ckpt) {
      throw new Error(
        `CompiledGraph.replayFrom(): checkpoint "${checkpointId}" not found in thread "${threadId}"`
      );
    }
    const mergedConfig = {
      ...config,
      configurable: { threadId, ...(config?.configurable ?? {}) },
    };
    return this._runLoop(ckpt.node, { ...ckpt.state }, ckpt.step + 1, mergedConfig);
  }

  /**
   * Fork from a specific checkpoint into a new thread.
   * Optionally merge stateUpdate on top of the checkpoint state before re-running.
   * Produces a new thread with its own checkpoint history.
   *
   * @param {string} threadId       - Source thread
   * @param {string} checkpointId   - The checkpoint to fork from
   * @param {object} [stateUpdate]  - Optional state patch to apply before replaying
   * @param {string} [forkThreadId] - ID for the new thread (auto-generated if omitted)
   * @param {object} [config]
   * @returns {Promise<{ threadId: string, state: object }>}
   */
  async forkFrom(threadId, checkpointId, stateUpdate = {}, forkThreadId, config = {}) {
    const history = await this.getHistory(threadId);
    const ckpt    = history.find(c => c.id === checkpointId);
    if (!ckpt) {
      throw new Error(
        `CompiledGraph.forkFrom(): checkpoint "${checkpointId}" not found in thread "${threadId}"`
      );
    }
    const newThreadId  = forkThreadId ?? `${threadId}-fork-${Date.now()}`;
    const forkState    = this._mergeState(ckpt.state, stateUpdate);
    const mergedConfig = {
      ...config,
      configurable: { threadId: newThreadId, ...(config?.configurable ?? {}) },
    };
    const finalState = await this._runLoop(ckpt.node, forkState, ckpt.step + 1, mergedConfig);
    return { threadId: newThreadId, state: finalState };
  }

  // ── Streaming ──────────────────────────────────────────────────────────────

  /**
   * Stream graph execution step by step.
   *
   * Stream modes:
   *   'updates'  — yields { [nodeName]: update } after each node
   *   'values'   — yields full state snapshot after each node
   *   'messages' — yields [chunk, { langgraph_node }] for each LLM token
   *                (nodes must call config.streamTokens(chunk, metadata) to emit)
   *   'custom'   — yields events emitted via config.writer(data)
   *   string[]   — multi-mode: yields ['mode', data] tuples per active mode
   *
   * @example
   *   for await (const chunk of graph.stream(state, {
   *     streamMode: ['updates', 'messages'],
   *     configurable: { threadId: 'sess-1', maxConcurrency: 4 }
   *   })) {
   *     const [mode, data] = chunk;  // multi-mode
   *   }
   */
  async* _stream(initialState, config) {
    const recursionLimit = config?.recursionLimit ?? 25;
    const threadId       = config?.configurable?.threadId ?? 'default';
    const maxConcurrency = config?.configurable?.maxConcurrency ?? Infinity;

    const rawMode   = config?.streamMode ?? 'updates';
    const modes     = Array.isArray(rawMode) ? rawMode : [rawMode];
    const multiMode = modes.length > 1;

    let state = { ...initialState };
    const checkpoint = await this._loadCheckpoint(threadId);
    if (checkpoint && !checkpoint.metadata?.resumeFrom) {
      state = { ...checkpoint.state, ...initialState };
    }

    let currentNode = this._entryPoint;
    let step        = 0;

    // ── Custom event queue ─────────────────────────────────────────────────
    const customQueue = [];
    const writer = modes.includes('custom')
      ? (data) => customQueue.push(data)
      : undefined;

    // ── Messages (token) queue ─────────────────────────────────────────────
    const tokenQueue = [];
    const streamTokens = modes.includes('messages')
      ? (chunk, meta = {}) => tokenQueue.push([chunk, meta])
      : undefined;

    const nodeConfig = {
      ...config,
      writer,
      streamTokens,
      configurable: {
        ...(config?.configurable ?? {}),
        writer,
        streamTokens,
      },
    };

    function* flushCustom() {
      while (customQueue.length > 0) {
        const data = customQueue.shift();
        yield multiMode ? ['custom', data] : data;
      }
    }

    function* flushTokens(nodeName) {
      while (tokenQueue.length > 0) {
        const [chunk, meta] = tokenQueue.shift();
        const enriched = [chunk, { langgraph_node: nodeName, ...meta }];
        yield multiMode ? ['messages', enriched] : enriched;
      }
    }

    while (currentNode !== END) {
      if (step >= recursionLimit) {
        throw new Error(
          `CompiledGraph: recursion limit (${recursionLimit}) exceeded at node "${currentNode}".`
        );
      }

      const node = this._nodes.get(currentNode);
      if (!node) throw new Error(`CompiledGraph: node "${currentNode}" not found in graph`);

      yield* flushCustom();
      yield* flushTokens(currentNode);

      const interruptCtx = new InterruptContext();
      let update, command;
      try {
        ({ update, command } = await this._executeNode(node, state, nodeConfig, interruptCtx));
      } catch (err) {
        if (err instanceof GraphInterruptSignal) {
          if (!this._checkpointer) throw new Error(
            `CompiledGraph: dynamic interrupt() in stream requires a checkpointer (node "${currentNode}")`
          );
          await this._saveCheckpoint(threadId, currentNode, state, step, {
            resumeFrom: currentNode,
            __interruptIndex: err.index,
          });
          if (modes.includes('updates')) {
            const chunk = { __interrupt__: err.value };
            yield multiMode ? ['updates', chunk] : chunk;
          }
          throw new GraphInterrupt({
            threadId, node: currentNode, state: { ...state },
            resumeFrom: currentNode, step,
            interruptValue: err.value,
          });
        }
        throw err;
      }

      yield* flushTokens(currentNode);
      yield* flushCustom();

      if (update) state = this._mergeState(state, update);
      await this._saveCheckpoint(threadId, currentNode, state, step);

      if (modes.includes('updates')) {
        const chunk = { [currentNode]: update ?? null };
        yield multiMode ? ['updates', chunk] : chunk;
      }
      if (modes.includes('values')) {
        yield multiMode ? ['values', { ...state }] : { ...state };
      }

      const next = command?.hasGoto
        ? this._resolveCommandGoto(command.goto)
        : this._resolveNext(currentNode, state);

      // ── Parallel fan-out in stream mode ────────────────────────────────────
      if (Array.isArray(next)) {
        if (next.length === 0) { currentNode = END; continue; }

        const convergenceNode = this._resolveConvergence(next, currentNode);
        const sem = new Semaphore(maxConcurrency);

        const branchResults = await Promise.all(
          next.map(send => sem.run(async () => {
            const branchNode = this._nodes.get(send.node);
            if (!branchNode) throw new Error(
              `CompiledGraph: Send target "${send.node}" is not a registered node`
            );
            const branchState = this._mergeState(state, send.state);
            const branchCtx   = new InterruptContext();
            const { update: bu } = await this._executeNode(branchNode, branchState, nodeConfig, branchCtx);
            return { name: send.node, update: bu };
          }))
        );

        for (const { name: bName, update: bu } of branchResults) {
          yield* flushTokens(bName);
          yield* flushCustom();
          state = this._mergeState(state, bu);
          await this._saveCheckpoint(threadId, bName, state, step);
          if (modes.includes('updates')) {
            const chunk = { [bName]: bu ?? null };
            yield multiMode ? ['updates', chunk] : chunk;
          }
          if (modes.includes('values')) {
            yield multiMode ? ['values', { ...state }] : { ...state };
          }
          step++;
        }

        currentNode = convergenceNode;
        continue;
      }

      currentNode = next;
      step++;
    }
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  /** All node names registered in this graph. */
  get nodeNames() {
    return [...this._nodes.keys()];
  }

  /** The entry point node name. */
  get entryPoint() {
    return this._entryPoint;
  }

  /** Whether this graph runs in stateless mode (no checkpointing). */
  get isStateless() {
    return this._stateless;
  }
}

export default CompiledGraph;
