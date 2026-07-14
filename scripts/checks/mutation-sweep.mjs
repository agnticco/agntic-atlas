#!/usr/bin/env node
/**
 * mutation-sweep — GENERATED mutants, not a hand-picked list.
 *
 * WHY THIS EXISTS, and why it is different from mutation-guard.mjs.
 *
 * `mutation-guard.mjs` re-introduces a CURATED list of ~23 historical defects.
 * It is regression protection and it is valuable — but it has a fatal blind spot
 * as a measure of test quality: **the builder writes the list**. So it can only
 * mutate the things the builder already thought of, which are precisely the
 * things he already wrote tests for. Twice in this phase the builder published a
 * mutation score ("7/7", "11/11") that an independent verifier falsified simply
 * by writing a WIDER list. A self-authored mutation score is a tautology.
 *
 * This sweep removes the builder from the loop. It walks the source, applies
 * mechanical operators to EVERY site that matches — including code nobody thought
 * to defend — and reports what survives. You cannot omit a mutation you didn't
 * think of, because you are not the one choosing them.
 *
 * A survivor is not automatically a bug. Some mutants are semantically equivalent
 * (a `??` default that is never reached; a log line). That is why this reports a
 * KILL RATE against a floor rather than demanding 100%: the floor makes it
 * impossible to ship a suite that cannot fail, while leaving room for genuinely
 * equivalent mutants. Read the survivors — that list IS the coverage report, and
 * it is the most honest one available.
 *
 * Operators (deliberately blunt — subtle mutants are a research project):
 *   COND_TRUE     if (x)         → if (true)        — the guard never fires
 *   COND_FALSE    if (x)         → if (false)       — the guard always fires
 *   NULLISH       a ?? b         → a                — the default silently vanishes
 *   THROW_GONE    throw new E()  → /* removed *\/     — the failure is swallowed
 *   NEGATE        !x             → x                 — the condition inverts
 *
 * Usage:  node scripts/checks/mutation-sweep.mjs [--floor 0.85] [--verbose]
 * Output: MUTATION-SWEEP-PASS + kill rate; non-zero exit below the floor.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SUITES = [
  'tests/workflows/control-flow.test.js',
  'tests/workflows/validator-config-keys.test.js',
  'tests/converger/gap-oracle.test.js',
  // Added by the test-adversary pass on Increment C. The sweep widened TARGETS to
  // workflow-validator.js + the three C files and the survivor list came back
  // showing that essentially the ENTIRE legacy publish gate (MISSING_NAME,
  // EMPTY_WORKFLOW, MISSING_TRIGGER, MISSING_DELIVER, SELF_LOOP, CYCLE_DETECTED,
  // UNKNOWN_CHANNEL, …) was pinned by nothing at all, and that `nodeForAssertion`
  // — the half of the oracle the elicitation graph actually calls — was executed
  // by no test whatsoever. A mutant is only killable by a suite the sweep RUNS.
  'tests/workflows/validator-rules.test.js',
  'tests/workflows/outcome-oracle.test.js',
  'tests/workflows/decision-analysis.test.js',
  // The five defects the test-adversary found in Increment C, now fixed and
  // pinned: the moat bypassed by one laundering hop (an `assemble` between a
  // freeform llm and a branch), a malformed rule silently covering the whole
  // table, duplicate assertion ids dropping an assertion, a phantom gap on
  // `integer` domains, and a null node crashing publish with a 500.
  'tests/converger/moat-adversarial.test.js',
  // P12 Increment D — the approval gate. Without this suite in the list, every
  // mutant the sweep generates in approval-store.js / approval-service.js / the
  // scheduler's resume path is unkillable BY CONSTRUCTION (no test that could
  // catch it is ever run), and the survivor list would report D's guards as
  // untested when in fact they were merely unexecuted. A mutant is only killable
  // by a suite the sweep RUNS.
  'tests/approvals/approval-store.test.js',
  // The ASK — Block Kit, the magic-link email, the in-app item — and each
  // channel's answer coming back. These paths were covered ONLY by
  // scripts/checks/approval-adversarial.mjs, which the sweep does not run, so it
  // reported the whole Slack/email surface as unkillable. It was right to: a
  // mutant is only killable by a suite that EXECUTES it, and "some other script
  // covers it" is how a guard ends up pinned by nothing.
  'tests/approvals/approval-channels.test.js',
  // The scheduler had NO unit tests at all — and it is the choke point every real
  // run passes through: the retry wrapper, the monthly-run PLAN CAP, the
  // suspended-tenant gate, and (since D) the pause and the resume. Widening
  // TARGETS to it, as the round-9 residual asked, made that visible immediately:
  // `if (allowed === false)` — the plan cap itself — could be inverted with the
  // whole suite still green.
  'tests/workflows/scheduler.test.js',
  // The moat + the human-gate + the catch-all guards (F1–F5) live here. Without
  // it in the sweep, the guards it pins — HUMAN_ANSWER_NOT_ROUTED, the `.decision`
  // moat, the silent-timeout write refusal at workflow-scheduler.js:603 — read as
  // unpinned survivors. "Some other suite (the gate) runs it" is exactly how a
  // guard ends up pinned by nothing the SWEEP can see. A mutant is only killable
  // by a suite the sweep RUNS.
  'tests/approvals/gate-adversarial.test.js',
  // P12 Increment E — the `decision` node. The table's run-time half: an
  // uncovered case THROWS rather than guessing, an AI-judged input is snapped to
  // its closed enum or the run stops, and the decision's output never becomes the
  // delivered body. Without this suite in the list every mutant in decision.js is
  // unkillable by construction, and the survivor list would report the newest
  // guards in the engine as untested when they were merely unexecuted.
  'tests/workflows/decision-node.test.js',
];

/**
 * The engine surface the phase owns. Deliberately NOT the whole repo: a sweep
 * that takes an hour gets disabled, and a disabled check protects nothing.
 *
 * Increment C widens this to `workflow-validator.js` and the three files that
 * carry the completeness proof. The round-9 readiness verifier flagged the
 * validator as graded only by the CURATED mutation-guard — i.e. only against
 * defects its own author had already thought of, which is the tautology this
 * sweep exists to break. C makes that worse, not better, if left alone: the moat
 * (LLM_INPUT_NOT_ENUM) and the outcome contract (UNSATISFIED_ASSERTION) both
 * live in the validator, and a guard nothing pins is a guard the next person can
 * delete with the gate still smiling.
 */
