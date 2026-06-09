/**
 * StateGraph — builder for stateful cyclic graphs.
 *
 * A StateGraph defines nodes (computation units) connected by edges
 * (static) or conditional edges (dynamic routing). The graph is compiled
 * into a CompiledGraph, which is a Runnable that can be invoked, streamed,
 * or composed with .pipe().
 *
 * @module src/graph/state-graph.js
 */

import { GraphNode }         from './node.js';
import { ConditionalEdge }   from './conditional-edge.js';
import { CompiledGraph, END, START } from './compiled-graph.js';
import { MemoryCheckpointer } from './checkpointer/memory-checkpointer.js';

export { END, START };

export class StateGraph {
  /**
   * @param {object} [options]
   * @param {object} [options.stateSchema] - Default/initial state shape.
   *   Each key maps to either:
   *   - A plain default value:  { messages: [], query: '' }
   *   - A reducer spec:         { results: { default: [], reducer: (acc, val) => [...acc, ...val] } }
   *
   *   Reducer specs are used for fields that must accumulate across parallel
   *   branches (Send fan-out). Without a reducer, the last branch to write
   *   a field wins; with one, all branch updates are merged.
   */
  constructor({ stateSchema = {} } = {}) {
    // Parse stateSchema: separate plain defaults from { default, reducer } specs
    this._stateSchema = {};
    /** @type {Object<string, Function>} field → reducer(accumulated, incoming) */
    this._reducers    = {};

    for (const [key, spec] of Object.entries(stateSchema)) {
      if (
        spec !== null &&
        typeof spec === 'object' &&
        !Array.isArray(spec) &&
        'default' in spec &&
        typeof spec.reducer === 'function'
      ) {
        this._stateSchema[key] = spec.default;
        this._reducers[key]    = spec.reducer;
      } else {
        this._stateSchema[key] = spec;
      }
    }

    /** @type {Map<string, GraphNode>} */
    this._nodes              = new Map();
    /** @type {Map<string, string>} */
    this._edges              = new Map();
    /** @type {Map<string, ConditionalEdge[]>} */
    this._conditionalEdges   = new Map();
    this._entryPoint         = null;
    /** @type {Set<string>} */
    this._finishPoints       = new Set();
  }

  // ── Builder methods — all return `this` for chaining ──────────────────────

  /**
   * Register a node.
   *
   * @param {string}   name - Unique node name
   * @param {Function} fn   - async (state, config?) => partialStateUpdate | Command
   * @param {object}   [options]
   * @param {object|null} [options.retryPolicy] - Optional retry configuration:
   *   { maxAttempts?, delay?, backoff?, retryOn? }
   *   - maxAttempts: number (default 3) — total attempts including first
   *   - delay: number ms (default 1000) — initial delay between retries
   *   - backoff: 'fixed' | 'exponential' (default 'exponential')
   *   - retryOn: Error[] (default [Error]) — only retry these error classes
   * @returns {this}
   */
  addNode(name, fn, { retryPolicy } = {}) {
    if (this._nodes.has(name)) {
      throw new Error(`StateGraph: node "${name}" is already registered`);
    }
    if (name === END || name === START) {
      throw new Error(`StateGraph: "${name}" is a reserved name — use a different node name`);
    }
    this._nodes.set(name, new GraphNode(name, fn, retryPolicy ?? null));
    return this;
  }

  /**
   * Add a static edge: after `from` always go to `to`.
   * Only one static edge per source node is allowed.
   *
   * @param {string} from - Source node name (or START)
   * @param {string} to   - Destination node name (or END)
   * @returns {this}
   */
  addEdge(from, to) {
    if (from === END) {
      throw new Error('StateGraph: cannot add an edge from END');
    }
    // Treat START as an entry-point alias
    if (from === START) {
      return this.setEntryPoint(to);
    }
    if (this._edges.has(from)) {
      throw new Error(
        `StateGraph: node "${from}" already has a static edge to "${this._edges.get(from)}". ` +
        `Use addConditionalEdges() for multiple outgoing routes.`
      );
    }
    this._edges.set(from, to);
    return this;
  }

