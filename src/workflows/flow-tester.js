/**
 * FlowTester — execute a draft workflow definition step-by-step and emit
 * per-node events so the UI can animate the run.
 *
 * Node types are not listed here — they are whatever the NodeTypeRegistry holds
 * (src/workflows/node-types/index.js), and _runNode dispatches to the type's own
 * run(). The registry is the source of truth; a list here would only go stale.
 *
 * v1 nodes are lifted to their v2 shape in _runNode, so specs written before the
 * P12 node re-cut still execute unmigrated. See ./node-types/compat-v1.js.
 *
 * Execution is single-threaded topological order. If no explicit edges match,
 * the tester runs nodes in declaration order.
 *
 * @module src/workflows/flow-tester.js
 */

// Note: node types import SystemMessage/HumanMessage themselves now that
// each type's executor lives in its own module.

import { withTimeout } from '../utils/with-timeout.js';
import { numEnv } from '../utils/env.js';
import { liftV1Node } from './node-types/compat-v1.js';
import { buildAsk } from './node-types/human.js';

/**
 * Control nodes. Their output is routing/audit metadata, not the work product,
 * so they never become `lastOutput` — which is what `deliver` sends.
 */
const CONTROL_TYPES = new Set(['branch', 'human']);

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
  constructor({ sourceRegistry, scheduler, tools, llm, channelRegistry, nodeTypes, idempotencyStore = null } = {}) {
    // Optional: only needed by specs that declare an `idempotency` attribute. A
    // node that declares one with no store wired throws rather than silently
    // failing to deduplicate (see _executeNode).
    this.idempotencyStore = idempotencyStore;
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
   *   { type: 'step_skipped',  nodeId, reason }        — a branch didn't select it
   *   { type: 'run_paused',    nodeId, ask }           — a `human` step is waiting
   *
   * @param {object} flow — { nodes: [...], edges: [...] }
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {string}      [options.runId]       — used as the cost-attribution sessionId
   *                                              so the CostTracker can report this run's
   *                                              tokens/USD in isolation.
   * @param {string}      [options.costContext] — label for the cost ledger (e.g. a slug)
   * @param {object}      [options.checkpoint]  — resume state from a paused run
   *                                              (workflow_runs.checkpoint): full-fidelity
   *                                              {outputs, skipped, live, ruledOut, lastOutput}.
   *                                              NOT workflow_runs.steps — those carry the
   *                                              display-shrunk event stream and resuming from
   *                                              them delivers truncated content.
   * @param {object}      [options.decisions]   — { [humanNodeId]: { decision, by, at, channel } }
   *                                              the answers that unblock paused `human` steps.
   */
  async* run(flow, options = {}) {
    const nodes = flow.nodes ?? [];
    const edges = flow.edges ?? [];
    const order = this._topoSort(nodes, edges);
    const outputs = new Map();

    // ── Resume (§7.4) ────────────────────────────────────────────────────────
    // A paused run holds no compute. To continue it, we rehydrate from a
    // CHECKPOINT the run emitted when it paused — no StateGraph checkpointer,
    // because the DAG is deterministic and the checkpoint is a plain object.
    //
    // THE CHECKPOINT IS NOT THE PERSISTED STEP EVENTS. That was the original
    // design, and it was wrong in a way that quietly corrupted the work product:
    // `step_completed` carries a DISPLAY-SHRUNK output (_shrinkOutput truncates
    // at 2000 chars and appends "…(truncated)", and JSON-encodes objects) so the
    // event stream doesn't flood the UI. Resuming from that meant:
    //
    //   • a 3363-char drafted email came back as 2013 chars ending in
    //     "…(truncated)" — the person approved one thing and the CUSTOMER GOT A
    //     DIFFERENT, MUTILATED ONE, with no error and no warning; and
    //   • every object output came back as a JSON string, so a downstream
    //     {{step.output}} or a channel handler reading `.text` got a blob.
    //
    // 2000 characters is about 400 words. A routine drafted reply exceeds it. So
    // the shrink stays where it belongs — the event stream, for the UI — and the
    // checkpoint carries the FULL, un-shrunk values. It is written once, on
    // pause, so it costs nothing on the runs that never pause.
    // The checkpoint also carries the EDGE LIVENESS as it stood at the pause, and
    // that is not a detail — it is the whole reason this is correct.
    //
    // The first design re-DERIVED liveness on resume by replaying propagate() for
    // every already-done node. That is wrong, because propagate() lights ALL of a
    // node's outgoing edges, while the original leg may have lit only SOME of them:
    //
    //   • a `branch` lights exactly one case — so replay revived the path it ruled out;
    //   • an `on_error: route_to` step lights ONLY the error target — so replay
    //     revived the HAPPY path of a step that had failed, and the run went on to
    //     deliver as though the failure never happened.
    //
    // Liveness is a fact about what happened, not something to recompute from
    // outputs. So the checkpoint RESTORES it, and replayed nodes propagate nothing.
    const decisions   = options.decisions ?? {};
    const doneOutputs = new Set();   // ran before the pause — don't re-run, don't re-propagate
    // Ruled out before the pause. What keeps these nodes DEAD across the resume is
    // the restored liveness (nothing lit them, so liveInto stays 0) — NOT this
    // set. Its only job is to avoid emitting a second `step_skipped` for a node
    // already recorded as skipped, which would otherwise be appended to
    // `workflow_runs.steps` twice.
    const doneSkipped = new Set();
    const ckpt = options.checkpoint ?? null;
    if (ckpt) {
      for (const [id, out] of Object.entries(ckpt.outputs ?? {})) {
        outputs.set(id, out);
        doneOutputs.add(id);
      }
      for (const id of (ckpt.skipped ?? [])) doneSkipped.add(id);
    }
    // Allow a caller (e.g. the scheduler's email-trigger path) to inject an
    // initial value that downstream nodes see as ctx.lastOutput before any
    // node has run. This is how a fetched email becomes the input to a
    // summarize or deliver node without a separate fetch step in the spec.
    let lastOutput = ckpt?.lastOutput ?? options.initialContext ?? null;

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

    // ── Edge liveness — conditional execution (§4) ───────────────────────────
    // A node is SKIPPED iff it has at least one incoming edge and NONE of them
    // is live. An edge goes live when its source completes — EXCEPT out of a
    // `branch`, where only the selected case's edge goes live.
    //
    // This is an edge-level model, not the node-level `active` set §4 sketches,
    // because a node-level set gets JOINS wrong: a node downstream of both the
    // taken and the untaken path would be wrongly skipped. With edges, a join
    // runs as soon as ONE incoming edge is live, which is the correct semantics
    // and the one BPMN uses.
    //
    // It is also why §11.2 holds STRUCTURALLY rather than by promise: with no
    // `branch` in the spec, every edge goes live the instant its source
    // completes, nothing is ever skipped, and this loop reduces to the old one.
    const byId     = new Map(nodes.map(n => [n.id, n]));
    const outEdges = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) {
      if (!e?.from || !e?.to) continue;
      if (outEdges.has(e.from)) outEdges.get(e.from).push(e.to);
    }
    const hasIncoming = new Set(edges.filter(e => e?.to).map(e => e.to));
    // Restored from the checkpoint on a resume — never re-derived. See the note
    // in the resume block above.
    const liveInto = new Map(nodes.map(n => [n.id, ckpt?.live?.[n.id] ?? 0]));

    // Nodes a branch explicitly ruled out. Liveness alone isn't quite enough: if
    // an untaken case target ALSO has an edge from some earlier node, that edge
    // is live and the node would run anyway — the branch would have decided
    // nothing. So a ruled-out target is dead regardless of its other parents.
    // (The validator rejects that shape outright — BRANCH_TARGET_EXTRA_PARENT —
    // but the engine must not depend on the validator having run: specs already
    // in the database were saved before the rule existed.)
    const ruledOut = new Set(ckpt?.ruledOut ?? []);

    /** Light up this node's outgoing edges. A branch lights only the case it picked. */
    const propagate = (nodeId, output) => {
      const isBranch = byId.get(nodeId)?.type === 'branch';
      let selected = null;
      if (isBranch) {
        // Be robust to a stringified output (a resumed run rehydrates from the
        // SHRUNK step events). If we cannot read the selection we must NOT fall
        // back to "light everything" — that would run the path the branch ruled
        // out. Fail the run instead: a branch whose decision we cannot recover is
        // not a branch, and silently taking every path is the worst possible
        // answer to "which way did it go?".
        const decoded = typeof output === 'string' ? tryParseJson(output) : output;
        selected = decoded?.to ?? null;
        if (!selected) {
          throw new Error(
            `branch "${nodeId}" produced no route (got: ${JSON.stringify(output)?.slice(0, 120)}). ` +
            'Refusing to continue — taking every path would run the branch that was ruled out.',
          );
        }
      }
      for (const target of (outEdges.get(nodeId) ?? [])) {
        if (selected !== null && target !== selected) {
          ruledOut.add(target);   // the untaken path is dead, not merely unlit
          continue;
        }
        liveInto.set(target, (liveInto.get(target) ?? 0) + 1);
      }
    };

    yield { type: 'run_started', runId };

    for (const node of order) {
      if (options.signal?.aborted) {
        yield { type: 'run_failed', error: 'aborted' };
        return;
      }

      // Ruled out BEFORE the pause. It stays dark and relights nothing — its
      // children must not come back to life just because the run was resumed.
      // (This is the half that let a rejected draft get sent on resume.)
      if (doneSkipped.has(node.id)) {
        ruledOut.add(node.id);
        continue;
      }

      // Not selected by an upstream branch (or every path into it died).
      if (ruledOut.has(node.id) || (hasIncoming.has(node.id) && (liveInto.get(node.id) ?? 0) === 0)) {
        doneSkipped.add(node.id);
        yield { type: 'step_skipped', nodeId: node.id, reason: 'not on the selected branch' };
        continue;   // its own outgoing edges stay dark
      }

      // Already ran, in the part of this run that happened before the pause.
      // Don't re-run it — but DO relight its edges, so the graph downstream of
      // the pause knows which paths are live. For a branch, that relights ONLY
      // the case it originally picked (propagate decodes the persisted output).
      if (doneOutputs.has(node.id)) {
        // Deliberately does NOT propagate. The edges this node lit — which may be
        // only SOME of its outgoing edges, if it is a branch or it failed with
        // route_to — were restored from the checkpoint. Re-lighting them here is
        // what revived ruled-out branches and the happy paths of failed steps.
        // Do NOT recompute `lastOutput` while replaying already-done nodes. The
        // checkpoint's own `lastOutput` is what the original leg actually had at
        // the moment it paused, and it is authoritative — recomputing it from
        // `outputs` re-derives it from values the original leg deliberately never
        // promoted. Concretely: an `on_error: route_to` step stores the sentinel
        // {error, failed:true} into `outputs` but never makes it `lastOutput`
        // (the catch block doesn't touch it). Replaying it as `lastOutput` — it
        // is an `llm` node, so CONTROL_TYPES doesn't exclude it — meant a
        // `deliver` after the pause sent the customer the raw error blob
        // {"error":"LLM step failed: card declined","failed":true}, with
        // run_completed and no error. Same spec, same failure, only difference
        // being a `human` step in between.
        continue;
      }

      // ── The durable pause (§7.4) ──────────────────────────────────────────
      // A `human` step with no answer yet stops the run here. Everything already
      // computed is persisted by the caller (the scheduler appends every step),
      // and the run holds NO compute while it waits — a pending approval is free.
      if (node.type === 'human' && !decisions[node.id]) {
        const askCfg = this._substitute(node.config ?? {}, { outputs, lastOutput });
        yield {
          type: 'run_paused',
          nodeId: node.id,
          ask: buildAsk(node, askCfg),
          // THE CHECKPOINT — full fidelity, NOT the shrunk step events. This is
          // what the run resumes on, so the content the person approves is the
          // content that actually gets sent. See the note at the top of run().
          checkpoint: {
            outputs:  Object.fromEntries(outputs),
            skipped:  [...doneSkipped],
            // The edge liveness AS IT STOOD, not something to recompute later.
            live:     Object.fromEntries(liveInto),
            ruledOut: [...ruledOut],
            lastOutput,
          },
        };
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
        const backstopMs   = numEnv('NODE_RUN_TIMEOUT_MS', 180_000);
        // Slow external steps (web search, multi-page fetch, connector HTTP) need
        // more headroom than in-process transforms — a real web_search + synthesis
        // can exceed 180s and shouldn't fail the run (S7-2). Give them at least 300s.
        // The registered type id is `search_web` (underscore). This read
        // 'search-web' — a hyphen that matched nothing — so a web-search step
        // silently got the short timeout instead of the long one. `fetch` was
        // deleted in the P12 node re-cut.
        const isSlowExternal = node.type === 'connector-action' || node.type === 'search_web';
        const effectiveBackstop = isSlowExternal ? Math.max(backstopMs, 300_000) : backstopMs;
        const nodeTimeout  = Math.max(effectiveBackstop, Number(node.config?.timeoutMs ?? 0) + 30_000);

        const nodeCtx = {
          outputs, lastOutput,
          costConfig: nodeCostConfig,
          ancestorOutputs,
          humanDecision: decisions[node.id] ?? null,
        };

        // ── on_error: retry ───────────────────────────────────────────────
        // `retry` is the number of EXTRA attempts, so retry:2 => up to 3 tries.
        // Matches workflow.error_handling.retry.attempts (the scheduler's
        // whole-run retry, P7) — same word, same meaning, one level down.
        const policy   = node.on_error ?? {};
        const attempts = Math.max(0, Math.floor(Number(policy.retry ?? 0))) + 1;

        let output, lastErr = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            output = await withTimeout(
              this._executeNode(node, nodeCtx, { runId, workflowId: options.workflowId }),
              nodeTimeout,
              `node ${node.id} (${node.type})`,
            );
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < attempts) {
              yield {
                type: 'step_retry', nodeId: node.id, attempt,
                of: attempts, error: err.message ?? String(err),
              };
              const delayMs = Math.max(0, Number(policy.retry_delay_ms ?? 0));
              if (delayMs) await new Promise(r => setTimeout(r, delayMs));
            }
          }
        }
        if (lastErr) throw lastErr;

        outputs.set(node.id, output);
        // A CONTROL node must not become `lastOutput`. A branch's output is
        // {value, matched, to} and a human's is {decision, by, at, channel} —
        // routing and audit metadata, not the work product. `deliver` sends
        // `ctx.lastOutput`, so leaving them in means the step after an approval
        // delivers the literal {"decision":"approve",…} to the customer instead
        // of the reply they approved. `lastOutput` means "the last CONTENT".
        // Restricted to the two types added in this increment, so no existing
        // spec's behaviour can change (§11.2).
        if (!CONTROL_TYPES.has(node.type)) lastOutput = output;
        propagate(node.id, output);
        yield {
          type: 'step_completed',
          nodeId: node.id,
          output: this._shrinkOutput(output),
          durationMs: Date.now() - t0,
        };
      } catch (err) {
        const message = err.message ?? String(err);
        yield {
          type: 'step_failed',
          nodeId: node.id,
          error: message,
          durationMs: Date.now() - t0,
        };

        // ── on_error: then ────────────────────────────────────────────────
        const then = node.on_error?.then;

        // `route_to:<id>` — a declared failure path. The run does NOT die; it
        // continues down the error branch (e.g. to a human step, or a Slack
        // "this broke" delivery). Only that edge is lit, so the happy path
        // downstream stays dark.
        if (typeof then === 'string' && then.startsWith('route_to:')) {
          const target = then.slice('route_to:'.length).trim();
          if (byId.has(target)) {
            liveInto.set(target, (liveInto.get(target) ?? 0) + 1);
            outputs.set(node.id, { error: message, failed: true });
            yield { type: 'step_routed', nodeId: node.id, to: target, error: message };
            continue;
          }
          yield { type: 'run_failed', error: `${node.id}: ${message} (on_error.route_to named "${target}", which is not a step)` };
          return;
        }

        // `escalate` — the run still fails, but it is MARKED as needing a person
        // rather than dying quietly in a log. Increment D turns this flag into a
        // real Approvals-inbox item; until then it is an honest, visible failure.
        // It deliberately does NOT pause: a pause nobody can answer is a hang,
        // and the answering surface is D's job.
        if (then === 'escalate') {
          yield { type: 'run_failed', error: `${node.id}: ${message}`, escalated: true };
          return;
        }

        yield { type: 'run_failed', error: `${node.id}: ${message}` };
        return;
      }
    }

    // run_completed carries the FULL output (not shrunk) — this is what the
    // Inbox/persistence layer reads. Per-step events still get shrunk because
    // they repeat many times per run and can flood the UI.
    yield { type: 'run_completed', output: lastOutput };
  }

  // ── Node execution ────────────────────────────────────────────────────────

  /**
   * Run a node, honouring its `idempotency` attribute (§2.2).
   *
   *   idempotency: { key: "{{extract.email}}", on_conflict: "skip"|"update"|"error" }
   *
   * The problem it solves: a trigger re-fires (Gmail redelivers, a webhook is
   * retried, the operator re-runs a workflow) and the connector action runs a
   * SECOND time — creating a duplicate Airtable record, sending the customer a
   * second email. Nothing in the engine prevented that; the key does.
   *
   * `skip` (the default) is the safe one: on a repeat key the node does not run
   * at all and the FIRST run's output is returned, so downstream steps still see
   * a record and the workflow completes normally. `update` re-runs (for actions
   * that upsert). `error` fails loudly.
   *
   * A node that declares idempotency with no store wired is an ERROR, not a
   * silent no-op — pretending to deduplicate is worse than not claiming to.
   */
  async _executeNode(node, ctx, { workflowId } = {}) {
    const idem = node.idempotency;
    if (!idem?.key) return await this._runNode(node, ctx);

    if (!this.idempotencyStore) {
      throw new Error(
        `step "${node.id}" declares idempotency but no idempotency store is wired into the executor. ` +
        'Refusing to run — a step that claims to deduplicate and does not is worse than one that never claimed to.',
      );
    }

    const key = String(this._substitute(String(idem.key), ctx) ?? '').trim();
    if (!key) {
      throw new Error(`step "${node.id}" has an idempotency key that resolved to nothing (${idem.key}).`);
    }
    const scope      = `${workflowId ?? 'unscoped'}:${node.id}`;
    const onConflict = idem.on_conflict ?? 'skip';
    const prior      = this.idempotencyStore.get(scope, key);

    if (prior) {
      if (onConflict === 'error') {
        throw new Error(`step "${node.id}" has already run for "${key}" (idempotency on_conflict: error).`);
      }
      if (onConflict !== 'update') return prior.output;   // 'skip' — do not run again
    }

    const output = await this._runNode(node, ctx);
    this.idempotencyStore.put(scope, key, output);
    return output;
  }

  async _runNode(rawNode, ctx) {
    // Lift v1 nodes to their v2 shape (summarize/extract/rewrite → llm + mode,
    // daily_digest → assemble). Specs written before the P12 node re-cut are
    // still in the database, unmigrated, and must keep running untouched — this
    // and WorkflowValidator.validate() are the only two places that lift. The
    // scheduler and the REST run path both execute through here, so this one
    // call site covers every way a workflow runs. See ./node-types/compat-v1.js.
    const node = liftV1Node(rawNode);
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
      // `foreach` executes its per-item steps through this — the SAME dispatch
      // every other node goes through (template substitution, the v1 lift, the
      // node registry), so a step inside a loop behaves exactly like one
      // outside it. A separate mini-executor would drift.
      runSubNode:      (subNode, subCtx) => this._runNode(subNode, subCtx),
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
        // {{item}} / {{index}} — the current element inside a `foreach`. Only
        // bound within a loop; the validator rejects them anywhere else, so an
        // empty substitution here means a bug upstream, not a silent default.
        .replace(/\{\{\s*item\s*\}\}/gi, () => this._stringifyForDelivery(ctx.item))
        .replace(/\{\{\s*index\s*\}\}/gi, () => (ctx.index == null ? '' : String(ctx.index)))
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

/**
 * Decode a JSON string, or return undefined. Used to recover a `branch`'s
 * routing decision from a resumed run, where the persisted step_completed event
 * carries the SHRUNK (JSON-encoded) output rather than the live object.
 */
function tryParseJson(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}
