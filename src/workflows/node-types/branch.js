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
 * The value references a branch may route on. DELIBERATELY TWO, not "any field".
 *
 *   <id>            the node's output
 *   <id>.output     the same thing, said out loud
 *   <id>.decision   a `human` node's answer — the shape converger-v2 §7.1
 *                   documents ("{{approve_send.decision}}"), and the one anybody
 *                   writing an approval gate reaches for first.
 *
 * It cannot be widened to an arbitrary field path, and that is the moat rather
 * than fussiness: `closedDomainOf()` declares what values a node can EMIT, and
 * every branch rule — the LLM_INPUT_NOT_ENUM allowlist, BRANCH_CASE_NOT_IN_ENUM —
 * is a claim about THAT value. Route on `classify.confidence` instead and the
 * declared domain describes something you are no longer looking at: the case
 * check passes, nothing matches at run time, and the mandatory catch-all quietly
 * swallows every run. A field whose domain nobody declared is a field a branch
 * may not read.
 *
 * @see workflow-validator.js — BRANCH_BAD_ON parses the SAME shapes. They must
 *      agree, or the validator accepts a reference the engine cannot resolve.
 */
export const ON_REF = /^([a-z0-9_-]+)(?:\.(output|decision))?$/i;

/**
 * Resolve `on` against the run context. FlowTester leaves `on` RAW (it is a
 * reference, not a template — substituting it would replace it with the VALUE,
 * which is indistinguishable from a step id), so every form arrives here intact.
 */
function resolveOn(on, ctx) {
  if (on == null) return undefined;
  const raw = String(on).trim();
  const inner = raw.replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
  const m = ON_REF.exec(inner);
  if (m) {
    const id    = m[1];
    const field = m[2]?.toLowerCase();
    if (ctx?.outputs?.has(id)) {
      const out = ctx.outputs.get(id);
      if (field !== 'decision') return out;

      // `.decision` on something that has no decision. The step ran and produced
      // a value, but not the one being asked for — a `human` node's output is
      // {decision, by, at, channel} and nothing else has a `decision` at all.
      // Returning undefined here would fall through to the catch-all, i.e. route
      // 100% of runs down the "not approved" path, silently, forever. Refuse.
      if (out == null || typeof out !== 'object' || out.decision === undefined) {
        throw new Error(
          `branch routes on "${raw}", but step "${id}" produced no decision (its output is ${typeof out}). ` +
          'Only a human step has a decision. Refusing to fall through to the catch-all — that would silently misroute every run.',
        );
      }
      return out.decision;
    }

    // The step EXISTS in the spec but produced nothing on this leg — an upstream
    // branch skipped it. That is not an error: the value genuinely isn't there,
    // so nothing can match, and the run takes the catch-all. Which is precisely
    // what a mandatory catch-all is for. (Throwing here failed an entirely valid
    // workflow — two branches where the second routes on a step the first ruled
    // out. The validator accepts that shape, and should: it is well-defined.)
    if (ctx?.nodeIds?.has(id)) return undefined;

    // No step of that name exists at all — a typo. The validator rejects this as
    // BRANCH_BAD_ON, but the engine must not depend on the validator having run:
    // specs already in the database predate the rule. Fail loudly rather than
    // fall through to the catch-all, which would silently misroute 100% of runs.
    throw new Error(
      `branch routes on "${raw}", but no step "${id}" exists in this workflow. ` +
      'Refusing to fall through to the catch-all — that would silently misroute every run.',
    );
  }
  // Not a step reference — a literal.
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
