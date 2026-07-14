#!/usr/bin/env node
/**
 * mutation-guard — does the test suite actually have teeth?
 *
 * WHY THIS EXISTS. P12 Increment B failed independent verification SEVEN times.
 * Every single defect — a cross-tenant data leak, a resumed approval delivering
 * truncated content, a ruled-out branch that ran and delivered, a declined charge
 * that still sent the receipt — reached candidate state **behind a fully green
 * suite**, because a test passed for the wrong reason:
 *
 *   · a validator test that only asserted the REJECTION (it would have passed if
 *     the rule were `if (true)` — and the rule was, in fact, rejecting every
 *     valid spec);
 *   · a resume test whose stub LLM returned 16 characters, so it never crossed
 *     the 2000-char truncation cap it existed to catch;
 *   · a test that asserted a delivery RAN, never WHAT IT SENT;
 *   · idempotency tests that hand-passed an option no production caller passes.
 *
 * The gate could not see any of it. `p12.sh` checked that the test file EXISTS
 * and PASSES, and grepped the validator for symbol names. A suite of 70 tests
 * that cannot fail satisfies that perfectly. **The gate measured the existence of
 * tests, not their power.**
 *
 * So this closes that hole mechanically: it re-introduces each bug and requires
 * the suite to FAIL. A guard whose mutation survives is a guard nothing pins —
 * which means the next person to touch it can delete it and the gate will smile.
 *
 * Adding a check, never weakening one (CLAUDE.md, Gates).
 *
 * Usage:  node scripts/checks/mutation-guard.mjs
 * Output: MUTATION-GUARD-PASS on success; non-zero exit + the survivors on failure.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * ALL suites that could pin a guard — not just the one you have in mind.
 * On its first run this harness reported UNKNOWN_CONFIG_KEY as unpinned, because
 * it only ran control-flow.test.js while that guard is pinned by
 * validator-config-keys.test.js. A mutation harness that runs too few suites
 * manufactures false survivors, which is its own kind of lie.
 */
const SUITES = [
  'tests/workflows/control-flow.test.js',
  'tests/workflows/validator-config-keys.test.js',
  // P12 Increment E. ADDED, not swapped. Without it the two `decision` guards
  // below are unkillable BY CONSTRUCTION — the only suite that exercises them is
  // never run, so the guard would report them as surviving (correctly) while the
  // tests that pin them sat green in another file. "Some other suite covers it"
  // is exactly how a guard ends up pinned by nothing (CLAUDE.md, Increment D:
  // the Slack/email surface).
  'tests/workflows/decision-node.test.js',
  // The six defects the test-adversary + the verifier found in Increment E, now
  // fixed. These are the suites that pin them.
  'tests/workflows/decision-adversarial.test.js',
  'tests/workflows/decision-pinning.test.js',
  // Multiple destinations: what each one RECEIVED, not that delivery ran.
  'tests/workflows/fan-out.test.js',
  // P12 Increment F — the last open config hole, closed.
  'tests/workflows/connector-schema.test.js',
  'tests/converger/destination-adversarial.test.js',
  'tests/converger/destination-mapping.test.js',
  'tests/workflows/foreach-config-adversarial.test.js',
];

/**
 * Each entry re-introduces one real, historical defect. `find` MUST match the
 * current source — a mutation that silently fails to apply is a mutation that
 * proves nothing, and that mistake was itself made here once.
 */
