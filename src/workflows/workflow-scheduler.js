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
import { deadlineFrom } from './duration.js';
import { normalizeDecisions, TIMEOUT_DECISION } from './node-types/human.js';
import { timeoutAuthorizesWrite } from './workflow-validator.js';

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
      // Skip workflows whose tenant is inactive (suspended/archived) — a
      // non-paying or cancelled tenant's automations must not run.
      const active = (w) => !this._tenantGate || this._tenantGate(w.tenant_id);

      // 1. Schedule-triggered workflows (existing behaviour).
      const due = this.workflowStore.getDue().filter(active);
      if (due.length > 0) {
        log.info(`[workflow-scheduler] ${due.length} workflow(s) due`);
        for (const workflow of due) {
          await this._execute(workflow);
        }
      }

      // 1b. Expired approvals (P12 Increment D). A pause holds no compute, so
      //     this tick is the only thing in the system that ever notices a deadline
      //     pass. Note what this is NOT: it never re-executes a parked run. A run
      //     comes back to life only through resumeRun(), which requires an answer.
      //     The sweeper's job is to supply the one answer nobody gave — the
      //     declared timeout — and then resume like any other channel.
      try {
        await this.sweepTimeouts();
      } catch (err) {
        log.error(`[workflow-scheduler] timeout sweep error: ${err.message}`);
      }

      // 2. Email-triggered workflows — poll Gmail for each active flow with
      //    an `email` trigger type. Requires the gmail poll function to be
      //    registered via registerEmailPoller().
      if (this._pollEmail) {
        const emailFlows = this.workflowStore.list({ kind: 'flow', status: 'active' })
          .filter((w) => (w.triggers ?? []).some((t) => t.type === 'email'))
          .filter(active);
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
   * Register a tenant-active predicate. Before running a due/email-triggered
   * workflow, the scheduler asks this hook whether the owning tenant is active;
   * suspended/archived tenants are skipped so their automations don't run.
   * @param {(tenantId: string) => boolean} fn
   */
  registerTenantGate(fn) {
    this._tenantGate = fn;
  }

  /**
   * Register a run-budget predicate — the hard `monthlyRuns` plan cap. Before any
   * real flow run (scheduled, connector-event, or manual "run now" — all funnel
   * through _executeFlow), the scheduler asks whether the owning tenant is under
   * its monthly run budget. Returning `false` skips the run. Fails OPEN: if the
   * hook throws or returns anything other than `false`, the run proceeds.
   * @param {(workflow: object) => boolean} fn
   */
  registerRunBudgetCheck(fn) {
    this._runBudgetCheck = fn;
  }

  /**
   * Register the ask deliverer (P12 Increment D). Called the moment a run pauses
   * on a `human` step, with everything needed to actually put the question in
   * front of a person: `{ workflow, run, ask, expiresAt }`.
   *
   * The scheduler does not know what Slack is, and must not: it hands over the
   * ask and the ApprovalService decides which channels it goes out over.
   *
   * NOT optional in the way the other hooks are. A pause with no deliverer is a
   * question nobody will ever be asked — the exact hang Increment B refused to
   * ship, and why `human` stayed unreachable until this hook existed. If it is
   * unset, the run is FAILED rather than parked: an honest, visible failure beats
   * a run that waits forever for an answer that cannot come.
   * @param {(ctx: {workflow: object, run: object, ask: object, expiresAt: string|null}) => Promise<void>} fn
   */
  registerAskDeliverer(fn) {
    this._deliverAsk = fn;
  }

  /**
   * Register the escalation notifier (P12 Increment D). Called when a step fails
   * under `on_error: { then: 'escalate' }` — the flag Increment B introduced and
   * deliberately left inert, because escalating to a person requires a person's
   * inbox to escalate INTO, and that did not exist yet. It does now.
   * @param {(ctx: {workflow: object, run: object, nodeId: string, error: string}) => Promise<void>} fn
   */
  registerEscalationNotifier(fn) {
    this._notifyEscalation = fn;
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
    // Hard monthly-run cap (plan gate). The single choke point for every real
    // run — scheduled, connector-event, and console "run now" all reach here.
    // Fails open (only an explicit `false` skips the run). Test runs never enter
    // this path, so they're inherently exempt from the budget.
    if (this._runBudgetCheck) {
      let allowed = true;
      try { allowed = this._runBudgetCheck(workflow); } catch { allowed = true; }
      if (allowed === false) {
        log.warn(`[workflow-scheduler] "${workflow.slug}" skipped — tenant over monthly run budget`);
        return;
      }
    }

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

    // Mark the workflow itself as broken so the sidebar dot turns red.
    try {
      this.workflowStore.update(workflow.id, { status: 'error' }, { userId: workflow.user_id });
    } catch (e) {
      log.warn(`[workflow-scheduler] could not mark workflow ${workflow.id} as error: ${e.message}`);
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
   * @param {object|null} [opts.existingRun] — RESUME: continue this run row rather
   *        than opening a new one (P12 Increment D).
   * @param {object|null} [opts.checkpoint]  — RESUME: the state the run paused on.
   * @param {object|null} [opts.decisions]   — RESUME: { [humanNodeId]: {decision,by,at,channel} }
   * @returns {Promise<null|Error>}
   */
  async _runFlowOnce(workflow, {
    trigger = 'scheduled', sessionId = null, emailContext = null,
    existingRun = null, checkpoint = null, decisions = null,
  } = {}) {
    if (!this.flowTester) {
      log.error(`[workflow-scheduler] flow-kind workflow "${workflow.slug}" is due but no flowTester is configured`);
      return new Error('flowTester not configured');
    }
    const startedAt = Date.now();
    // A RESUME CONTINUES THE RUN; IT DOES NOT START ONE. Opening a fresh run row
    // here would bill the tenant a second run against their monthly cap for a
    // workflow that fired once, and it would split one story — the trigger, the
    // pause, the person's answer, the delivery — across two rows in the console,
    // neither of which is the truth.
    const run = existingRun ?? this.workflowStore.startRun(workflow.id);
    // Register user attribution so every LLM cost record carries the tenant.
    this.costTracker?.setSessionUser(`flow-run-${run.id}`, workflow.user_id ?? null);
    log.info(existingRun
      ? `[workflow-scheduler] resuming flow "${workflow.slug}" (run ${run.id.slice(0, 8)})`
      : `[workflow-scheduler] executing flow "${workflow.slug}" (run ${run.id.slice(0, 8)})`);

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
      // tenantId/workflowId are LOAD-BEARING: they scope the idempotency keys.
      // Omitting them used to collapse every tenant into one shared namespace.
      const runOpts = {
        runId: run.id,
        costContext: `workflow:${workflow.slug}`,
        tenantId:   workflow.tenant_id,
        workflowId: workflow.id,
      };
      if (emailContext) runOpts.initialContext = emailContext;
      // RESUME (§7.4). The checkpoint — not the steps. The steps are display-shrunk.
      if (checkpoint) runOpts.checkpoint = checkpoint;
      if (decisions)  runOpts.decisions  = decisions;
      for await (const evt of this.flowTester.run(
        { nodes: wf.nodes, edges: wf.edges },
        runOpts,
      )) {
        // step_skipped / step_retry / step_routed are new in P12 Increment B.
        // They are persisted for the run HISTORY (the console/SOP read `steps`).
        // They are NOT the resume state — that is `evt.checkpoint`, stored in its
        // own column below. `steps` carries the display-shrunk event stream, and
        // resuming from it delivered the customer a truncated copy of what the
        // person had approved. See converger-v2 §7.4.
        if (evt.type === 'step_started'  || evt.type === 'step_completed' ||
            evt.type === 'step_failed'   || evt.type === 'step_skipped'   ||
            evt.type === 'step_retry'    || evt.type === 'step_routed') {
          this.workflowStore.appendStep(run.id, evt);
        }
        if (evt.type === 'step_failed') failedStep = evt.nodeId ?? null;
        if (evt.type === 'run_completed') lastOutput = evt.output;
        if (evt.type === 'run_failed')    failed = evt.error;

        // ── The durable pause (§7.4) ──────────────────────────────────────
        // A `human` step stopped the run. Park it: the completed steps are
        // already persisted, the run holds no compute, and it costs nothing
        // while it waits. It is NOT a failure and NOT still running — either
        // would be a lie, and 'running' would get it swept up as a stale run.
        //
        // Increment D delivers the ask: the run is parked, THEN the question goes
        // out over the node's channels (Slack buttons, the Approvals inbox, a
        // signed magic link). Park first, ask second — if the ask went first and
        // a very fast approver answered before the row said `awaiting_human`, the
        // answer would arrive at a run that is not yet waiting for it and be
        // dropped on the floor.
        if (evt.type === 'run_paused') {
          const expiresAt = deadlineFrom(evt.ask?.timeout?.after);

          // A PAUSE WITH NO WAY TO ASK IS A HANG. The validator rejects a `human`
          // node with no timeout, but nothing structural can stop this process
          // from booting with no deliverer wired (a misconfiguration, a partial
          // boot), and in that state a parked run waits for an answer that no
          // surface will ever request. Fail loudly instead — an error somebody
          // reads beats a silence nobody does.
          if (!this._deliverAsk) {
            const err = `"${evt.nodeId}" needs a person, but no approval channel is wired in this deployment — nobody could be asked.`;
            log.error(`[workflow-scheduler] ${err}`);
            this.workflowStore.failRun(run.id, err, null, translateError(err, { workflow }));
            return err;
          }

          this.workflowStore.pauseRun(run.id, evt.nodeId, evt.ask, evt.checkpoint, expiresAt);
          log.info(`[workflow-scheduler] flow "${workflow.slug}" paused at "${evt.nodeId}" awaiting a person (until ${expiresAt ?? 'never'})`);

          try {
            await this._deliverAsk({ workflow, run, ask: evt.ask, expiresAt });
          } catch (e) {
            // The run stays parked and the deadline still stands, so the timeout
            // path will eventually fire and the run cannot hang. But a question
            // that failed to reach anyone is not a detail to swallow.
            log.error(`[workflow-scheduler] could not deliver the ask for run ${run.id.slice(0, 8)}: ${e.message}`);
          }
          return null;   // not an error — there is simply nothing more to do yet
        }

        // ── on_error: escalate (Increment B's flag, Increment D's inbox) ──
        // The step failed and the spec said a person should hear about it. B
        // marked the run and said so out loud; it could do no more, because there
        // was no surface to escalate INTO. There is now.
        if (evt.type === 'run_failed' && evt.escalated && this._notifyEscalation) {
          try {
            await this._notifyEscalation({
              workflow, run, nodeId: failedStep, error: evt.error,
            });
          } catch (e) {
            log.warn(`[workflow-scheduler] escalation notice failed: ${e.message}`);
          }
        }
      }
      const runCost = this.costTracker?.getSessionCost(`flow-run-${run.id}`) ?? null;
      const actualDurationS = (Date.now() - startedAt) / 1000;
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
        const baselineS = workflow.baseline_duration_s ?? 0;
        const timeSavedMinutes = baselineS > 0 ? Math.max(0, (baselineS - actualDurationS) / 60) : null;
        this.workflowStore.completeRun(run.id, lastOutput, runCost, warnings, timeSavedMinutes);
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
   * Resume a run that was waiting on a person (P12 Increment D).
   *
   * The ONE place a paused run comes back to life. Every channel — the in-app
   * inbox, a Slack button, an emailed magic link, the timeout sweeper — converges
   * here, having already ESTABLISHED WHO IS ANSWERING. This method does not
   * authenticate anything and must never be reachable from an unauthenticated
   * caller; that job belongs to ApprovalService, which owns the token and
   * signature checks.
   *
   * @param {object} run — a hydrated `awaiting_human` row (checkpoint decoded)
   * @param {{decision: string, by: string|null, channel: string|null}} answer
   * @returns {Promise<{resumed: boolean, reason?: string}>}
   */
  async resumeRun(run, answer) {
    if (!run || run.status !== 'awaiting_human') {
      return { resumed: false, reason: 'this run is not waiting for an answer' };
    }
    const nodeId = run.paused_node;
    if (!nodeId) return { resumed: false, reason: 'the paused run does not say which step it stopped at' };

    // ONE ANSWER, ONCE. This flips awaiting_human → running conditionally, so of
    // two answers racing (Approve in Slack while the sweeper fires the timeout;
    // two people clicking at once) exactly one wins and the loser stops HERE —
    // before the run is resumed a second time and the customer is emailed twice.
    if (!this.workflowStore.markRunResumed(run.id)) {
      return { resumed: false, reason: 'that question has already been answered' };
    }

    const workflow = this.workflowStore.get(run.workflow_id);
    if (!workflow) {
      const err = `run ${run.id} resumed but its workflow ${run.workflow_id} no longer exists`;
      this.workflowStore.failRun(run.id, err);
      return { resumed: false, reason: 'the workflow this run belongs to no longer exists' };
    }

    const decisions = {
      [nodeId]: {
        decision: String(answer?.decision),
        by:       answer?.by ?? null,
        at:       new Date().toISOString(),
        channel:  answer?.channel ?? null,
      },
    };
    // The audit trail: who answered what, when, over which channel — persisted in
    // the run's own step stream, before any of the work it unblocks happens.
    this.workflowStore.appendStep(run.id, {
      type: 'human_answered', nodeId,
      decision: decisions[nodeId].decision,
      by: decisions[nodeId].by, channel: decisions[nodeId].channel,
      at: decisions[nodeId].at,
    });

    // Resumes through the SAME executor, with the SAME token injection, from the
    // checkpoint. Not through _executeFlow: the workflow-level retry wrapper
    // re-runs a flow from the top, and re-running a flow that has already sent
    // half of its side effects is not a retry, it is a duplicate.
    const err = await this._runFlowOnce(workflow, {
      trigger: 'event',
      existingRun: run,
      checkpoint:  run.checkpoint,
      decisions,
    });
    return err ? { resumed: true, error: String(err.message ?? err) } : { resumed: true };
  }

  /**
   * Fire the declared timeout path for every pause whose deadline has passed
   * (§7.4). Runs on the existing 60s tick — a pending approval costs nothing
   * while it waits, and this is the only thing that ever looks at it.
   *
   * `timeout.then` is one of the node's own decisions ("reject"), or `escalate`.
   * Anything else is rejected at build time (HUMAN_BAD_TIMEOUT), so an unreadable
   * one here can only come from a spec that predates the rule — and it resolves as
   * `timeout`, which is in every human node's closed domain and can therefore be
   * routed on. It never resolves as `approve`. An approval must never be the
   * default, and silence is not consent.
   */
  async sweepTimeouts() {
    const expired = this.workflowStore.listExpiredPauses();
    for (const run of expired) {
      const ask = run.pending_ask ?? {};
      const then = ask.timeout?.then == null ? null : String(ask.timeout.then);
      const allowed = new Set(normalizeDecisions(ask.decisions));
      let decision = (then && allowed.has(then)) ? then : TIMEOUT_DECISION;

      // SILENCE IS NOT CONSENT (F3). The validator now rejects `then: 'approve'`
      // at build time, but a spec ALREADY IN THE DATABASE predates that rule — and
      // the engine must not rely on the validator having run (the
      // BRANCH_TARGET_EXTRA_PARENT doctrine). So trace what this decision would
      // actually do: if it routes to a real send or write, the system would be
      // approving on a person's behalf. Downgrade to `timeout` (which the mandatory
      // catch-all handles) rather than perform it. The sweeper is INCAPABLE of
      // auto-authorising an action nobody approved.
      const workflow = this.workflowStore.get(run.workflow_id);
      const writesOnSilence = (d) => workflow
        && timeoutAuthorizesWrite({ nodes: workflow.nodes, edges: workflow.edges }, run.paused_node, d);
      if (decision !== TIMEOUT_DECISION && writesOnSilence(decision)) {
        log.warn(`[workflow-scheduler] pause on run ${run.id.slice(0, 8)}: timeout "${decision}" would act with nobody's approval — resolving as "${TIMEOUT_DECISION}" instead`);
        decision = TIMEOUT_DECISION;
      }

      // Even the TIMEOUT floor routes to a write — the branch's timeout/catch-all
      // case itself sends (an inverted gate: `*→send`). There is NO decision that
      // does not perform an unapproved action, so the sweeper REFUSES to resume:
      // it fails the run rather than move money on silence. The validator now
      // rejects this shape at build time (HUMAN_BAD_TIMEOUT), but a spec already in
      // the database predates that rule. (Found by the verifier, round 2.)
      if (writesOnSilence(decision)) {
        const err = `"${run.paused_node}" timed out, but every path from here sends or writes without anyone approving — refusing to act.`;
        log.error(`[workflow-scheduler] run ${run.id.slice(0, 8)}: ${err}`);
        if (this._onTimeout) { try { await this._onTimeout({ run, ask, decision }); } catch { /* best-effort link burn */ } }
        try { this.workflowStore.failRun(run.id, err, null, translateError(err, { workflow })); }
        catch (e) { log.error(`[workflow-scheduler] could not fail run ${run.id.slice(0, 8)}: ${e.message}`); }
        continue;
      }

      log.info(`[workflow-scheduler] pause on run ${run.id.slice(0, 8)} expired — resolving as "${decision}"`);
      try {
        if (this._onTimeout) await this._onTimeout({ run, ask, decision });
        // `then: 'escalate'` must actually TELL A PERSON (found by the verifier,
        // R3). `escalate` is not one of the node's decisions, so it resolves as
        // `timeout` (routing to the catch-all) — which is the safe path, but on its
        // own it is silent, and the whole point of `escalate` over `reject` is that
        // somebody hears about it. Put it in the owner's Approvals list.
        if (then === 'escalate' && this._notifyEscalation && workflow) {
          try {
            await this._notifyEscalation({
              workflow, run, nodeId: run.paused_node,
              error: 'Nobody answered this approval in time — it was escalated.',
            });
          } catch (e) { log.warn(`[workflow-scheduler] timeout escalation notice failed: ${e.message}`); }
        }
        await this.resumeRun(run, { decision, by: 'system:timeout', channel: 'timeout' });
      } catch (e) {
        log.error(`[workflow-scheduler] timeout sweep failed for run ${run.id.slice(0, 8)}: ${e.message}`);
      }
    }
    return expired.length;
  }

  /**
   * Called just before a timed-out pause resolves, so the ApprovalService can
   * burn the outstanding magic links: the question is answered, and a link that
   * still works is a second answer waiting to happen.
   */
  registerTimeoutHook(fn) {
    this._onTimeout = fn;
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
 * Collect the distinct capabilities a workflow reaches out through, for the
 * run record's `tool_used` column. Static analysis (no per-step runtime
 * tracking) — cheap, and directionally right.
 *
 * This used to read `tool` and `mcp_tool` nodes. Both were deleted in the P12
 * node re-cut, because neither could ever run: there is no ToolRegistry in this
 * build. So this had been reporting on two node types that never executed, and
 * would now return null forever.
 *
 * `connector-action` is the tool path in this build — it reaches a registered
 * connector capability through the CapabilityRegistry — so that is what gets
 * counted. LLM/assemble/deliver nodes are not tools: they wrap a model call or
 * a delivery, not an outbound capability the console would want to filter on.
 *
 * @returns {string|null} comma-joined alphabetical capability ids, or null
 */
function _collectToolsUsed(workflow) {
  const tools = new Set();
  for (const node of workflow?.nodes ?? []) {
    if (node?.type === 'connector-action'
        && typeof node.config?.action === 'string' && node.config.action.trim()) {
      tools.add(node.config.action.trim());
    }
  }
  return tools.size ? [...tools].sort().join(', ') : null;
}
