/**
 * A SHORT MESSAGE IS STILL A MESSAGE.
 *
 * ── Witnessed on prod, 2026-08-03 ───────────────────────────────────────────
 *
 * A Slack-triggered workflow was handed a real message and recorded its run as a
 * FAILURE. The seeded context was measured at the point it was applied:
 *
 *   seeded: true   type: string   length: 62
 *   preview: "New Slack message in <#C0B9AFWCSLB> from <@U0B3LM5KRGV>:\n\ntest"
 *
 * Perfect plumbing. The message body was the word "test", and every content step
 * the converger writes opens with a guard clause telling it to emit
 * `ERROR: required data not found` when its input is missing. The model judged
 * there was nothing worth summarising and did what it was told; the scheduler read
 * the sentinel and marked the workflow broken.
 *
 * **Posting "test" is the first thing anyone does to check an automation works**,
 * and the product answered by telling them it was broken. That is the product
 * misdescribing itself — the class of defect this whole stretch has been about.
 *
 * ── What changed, and what deliberately did not ─────────────────────────────
 *
 * The guard STAYS. It exists because an llm node handed genuinely nothing used to
 * invent content, which is worse than any refusal. What changed is its threshold:
 * it fires on input that is ENTIRELY absent, and never on input that is merely
 * short. "Any content, however short, counts as present."
 *
 * This is a PROMPT change, and a prompt is a belief about model behaviour that is
 * pinned by nothing. The test below pins the INSTRUCTION only — that the guard is
 * still demanded, and that it now carries its own limit. Whether the model obeys
 * is not provable here, and the honest place to see it is a real short message
 * through a real workflow.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROMPTS = readFileSync(path.join(ROOT, 'src/converger/prompts.js'), 'utf8');

describe('the guard against invention is still demanded', () => {
  test('an llm step consuming connector output must still carry one', () => {
    // Never weaken this to "sometimes". A step handed nothing that invents content
    // is the defect the guard exists for, and it is worse than any false refusal.
    assert.match(PROMPTS, /MUST begin with a guard clause/);
    assert.match(PROMPTS, /ERROR: required data not found/);
    assert.match(PROMPTS, /prevents silent hallucination/i);
  });
});

describe('but it may not fire on something merely short', () => {
  const clause = (() => {
    const i = PROMPTS.indexOf('MUST begin with a guard clause');
    assert.notEqual(i, -1, 'the guard instruction is gone — re-point this, do not delete the test');
    return PROMPTS.slice(i, i + 1400);
  })();

  test('the threshold is ENTIRELY absent, not empty-ish', () => {
    assert.match(clause, /ENTIRELY absent/,
      'a message with four characters in it is not absent');
  });

  test('and the instruction says so in as many words', () => {
    // The half that does the work. Without it the model applies its own judgement
    // about what is "worth" summarising, which is how "test" became a failure.
    assert.match(clause, /however short, counts as present/i,
      'the model must be told that brevity is not absence');
  });

  test('the reason is recorded next to the rule', () => {
    // So the next person to read this cannot quietly widen it back — the cost is
    // written beside the constraint, not in a commit nobody re-reads.
    assert.match(clause, /"test"/, 'the witnessed case must stay attached to the rule');
    assert.match(clause, /never fire on something short/i);
  });
});
