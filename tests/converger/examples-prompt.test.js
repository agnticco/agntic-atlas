/**
 * The examples prompt must tell the model the TRIGGER's event shape. (P12 G residual.)
 *
 * `given` is the event the workflow's first step receives and reads verbatim. If its
 * shape does not match the trigger, the first step gets nonsense: an email→summarize
 * node handed a `{scenario:"…"}` blob reads its own guard clause ("if the email is
 * empty or missing → ERROR") and fails a run that would have worked — so the test
 * panel showed a false red on a common workflow. The prompt now instructs the model
 * to shape `given` as a realistic instance of the trigger's own event, with the
 * content in `given` (not `expect`).
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { buildExamplesPrompt } from '../../src/converger/prompts.js';

describe('buildExamplesPrompt — the given must match the trigger event', () => {
  test('an EMAIL trigger asks for a concrete {from, subject, body} given', () => {
    const p = buildExamplesPrompt({
      intent: 'summarize support email',
      outcome: { statement: 'x' },
      triggers: [{ type: 'email', filter: 'to:support@acme.com' }],
    });
    assert.match(p, /TRIGGERED BY an incoming email/);
    assert.match(p, /"from"/);
    assert.match(p, /"subject"/);
    assert.match(p, /"body"/);
    // The content goes in `given`, NOT in `expect` — the exact mistake that broke it.
    assert.match(p, /Put the email IN `given`/);
  });

  test('a SCHEDULE trigger says there is no inbound event', () => {
    const p = buildExamplesPrompt({ intent: 'daily digest', outcome: {}, triggers: [{ type: 'schedule', cron: '0 6 * * *' }] });
    assert.match(p, /TRIGGERED ON A SCHEDULE/);
  });

  test('no/unknown trigger still demands a realistic event in given, not expect', () => {
    const p = buildExamplesPrompt({ intent: 'do a thing', outcome: {}, triggers: [] });
    assert.match(p, /realistic instance of that event/);
    assert.match(p, /put the content in `given`, not in `expect`/);
    // and it must NOT wrongly claim an email shape for a non-email trigger
    assert.equal(/TRIGGERED BY an incoming email/.test(p), false);
  });

  test('still returns the JSON contract the caller parses', () => {
    const p = buildExamplesPrompt({ intent: 'x', outcome: {}, triggers: [{ type: 'email' }] });
    assert.match(p, /"examples":\[\{"id":"e1"/);
  });
});
