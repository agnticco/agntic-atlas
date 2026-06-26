/**
 * FlowTester — execute a draft workflow definition step-by-step and emit
 * per-node events so the UI can animate the run.
 *
 * Node types supported in MVP
 * ───────────────────────────
 *   trigger  — yields immediately; starting point
 *   fetch    — calls a SourceRegistry fetcher with node.config
 *   tool     — calls a ToolRegistry tool by name with node.config.args
 *   llm      — invokes the LLM with node.config.prompt (substituting {{prev}})
 *   deliver  — stub that echoes prior output (real delivery is Phase 2)
 *   branch   — not executed; router (control flow)
 *   loop     — not executed; iteration (control flow)
 *
 * Execution is single-threaded topological order. If no explicit edges match,
 * the tester runs nodes in declaration order.
 *
 * @module src/workflows/flow-tester.js
 */

// Note: node types import SystemMessage/HumanMessage themselves now that
// each type's executor lives in its own module.

import { withTimeout } from '../utils/with-timeout.js';

export class FlowTester {
  /**
   * @param {object} options
   * @param {import('./source-registry.js').SourceRegistry} [options.sourceRegistry]
   * @param {import('./workflow-scheduler.js').WorkflowScheduler} [options.scheduler]  — used for preview fetches
   * @param {import('../tools/tool-registry.js').ToolRegistry} [options.tools]
   * @param {object} [options.llm]  — LLM instance for `llm` nodes
   * @param {import('./channel-registry.js').ChannelRegistry}  [options.channelRegistry]
   * @param {import('./node-type-registry.js').NodeTypeRegistry} [options.nodeTypes] — required for execution
   */
  constructor({ sourceRegistry, scheduler, tools, llm, channelRegistry, nodeTypes } = {}) {
    this.sourceRegistry  = sourceRegistry;
    this.scheduler       = scheduler;
    this.tools           = tools;
    this.llm             = llm;
    this.channelRegistry = channelRegistry;
    this.nodeTypes       = nodeTypes;
  }