const TARGETS = [
  'src/workflows/flow-tester.js',
  'src/workflows/node-types/branch.js',
  'src/workflows/node-types/foreach.js',
  'src/workflows/node-types/human.js',
  'src/workflows/idempotency-store.js',
  // P12 Increment C — the completeness proof.
  'src/workflows/workflow-validator.js',
  'src/workflows/outcome-oracle.js',
  'src/workflows/decision-analysis.js',
  'src/converger/gap-scorer.js',
  // P12 Increment D — the approval gate. Closes the residual the round-9 verifier
  // recorded ("TARGETS excludes workflow-scheduler.js — widen it when a later
  // increment touches that file"), because D touches it: the resume path, the
  // timeout sweeper, and the ask deliverer all live there. These files decide
  // whether an approval can be FORGED, whether an unanswered one can quietly
  // become a yes, and whether one answer can resume a run twice — the sweep must
  // be able to tell whether anything would notice if they stopped working.
  'src/approvals/approval-store.js',
  'src/approvals/approval-service.js',
  'src/workflows/workflow-scheduler.js',
  // P12 Increment E — the decision table. `decision-analysis.js` (the PROOF) has
  // been in TARGETS since C; this is the EXECUTOR that has to agree with it. A
  // proof the engine does not honour is not a proof, so the two must be swept
  // together: the guard that makes an uncovered case throw, the one that snaps an
  // AI answer to the closed enum, and the one that refuses an unparseable
  // condition all live here.
  'src/workflows/node-types/decision.js',
];

