/**
 * ASKING A PERSON IS A TOOL WITH RULES, NOT A STRING THE MODEL MAY EMIT.
 *
 * Charles, 2026-07-30: *"The agent/converger/system should see the conversation as a
 * tool to fill gaps the user could fill with information."* This pins the first
 * increment: a question must pass the same kind of check any other capability's output
 * does, before a person ever sees it.
 *
 * THE QUESTIONS THAT PROMPTED IT, all observed the same day:
 *   · *"What is the spreadsheet ID for 'Pricing Enquiries'? You can find it in the URL
 *     of the sheet, between /d/ and /edit."* — asked AFTER offering "ID or name" and
 *     being given a name. A customer sent to dig an identifier out of a URL is the
 *     developer-settings errand P13 forbids, wearing a chat bubble.
 *   · A Slack identity question put to someone building an email-only workflow.
 *   · And the inverse: a knowledge base never checked and asserted about instead.
 *
 * Slack and Airtable destination questions have always been GOOD, and the reason is the
 * whole design: they arrive carrying options the connector was actually queried for.
 * Sheets had no discovery wired, so the same code path produced an errand. **The
 * difference was never the wording — it was whether anything had been looked up.**
 *
 * WHAT THIS IS NOT: a way to ask more. The promise is that a person can publish having
 * answered nothing, so refusal is the common outcome and the budget is a ceiling.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  shouldAsk, planQuestions, withDiscoveredOptions, looksLikeAnIdentifier,
  MAX_QUESTIONS_PER_BUILD,
} from '../../src/converger/asking.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('RULE 1 — never ask a person for a machine identifier', () => {
  test('THE PROD QUESTION is refused', () => {
    const v = shouldAsk({ text: "What is the spreadsheet ID for 'Pricing Enquiries'? (I need it to map the columns correctly — you can find it in the URL of the sheet, between /d/ and /edit.)" });
    assert.equal(v.ask, false);
    assert.equal(v.code, 'IDENTIFIER');
  });

  test('every identifier a connector actually uses is caught', () => {
    for (const t of ['What is the spreadsheet ID?', 'Please give me the base id',
                     'What is the table ID for Companies?', 'Paste the calendar id',
                     'Grab the id from the URL and paste it here',
                     'Use base appXXXXXXXXXXXXXX', 'the table is tbl1234567890abcd']) {
      assert.equal(looksLikeAnIdentifier(t), true, t);
    }
  });

  test('and a question a person CAN answer is not', () => {
    // A false positive here silences a legitimate question, which is worse than the
    // errand it prevents. These are all things a person knows off the top of their head.
    for (const t of ['Which Google Sheet should I use?',
                     'What should the email subject say?',
                     'Which Slack channel should this go to?',
                     'Should I create a new sheet, or add to one you already have?',
                     'Who should approve this before it sends?',
                     'What time should this run, and in which timezone?']) {
      assert.equal(looksLikeAnIdentifier(t), false, t);
      assert.equal(shouldAsk({ text: t }).ask, true, t);
    }
  });

  test('it is refused even when the budget is empty and nothing else objects', () => {
    // The one rule with no exception.
    const v = shouldAsk({ text: 'What is the spreadsheet ID?' }, { alreadyAsked: [], askedCount: 0 });
    assert.equal(v.ask, false);
    assert.equal(v.code, 'IDENTIFIER');
  });
});

describe('RULE 2 — never ask what was never looked up', () => {
  test('a discoverable question with no lookup attempted is refused', () => {
    const v = shouldAsk({ text: 'Which sheet should I use?', discoverable: true, discoveryAttempted: false });
    assert.equal(v.ask, false);
    assert.equal(v.code, 'UNDISCOVERED');
    assert.match(v.reason, /try that before asking/);
  });

  test('…and is allowed once the lookup HAS been made', () => {
    const v = shouldAsk({ text: 'Which sheet should I use?', discoverable: true, discoveryAttempted: true });
    assert.equal(v.ask, true);
  });

  test('a question nothing could answer is asked without ceremony', () => {
    // "What should the subject line say?" is not discoverable by any connector.
    assert.equal(shouldAsk({ text: 'What should the subject line say?' }).ask, true);
  });

  test("discovered options are offered, in the connector's own words", () => {
    const q = withDiscoveredOptions({
      text: 'Which sheet should I use?',
      options: [{ label: 'Pricing Enquiries' }, { label: 'Renewals Log' }],
    });
    assert.match(q.text, /You have: Pricing Enquiries, Renewals Log\./);
    assert.equal(q.discoveryAttempted, true, 'offering options IS the lookup');
  });

  test('it never invents an option when discovery found none', () => {
    const q = withDiscoveredOptions({ text: 'Which sheet should I use?', options: [] });
    assert.equal(q.text, 'Which sheet should I use?');
  });
});

describe('RULE 3 — never ask the same thing twice', () => {
  test('a repeat is refused', () => {
    const v = shouldAsk({ text: 'Which sheet should I use?', about: 'sheet' },
                        { alreadyAsked: ['sheet'], askedCount: 1 });
    assert.equal(v.ask, false);
    assert.equal(v.code, 'ALREADY_ASKED');
  });

  test('matching ignores spacing and case', () => {
    const v = shouldAsk({ text: 'x', about: '  Which  SHEET ' }, { alreadyAsked: ['which sheet'] });
    assert.equal(v.ask, false);
  });

  test('a DIFFERENT question is still allowed', () => {
    const v = shouldAsk({ text: 'What should it log?', about: 'columns' },
                        { alreadyAsked: ['sheet'], askedCount: 1 });
    assert.equal(v.ask, true);
  });
});

describe('RULE 4 — the budget is a ceiling, not a target', () => {
  test('past the budget, it decides instead of asking', () => {
    const v = shouldAsk({ text: 'One more thing?' }, { askedCount: MAX_QUESTIONS_PER_BUILD });
    assert.equal(v.ask, false);
    assert.equal(v.code, 'BUDGET');
    assert.match(v.reason, /let them correct it/);
  });

  test('the budget is applied LAST, so a better reason wins', () => {
    // A question refused for asking after an identifier should say IDENTIFIER — the
    // reason a person or a log reader needs is the real one, not "we ran out".
    const v = shouldAsk({ text: 'What is the spreadsheet ID?' }, { askedCount: 99 });
    assert.equal(v.code, 'IDENTIFIER');
  });

  test('the ceiling matches what a person tolerated', () => {
    // Not a guess: the builds that felt like a conversation asked one or two.
    assert.ok(MAX_QUESTIONS_PER_BUILD <= 3, 'above three the interview becomes a form');
  });
});

describe("planning a whole build's questions", () => {
  test('it returns what to ask AND what it refused, with reasons', () => {
    // Refusals are not noise — "we did not ask because nothing was looked up" is exactly
    // the finding that should reach a log. Dropping them silently would hide the
    // behaviour this module exists to change.
    const { ask, refused } = planQuestions([
      { text: 'Which Slack channel?', about: 'channel', options: [{ label: '#ops' }] },
      { text: 'What is the spreadsheet ID?', about: 'sheet-id' },
      { text: 'Which sheet?', about: 'sheet', discoverable: true, discoveryAttempted: false },
    ]);
    assert.deepEqual(ask.map(q => q.about), ['channel']);
    assert.deepEqual(refused.map(r => r.code), ['IDENTIFIER', 'UNDISCOVERED']);
  });

  test('the budget is spent across the whole build, not per question', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ text: `Question ${i}?`, about: `q${i}` }));
    const { ask, refused } = planQuestions(many);
    assert.equal(ask.length, MAX_QUESTIONS_PER_BUILD);
    assert.ok(refused.every(r => r.code === 'BUDGET'));
  });

  test('a build that has already asked starts from where it left off', () => {
    const { ask } = planQuestions([{ text: 'One more?', about: 'more' }],
                                  { askedCount: MAX_QUESTIONS_PER_BUILD });
    assert.deepEqual(ask, []);
  });

  test('nothing in, nothing out', () => {
    assert.deepEqual(planQuestions([]), { ask: [], refused: [] });
    assert.deepEqual(planQuestions(null), { ask: [], refused: [] });
  });

  test('an empty question is refused rather than shown as a blank bubble', () => {
    assert.equal(shouldAsk({ text: '   ' }).code, 'EMPTY');
  });
});

describe('it is wired into the path that produced the errand', () => {
  /**
   * SOURCE-level, and weaker than the rest of this file — said plainly. The clarification
   * site lives inside the `analyze` node, which closes over the LLM and the graph state
   * and cannot be lifted and executed here. Replace with a behavioural check if that node
   * is ever made extractable.
   */
  const SRC = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');

  test('the model PROPOSES the question; shouldAsk decides', () => {
    const at = SRC.indexOf("if (parsed?.ready === false && parsed.question) {");
    assert.ok(at > 0, 're-point this test');
    const body = SRC.slice(at, at + 1800);
    assert.match(body, /const verdict = shouldAsk\(/);
    assert.match(body, /if \(verdict\.ask\)/, 'the question must be gated, not merely logged');
  });

  test('a refused question is RECORDED, not silently dropped', () => {
    const at = SRC.indexOf("if (parsed?.ready === false && parsed.question) {");
    assert.match(SRC.slice(at, at + 1800), /converger\.question_refused/);
  });

  test('and the build continues rather than stalling', () => {
    // A refused question is not a dropped requirement: the build proceeds with what the
    // person already said, and an unresolvable destination fails honestly at test time.
    const at = SRC.indexOf("if (parsed?.ready === false && parsed.question) {");
    assert.match(SRC.slice(at, at + 1800), /fall through — decide it/);
  });

  test("the prior questions it counts are the PERSON's, not Atlas's bookkeeping", () => {
    // `clarifications` carries machine-authored entries marked with a parenthesised
    // question — counting those would spend the budget on Atlas talking to itself.
    const at = SRC.indexOf("if (parsed?.ready === false && parsed.question) {");
    assert.match(SRC.slice(at, at + 1800), /!q\.trim\(\)\.startsWith\('\('\)/);
  });
});