const MUTATIONS = [
  // ── the cross-tenant leak (round 7) ──────────────────────────────────────
  { file: 'src/workflows/flow-tester.js',
    name: 'idempotency scope falls back to "unscoped" (cross-tenant leak)',
    find: '    if (!tenantId || !workflowId) {', repl: '    if (false) {' },
  { file: 'src/workflows/flow-tester.js',
    name: 'tenantId dropped from the idempotency scope',
    find: '    const scope = `${tenantId}:${workflowId}:', repl: '    const scope = `${workflowId}:' },
  { file: 'src/workflows/workflow-scheduler.js',
    name: 'the scheduler stops passing tenantId',
    find: '        tenantId:   workflow.tenant_id,', repl: '' },

  // ── the lossy checkpoint (round 3/4) ─────────────────────────────────────
  { file: 'src/workflows/flow-tester.js',
    name: 'checkpoint carries the display-SHRUNK outputs (truncates the work product)',
    find: '            outputs:  Object.fromEntries(outputs),',
    repl: '            outputs:  Object.fromEntries([...outputs].map(([k,v]) => [k, this._shrinkOutput(v)])),' },
  { file: 'src/workflows/flow-tester.js',
    name: 'checkpoint drops `live` (edge liveness re-derived)',
    find: '            live:     Object.fromEntries(liveInto),', repl: '            live:     {},' },
  { file: 'src/workflows/flow-tester.js',
    name: 'checkpoint drops `ruledOut` (ruled-out branch revives on resume)',
    find: '            ruledOut: [...ruledOut],', repl: '            ruledOut: [],' },
  { file: 'src/workflows/flow-tester.js',
    name: 'lastOutput recomputed on replay (delivers a failed step\'s error blob)',
    find: '        continue;\n      }\n\n      // ── The durable pause',
    repl: '        if (prior !== undefined && !CONTROL_TYPES.has(node.type)) lastOutput = prior;\n        continue;\n      }\n\n      // ── The durable pause' },

  // ── control nodes leaking into the work product (round 4/7) ──────────────
  //
  // ANCHORS RE-GROUNDED (P12 Increment E) — `decision` joined both sets, so the
  // exact-match `find` strings drifted and the mutations stopped APPLYING. The
  // guard caught that itself and failed the gate, which is the whole point of
  // refusing to pass on an unapplied mutation: a mutation that cannot be applied
  // is not a check, it is a blank line that reports "ok".
  //
  // The MUTATIONS ARE UNCHANGED — each still deletes one type from the set and
  // still requires the suite to go red. `decision` gets its own two entries below,
  // because a guard that covers a set must cover every member of it: a `decision`
  // silently dropped from CONTROL_TYPES delivers {"value":"P1","rule":{…}} to the
  // customer instead of the draft, exactly as `branch` and `human` did.
  { file: 'src/workflows/flow-tester.js',
    name: 'CONTROL_TYPES loses `branch` (router bookkeeping delivered to the customer)',
    find: "const CONTROL_TYPES = new Set(['branch', 'human', 'decision', 'deliver']);",
    repl: "const CONTROL_TYPES = new Set(['human', 'decision', 'deliver']);" },
  { file: 'src/workflows/flow-tester.js',
    name: 'CONTROL_TYPES loses `human` (approval record delivered to the customer)',
    find: "const CONTROL_TYPES = new Set(['branch', 'human', 'decision', 'deliver']);",
    repl: "const CONTROL_TYPES = new Set(['branch', 'decision', 'deliver']);" },
  { file: 'src/workflows/flow-tester.js',
    name: 'CONTROL_TYPES loses `decision` (the audit record delivered to the customer)',
    find: "const CONTROL_TYPES = new Set(['branch', 'human', 'decision', 'deliver']);",
    repl: "const CONTROL_TYPES = new Set(['branch', 'human', 'deliver']);" },
  { file: 'src/workflows/node-types/_node-input.js',
    name: 'NON_CONTENT_TYPES loses `branch`/`human` (control output fed to an AI step)',
    find: "new Set(['trigger', 'deliver', 'branch', 'human', 'decision'])",
    repl: "new Set(['trigger', 'deliver'])" },
  { file: 'src/workflows/node-types/_node-input.js',
    name: 'NON_CONTENT_TYPES loses `decision` (the audit record fed to an AI step)',
    find: "new Set(['trigger', 'deliver', 'branch', 'human', 'decision'])",
    repl: "new Set(['trigger', 'deliver', 'branch', 'human'])" },

  // ── foreach (rounds 5/6) ─────────────────────────────────────────────────
  { file: 'src/workflows/flow-tester.js',
    name: 'foreach bypasses the policy path (idempotency + retry silently skipped in a loop)',
    find: '      runSubNode: (subNode, subCtx) => this._executeNode(subNode, subCtx, {',
    repl: '      runSubNode: (subNode, subCtx) => this._runNode(subNode, subCtx) ?? this._executeNode(subNode, subCtx, {' },
  { file: 'src/workflows/flow-tester.js',
    name: 'foreach `steps` pre-substituted ({{item}} silently becomes "")',
    find: '      cfg = { ...this._substitute(rest, ctx), steps };   // `steps` stay RAW',
    repl: '      cfg = this._substitute(rawCfg, ctx);' },
  { file: 'src/workflows/node-types/foreach.js',
    name: 'foreach default maxItems unbounded (cost incident)',
    find: 'cfg.maxItems ?? DEFAULT_MAX_ITEMS', repl: 'cfg.maxItems ?? Infinity' },

  // ── branch routing (rounds 5/6) ──────────────────────────────────────────
  { file: 'src/workflows/flow-tester.js',
    name: 'branch `on` gets template-substituted (mainline {{x.output}} form crashes)',
    find: '      cfg = { ...this._substitute(rest, ctx), on };      // `on` stays RAW',
    repl: '      cfg = this._substitute(rawCfg, ctx);' },
  { file: 'src/workflows/node-types/branch.js',
    name: 'branch throws on a legitimately SKIPPED step (crashes a valid workflow)',
    find: '    if (ctx?.nodeIds?.has(id)) return undefined;', repl: '    // removed' },
  { file: 'src/workflows/node-types/branch.js',
    name: 'branch falls through to the catch-all on a typo (silent 100% misroute)',
    find: '    throw new Error(\n      `branch routes on "${raw}", but no step "${id}" exists',
    repl: '    return raw; throw new Error(\n      `branch routes on "${raw}", but no step "${id}" exists' },

  // ── validator rules — each must be pinned in BOTH directions ─────────────
  { file: 'src/workflows/workflow-validator.js',
    name: 'NON_EXHAUSTIVE_BRANCH disabled (a branch can silently do nothing)',
    find: "        if (!cases.some(c => String(c?.when).trim() === CATCH_ALL)) {", repl: '        if (false) {' },
  { file: 'src/workflows/workflow-validator.js',
    name: 'BRANCH_BAD_ON disabled (typo routes 100% of traffic to the catch-all)',
    find: '        } else if (!onId || !seenIds.has(onId)) {', repl: '        } else if (false) {' },
  { file: 'src/workflows/workflow-validator.js',
    name: 'BRANCH_BAD_ON always fires (rejects every valid branch)',
    find: '        } else if (!onId || !seenIds.has(onId)) {', repl: '        } else if (true) {' },
  { file: 'src/workflows/workflow-validator.js',
    name: 'ON_ERROR_ROUTE_NO_EDGE always fires (rejects every valid route_to)',
    find: '        } else if (!edgeSet.has(edgeKey(node.id, target))) {', repl: '        } else if (true) {' },
  { file: 'src/workflows/workflow-validator.js',
    name: 'UNKNOWN_CONFIG_KEY disabled (a hallucinated config key ships)',
    find: "    if (typeDef && typeDef.configPolicy !== 'open' && capResolved) {", repl: '    if (false) {' },
  // …and the half of it Increment F added: a connector-action's params are checked
  // against the SELECTED CAPABILITY's own schema. Dropping it re-opens the last open
  // config hole — `tableName` on an Airtable create ships, the handler ignores it,
  // and the record lands in a table nobody chose.
  { file: 'src/workflows/workflow-validator.js',
    name: 'connector-action params stop being checked against the capability schema',
    find: '      for (const f of capSchema) declared.add(f.key);',
    repl: '      for (const f of []) declared.add(f.key);' },
  { file: 'src/workflows/workflow-validator.js',
    name: 'the capability check judges what it CANNOT resolve (false rejections with no registry)',
    find: '    const capResolved = !capBearing || !!this._resolveCapability(capBearing);',
    repl: '    const capResolved = true;' },

  // ── control node blob leaking from INSIDE a loop (round 8) ───────────────
  { file: 'src/workflows/node-types/foreach.js',
    name: 'foreach sub-loop lets a control node become `last` (branch blob delivered per item)',
    find: 'if (!CONTROL_SUBSTEP_TYPES.has(step.type)) last = out;',
    repl: 'last = out;' },
  { file: 'src/workflows/node-types/foreach.js',
    name: 'BRANCH_IN_FOREACH disabled (a branch in a loop validates clean)',
    find: "    if (steps.some(s => s?.type === 'branch')) {", repl: '    if (false) {' },

  // ── the approval gate's only integrity constraint in B ───────────────────
  { file: 'src/workflows/node-types/human.js',
    name: 'human accepts an answer outside the declared set',
    // Anchor re-grounded (P12 Increment D): the `run()` allow-check dropped its
    // `allowed.length &&` guard when `allowedDecisions()` began ALWAYS returning a
    // non-empty set (approve|reject|timeout). Same line, same defect under
    // mutation (a human accepting an off-enum answer) — just the current text.
    find: '    if (!allowed.includes(String(provided.decision))) {', repl: '    if (false) {' },
  { file: 'src/workflows/node-types/human.js',
    name: 'human defaults to approved when no decision was given',
    find: '    if (!provided || !provided.decision) {', repl: '    if (false) {' },

  // ── P12 Increment E: the six defects the test-adversary and the verifier found ──
  // Every one reached candidate state behind a green suite, and three of them were
  // SILENT — the workflow reported success while doing the wrong thing. They are
  // history now, which is exactly what this list is for.
  { file: 'src/workflows/node-types/foreach.js',
    name: 'CONTROL_SUBSTEP_TYPES loses `decision` (the decided VALUE delivered to the customer, once per row)',
    find: "const CONTROL_SUBSTEP_TYPES = new Set(['branch', 'human', 'decision']);",
    repl: "const CONTROL_SUBSTEP_TYPES = new Set(['branch', 'human']);" },
  { file: 'src/workflows/node-types/foreach.js',
    name: 'DECISION_IN_FOREACH disabled (a decision in a loop publishes clean)',
    find: "    if (steps.some(s => s?.type === 'decision')) {", repl: '    if (false) {' },
  { file: 'src/workflows/node-types/decision.js',
    name: 'coerce() stops checking an enum value against its declared set (free text takes the catch-all)',
    find: '    if (!hit) {\n      throw new Error(\n        `decision input "${input.key}" is ${JSON.stringify(String(value).slice(0, 80))}, which is not one of its `',
    repl: '    if (false) {\n      throw new Error(\n        `decision input "${input.key}" is ${JSON.stringify(String(value).slice(0, 80))}, which is not one of its `' },
  { file: 'src/workflows/node-types/decision.js',
    name: 'coerce() lets a NULL extracted field decide via the catch-all',
    find: '  if (value === null) {', repl: '  if (false) {' },
  { file: 'src/workflows/node-types/decision.js',
    name: 'pickCategory accepts an AMBIGUOUS answer (a negated answer classifies as the value it negates)',
    find: '  return hits.length === 1 ? hits[0] : null;',
    repl: '  return hits.length >= 1 ? hits[0] : null;' },
  { file: 'src/workflows/flow-tester.js',
    name: "a decision's `from` gets template-substituted (the reference becomes the value; the engine hunts for a step named after the prose)",
    find: "      const { inputs, ...rest } = rawCfg;\n      cfg = { ...this._substitute(rest, ctx), inputs };  // `inputs` stay RAW",
    repl: '      cfg = this._substitute(rawCfg, ctx);' },
  { file: 'src/workflows/decision-analysis.js',
    name: 'the analyser reads an enum literal case-SENSITIVELY while the engine reads it case-insensitively',
    find: '  const declared = (w) => atoms.find(a => String(a).toLowerCase() === String(w).toLowerCase());',
    repl: '  const declared = (w) => atoms.find(a => String(a) === String(w));' },
  { file: 'src/workflows/decision-analysis.js',
    name: 'a comma list silently drops its undeclared members (the rule covers less than its author believes)',
    find: '  if (wanted.some(w => !declared(w))) return { atoms: new Set(), ok: false };',
    repl: '  if (false) return { atoms: new Set(), ok: false };' },

  // ── The residuals the independent verifier left after the E fix ────────────
  // Each of these was CORRECT CODE PINNED BY NOTHING — deletable with the whole
  // suite green. That is the state a guard is in right before someone deletes it.
  { file: 'src/workflows/node-types/llm.js',
    name: 'llm classify reverts to the substring scan (THE sanctioned LLM→decision door: a negated answer classifies as the value it negates)',
    find: '      const picked = pickCategory(raw, categories);',
    repl: "      const picked = categories.find(c => c.toLowerCase() === String(raw).trim().toLowerCase()) ?? categories.find(c => String(raw).toLowerCase().includes(c.toLowerCase()));" },
  { file: 'src/workflows/workflow-validator.js',
    name: 'the moat re-reads the table privately (a JSON-string config.inputs skips LLM_INPUT_NOT_ENUM)',
    find: '        const inputs = tableOf(node).inputs;',
    repl: "        const inputs = Array.isArray(node.inputs) ? node.inputs : Array.isArray(node.config?.inputs) ? node.config.inputs : [];" },
  { file: 'src/workflows/decision-analysis.js',
    name: 'the engine reads an UNDECLARED enum literal as a plain no-match (and not(<undeclared>) as matching EVERYTHING)',
    find: '  if (declared.length && wanted.some(w => !declared.includes(w.toLowerCase()))) {',
    repl: '  if (false) {' },
  // ── Multiple destinations (found by a load-bearing test, 2026-07-14) ──────
  { file: 'src/workflows/flow-tester.js',
    name: "CONTROL_TYPES loses `deliver` (the SECOND destination in a fan-out ships the FIRST one's receipt)",
    find: "const CONTROL_TYPES = new Set(['branch', 'human', 'decision', 'deliver']);",
    repl: "const CONTROL_TYPES = new Set(['branch', 'human', 'decision']);" },

  // ── P12 Increment F: the nine defects the review pair found ───────────────
  { file: 'src/workflows/workflow-validator.js',
    name: 'the config checks stop recursing into a foreach (a loop launders every one of them)',
    find: '          this._checkNodeConfig(sub, issues, { inForeach: node });',
    repl: '          void sub;' },
  { file: 'src/workflows/workflow-validator.js',
    name: 'UNCHECKABLE_WRITE_FIELDS disabled (a templated `fields` picks its columns at RUN time)',
    find: "      if (typeof f === 'string' && /\\{\\{/.test(f)) {",
    repl: '      if (false) {' },
  { file: 'src/workflows/outcome-oracle.js',
    name: 'the outcome oracle goes blind inside a foreach (the shape F teaches cannot satisfy its own assertion)',
    find: "  if (node.type === 'foreach') {", repl: '  if (false) {' },
  { file: 'src/workflows/outcome-oracle.js',
    name: 'a JSON-string `fields` makes NO claim (the assertion passes on invented columns)',
    find: "  if (typeof fields === 'string') {\n    try { fields = JSON.parse(fields); } catch { return null; }\n  }",
    repl: '  if (typeof fields === \'string\') return null;' },
  { file: 'src/converger/elicitation-graph.js',
    name: 'fillDestination ships the hallucinated columns when NOTHING maps',
    find: '    if (columnsRead && config.fields && typeof config.fields === \'object\') {\n      config.fields = fields ?? {};',
    repl: '    if (columnsRead && config.fields && fields && typeof config.fields === \'object\') {\n      config.fields = fields;' },
  { file: 'src/converger/elicitation-graph.js',
    name: 'the outcome is NOT restated in the real column names (complete but unpublishable — on the SUCCESS path)',
    find: '    const outcome = rewriteAssertionFields(state.draft?.outcome, renames, columns);',
    repl: '    const outcome = state.draft?.outcome;' },
  { file: 'src/converger/elicitation-graph.js',
    name: 'the mapping model is trusted (it invents a column and we write it)',
    find: '    const column   = proposed == null ? null : real.get(String(proposed).toLowerCase()) ?? null;',
    repl: '    const column   = proposed == null ? null : String(proposed);' },

  { file: 'src/workflows/node-types/decision.js',
    name: 'pickCategory crosses a non-ASCII letter ("urgentísimo" classifies as "urgent")',
    find: "  return new RegExp(`(?:^|[^\\\\p{L}\\\\p{N}_-])${esc}(?:[^\\\\p{L}\\\\p{N}_-]|$)`, 'iu');",
    repl: "  return new RegExp(`(?:^|[^\\\\w-])${esc}(?:[^\\\\w-]|$)`, 'i');" },
];