const args    = process.argv.slice(2);
/**
 * THE FLOOR IS A RATCHET, NOT A TARGET.
 *
 * Its job is narrow and important: make it IMPOSSIBLE to ship a suite that cannot
 * fail. It is not a certificate of quality, and 100% is not the goal — a large
 * share of the surviving mutants are genuinely EQUIVALENT (a `?? null` on an
 * output field nobody asserts; a `typeof x === 'string'` guard where both branches
 * accept the same input shapes). Chasing those would mean writing tests that
 * assert implementation details rather than behaviour, which is how a suite gets
 * brittle without getting stronger.
 *
 * The real artefact of this script is the SURVIVOR LIST. Read it. That list is the
 * most honest coverage report available, and it is what found the untested
 * `escalate` flag, the untested branch/foreach throws, and the untested
 * JSON-string paths — none of which the hand-written mutation list touched,
 * because its author could only mutate what he had already thought of.
 *
 * RULE: when the rate goes up, RAISE this number. NEVER lower it to make a run
 * pass — lowering it is exactly the "weaken the check to force a pass" move the
 * constitution forbids. It was 0.65 when 69.5% was the measured rate; 0.72 when
 * 75.0% was; and 0.78 after the test-adversary pass on Increment C took the
 * measured rate to 81.7% (299/366) by pinning the legacy publish gate, the
 * `nodeForAssertion` backward-chainer, and the FEEL-A grammar — none of which any
 * test had ever executed.
 */
const FLOOR   = Number(args[args.indexOf('--floor') + 1]) || 0.78;
const VERBOSE = args.includes('--verbose');

/** Generate every mutant for one file. Line-oriented and blunt, on purpose. */
function mutantsFor(file) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const out = [];

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Skip comments and strings-only lines — mutating a comment proves nothing.
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    const at = (repl, op) => out.push({ file, line: i, op, before: line, after: repl });

    // if (cond) → if (true) / if (false)
    const m = /^(\s*)(\}\s*else\s+)?if\s*\((.+)\)\s*\{\s*$/.exec(line);
    if (m && m[3] !== 'true' && m[3] !== 'false') {
      at(`${m[1]}${m[2] ?? ''}if (true) {`,  'COND_TRUE');
      at(`${m[1]}${m[2] ?? ''}if (false) {`, 'COND_FALSE');
    }

    // a ?? b → a   (the default silently disappears — this is how the leak happened)
    if (/\?\?/.test(line) && !/\?\?=/.test(line)) {
      at(line.replace(/\s*\?\?\s*[^,;)\]}]+/, ''), 'NULLISH');
    }

    // throw new Error(...) on one line → removed (the failure is swallowed)
    if (/^\s*throw new Error\(.*\);\s*$/.test(line)) {
      at(line.replace(/^(\s*)throw/, '$1void 0 &&'), 'THROW_GONE');
    }
  });

  return out;
}

/**
 * Run EVERY suite in ONE node process, not one process per suite.
 *
 * Same suites, same pass/fail rule — `node --test a b c` exits non-zero if any
 * test in any file fails, exactly as the old loop did. This is a speed fix, not a
 * weakening, and it is worth spelling out because a diff against `scripts/` is how
 * a verifier catches a builder loosening their own gate.
 *
 * Why it matters: the old loop paid a full node startup PER SUITE, and a
 * SURVIVING mutant pays for all of them (it only short-circuits on a failure — and
 * a survivor, by definition, never fails). Increment D took SUITES from 7 to 10,
 * so every survivor went from 7 startups to 10 — and the sweep runs inside the
 * PHASE GATE. A gate slow enough to be annoying is a gate people start skipping,
 * which protects nothing. Node's own runner also executes the files concurrently,
 * so this is a large win rather than a marginal one.
 */
