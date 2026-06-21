/**
 * WorkflowScheduler — Tick loop that runs due workflows.
 *
 * Checks every TICK_INTERVAL_MS (default 60s) for workflows whose schedule
 * time has passed and haven't run today. Executes them by loading the source
 * fetcher and storing the output.
 *
 * iter-8: every terminal run (success or error) writes a `workflow_run` row
 * to the unified outputs log via metricsStore.recordOutput. The `trigger`
 * arg threads through runNow / _execute / _executeFlow / _executeFetch so
 * the row records what kicked it off (`scheduled` / `manual` / `chat`).
 *
 * @module src/workflows/workflow-scheduler.js
 */

import { log } from '../utils/logger.js';
import { translateError } from './error-translator.js';
import { validateRunOutput } from './output-validator.js';

const TICK_INTERVAL_MS = 60_000;

/**
 * iter-9: map our internal `trigger` field to the top-level `source_surface`
 * column Core's wide-schema pivot groups on. Canonical mapping from the brief.
 */
const SURFACE_BY_TRIGGER = {
  manual:    'api',
  scheduled: 'scheduled',
  chat:      'chat',
};

export class WorkflowScheduler {
  /**
   * @param {object} options
   * @param {import('./workflow-store.js').WorkflowStore} options.workflowStore
   * @param {import('./source-registry.js').SourceRegistry} options.sourceRegistry
   * @param {object} [options.fetchers] — map of fetch_module name → { fetch } module
   * @param {import('./flow-tester.js').FlowTester} [options.flowTester] — DAG executor for flow-kind workflows
   * @param {import('../llm/cost-tracker.js').CostTracker} [options.costTracker] — shared cost ledger
   * @param {import('../observability/metrics-store.js').MetricsStore} [options.metricsStore] — unified outputs log (iter-8)
   * @param {number} [options.tickInterval] — ms between checks (default 60s)
   */
  constructor({ workflowStore, sourceRegistry, fetchers = {}, flowTester = null, costTracker = null, metricsStore = null, tickInterval = TICK_INTERVAL_MS } = {}) {
    this.workflowStore  = workflowStore;
    this.sourceRegistry = sourceRegistry;
    this.fetchers       = fetchers;
    this.flowTester     = flowTester;
    this.costTracker    = costTracker;
    this.metricsStore   = metricsStore;
    this.tickInterval   = tickInterval;
    this._timer         = null;
    this._running       = false;
  }

  /** Start the tick loop. */
  start() {
    if (this._timer) return;
    log.info(`[workflow-scheduler] started (tick every ${this.tickInterval / 1000}s)`);
    // Run immediately on start, then on interval
    this._tick();
    this._timer = setInterval(() => this._tick(), this.tickInterval);
  }

  /** Stop the tick loop. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    log.info('[workflow-scheduler] stopped');
  }

  /** Register a fetcher module at runtime. */
  registerFetcher(name, fetcherModule) {
    this.fetchers[name] = fetcherModule;
  }

  /** Single tick — find and execute all due workflows + poll email triggers. */
  async _tick() {
    if (this._running) return; // prevent overlapping ticks
    this._running = true;

    try {
      // 1. Schedule-triggered workflows (existing behaviour).
      const due = this.workflowStore.getDue();
      if (due.length > 0) {
        log.info(`[workflow-scheduler] ${due.length} workflow(s) due`);
        for (const workflow of due) {
          await this._execute(workflow);
        }
      }

      // 2. Email-triggered workflows — poll Gmail for each active flow with
      //    an `email` trigger type. Requires the gmail poll function to be
      //    registered via registerEmailPoller().
      if (this._pollEmail) {
        const emailFlows = this.workflowStore.list({ kind: 'flow', status: 'active' })
          .filter((w) => (w.triggers ?? []).some((t) => t.type === 'email'));
        for (const workflow of emailFlows) {
          try {
            const newEmails = await this._pollEmail(workflow);
            for (const email of newEmails) {
              log.info(`[workflow-scheduler] email trigger: "${workflow.slug}" — new message from ${email.from}`);
              await this._executeFlow(workflow, { trigger: 'event', emailContext: email });
            }
          } catch (err) {
            log.error(`[workflow-scheduler] email poll error for "${workflow.slug}": ${err.message}`);
          }
        }
      }
    } catch (err) {
      log.error(`[workflow-scheduler] tick error: ${err.message}`);
    } finally {
      this._running = false;
    }
  }

  /**
   * Register the Gmail polling function. Called by server.js after the Google
   * connector is available. The function receives a workflow and returns an
   * array of new email objects (empty = nothing new).
   * @param {(workflow: object) => Promise<object[]>} fn
   */
  registerEmailPoller(fn) {
    this._pollEmail = fn;
  }