  /**
   * Run a flow definition. Yields events as an async generator:
   *   { type: 'run_started', runId }
   *   { type: 'step_started', nodeId, label }
   *   { type: 'step_completed', nodeId, output, durationMs }
   *   { type: 'step_failed', nodeId, error }
   *   { type: 'run_completed', output }
   *   { type: 'run_failed', error }
   *
   * @param {object} flow — { nodes: [...], edges: [...] }
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {string}      [options.runId]       — used as the cost-attribution sessionId
   *                                              so the CostTracker can report this run's
   *                                              tokens/USD in isolation.
   * @param {string}      [options.costContext] — label for the cost ledger (e.g. a slug)
   */
  async* run(flow, options = {}) {
    const nodes = flow.nodes ?? [];
    const edges = flow.edges ?? [];
    const order = this._topoSort(nodes, edges);
    const outputs = new Map();
    // Allow a caller (e.g. the scheduler's email-trigger path) to inject an
    // initial value that downstream nodes see as ctx.lastOutput before any
    // node has run. This is how a fetched email becomes the input to a
    // summarize or deliver node without a separate fetch step in the spec.
    let lastOutput = options.initialContext ?? null;

    // Reverse adjacency + transitive-ancestor resolver. Transform nodes
    // (summarize/rewrite/extract) and deliver use this so they can gather
    // ALL upstream content-producing outputs — not just the immediately
    // preceding node's output. Without it, a linear chain of four searches
    // feeding a summarize only ever exposes the LAST search to summarize
    // (the rest are silently dropped). See workflows delivery-threading fix.
    const parents = new Map();
    for (const e of edges) {
      if (!e || !e.to || !e.from) continue;
      if (!parents.has(e.to)) parents.set(e.to, new Set());
      parents.get(e.to).add(e.from);
    }
    const ancestorsOf = (nodeId) => {
      const seen = new Set();
      const stack = [...(parents.get(nodeId) ?? [])];
      while (stack.length) {
        const p = stack.pop();
        if (seen.has(p)) continue;
        seen.add(p);
        for (const pp of (parents.get(p) ?? [])) stack.push(pp);
      }
      return seen;
    };

    const runId = options.runId ?? `test-${Date.now()}`;
    const costConfig = {
      configurable: {
        sessionId:   `flow-run-${runId}`,
        costContext: options.costContext ?? 'workflow',
      },
    };

    yield { type: 'run_started', runId };

    for (const node of order) {
      if (options.signal?.aborted) {
        yield { type: 'run_failed', error: 'aborted' };
        return;
      }

      yield { type: 'step_started', nodeId: node.id, label: node.label ?? node.type };
      const t0 = Date.now();

      try {
        // Tag per-node cost context so the CostTracker can attribute
        // tokens/USD to individual steps later (used by the run-detail view).
        const nodeCostConfig = {
          configurable: {
            ...(costConfig.configurable ?? {}),
            costContext: `${costConfig.configurable?.costContext ?? 'workflow'}:${node.id}`,
          },
        };
        // Ordered list of this node's transitive-ancestor outputs available
        // so far (topo order). Lets summarize/rewrite/extract aggregate every
        // upstream content producer, and lets deliver know whether real
        // content exists upstream before honoring a static body.
        const ancIds = ancestorsOf(node.id);
        const ancestorOutputs = order
          .filter(n => ancIds.has(n.id) && outputs.has(n.id))
          .map(n => ({
            id:    n.id,
            label: n.label ?? n.id,
            type:  n.type,
            output: outputs.get(n.id),
          }));
        // Per-node timeout backstop: a hung external call (connector HTTP with no
        // socket timeout, a stalled fetch) must fail the step, not stall the whole
        // run forever. Generous default so slow-but-progressing LLM/web_search calls
        // aren't cut; a node's own configured timeout (e.g. llm) fires first, with
        // 30s headroom under this backstop. Env-tunable via NODE_RUN_TIMEOUT_MS.
        const backstopMs   = Number(process.env.NODE_RUN_TIMEOUT_MS ?? 180_000);
        const nodeTimeout  = Math.max(backstopMs, Number(node.config?.timeoutMs ?? 0) + 30_000);
        const output = await withTimeout(
          this._runNode(node, { outputs, lastOutput, costConfig: nodeCostConfig, ancestorOutputs }),
          nodeTimeout,
          `node ${node.id} (${node.type})`,
        );
        outputs.set(node.id, output);
        lastOutput = output;
        yield {
          type: 'step_completed',
          nodeId: node.id,
          output: this._shrinkOutput(output),
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        yield {
          type: 'step_failed',
          nodeId: node.id,
          error: err.message ?? String(err),
          durationMs: Date.now() - t0,
        };
        yield { type: 'run_failed', error: `${node.id}: ${err.message ?? err}` };
        return;
      }
    }

    // run_completed carries the FULL output (not shrunk) — this is what the
    // Inbox/persistence layer reads. Per-step events still get shrunk because
    // they repeat many times per run and can flood the UI.
    yield { type: 'run_completed', output: lastOutput };
  }

  // ── Node execution ────────────────────────────────────────────────────────

  async _runNode(node, ctx) {
    const type = node.type ?? 'noop';
    // Substitute template variables ({{prev}}, {{date}}, etc.) across the full
    // node config so every type's run() sees resolved strings.
    const cfg  = this._substitute(node.config ?? {}, ctx);

    if (!this.nodeTypes) throw new Error('FlowTester constructed without a NodeTypeRegistry');
    const def = this.nodeTypes.get(type);
    if (!def) {
      throw new Error(`Node type "${type}" is not registered in this build. Known types: ${this.nodeTypes.typeIds().join(', ')}.`);
    }

    // Services made available to every node executor. Each type uses only
    // what it needs (trigger uses none; deliver uses channelRegistry; etc.).
    const services = {
      llm:             this.llm,
      tools:           this.tools,
      sourceRegistry:  this.sourceRegistry,
      channelRegistry: this.channelRegistry,
      scheduler:       this.scheduler,
    };
    // Expose the RAW (pre-substitution) config so a node can tell a
    // templated field from a static one. deliver uses rawConfig.body to
    // know whether the author explicitly composed the delivered content
    // (template) vs left a static description that must NOT shadow real
    // upstream output. Per-node shallow copy — never mutate shared ctx.
    const nodeCtx = { ...ctx, rawConfig: node.config ?? {} };
    return await def.run(cfg, nodeCtx, services);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Kahn's algorithm topological sort. Falls back to declaration order when
   * the graph has cycles or disconnected pieces.
   */
  _topoSort(nodes, edges) {
    const indeg = new Map(nodes.map(n => [n.id, 0]));
    const adj   = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) {
      if (!adj.has(e.from) || !indeg.has(e.to)) continue;
      adj.get(e.from).push(e.to);
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
    const queue = nodes.filter(n => (indeg.get(n.id) ?? 0) === 0).map(n => n.id);
    const order = [];
    const byId = new Map(nodes.map(n => [n.id, n]));

    while (queue.length) {
      const id = queue.shift();
      const node = byId.get(id);
      if (node) order.push(node);
      for (const next of (adj.get(id) ?? [])) {
        const d = (indeg.get(next) ?? 0) - 1;
        indeg.set(next, d);
        if (d === 0) queue.push(next);
      }
    }

    if (order.length !== nodes.length) {
      // Cycle or missing edge target — fall back to declaration order
      return [...nodes];
    }
    return order;
  }

  /**
   * Template substitution. Supports:
   *   {{prev}}              — prior node's output
   *   {{nodeId.output}}     — a specific node's output
   *   {{date}}              — current date (YYYY-MM-DD)
   *   {{time}}              — current time (HH:MM, 24h)
   *   {{datetime}}          — ISO timestamp
   *   {{year}} {{month}} {{day}}
   * Operates recursively on objects and arrays.
   */
  _substitute(value, ctx) {
    if (typeof value === 'string') {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const vars = {
        date:     now.toISOString().slice(0, 10),
        time:     `${pad(now.getHours())}:${pad(now.getMinutes())}`,
        datetime: now.toISOString(),
        year:     String(now.getFullYear()),
        month:    pad(now.getMonth() + 1),
        day:      pad(now.getDate()),
      };
      return value
        .replace(/\{\{\s*prev\s*\}\}/g, () => this._stringifyForDelivery(ctx.lastOutput))
        .replace(/\{\{\s*([a-z0-9_-]+)\.output\s*\}\}/gi, (_, id) =>
          this._stringifyForDelivery(ctx.outputs.get(id))
        )
        .replace(/\{\{\s*(date|time|datetime|year|month|day)\s*\}\}/gi, (_, key) => vars[key.toLowerCase()] ?? '');
    }
    if (Array.isArray(value)) return value.map(v => this._substitute(v, ctx));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this._substitute(v, ctx);
      return out;
    }
    return value;
  }

  _stringifyForDelivery(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && 'text' in v) return v.text;
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  /** Cap large outputs so SSE events stay small. Full output is stored in run.output. */
  _shrinkOutput(v, limit = 2000) {
    if (v == null) return null;
    const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
    return s.length > limit ? s.slice(0, limit) + '\n…(truncated)' : s;
  }
}
