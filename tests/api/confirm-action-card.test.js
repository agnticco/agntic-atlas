/**
 * THE LAST GATE BEFORE ATLAS CHANGES SOMETHING MUST SAY WHAT IT IS CHANGING —
 * AND THE CONVERSATION MUST NOT END THERE.
 *
 * Both witnessed on prod, 2026-07-29, in one exchange. Asked to add three Airtable
 * columns, Atlas offered them correctly and then:
 *
 *  1. listed them for approval as three identical rows —
 *
 *         Add Airtable Column
 *         Add Airtable Column
 *         Add Airtable Column
 *
 *     with the column names sitting unused in the arguments. This is the last gate
 *     before a change to a system of record, and it showed nothing to check. Same
 *     rule as the step-approval card: never ask someone to approve something you
 *     have not shown them.
 *
 *  2. stopped dead once they ran. It had said "give me the go-ahead and I'll add
 *     them, THEN WE CAN BUILD THE FULL WORKFLOW" — the columns went in, the card
 *     ticked, and nothing followed. Typing "now build it" recovered it, but only
 *     someone who guessed that would get there.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describePendingAction } from '../../src/api/builder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');

const COLUMN = { name: 'Add Airtable Column', id: 'airtable_create_field' };

describe('the confirmation says what is being acted on', () => {
  test('the prod case: three columns are told apart', () => {
    const labels = ['Email Address', 'Subject', 'Summary'].map(n =>
      describePendingAction(COLUMN, { baseId: 'appXXXXXXXXXXXXXX', tableId: 'Table 1', name: n }));
    assert.equal(new Set(labels).size, 3, 'three identical rows is what a person had to approve');
    for (const [i, n] of ['Email Address', 'Subject', 'Summary'].entries()) {
      assert.match(labels[i], new RegExp(n), `row ${i + 1} must name its column`);
    }
  });

  test('it names where the change lands', () => {
    const l = describePendingAction(COLUMN, { baseId: 'appXXXXXXXXXXXXXX', tableId: 'Table 1', name: 'Subject' });
    assert.match(l, /Table 1/);
  });

  test('an opaque provider id is suppressed, not shown', () => {
    // `tblXXXXXXXXXXXXXX` identifies nothing to a reader. The promise checker
    // already treats these as unreadable; this uses the same rule.
    const l = describePendingAction(COLUMN, { baseId: 'appABCDEFGHIJKLMN', tableId: 'tblABCDEFGHIJKLMN', name: 'Subject' });
    assert.doesNotMatch(l, /tbl[A-Za-z0-9]{14}/);
    assert.doesNotMatch(l, /app[A-Za-z0-9]{14}/);
    assert.match(l, /Subject/, 'the column name still has to be there');
  });

  test('creating a channel names the channel', () => {
    const l = describePendingAction({ name: 'Slack Create Channel' }, { name: 'ops-alerts' });
    assert.match(l, /ops-alerts/);
  });

  test('a send still reads as it did — recipient and subject', () => {
    // The old shape must not regress: this function existed for these.
    const l = describePendingAction({ name: 'Send Email' }, { to: 'sam@acme.com', subject: 'Your invoice' });
    assert.match(l, /sam@acme\.com/);
    assert.match(l, /Your invoice/);
  });

  test('a capability with nothing identifying still returns its name', () => {
    assert.equal(describePendingAction({ name: 'Do The Thing' }, {}), 'Do The Thing');
    assert.ok(describePendingAction(null, {}).length > 0, 'never an empty row');
  });
});

describe('the conversation carries on once the actions have run', () => {
  const fn = (() => {
    const i = HTML.indexOf('async _runChatActions(msgId) {');
    assert.ok(i > 0, '`_runChatActions` is gone — re-point this test');
    return code(HTML.slice(i, i + 2600));
  })();

  test('success hands back to the assistant', () => {
    assert.match(fn, /if \(allOk\) \{[\s\S]*this\.sendChat\(/,
      'the card ticking was the end of the exchange');
  });

  test('and it tells the assistant not to re-ask', () => {
    assert.match(fn, /do not ask the user to confirm them again/i);
  });

  test('a FAILED action does not carry on regardless', () => {
    // Someone has to decide what happens next; continuing would talk past it.
    const i = fn.indexOf('if (allOk)');
    assert.ok(i > 0);
    assert.doesNotMatch(fn.slice(0, i), /this\.sendChat\(/,
      'nothing may send before the success check');
  });

  test('the turn is HIDDEN — Atlas does not put words in the user\'s mouth', () => {
    assert.match(fn, /\{ hidden: true \}/);
  });
});

describe('a hidden turn reaches the model without being drawn', () => {
  const fn = (() => {
    const i = HTML.indexOf('async sendChat(t, opts = {}) {');
    assert.ok(i > 0, '`sendChat` signature changed — re-point this test');
    return code(HTML.slice(i, i + 1600));
  })();

  test('it is not appended as a user message', () => {
    assert.match(fn, /const msgs = hidden \? this\.state\.msgs :/,
      'a hidden turn drawn as an operator bubble is exactly what this avoids');
  });

  test('but it IS sent as a turn, or the assistant learns nothing', () => {
    assert.match(fn, /if \(hidden\) history\.push\(\{ role: "user", content: t \}\)/);
  });

  test('an ordinary message is unchanged', () => {
    assert.match(fn, /\{ isOperator: true, text: t \}/);
  });
});