  /**
   * Register a per-tenant token injector. Before a flow runs, the scheduler asks
   * this hook to return the workflow with any connector credentials its tenant
   * owns injected into the relevant nodes — so an automatically-fired workflow
   * acts as the OWNING tenant, never a shared/operator token. Connector-agnostic:
   * the hook decides which nodes need which connector's token. No-op if unset.
   * @param {(workflow: object) => object} fn
   */
  registerTokenInjector(fn) {
    this._injectTokens = fn;
  }

  /**
   * Register the error notifier. Called after every terminal failure (all
   * retry attempts exhausted). Receives (workflow, error) and is responsible
   * for sending the notification described in `workflow.error_handling.notify`.
   * No-op if unset.
   * @param {(workflow: object, error: Error) => Promise<void>} fn
   */
  registerErrorNotifier(fn) {
    this._errorNotifier = fn;
  }

  /**
   * Execute a single workflow (dispatch by kind).
   * @param {object} workflow
   * @param {object} [options]
   * @param {'scheduled'|'manual'|'chat'|'event'} [options.trigger='scheduled']
   * @param {string|null} [options.sessionId] — chat session that kicked off, if any
   */
  async _execute(workflow, { trigger = 'scheduled', sessionId = null } = {}) {
    if (workflow.kind === 'flow') return this._executeFlow(workflow, { trigger, sessionId });
    return this._executeFetch(workflow, { trigger, sessionId });
  }

  /** Execute a fetch-kind workflow via its registered source fetcher. */
  async _executeFetch(workflow, { trigger = 'scheduled', sessionId = null } = {}) {
    const source = this.sourceRegistry.get(workflow.source_id);
    if (!source) {
      log.error(`[workflow-scheduler] source "${workflow.source_id}" not found for workflow ${workflow.id}`);
      return;
    }

    const fetcher = this.fetchers[source.fetch_module];
    if (!fetcher) {
      log.error(`[workflow-scheduler] fetcher "${source.fetch_module}" not registered for source ${source.id}`);
      return;
    }

    const startedAt = Date.now();
    const run = this.workflowStore.startRun(workflow.id);
    log.info(`[workflow-scheduler] executing "${workflow.slug}" (run ${run.id.slice(0, 8)})`);

    try {
      const result = await fetcher.fetch(workflow.config);
      this.workflowStore.completeRun(run.id, result.text ?? JSON.stringify(result));
      this.emitWorkflowRun({
        workflow, run, trigger, sessionId, startedAt,
        status: 'success', stepCount: 1, // fetch-kind is effectively a single fetch step
      });
      log.info(`[workflow-scheduler] "${workflow.slug}" completed`);
    } catch (err) {
      this.workflowStore.failRun(run.id, err);
      this.emitWorkflowRun({
        workflow, run, trigger, sessionId, startedAt,
        status: 'error', stepCount: 1,
        error: err, errorClass: this._classifyError(err),
      });
      log.error(`[workflow-scheduler] "${workflow.slug}" failed: ${err.message}`);
    }
  }

  /**
   * Execute a flow-kind workflow with retry and error notification.
   * Reads `workflow.error_handling` for:
   *   retry.attempts      — how many extra attempts (0 = no retry, default)
   *   retry.delay_seconds — seconds to wait between attempts (default 0)
   *   notify.type         — 'slack' | 'email' (routed via _errorNotifier hook)
   *   notify.channel      — target for the notification
   */
  async _executeFlow(workflow, opts = {}) {
    const eh = workflow.error_handling ?? {};
    const maxAttempts = Math.max(1, 1 + (parseInt(eh.retry?.attempts, 10) || 0));
    const retryDelayMs = Math.max(0, (parseInt(eh.retry?.delay_seconds, 10) || 0)) * 1_000;

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastError = await this._runFlowOnce(workflow, opts);
      if (!lastError) return;
      if (attempt < maxAttempts) {
        log.warn(`[workflow-scheduler] flow "${workflow.slug}" failed (attempt ${attempt}/${maxAttempts}) — retrying in ${retryDelayMs / 1_000}s`);
        if (retryDelayMs > 0) await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }

    if (this._errorNotifier) {
      try {
        await this._errorNotifier(workflow, lastError);
      } catch (e) {
        log.warn(`[workflow-scheduler] error notifier failed: ${e.message}`);
      }
    }
  }

