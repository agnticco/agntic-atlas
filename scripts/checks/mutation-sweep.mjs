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
];

/**
 * The engine surface Increment B owns. Deliberately NOT the whole repo: a sweep
 * that takes an hour gets disabled, and a disabled check protects nothing.
 */
const TARGETS = [
  'src/workflows/flow-tester.js',
  'src/workflows/node-types/branch.js',
  'src/workflows/node-types/foreach.js',
  'src/workflows/node-types/human.js',
  'src/workflows/idempotency-store.js',
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
 * constitution forbids. It was 0.65 when 69.5% was the measured rate.
 */
const FLOOR   = Number(args[args.indexOf('--floor') + 1]) || 0.65;
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

function suitesPass() {
  for (const s of SUITES) {
    try { execFileSync('node', ['--test', s], { stdio: 'pipe' }); }
    catch { return false; }
  }
  return true;
}

// ── Run ──────────────────────────────────────────────────────────────────────
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
