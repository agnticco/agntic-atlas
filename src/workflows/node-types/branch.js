/**
 * branch node — routes on an EXISTING value. (P12 Increment B.)
 *
 * BPMN's exclusive gateway (XOR). It does not decide anything — it *routes* on a
 * value some earlier node already produced. The deciding is a `decision` node's
 * job (Increment E), or an `llm` node in `classify` mode. Keeping those apart is
 * what makes the routing auditable: the branch's own logic is a lookup, not a
 * judgement, so "why did it go that way" is always answerable by pointing at the
 * upstream value.
 *
 * config:
 *   on:    "<nodeId>.output" (or "{{<nodeId>.output}}") — the value to route on
 *   cases: [ { when: "P1", to: "<nodeId>" }, … , { when: "*", to: "<nodeId>" } ]
 *
 * Exactly ONE case is selected: the first whose `when` matches, else the `*`
 * catch-all. **The catch-all is mandatory** — the validator rejects a branch
 * without one (NON_EXHAUSTIVE_BRANCH). A branch that can fall through every case
 * is a workflow that silently does nothing on an input nobody thought about,
 * which is the exact failure this phase exists to make impossible.
 *
 * This node only REPORTS its selection. Suppressing the untaken paths is
 * FlowTester's job (edge liveness) — see flow-tester.js. Doing it here would
 * mean a node type reaching into the run's control flow.
 */

export const CATCH_ALL = '*';

export const branchNodeType = {
  type: 'branch',
  label: 'Branch',
  description: 'Routes the workflow down exactly one path, based on a value an earlier step produced.',
  icon: 'call_split',
  family: 'control',
  configPolicy: 'closed',
  configSchema: [
    { key: 'on', label: 'Route on', type: 'text',
      placeholder: 'e.g. score_priority.output',
      hint: 'The value to route on — normally "<stepId>.output" from an earlier step.' },
    { key: 'cases', label: 'Cases', type: 'object',
      hint: 'A list of { when, to }. `when: "*"` is the catch-all and is REQUIRED — it is the path taken when nothing else matches.' },
  ],
  previewTemplate: 'Routes on {on} — one path is taken, the rest are skipped.',

  // No validate() here on purpose. A branch can only be checked against the
  // EDGE LIST (a case must name a real step, and there must be an edge to it, or
  // the target would run before the branch in topological order and the routing
  // would be a no-op). The node-level validate(node) hook doesn't see edges, so
  // every branch rule — including NON_EXHAUSTIVE_BRANCH — lives in
  // workflow-validator.js `_checkControlFlow`.

  /**
   * Returns the routing decision. FlowTester reads `.to` to decide which of this
   * node's outgoing edges are live.
   */
  run: async (cfg, ctx, _services) => {
    const cases = normalizeCases(cfg.cases);
    if (!cases.length) throw new Error('branch requires at least one case');

    const value = resolveOn(cfg.on, ctx);

    let chosen = cases.find(c => String(c.when).trim() !== CATCH_ALL && matches(c.when, value));
    let viaCatchAll = false;
    if (!chosen) {
      chosen = cases.find(c => String(c.when).trim() === CATCH_ALL);
      viaCatchAll = true;
    }
    if (!chosen) {
      // The validator forbids this shape; if it ever reaches the engine, fail
      // loudly rather than silently dropping the rest of the workflow.
      throw new Error(
        `branch "${cfg.on}" matched no case and has no "*" catch-all (value: ${JSON.stringify(value)})`,
      );
    }

    return { value, matched: chosen.when, to: chosen.to, viaCatchAll };
  },
};

/** Cases may arrive as a JSON string (textarea) or a real array. */
export function normalizeCases(raw) {
  let cases = raw;
  if (typeof cases === 'string') {
    try { cases = JSON.parse(cases); } catch { return []; }
  }
  return Array.isArray(cases) ? cases.filter(c => c && typeof c === 'object') : [];
}

/**
 * Resolve `on` against the run context. Accepts "{{x.output}}", "x.output" or a
 * bare node id. FlowTester has already template-substituted the config, so a
 * "{{…}}" form usually arrives resolved; the node-id forms are handled here so a
 * spec can say `on: "score.output"` without braces (which is what the converger
 * emits, and what reads naturally in the table UI).
 */
function resolveOn(on, ctx) {
  if (on == null) return undefined;
  const raw = String(on).trim();
  const inner = raw.replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
  const m = /^([a-z0-9_-]+)(?:\.output)?$/i.exec(inner);
  if (m) {
    if (ctx?.outputs?.has(m[1])) return ctx.outputs.get(m[1]);
    // It NAMES a step, and that step produced nothing. Treating it as a literal
    // here is what let a one-letter typo route 100% of traffic to the catch-all,
    // silently, forever. Fail loudly instead. (The validator rejects this shape
    // as BRANCH_BAD_ON — but the engine must not depend on the validator having
    // run: specs already in the database predate the rule.)
    throw new Error(
      `branch routes on "${raw}", but no step "${m[1]}" produced a value. ` +
      'Refusing to fall through to the catch-all — that would silently misroute every run.',
    );
  }
  // Not a step reference — a literal (already substituted).
  return raw;
}

/**
 * Case matching. Deliberately narrow: exact value equality, case-insensitively
 * for strings. No expressions, no ranges — those belong in a `decision` table
 * (Increment E), where they can be gap-analysed. A branch that could evaluate
 * arbitrary expressions would be undecidable, which deletes the completeness
 * proof.
 */
function matches(when, value) {
  if (value != null && typeof value === 'object') {
    // A branch routing on a whole object is almost always routing on a decision
    // node's output; compare against its `.output`/`.decision` if present.
    const scalar = value.output ?? value.decision ?? value.value;
    if (scalar !== undefined) value = scalar;
  }
  if (typeof when === 'boolean' || typeof value === 'boolean') return String(when) === String(value);
  return String(when).trim().toLowerCase() === String(value ?? '').trim().toLowerCase();
}