  /**
   * Single execution attempt for a flow-kind workflow.
   * Returns `null` on success, or the error on failure (engine error or uncaught throw).
   * @param {object} workflow
   * @param {object} [opts]
   * @param {string} [opts.trigger]
   * @param {string|null} [opts.sessionId]
   * @param {object|null} [opts.emailContext]
   * @returns {Promise<null|Error>}
   */
  async _runFlowOnce(workflow, { trigger = 'scheduled', sessionId = null, emailContext = null } = {}) {
    if (!this.flowTester) {
      log.error(`[workflow-scheduler] flow-kind workflow "${workflow.slug}" is due but no flowTester is configured`);
      return new Error('flowTester not configured');
    }
    const startedAt = Date.now();
    const run = this.workflowStore.startRun(workflow.id);
    log.info(`[workflow-scheduler] executing flow "${workflow.slug}" (run ${run.id.slice(0, 8)})`);

    const stepCount = (workflow.nodes ?? []).length;
    let lastOutput = null;
    let failed = null;
    let failedStep = null;
    try {
      // Inject the owning tenant's connector credentials into the nodes so the
      // automatic run acts as that tenant (never a shared/operator token).
      const wf = this._injectTokens ? await this._injectTokens(workflow) : workflow;
      // For email-triggered flows, inject the fetched email as the initial
      // lastOutput so summarize/llm nodes see it without a separate fetch step.
      const runOpts = { runId: run.id, costContext: `workflow:${workflow.slug}` };
      if (emailContext) runOpts.initialContext = emailContext;
      for await (const evt of this.flowTester.run(
        { nodes: wf.nodes, edges: wf.edges },
        runOpts,
      )) {
        if (evt.type === 'step_started' || evt.type === 'step_completed' || evt.type === 'step_failed') {
          this.workflowStore.appendStep(run.id, evt);
        }
        if (evt.type === 'step_failed') failedStep = evt.nodeId ?? null;
        if (evt.type === 'run_completed') lastOutput = evt.output;
        if (evt.type === 'run_failed')    failed = evt.error;
      }
      const runCost = this.costTracker?.getSessionCost(`flow-run-${run.id}`) ?? null;
      if (failed) {
        const explanation = translateError(failed, { workflow });
        this.workflowStore.failRun(run.id, failed, runCost, explanation);
        this.emitWorkflowRun({
          workflow, run, trigger, sessionId, startedAt, runCost,
          status: 'error', stepCount, failedStep,
          error: failed, errorClass: this._classifyError(failed),
        });
        log.error(`[workflow-scheduler] flow "${workflow.slug}" failed: ${explanation.title}`);
        return failed;
      } else {
        const finalRun = this.workflowStore.getRun(run.id);
        const probeRun = { ...finalRun, output: typeof lastOutput === 'string' ? lastOutput : JSON.stringify(lastOutput), steps: finalRun?.steps ?? [] };
        const warnings = validateRunOutput(probeRun, workflow);
        this.workflowStore.completeRun(run.id, lastOutput, runCost, warnings);
        this.emitWorkflowRun({
          workflow, run, trigger, sessionId, startedAt, runCost,
          status: 'success', stepCount,
        });
        const warnNote = warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : '';
        log.info(`[workflow-scheduler] flow "${workflow.slug}" completed · $${(runCost?.costUsd ?? 0).toFixed(4)} (${runCost?.calls ?? 0} llm calls)${warnNote}`);
        return null;
      }
    } catch (err) {
      this.workflowStore.failRun(run.id, err);
      this.emitWorkflowRun({
        workflow, run, trigger, sessionId, startedAt,
        status: 'error', stepCount, failedStep,
        error: err, errorClass: this._classifyError(err),
      });
      log.error(`[workflow-scheduler] flow "${workflow.slug}" crashed: ${err.message}`);
      return err;
    }
  }

