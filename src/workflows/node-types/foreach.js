/**
 * foreach node — run a short sequence of steps once per item. (P12 Increment B.)
 *
 * The engine had NO per-item iteration, which is why the converger prompt has to
 * tell the model "a connector-action runs EXACTLY ONCE and CANNOT loop"
 * (src/converger/prompts.js) and why "enrich every row" was an unbuildable
 * pattern. This node is the loop.
 *
 * config:
 *   over:     "<nodeId>.output" — the collection to iterate (array, or an object
 *             with a `results`/`records`/`items`/`files` array)
 *   steps:    [ { id, type, config }, … ] — run in order, once per item
 *   maxItems: hard bound, default 100
 *
 * Inside `steps`, `{{item}}` is the current element and `{{index}}` is its
 * 0-based position. A step may also reference an earlier step of the SAME
 * iteration by id.
 *
 * **`maxItems` is a hard bound, not a suggestion.** A `foreach` over a web search
 * that returns 10,000 rows, each item making an LLM call, is a cost incident that
 * empties a tenant's month in one tick — and the run-budget check (tier gating)
 * only counts RUNS, not steps within a run, so nothing else would stop it. The
 * collection is truncated and the truncation is REPORTED in the output
 * (`truncated`, `skipped`) rather than passed over in silence: a loop that
 * quietly processed 100 of your 500 rows is worse than one that failed.
 *
 * No nesting (converger-v2 §12: "foreach nesting — start: no"). A foreach inside
 * a foreach is rejected by the validator.
 */

export const DEFAULT_MAX_ITEMS = 100;

/**
 * Control-node types whose output is routing/audit metadata, never the work
 * product — so they never become a loop iteration's `last`. Mirrors
 * flow-tester.js CONTROL_TYPES for the sub-loop, which has its own executor.
 *
 * `decision` (P12 Increment E) was missed here, and it is the THIRD time this
 * exact line has been the defect: `branch` and `human` were both added to the
 * top-level CONTROL_TYPES first and to this one only after a verifier found a
 * control blob being delivered to a customer once per item. A decision's output
 * is {value, text, rule, inputs}, and `stringifyOutput` picks its `.text` — so
 * the customer receives a plausible-looking "P1" instead of the lead, once per
 * row, with `run_completed` and no error.
 *
 * THE SUB-LOOP IS A SECOND EXECUTOR. Any rule about what may become the work
 * product must be applied to BOTH, and a new control type is not done until it is
 * in both sets. (Found by the independent verifier + the test-adversary.)
 */
const CONTROL_SUBSTEP_TYPES = new Set(['branch', 'human', 'decision', 'stop']);

