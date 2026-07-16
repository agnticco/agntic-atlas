/**
 * dry-run-runner — run an ALREADY-PREPARED spec through the engine with terminal
 * side-effects STUBBED, then judge what it produced against its outcome contract.
 *
 * This is the safe execution core the converger's self-verification loop (#23) uses
 * to test its own draft on a sample event BEFORE handing off — build, run, read the
 * result, fix, re-run. An agent that iterates must cause NO real side effects while
 * it loops: no real emails, no records written, no Slack posts, no matter how many
 * fix-retries it takes. Dry-run mode (increment #21, flow-tester.js) is what makes
 * that safe — processing nodes run for real (their output is needed to check the
 * chain), and every terminal delivery/write is verified into a would-deliver receipt
 * instead of fired.
 *
 * It lives in `src/workflows/` (not in the server) deliberately: it depends only on
 * the engine + the outcome oracle, so it is unit-testable with a real FlowTester and
 * a recording registry — without standing up the whole HTTP server. The CALLER
 * (server.js) is responsible for injecting the tenant's tokens/context into the spec
 * BEFORE calling this; here the spec is assumed prepared.
 *
 * THE ONE NON-NEGOTIABLE: `dryRunDeliveries: true` is set unconditionally. Omit it
 * and the loop fires real deliveries on every fix-retry — the exact failure this
 * module exists to make impossible. `tests/workflows/dry-run-verify.test.js` pins it
 * (a recording registry that must stay empty).
 */

import { evaluateExampleRun, normalizeDelivery, isDeliveryNode } from './outcome-oracle.js';

/**
 * @param {object} args
 * @param {object} args.flowTester   — a constructed FlowTester (spine.engine.flowTester)
 * @param {object} args.spec         — a runnable spec, tenant tokens/context ALREADY injected
 * @param {*}      [args.initialContext] — the sample event to seed the entry node with
 * @param {string} [args.tenantId]   — scopes idempotency keys (mirrors the REST run path)
 * @param {string} [args.workflowId] — scopes idempotency keys, when the spec is persisted
 * @param {object} [args.costTracker]— spine.costTracker, so the spec's llm calls stay attributed
 * @param {string} [args.userId]     — the user the dry-run's cost belongs to
 * @returns {Promise<{outputs:Array, deliveries:Array, completed:boolean, error:any, paused:boolean, output:any, oracleResult:(object|null)}>}
 */
export async function runSpecDryRun({
  flowTester,
  spec,
  initialContext = undefined,
  tenantId = null,
  workflowId = null,
  costTracker = null,
  userId = null,
} = {}) {
  const steps = [];
  let runId = null, completed = false, output = null, error = null, paused = false;

  const flowOpts = {
    ...(initialContext != null ? { initialContext } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(workflowId ? { workflowId } : {}),
    // ── THE FLAG THAT MAKES THE LOOP SAFE — never conditional, never omitted. ──
    // With it, deliver + writing connector-action nodes are verified into
    // { dryRun:true, wouldDeliver, checks } receipts instead of fired. This is the
    // whole reason the converger can run its own draft as many times as it needs
    // without spamming real sends.
    dryRunDeliveries: true,
  };

  for await (const ev of flowTester.run(spec, flowOpts)) {
    if (ev.type === 'run_started') {
      runId = ev.runId;
      // Attribute the spec's real llm calls to the tenant exactly as the REST run
      // path does (server.js): the CostTracker resolves the flow-run session → user
      // → tenant, so an un-attributed converger self-test cannot drop out of the
      // per-tenant aggregates.
      if (userId) costTracker?.setSessionUser?.(`flow-run-${runId}`, userId);
    } else if (ev.type === 'step_completed') {
      steps.push({ nodeId: ev.nodeId, output: ev.output });
    } else if (ev.type === 'run_completed') {
      completed = true; output = ev.output;
    } else if (ev.type === 'run_paused') {
      // A human gate (rare pre-ratify) stops the run. It is not a failure — the
      // caller treats a paused dry-run as unjudgeable rather than as a broken
      // workflow. Stop reading events here, like the REST run path.
      paused = true; break;
    } else if (ev.type === 'run_failed') {
      error = ev.error; break;
    }
  }

  // Assemble the run's deliveries from the delivering NODE, not the handler's
  // return: handlers are inconsistent (only Slack stamps channel + delivered; inbox
  // omits channel; gmail/airtable omit both), so filtering on a bare `o.delivered`
  // drops gmail/airtable and leaves inbox with no channel. normalizeDelivery derives
  // channel + destination from the node config, which always has them — and reads a
  // would-deliver receipt as "would-satisfy". Identical to POST /workflows/run.
  const coerce = (o) => {
    if (o && typeof o === 'object') return o;
    if (typeof o === 'string') { try { return JSON.parse(o); } catch { /* not json */ } }
    return null;
  };
  const nodeById = new Map((spec?.nodes ?? []).map((n) => [n.id, n]));
  const deliveries = steps
    .map((s) => {
      const node = nodeById.get(s.nodeId);
      const o = coerce(s.output);
      if (!isDeliveryNode(node) && !(o && o.delivered === true)) return null;
      return normalizeDelivery(node, o);
    })
    .filter(Boolean);

  // Judge against the outcome contract — the loop's pass/fail. Absent an outcome
  // (v1 spec, or a bare run) there is nothing to gate on, so oracleResult is null and
  // the caller passes the build through untested.
  let oracleResult = null;
  if (Array.isArray(spec?.outcome?.assertions) && spec.outcome.assertions.length) {
    oracleResult = evaluateExampleRun(
      spec,
      { given: initialContext },
      { completed, deliveries, steps, error },
    );
  }

  return { outputs: steps, deliveries, completed, error, paused, output, oracleResult };
}