  /**
   * Add a conditional edge from `from`.
   * Multiple conditional edges can exist for the same source — they are
   * evaluated in registration order and the first non-null result wins.
   *
   * @param {string}      from        - Source node name
   * @param {Function}    conditionFn - (state) => nextNodeName | END | Send[]
   * @param {object|null} [pathMap]   - Optional { returnValue: nodeName } mapping
   * @returns {this}
   */
  addConditionalEdges(from, conditionFn, pathMap = null) {
    if (!this._conditionalEdges.has(from)) {
      this._conditionalEdges.set(from, []);
    }
    this._conditionalEdges.get(from).push(
      new ConditionalEdge(from, conditionFn, pathMap)
    );
    return this;
  }

  /**
   * Set the entry point — the first node executed on every run.
   * Can also be set by calling addEdge(START, nodeName).
   *
   * @param {string} nodeName
   * @returns {this}
   */
  setEntryPoint(nodeName) {
    this._entryPoint = nodeName;
    return this;
  }

  /**
   * Mark a node as a finish point.
   * When the graph reaches a finish point with no outgoing edges, it ends.
   * (In practice, most graphs just return END from a conditional edge instead.)
   *
   * @param {string} nodeName
   * @returns {this}
   */
  setFinishPoint(nodeName) {
    this._finishPoints.add(nodeName);
    return this;
  }

  // ── Compilation ────────────────────────────────────────────────────────────

  /**
   * Validate and compile the graph into a CompiledGraph Runnable.
   *
   * @param {object}   [options]
   * @param {import('./checkpointer/base-checkpointer.js').BaseCheckpointer|true|false|null} [options.checkpointer]
   *   Controls checkpointing and subgraph persistence when used as a subgraph node:
   *   - BaseCheckpointer instance → use this specific checkpointer
   *   - true  → auto-create a fresh MemoryCheckpointer (per-thread subgraph memory)
   *   - false → explicitly stateless (no checkpointing, interrupts not supported)
   *   - null/undefined → no checkpointer; can still support interrupts via parent graph
   *
   * @param {string[]} [options.interruptBefore] - Static: pause BEFORE these nodes (HITL)
   * @param {string[]} [options.interruptAfter]  - Static: pause AFTER these nodes (HITL)
   *   Static interrupts require a checkpointer. The caller catches GraphInterrupt,
   *   then calls compiledGraph.resume(threadId, stateUpdate) to continue.
   *   Dynamic interrupt() calls within node code work automatically regardless.
   *
   * @returns {CompiledGraph}
   */
  compile({ checkpointer, interruptBefore = [], interruptAfter = [] } = {}) {
    this._validate();

    let resolvedCheckpointer = null;
    let stateless = false;

    if (checkpointer === false) {
      stateless = true;
    } else if (checkpointer === true) {
      resolvedCheckpointer = new MemoryCheckpointer();
    } else {
      resolvedCheckpointer = checkpointer ?? null;
    }

    return new CompiledGraph({
      nodes:            this._nodes,
      edges:            this._edges,
      conditionalEdges: this._conditionalEdges,
      entryPoint:       this._entryPoint,
      finishPoints:     this._finishPoints,
      checkpointer:     resolvedCheckpointer,
      interruptBefore,
      interruptAfter,
      reducers:         this._reducers,
      stateless,
    });
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  _validate() {
    if (!this._entryPoint) {
      throw new Error(
        'StateGraph: entry point not set. Call setEntryPoint(nodeName) or addEdge(START, nodeName).'
      );
    }
    if (!this._nodes.has(this._entryPoint)) {
      throw new Error(
        `StateGraph: entry point "${this._entryPoint}" is not a registered node. ` +
        `Register it with addNode() first.`
      );
    }
    // Check all edges point to known nodes or END
    for (const [from, to] of this._edges) {
      if (to !== END && !this._nodes.has(to)) {
        throw new Error(
          `StateGraph: static edge "${from}" → "${to}" points to an unknown node`
        );
      }
    }
    // Check all conditional edge pathMaps (if provided) point to known nodes or END
    for (const [from, edges] of this._conditionalEdges) {
      for (const edge of edges) {
        if (edge._pathMap) {
          for (const [key, dest] of Object.entries(edge._pathMap)) {
            if (dest !== END && !this._nodes.has(dest)) {
              throw new Error(
                `StateGraph: conditional edge from "${from}" pathMap key "${key}" ` +
                `points to unknown node "${dest}"`
              );
            }
          }
        }
      }
    }
  }

  /** Default state derived from stateSchema (resolved plain values, no reducer specs). */
  get defaultState() {
    return { ...this._stateSchema };
  }
}

export default StateGraph;