const read  = (f) => readFileSync(f, 'utf8');
const write = (f, s) => writeFileSync(f, s);

/** Do ALL the suites pass? A guard is unpinned only if NONE of them catches it. */
function suitePasses() {
  for (const suite of SUITES) {
    try {
      execFileSync('node', ['--test', suite], { stdio: 'pipe' });
    } catch {
      return false;
    }
  }
  return true;
}

console.log(`mutation-guard: ${MUTATIONS.length} mutations against ${SUITES.length} suite(s)\n`);

// ── Crash-safety: NEVER leave a mutation on disk. ────────────────────────────
// These harnesses mutate one source file at a time and restore it after running
// the suite. An interrupt (Ctrl-C, SIGTERM, a thrown error) in that window used
// to leave the mutation applied — and a Ctrl-C'd run could silently arm the
// cross-tenant-leak mutation in the working tree. So snapshot every target up
// front and restore ALL of them on any exit path. (Found by the independent
// verifier.)
const __PRISTINE = new Map([...new Set(MUTATIONS.map(m => m.file))].map(f => [f, readFileSync(f, 'utf8')]));
let __restored = false;
function __restoreAll() {
  if (__restored) return;
  __restored = true;
  for (const [f, src] of __PRISTINE) {
    try { if (readFileSync(f, 'utf8') !== src) writeFileSync(f, src); } catch { /* best effort */ }
  }
}
process.on('exit', __restoreAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { __restoreAll(); process.exit(130); });
}
process.on('uncaughtException', (e) => { __restoreAll(); console.error(e); process.exit(1); });

