/**
 * A TEST SAMPLE MUST LOOK LIKE WHAT THE TRIGGER REALLY DELIVERS.
 *
 * ── Witnessed 2026-08-03 ─────────────────────────────────────────────────────
 *
 * The first Slack-triggered workflow ever to reach a test run — they were refused
 * at publish until Slack began delivering events an hour earlier, so this path had
 * never once been exercised. It failed immediately:
 *
 *   "summarize_message" couldn't find the data it needed, so what went out was an
 *   error, not real content.
 *
 * The workflow was correct. `_sampleEvent()` returned a realistic email for an
 * email trigger and, for everything else, the literal string
 * "Sample trigger event for testing this workflow." — eight generic words.
 *
 * Every content step the converger writes carries the instruction *"if the message
 * content is empty or missing, output EXACTLY: ERROR: required data not found"*.
 * The model read that sentence, correctly judged there was no message in it, and
 * did what it was told. The test then correctly refused to certify a workflow that
 * would have delivered an error. **Three correct behaviours composing into a
 * workflow that could never pass.**
 *
 * ── Why the FORMAT is copied, not invented ──────────────────────────────────
 *
 * A real Slack event reaches a workflow as a plain STRING built by
 * `dispatchSlackEvent` in server.js:
 *
 *   `New Slack message in <#C…> from <@U…>:\n\n<text>`
 *
 * A sample in any other shape tests a program nobody runs — which is exactly how
 * this defect came to exist. The test below reads BOTH the dispatcher and the
 * sample generator and requires them to agree, so the two cannot drift apart the
 * way they silently had.
 *
 * ── Mutations, run by hand (2026-08-03) ─────────────────────────────────────
 *
 *   M1  Slack falls back to the generic sample again   → 6 red
 *   M2  the sample drops its message body              → 1 red
 *   M3  mention and message share one wording          → 2 red
 *   M4  the sample stops matching the dispatcher       → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SERVER = readFileSync(path.join(ROOT, 'src/api/server.js'), 'utf8');

/** Lift the REAL `_sampleEvent` out of the page and run it. Never a copy. */
const sampleFor = (() => {
  const i = HTML.indexOf('  _sampleEvent() {');
  assert.notEqual(i, -1, '`_sampleEvent` is GONE — re-point this extraction, do not delete the test.');
  const body = HTML.slice(i, HTML.indexOf('\n  }', i) + 4);
  // eslint-disable-next-line no-new-func
  const make = new Function('state',
    'const self = { state }; ' + body.replace('_sampleEvent() {', 'const f = function() {').replace(/\}$/, '};')
    + ' return f.call(self);');
  return (trigger) => make({ spec: { triggers: [trigger] } });
})();

const EMAIL    = { type: 'email', filter: 'is:unread' };
const SLACK_MSG = { type: 'event', connector: 'slack', event: 'slack_message' };
const SLACK_AT  = { type: 'event', connector: 'slack', event: 'slack_mention' };
const AIRTABLE  = { type: 'event', connector: 'airtable', event: 'airtable_record_changed' };
const SCHEDULE  = { type: 'schedule', cron: '0 9 * * *' };

// ─────────────────────────────────────────────────────────────────────────────

describe('a sample carries something a step can actually read', () => {
  // THE PROPERTY THAT MATTERS, and the one the defect violated: every content step
  // the converger writes emits the error sentinel when handed no real content. So a
  // sample must contain a message, not a description of one.
  const cases = [['Slack message', SLACK_MSG], ['Slack mention', SLACK_AT], ['Airtable change', AIRTABLE], ['email', EMAIL]];

  for (const [name, trigger] of cases) {
    test(`${name}: the sample has a body worth summarising`, () => {
      const s = sampleFor(trigger);
      assert.doesNotMatch(s, /^Sample trigger event for testing this workflow\.$/,
        `${name} fell back to the generic seed — that is the defect, verbatim`);
      // Two lines and real prose: a header alone is still nothing to summarise.
      const body = s.split('\n\n').slice(1).join('\n\n').trim();
      assert.ok(body.length > 40,
        `${name} carries no message body, so a content step would emit the error sentinel: ${JSON.stringify(s)}`);
      assert.ok(/\s\w+\s\w+\s\w+/.test(body), `${name}'s body must be prose, not a placeholder`);
    });
  }

  test('a scheduled workflow keeps the generic seed, and that is correct', () => {
    // The anti-overreach direction. A schedule has no inbound event by definition —
    // its first step fetches its own data — so inventing one would be pretending.
    assert.match(sampleFor(SCHEDULE), /^Sample trigger event for testing this workflow\.$/);
  });

  test('a mention reads differently from an ordinary message', () => {
    // They arrive differently in production and a workflow may treat them
    // differently; one sample for both would test only one of them.
    assert.notEqual(sampleFor(SLACK_MSG), sampleFor(SLACK_AT));
    assert.match(sampleFor(SLACK_AT), /mentioned/i);
  });
});

describe('the sample matches what the DISPATCHER really builds', () => {
  // Read both sides and require agreement. The generic seed was not wrong because
  // it was short — it was wrong because it looked like nothing production sends.
  const dispatcher = (() => {
    const i = SERVER.indexOf('const context = isMention');
    assert.notEqual(i, -1, 'the Slack dispatch context moved — re-point this');
    return SERVER.slice(i, SERVER.indexOf('for (const wf of flows)', i));
  })();

  test('an ordinary message uses the dispatcher\'s own opening words', () => {
    assert.match(dispatcher, /New Slack message in/, 'the dispatcher wording changed — update the sample with it');
    assert.match(sampleFor(SLACK_MSG), /^New Slack message in <#/,
      'the sample must open exactly as a real event does');
  });

  test('a mention does too', () => {
    assert.match(dispatcher, /was @-mentioned in/);
    assert.match(sampleFor(SLACK_AT), /^Atlas was @-mentioned in <#/);
  });

  test('and both carry the channel and author references a real event has', () => {
    // `<#C…>` and `<@U…>` are Slack's own reference syntax. A workflow that reads
    // them must meet them in testing, or the first time it sees one is production.
    for (const t of [SLACK_MSG, SLACK_AT]) {
      const s = sampleFor(t);
      assert.match(s, /<#[A-Z0-9]+>/, 'a channel reference, as Slack sends it');
      assert.match(s, /<@[A-Z0-9]+>/, 'an author reference, as Slack sends it');
    }
  });
});