export const foreachNodeType = {
  type: 'foreach',
  label: 'For each item',
  description: 'Runs a short sequence of steps once for every item in a list.',
  icon: 'repeat',
  family: 'control',
  configPolicy: 'closed',
  configSchema: [
    { key: 'over', label: 'List to loop over', type: 'text',
      placeholder: 'e.g. search_rows.output',
      hint: 'The step whose output is the list — normally "<stepId>.output".' },
    { key: 'steps', label: 'Steps (per item)', type: 'object',
      hint: 'The steps to run for each item, in order. Use {{item}} for the current item and {{index}} for its position.' },
    { key: 'maxItems', label: 'Maximum items', type: 'number', optional: true, default: DEFAULT_MAX_ITEMS,
      hint: `Hard cap on how many items are processed. Default ${DEFAULT_MAX_ITEMS}. Extra items are skipped and reported, never processed silently.` },
  ],
  previewTemplate: 'Runs its steps once for each item in {over} (max {maxItems|100}).',

  validate: (node) => {
    const issues = [];
    const cfg = node?.config ?? {};
    const steps = normalizeSteps(cfg.steps);

    if (!steps.length) {
      issues.push({
        severity: 'error', code: 'MISSING_CONFIG',
        message: `"${node.label || node.id}" loops over a list but has no steps to run for each item.`,
        nodeId: node.id, field: 'config.steps',
        hint: 'Add at least one step to run per item.',
      });
    }
    if (steps.some(s => s?.type === 'foreach')) {
      issues.push({
        severity: 'error', code: 'NESTED_FOREACH',
        message: `"${node.label || node.id}" contains another loop. Nested loops aren't supported.`,
        nodeId: node.id, field: 'config.steps',
        hint: 'Flatten the data first, or split this into two workflows.',
      });
    }
    if (steps.some(s => s?.type === 'human')) {
      // A pause inside a loop would need one durable pause per item — the resume
      // model (§7.4) is per-run, not per-item. Reject it rather than pause on
      // item 1 and silently never process items 2..N.
      issues.push({
        severity: 'error', code: 'HUMAN_IN_FOREACH',
        message: `"${node.label || node.id}" asks a person to approve something inside a loop. That isn't supported.`,
        nodeId: node.id, field: 'config.steps',
        hint: 'Move the approval outside the loop — approve the whole batch once, before or after it runs.',
      });
    }
    if (steps.some(s => s?.type === 'decision')) {
      // A decision inside a loop is a structural no-op for exactly the reason a
      // branch is: nothing inside a loop can ROUTE on its answer (routing needs
      // edges and liveness, and a loop has neither), so the one thing a decision
      // exists to feed cannot exist there. It is not merely useless, it is
      // dangerous in the same way — its {value,text,rule} would become the
      // iteration's `last` and a downstream deliver sub-step would send the
      // decided VALUE ("P1") to the customer instead of the item, once per row.
      // The engine now refuses to let that happen (CONTROL_SUBSTEP_TYPES), and
      // this refuses to let the shape be built. Both, because the engine must not
      // depend on the validator having run — DB specs predate every rule.
      issues.push({
        severity: 'error', code: 'DECISION_IN_FOREACH',
        message: `"${node.label || node.id}" contains a decision table. A loop can't act on one — its steps run in order, and nothing inside can route on the answer.`,
        nodeId: node.id, field: 'config.steps',
        hint: 'Decide OUTSIDE the loop and route there, or loop over the rows and let each step act on the item directly.',
      });
    }
    if (steps.some(s => s?.type === 'branch')) {
      // A branch is a structural NO-OP inside a loop, and a dangerous one. Routing
      // needs edges and liveness; a loop runs its sub-steps in array order with
      // neither, so the branch's `.to` is ignored and EVERY sub-step runs every
      // iteration. Worse, its control output {value,matched,to} becomes the
      // iteration's `last`, so a downstream deliver sub-step sends that BLOB to the
      // customer, once per item. (Found by the independent verifier — a
      // validator-clean spec delivered `{"value":…,"viaCatchAll":true}` to Slack.)
      // To branch per item, branch OUTSIDE the loop on a value the loop produced.
      issues.push({
        severity: 'error', code: 'BRANCH_IN_FOREACH',
        message: `"${node.label || node.id}" contains a branch. A loop has no branches — its steps run in order, every time.`,
        nodeId: node.id, field: 'config.steps',
        hint: 'Routing needs the edges a loop does not have. Branch outside the loop, on a value the loop produced.',
      });
    }

    const max = cfg.maxItems;
    if (max != null && (!Number.isFinite(Number(max)) || Number(max) < 1)) {
      issues.push({
        severity: 'error', code: 'INVALID_MAX_ITEMS',
        message: `"${node.label || node.id}" has an invalid maximum of ${JSON.stringify(max)}.`,
        nodeId: node.id, field: 'config.maxItems',
        hint: 'Use a whole number of 1 or more.',
      });
    }
    return issues;
  },

  /**
   * services.runSubNode(nodeSpec, extraCtx) is injected by FlowTester — it is the
   * same dispatch every other node goes through (template substitution, the v1
   * lift, the node registry), so a step inside a loop behaves exactly like a step
   * outside one.
   */
  run: async (cfg, ctx, services) => {
    if (typeof services?.runSubNode !== 'function') {
      throw new Error('foreach requires a sub-node executor (FlowTester must inject services.runSubNode)');
    }
    const steps = normalizeSteps(cfg.steps);
    if (!steps.length) throw new Error('foreach requires at least one step');

    const all = resolveCollection(cfg.over, ctx);
    if (!Array.isArray(all)) {
      throw new Error(
        `foreach expected a list from "${cfg.over}" but got ${all == null ? 'nothing' : typeof all}. ` +
        'Point `over` at a step whose output is a list.',
      );
    }

    const max     = Math.max(1, Math.floor(Number(cfg.maxItems ?? DEFAULT_MAX_ITEMS)));
    const items   = all.slice(0, max);
    const skipped = Math.max(0, all.length - items.length);

    const results = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      // Per-iteration scope. Each sub-step sees {{item}}, {{index}}, and any
      // earlier sub-step of THIS iteration by id — but not other iterations, so
      // one item's output can't leak into the next.
      const scope = new Map(ctx.outputs ?? []);
      scope.set('item', item);
      scope.set('index', index);

      let last = item;
      for (const step of steps) {
        const out = await services.runSubNode(step, {
          ...ctx,
          outputs: scope,
          lastOutput: last,
          item,
          index,
        });
        if (step.id) scope.set(step.id, out);
        // A control node's output is routing/audit metadata, never the work
        // product — the same rule the top-level loop applies (flow-tester.js,
        // CONTROL_TYPES). Without this, a branch/human sub-step's blob becomes
        // `last` and a downstream deliver sends it to the customer. The engine
        // must not depend on the validator having rejected the shape: specs in
        // the DB predate BRANCH_IN_FOREACH.
        if (!CONTROL_SUBSTEP_TYPES.has(step.type)) last = out;
      }
      results.push(last);
    }

    return {
      count: results.length,
      total: all.length,
      truncated: skipped > 0,
      skipped,
      results,
    };
  },
};

/** Steps may arrive as a JSON string (textarea) or a real array. */
export function normalizeSteps(raw) {
  let steps = raw;
  if (typeof steps === 'string') {
    try { steps = JSON.parse(steps); } catch { return []; }
  }
  return Array.isArray(steps) ? steps.filter(s => s && typeof s === 'object') : [];
}

/**
 * Resolve `over` to an array. Connector list/search capabilities return their
 * rows under a wrapper key rather than as a bare array, so unwrap the common
 * ones — otherwise every foreach over a connector would need a hand-written
 * template the converger has no way to know about.
 */
function resolveCollection(over, ctx) {
  if (over == null) return undefined;
  let value = over;

  if (typeof over === 'string') {
    const inner = over.trim().replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
    const m = /^([a-z0-9_-]+)(?:\.output)?$/i.exec(inner);
    if (m) {
      // A step reference. If that step produced nothing, say so — do NOT fall
      // through to "not a list", which would blame the wrong thing.
      if (!ctx?.outputs?.has(m[1])) return undefined;
      value = ctx.outputs.get(m[1]);
    } else {
      // Not a step reference — allow a literal list, so a loop over a fixed set
      // ("for each of these three regions") doesn't need a step to produce it.
      value = inner;
    }
  }

  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['results', 'records', 'items', 'files', 'messages', 'rows']) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return undefined;
}