if (!suitePasses()) {
  console.error('mutation-guard: the suites do not pass UNMUTATED. Fix that first.');
  process.exit(1);
}

const survivors = [];
const noops     = [];

for (const m of MUTATIONS) {
  const original = read(m.file);

  // A mutation that does not apply proves nothing — and mistaking a no-op patch
  // for a passing guard is a mistake that was actually made here. Fail loudly.
  if (!original.includes(m.find)) {
    noops.push(m);
    console.log(`  ??  ${m.name}\n      (anchor not found in ${m.file} — the mutation did NOT apply)`);
    continue;
  }

  write(m.file, original.replace(m.find, m.repl));
  const survived = suitePasses();   // suite still green ⇒ nothing pins this guard
  write(m.file, original);          // always restore

  if (survived) {
    survivors.push(m);
    console.log(`  ✗   SURVIVED — ${m.name}`);
  } else {
    console.log(`  ok  killed   — ${m.name}`);
  }
}

console.log('');

if (noops.length) {
  console.error(`mutation-guard FAIL: ${noops.length} mutation(s) did not apply — the anchors have drifted.`);
  console.error('A mutation that cannot be applied is not a passing check. Re-ground the anchors against the source.');
  for (const m of noops) console.error(`  · ${m.name}  [${m.file}]`);
  process.exit(1);
}

if (survivors.length) {
  console.error(`mutation-guard FAIL: ${survivors.length} guard(s) SURVIVED deletion with the suite still green.`);
  console.error('Each is a guard that nothing pins — the next person to touch it can delete it and this gate will smile.');
  console.error('Every one of these was, at some point, a real defect that shipped behind a green suite.\n');
  for (const m of survivors) console.error(`  · ${m.name}\n      ${m.file}`);
  process.exit(1);
}

console.log(`MUTATION-GUARD-PASS: all ${MUTATIONS.length} mutations killed — the suite has teeth.`);
