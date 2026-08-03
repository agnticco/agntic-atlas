/**
 * A RETIRED CHECK MAY NOT BLOCK A RUN — AND A REFERENCE IS DESCRIBED, NOT PRINTED.
 *
 * Two findings from one browser session (prod, 2026-08-02), driving eight workflows
 * of eight different shapes. Seven reached "Contract kept". The eighth is the first
 * half of this file; the second half is a defect two of the eight displayed.
 *
 * ── 1. The removal was incomplete, and the leftover half blocked a good workflow ──
 *
 * `UNSATISFIED_ASSERTION` asks whether the promise's `target` STRING matches a
 * step's destination. That comparison was removed from the TEST earlier the same
 * day (src/workflows/delivery-verdict.js) after producing no findings about a wrong
 * workflow and repeatedly failing correct ones. The BUILD-time half was left alone
 * deliberately, as a separate decision.
 *
 * Then a calendar workflow — email arrives → put a 30-minute hold on the calendar →
 * reply to confirm — had BOTH its test runs refused before executing:
 *
 *     run.invalid   codes: ["UNSATISFIED_ASSERTION"]   ×2
 *
 * Its promise said `calendar:Connected Calendar`. Its step wrote to the account's
 * default calendar. **The same place, described two ways.** The retired rule blocked
 * it through a door the removal did not cover, and the test never got to look at the
 * one thing that could settle it.
 *
 * SCOPED TO THE RUN PATH ONLY. The validator is untouched and PUBLISHING is
 * untouched — `workflowService.create` validates independently and still sees this
 * code. What changes is that a disagreement about what a destination string means
 * can no longer stop you finding out whether the workflow works.
 *
 * ── 2. A raw template reached the last sentence before Run test ──────────────
 *
 *     each destination (a new Google Calendar event, {{extract_email.sender_email}})
 *     is confirmed reachable, not delivered to.
 *
 * Seen on two of the eight. The destination is genuinely unknowable until the run
 * (it is whoever emailed), so there is no literal to print — but "the sender email
 * from Extract email" is checkable by a person and braces are not. `_plainPreview`
 * is the SAME rule the approval card already applies to its own rows.
 *
 * ── Mutations, run by hand (2026-08-02) ──────────────────────────────────────
 *
 *   M1  UNSATISFIED_ASSERTION blocks a run again      → 2 red
 *   M2  the exemption widens to every error           → 3 red
 *   M3  the disclosure prints the reference raw again → 2 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SERVER = readFileSync(path.join(ROOT, 'src/api/server.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────

describe('the run path refuses only what a run can actually be stopped by', () => {
  // The filter sits inside the run handler's try/catch, which cannot be lifted out
  // and executed; the EXPRESSION is the subject, never the words around it.
  const gate = (() => {
    const i = SERVER.indexOf('const RETIRED_ON_RUN');
    assert.notEqual(i, -1, 'the run-path exemption is gone — re-point this, do not delete it');
    return SERVER.slice(i, SERVER.indexOf('\n', SERVER.indexOf('.filter(i =>', i)) );
  })();

  test('UNSATISFIED_ASSERTION no longer stops a test run', () => {
    assert.match(gate, /UNSATISFIED_ASSERTION/,
      'the check retired from the test must not block the test from happening');
    assert.match(gate, /!RETIRED_ON_RUN\.has\(i\.code\)/,
      'it must be filtered out of what blocks, not merely listed');
  });

  test('and EVERY other error still does', () => {
    // The anti-widening direction, and the one that matters. A spec with a bad
    // template reference, an unknown config key or a removed node type must still be
    // refused BEFORE it reaches a live third-party API — that is why this validation
    // is on the run path at all.
    assert.match(gate, /i\.severity === 'error'/,
      'the severity filter must survive — this is an exemption, not an amnesty');
    const codes = (gate.match(/'[A-Z_]{4,}'/g) || []);
    assert.deepEqual(codes, ["'UNSATISFIED_ASSERTION'"],
      'exactly one code is exempt; anything else here is a rule being quietly dropped: ' + codes.join(','));
  });

  test('PUBLISHING is untouched — this is scoped to the run path', () => {
    // `workflowService.create` validates independently. Whether the build-time half
    // should also go is a SEPARATE decision and has not been made; silently taking
    // it here would be making it.
    const i = SERVER.indexOf('const RETIRED_ON_RUN');
    const before = SERVER.slice(0, i);
    assert.ok(before.includes("app.post('/workflows/run'") || before.includes('runWorkflowHandler'),
      'the exemption must live in the run handler, not somewhere every caller sees it');
    assert.equal((SERVER.match(/RETIRED_ON_RUN/g) || []).length, 2,
      'declared once and used once — a second site would be a second policy');
  });
});

describe('the last sentence before Run test names no raw references', () => {
  const src = (() => {
    const i = HTML.indexOf('_runTestDisclosure()');
    assert.notEqual(i, -1, '_runTestDisclosure is gone — re-point this');
    return HTML.slice(i, HTML.indexOf('\n  }', i));
  })();

  test('a destination carrying a template is described in words', () => {
    assert.match(src, /_plainPreview\(String\(where\), spec\.nodes\)/,
      'a `{{...}}` reaching this sentence is the defect — it must be resolved to the step it refers to');
  });

  test('and it uses the SAME rule as the approval card, not a second copy', () => {
    // Two answers to "how do I describe a reference" is how one screen ends up
    // contradicting the next — the defect this file's sibling already records for
    // `_destinationOf` vs `_deliverySentence`.
    assert.match(src, /_destinationOf\(/,
      'where it goes is still answered by the one rule that owns that question');
    assert.doesNotMatch(src, /replace\(\s*\/\\\{\\\{/,
      'no hand-rolled template stripping here — that is a second copy by another name');
  });

  test('a literal destination is left exactly as it was', () => {
    // The anti-false-positive direction: `_plainPreview` runs ONLY when a template
    // is present, so "#atlas-test-temp" and "your Atlas inbox" are untouched.
    assert.match(src, /if \(where && \/\\\{\\\{\/\.test\(String\(where\)\)\)/,
      'the rewrite must be conditional on a reference actually being there');
  });
});
