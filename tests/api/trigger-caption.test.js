/**
 * THE SENTENCE SAYING WHAT STARTS A WORKFLOW MUST DESCRIBE THAT WORKFLOW.
 *
 * Two independent QA runs reported the same screen lying, in two different ways,
 * and both were on surfaces a person reads in order to CATCH a mistake:
 *
 *   · The step-approval card — the product's designated human safety check —
 *     presented an Airtable-triggered workflow as **"A new email arrives"**, with
 *     the envelope icon, and the wrong sentence was inside the confirm control
 *     itself ("Confirm this step: A new email arriv…"). There was no second,
 *     correct field on that card to catch it against. The caption mapped BOTH
 *     `email` and the legacy `connector_event` to the email wording.
 *   · The canvas called EVERY connector event **"A message is posted"** — Slack's
 *     wording — including an Airtable record change.
 *
 * In both cases the machine configuration underneath was CORRECT. The workflow
 * did the right thing; only the English was wrong. That inverts the usual shape
 * of a defect here and is worse than it sounds, because the whole purpose of the
 * approval screen is that a non-technical person can spot a mistake by reading.
 *
 * WHAT IS PINNED
 *   1. an Airtable trigger never reads as email, and never gets the envelope;
 *   2. the caption names the RIGHT connector, not the one we happen to know;
 *   3. the legacy unrunnable type says it cannot say, rather than guessing email;
 *   4. ordinary email / schedule / manual triggers are untouched;
 *   5. ONE function serves both surfaces, so they cannot drift apart again.
 *
 * WHY THIS SHAPE. `public/index.html` is one ~9,900-line page with no module
 * boundary and no build step, so there is nothing to import. This extracts the
 * REAL method sources and executes them, exactly as the neighbouring
 * step-approval-card suite does — a copy is precisely what would drift, and a
 * grep would pass against broken code.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function bodyFrom(i) {
  let j = HTML.indexOf('{', i), depth = 0;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}
function methodSrc(name) {
  const start = HTML.indexOf('\n  ' + name + '(');
  assert.notEqual(start, -1,
    `\`${name}\` is GONE from public/index.html — re-point this extraction, do not delete the test.`);
  const end = bodyFrom(start);
  assert.ok(end > start, `could not find the end of \`${name}\``);
  return HTML.slice(start + 1, end);
}

const METHODS = ['_triggerCaption', '_triggerIsMail', '_triggerGlyph', '_specTriggerTitle',
                 '_triggerTitle', '_getTriggerInfo', '_triggerNodeFrom', '_humanCron', '_titleCase'];

function component() {
  const obj = eval('({\n' + METHODS.map(methodSrc).join(',\n') + '\n})');
  obj.state = { _approvedPlanCache: null };
  return obj;
}
const C = component();

// The exact shapes read out of the QA databases and the connector catalog.
const AIRTABLE = { type: 'event', connector: 'airtable', event: 'airtable_record_changed',
                   filter: { baseId: 'appXXXX', tableId: 'tblYYYY' } };
const SLACK_MSG = { type: 'event', connector: 'slack', event: 'slack_message' };
const LEGACY    = { type: 'connector_event', filter: 'is:unread' };
const EMAIL     = { type: 'email', filter: 'is:unread' };

describe('the caption never says email about something that is not email', () => {
  test('THE DEFECT: an Airtable trigger is not described as an email', () => {
    const s = C._triggerCaption(AIRTABLE);
    assert.doesNotMatch(s, /email/i, `Airtable trigger described as: "${s}"`);
    assert.match(s, /airtable/i, 'it should name the app it actually watches');
  });

  test('THE OTHER HALF: it does not get the envelope either', () => {
    assert.equal(C._triggerIsMail(AIRTABLE), false);
    assert.equal(C._triggerNodeFrom({ triggers: [AIRTABLE] }).mode, null,
      'mode:"email" is what draws the envelope icon');
  });

  test('the legacy unrunnable type says it cannot say, rather than guessing email', () => {
    const s = C._triggerCaption(LEGACY);
    assert.doesNotMatch(s, /email/i, `legacy connector_event described as: "${s}"`);
    assert.equal(C._triggerIsMail(LEGACY), false);
  });

  test('a Slack event is not described as Airtable, and vice versa', () => {
    assert.match(C._triggerCaption(SLACK_MSG), /slack/i);
    assert.doesNotMatch(C._triggerCaption(SLACK_MSG), /airtable/i);
    assert.doesNotMatch(C._triggerCaption(AIRTABLE), /slack/i);
  });

  test('an event with no connector does not invent one', () => {
    const s = C._triggerCaption({ type: 'event' });
    assert.doesNotMatch(s, /airtable|slack|email/i, `invented a source: "${s}"`);
  });
});

describe('the ordinary triggers are untouched', () => {
  test('email still reads as email, and still gets the envelope', () => {
    assert.match(C._triggerCaption(EMAIL), /email/i);
    assert.equal(C._triggerIsMail(EMAIL), true);
    assert.equal(C._triggerNodeFrom({ triggers: [EMAIL] }).mode, 'email');
  });

  test('schedule and manual are unchanged', () => {
    assert.match(C._triggerCaption({ type: 'schedule' }), /schedule/i);
    assert.match(C._triggerCaption({ type: 'manual' }), /run it/i);
  });

  test('an explicit label always wins over any derived wording', () => {
    assert.equal(C._triggerCaption({ ...AIRTABLE, label: 'When a referral lands' }),
      'When a referral lands');
  });

  test("the plan's own sentence still wins on the approval card", () => {
    const n = C._triggerNodeFrom({ triggers: [{ ...AIRTABLE, _planText: 'When a new patient row appears' }] });
    assert.equal(n.label, 'When a new patient row appears');
  });
});

describe('one rule, not two — the surfaces cannot drift apart again', () => {
  test('the canvas and the approval card give the SAME sentence', () => {
    for (const t of [AIRTABLE, SLACK_MSG, EMAIL, LEGACY, { type: 'schedule', cron: '0 9 * * *' }]) {
      assert.equal(C._specTriggerTitle(t), C._triggerNodeFrom({ triggers: [t] }).label,
        `canvas and approval card disagree for ${JSON.stringify(t)}`);
    }
  });

  test('no caption is hardcoded outside the shared helper', () => {
    // The page may mention the strings only inside `_triggerCaption` (and its
    // comment). Anywhere else is a second copy waiting to drift.
    const body = methodSrc('_triggerCaption');
    const outside = HTML.split(body).join('');
    assert.doesNotMatch(outside, /'A new email arrives'/,
      'a second hardcoded email caption has reappeared outside the shared helper');
  });

  // ── the other three surfaces, found only by driving the real app ───────────
  // The canvas and approval card were fixed first. Testing in a browser then
  // showed the CONSOLE view — the screen you land on before the builder — still
  // calling an Airtable record change "Schedule", with a CLOCK icon and the raw
  // string "connector_event" shown to the customer as a chip. Five renderers
  // were deciding this independently. These pin the other three.

  test('THE CONSOLE RAIL: no surface calls a connector event a schedule', () => {
    // `_triggerTitle` feeds the pipeline strip and the draft list.
    assert.doesNotMatch(C._triggerTitle(AIRTABLE), /schedule/i);
    assert.doesNotMatch(C._triggerTitle(LEGACY), /schedule/i);
    // ...and it must not title-case the raw internal type at a person.
    assert.doesNotMatch(C._triggerTitle(LEGACY), /connector[_ ]event/i);
  });

  // WEAKER THAN THE REST, AND DELIBERATELY SO — read this before trusting it.
  //
  // The console rail is built inline inside `renderVals()`, a ~1000-line render
  // method that cannot be extracted and executed the way the others are. So this
  // pins the SOURCE, not the behaviour. That is exactly the "a grep proves a
  // symbol EXISTS, not that anything ENFORCES it" weakness CLAUDE.md warns about,
  // and it is recorded here rather than hidden.
  //
  // It exists because the first version of this fix was pinned by NOTHING: with
  // the rail reverted to the clock icon, the raw type tag and the word
  // "Schedule", all 17 other tests stayed green. Found by hand-mutation, and the
  // test was strengthened rather than the mutation dropped. If that rail is ever
  // made extractable, replace this with a real behavioural check.
  test('THE CONSOLE RAIL is wired to the shared rule (source pin, not behavioural)', () => {
    const anchor = HTML.indexOf('const trg = (wf.triggers || [])[0];');
    assert.notEqual(anchor, -1, 'the console rail moved — re-point this test, do not delete it');
    // Comments are stripped first: the fix's own explanatory comment quotes the
    // very literals this asserts are gone, and a test that a comment can turn
    // red is worse than no test.
    const stmt = HTML.slice(anchor, HTML.indexOf('(wf.nodes || []).forEach', anchor))
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

    assert.match(stmt, /this\._triggerGlyph\(/, 'the rail is choosing its own icon again');
    assert.match(stmt, /this\._triggerCaption\(/, 'the rail is writing its own caption again');
    assert.doesNotMatch(stmt, /"Schedule"/, 'the rail is calling non-email triggers a schedule again');
    assert.doesNotMatch(stmt, /"Email trigger"/, 'the rail has its own email wording again');
    assert.doesNotMatch(stmt, /trg\.type \|\| "trigger"\)\.toUpperCase\(\)/,
      'the rail is showing the raw internal type to a customer again');
  });

  test('THE STATUS CHIP: the raw internal type is never shown as prose', () => {
    const info = C._getTriggerInfo({ triggers: [LEGACY] });
    assert.doesNotMatch(info.label, /connector[_ ]event/i,
      `the chip showed the raw type: "${info.label}"`);
    // `type` stays raw on purpose — it is styling, not prose.
    assert.equal(info.type, 'connector_event');
  });

  test('the status chip still names the apps it already knew', () => {
    assert.match(C._getTriggerInfo({ triggers: [AIRTABLE] }).label, /airtable/i);
    assert.match(C._getTriggerInfo({ triggers: [SLACK_MSG] }).label, /slack/i);
    assert.match(C._getTriggerInfo({ triggers: [EMAIL] }).label, /gmail|email/i);
  });

  test('THE ICON is a claim too — no clock or envelope on an unknown trigger', () => {
    assert.equal(C._triggerGlyph(EMAIL), '✉');
    assert.equal(C._triggerGlyph({ type: 'schedule' }), '⏱');
    for (const t of [AIRTABLE, SLACK_MSG, LEGACY, { type: 'event' }]) {
      const g = C._triggerGlyph(t);
      assert.notEqual(g, '⏱', `clock icon on ${JSON.stringify(t)}`);
      assert.notEqual(g, '✉', `envelope on ${JSON.stringify(t)}`);
    }
  });

  test('the email filter survives on the strip that has nowhere else to show it', () => {
    assert.match(C._triggerTitle(EMAIL), /is:unread/);
  });

  test('every trigger produces a non-empty human sentence', () => {
    for (const t of [AIRTABLE, SLACK_MSG, EMAIL, LEGACY, {}, { type: 'nonsense' }, { type: 'event', connector: 'notion' }]) {
      const s = C._triggerCaption(t);
      assert.ok(typeof s === 'string' && s.trim().length > 0, `empty caption for ${JSON.stringify(t)}`);
      assert.doesNotMatch(s, /undefined|null|\[object/, `leaked a raw value: "${s}"`);
    }
  });
});