  /**
   * Execute a workflow immediately (manual "Run Now"). Used by:
   *   - chat tool `run_workflow_now` (trigger='chat', sessionId set)
   *   - REST `/workflows/:id/run` for fetch-kind workflows (trigger='manual')
   *
   * @param {string} workflowId
   * @param {object} [options]
   * @param {'manual'|'chat'} [options.trigger='manual']
   * @param {string|null} [options.sessionId]
   * @returns {Promise<object>} — the completed run object
   */
  async runNow(workflowId, { trigger = 'manual', sessionId = null } = {}) {
    const workflow = this.workflowStore.get(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
    await this._execute(workflow, { trigger, sessionId });
    return this.workflowStore.getLastRun(workflowId);
  }

  // ── iter-8 unified-outputs emit helpers ──────────────────────────────────

  /**
   * Emit one row to the unified outputs log per terminal workflow run.
   * Public method — called by:
   *   - internal _executeFlow / _executeFetch (scheduled or runNow-driven)
   *   - REST /workflows/:id/run handler (flow-kind inline execution path
   *     that bypasses runNow because it streams step events to the client)
   *
   * v1 emits ONLY the terminal row (status 'success' or 'error') — no start
   * row. Frontend pivot still gets per-run count + cost + duration. If
   * in-flight visibility becomes a need, add a status='running' emit at
   * startRun() time and update the row id on terminal.
   *
   * parent_output_id is NULL in v1 even for chat-triggered runs because the
   * parent turn row is written at turn end, after this fires. Frontend can
   * correlate via (session_id, timestamp) in the meantime — matches the
   * convention Core uses for tool_call rows.
   */
  emitWorkflowRun({
    workflow, run, trigger, sessionId, startedAt, runCost = null,
    status, stepCount, failedStep = null, error = null, errorClass = null,
  }) {
    if (!this.metricsStore) return;
    const durationMs = Date.now() - startedAt;
    const isTimeout  = error?.message ? /timed out|timeout/i.test(error.message) : false;
    try {
      this.metricsStore.recordOutput({
        type: 'workflow_run',
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        user_id: workflow.user_id ?? null,
        parent_output_id: null,
        latency_ms: durationMs,
        cost_usd: runCost?.costUsd ?? null,
        status,
        error_class: errorClass,
        // iter-9: wide-schema top-level columns. recordOutput silently
        // ignores unknown fields on pre-iter-11 builds, so these are safe
        // to pass before Core's schema lands.
        source_surface: SURFACE_BY_TRIGGER[trigger] ?? 'api',
        tool_used:      _collectToolsUsed(workflow),
        attrs: {
          workflow_id: workflow.id,
          run_id:      run.id,
          trigger,
          step_count:  stepCount,
          duration_ms: durationMs,
          ...(failedStep ? { failed_step: failedStep } : {}),
        },
        flags: status === 'error' ? { error: true, ...(isTimeout ? { timeout: true } : {}) } : null,
      });
    } catch (e) {
      log.warn?.(`[workflow-scheduler] recordOutput(workflow_run) failed: ${e.message}`);
    }
  }

  /**
   * Coarse error categorization for the workflow_run.error_class column.
   * Mirrors the shape Core uses for tool_call rows. Keep this list small —
   * the pivot UI groups by error_class, too many strings dilutes the chart.
   */
  _classifyError(err) {
    const msg = (err?.message ?? String(err ?? '')).toLowerCase();
    if (/timed out|timeout/.test(msg))                 return 'timeout';
    if (/not found|missing|unknown.*(source|tool|channel)/.test(msg)) return 'config';
    if (/unauthorized|forbidden|auth/.test(msg))       return 'auth';
    if (/validation|invalid|required/.test(msg))       return 'validation';
    if (/network|fetch failed|econn|http\s+5\d\d/.test(msg)) return 'network';
    return 'tool_failed';
  }

  /**
   * Preview a workflow — fetch live data without recording a run.
   * @param {string} sourceId
   * @param {object} config — source-specific params (e.g., { office: 'BMX' })
   * @returns {Promise<object>} — raw fetch result
   */
  async preview(sourceId, config) {
    const source = this.sourceRegistry.get(sourceId);
    if (!source) throw new Error(`Source "${sourceId}" not found`);

    const fetcher = this.fetchers[source.fetch_module];
    if (!fetcher) throw new Error(`Fetcher "${source.fetch_module}" not registered`);

    return fetcher.fetch(config);
  }
}

/**
 * iter-9: collect distinct tool names referenced by a workflow's nodes.
 *
 * Static analysis (no per-step runtime tracking) — slightly less accurate
 * than dynamic tracking for conditional flows but cheap and "directionally
 * right" for the Frontend pivot. Returns a comma-joined alphabetical string,
 * or null if no tool/mcp_tool nodes are referenced.
 *
 * Tool name format matches what Core's tool_call rows record:
 *   - `tool` node           → config.tool       (e.g. "web_search")
 *   - `mcp_tool` node       → "<server>__<tool>" (matches the validator's
 *                              namespacing convention)
 * Higher-level primitives (`summarize`, `rewrite`, `search-web`, `extract`,
 * etc.) and pure LLM/fetch/deliver nodes are NOT counted as tools — they
 * either wrap an LLM call or a source fetch, not a registered tool the
 * pivot would want to filter on.
 */
function _collectToolsUsed(workflow) {
  const tools = new Set();
  for (const node of workflow?.nodes ?? []) {
    if (node?.type === 'tool' && typeof node.config?.tool === 'string' && node.config.tool.trim()) {
      tools.add(node.config.tool.trim());
    } else if (node?.type === 'mcp_tool'
               && typeof node.config?.server === 'string' && node.config.server.trim()
               && typeof node.config?.tool   === 'string' && node.config.tool.trim()) {
      tools.add(`${node.config.server.trim()}__${node.config.tool.trim()}`);
    }
  }
  return tools.size ? [...tools].sort().join(', ') : null;
}