function suitesPass() {
  // TIMEOUT IS LOAD-BEARING, not a nicety. A mutant can make a test HANG rather
  // than fail — e.g. neutering `WorkflowScheduler.stop()` leaves a live
  // `setInterval` that keeps Node's event loop alive, so `node --test` reports
  // the failing assertion and then NEVER EXITS. Without a timeout, `execFileSync`
  // waits forever, the whole sweep stalls on that one mutant, and every killed
  // gate run orphans the hung worker (observed: 4-hour-old zombies, an 83-minute
  // sweep that would never finish). A hang is a FAILURE — the suite did not pass —
  // so a timeout that throws is the CORRECT kill, not a false one. 120s is ~50x
  // the normal run, so it never trips on a slow-but-passing suite.
  //
  // `killSignal: 'SIGKILL'` because a mutant that hangs on a timer will ignore
  // SIGTERM; `--test-force-exit` so the child tears down even with a live handle.
  //
  // 30s, not 120s. A full clean run of all suites is ~0.15s wall (they execute
  // concurrently), so 30s is ~200x headroom — no slow-but-passing suite trips it.
  // The old 120s was calibrated against a wrong guess (2-4s); the real cost of the
  // cap is that EVERY hang-inducing mutant (one that makes a test await something
  // that never resolves) pays it, and there are ~20, so 120s turned a ~2-minute
  // sweep into a ~45-minute one. A hang is still a FAILURE (correct kill); this
  // only bounds how long we wait to record it.
  try {
    execFileSync('node', ['--test', '--test-force-exit', ...SUITES],
      { stdio: 'pipe', timeout: 30_000, killSignal: 'SIGKILL' });
    return true;
  } catch { return false; }
}

// ── Run ──────────────────────────────────────────────────────────────────────
// ── Crash-safety: NEVER leave a mutation on disk. ────────────────────────────
// These harnesses mutate one source file at a time and restore it after running
// the suite. An interrupt (Ctrl-C, SIGTERM, a thrown error) in that window used
// to leave the mutation applied — and a Ctrl-C'd run could silently arm the
// cross-tenant-leak mutation in the working tree. So snapshot every target up
// front and restore ALL of them on any exit path. (Found by the independent
// verifier.)
const __PRISTINE = new Map(TARGETS.map(f => [f, readFileSync(f, 'utf8')]));
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

if (!suitesPass()) {
  console.error('mutation-sweep: the suites do not pass UNMUTATED. Fix that first.');
  process.exit(1);
}

const all = TARGETS.flatMap(mutantsFor);
console.log(`mutation-sweep: ${all.length} generated mutants across ${TARGETS.length} files\n`);

const survivors = [];
let killed = 0;

for (const mut of all) {
  const original = readFileSync(mut.file, 'utf8');
  const lines = original.split('\n');
  lines[mut.line] = mut.after;

  writeFileSync(mut.file, lines.join('\n'));
  let survived;
  try {
    survived = suitesPass();
  } catch {
    survived = false;      // a mutant that doesn't even parse counts as killed
  }
  writeFileSync(mut.file, original);   // ALWAYS restore

  if (survived) {
    survivors.push(mut);
    if (VERBOSE) console.log(`  ✗ SURVIVED ${mut.op.padEnd(10)} ${mut.file}:${mut.line + 1}  ${mut.before.trim().slice(0, 76)}`);
  } else {
    killed++;
    if (VERBOSE) console.log(`  ok killed  ${mut.op.padEnd(10)} ${mut.file}:${mut.line + 1}`);
  }
}

const rate = all.length ? killed / all.length : 1;
console.log(`\nkilled ${killed}/${all.length}  (${(rate * 100).toFixed(1)}%)   floor ${(FLOOR * 100).toFixed(0)}%\n`);

if (survivors.length) {
  console.log('SURVIVORS — each is a line the tests cannot tell was changed.');
  console.log('Some are genuinely equivalent mutants. The rest are your coverage holes.\n');
  for (const m of survivors) {
    console.log(`  ${m.op.padEnd(10)} ${m.file}:${m.line + 1}`);
    console.log(`             ${m.before.trim().slice(0, 96)}`);
  }
  console.log('');
}

if (rate < FLOOR) {
  console.error(`MUTATION-SWEEP FAIL: kill rate ${(rate * 100).toFixed(1)}% is below the ${(FLOOR * 100).toFixed(0)}% floor.`);
  console.error('The suite cannot detect changes to this much of the engine. A green suite is evidence of nothing');
  console.error('until you have watched it go red.');
  process.exit(1);
}

console.log(`MUTATION-SWEEP-PASS: ${(rate * 100).toFixed(1)}% of generated mutants killed.`);
