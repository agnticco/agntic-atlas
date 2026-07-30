/**
 * "AN EVENT EXISTS IN MY CALENDAR" WAS SCORED AS A BROKEN PROMISE.
 *
 * WITNESSED ON PROD, 2026-07-30 (`build-platform-1785424869443`), driving a
 * demo-booking workflow: read the email, book a 30-minute hold, reply to confirm.
 * The workflow was right. The oracle said:
 *
 *     nothing reached "Calendar" in google — this run delivered to
 *     {{compute_event.event_title}} (calendar)
 *
 * Two whole-spec Opus passes were spent trying to fix it, and the rebuild gate
 * refused the third.
 *
 * THE CAUSE. The contract was written `google:Calendar` — the vendor, then the
 * service — which is how a person says "put it in my Google Calendar". There has long
 * been a rule for a locator that merely repeats the product name
 * (`locatorIsJustTheConnector`), and it is deliberately exact: it excuses `calendar`
 * and `googlecalendar` for a target written `calendar:…`. But here the ASSERTION's
 * connector is `google`, so the locator `Calendar` was compared against `google`,
 * matched nothing, and the promise was measured against the event's TITLE instead.
 *
 * THE FIX. The locator is also compared against the connectors the DELIVERY actually
 * uses. A calendar write carries `calendar` among its connectors, so a locator of
 * `Calendar` adds nothing the connector had not already said — which is exactly what
 * the existing rule is for, applied from the other side.
 *
 * It is additive: it can only accept a target that was previously rejected. Every
 * case where the locator names a REAL destination still compares normally, and the
 * second describe block is the proof.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import {
  normalizeDelivery, satisfiesAssertion, checkAssertionAtRuntime, setCapabilityCatalog,
} from '../../src/workflows/outcome-oracle.js';

function catalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  setCapabilityCatalog(reg);
}

/** The prod node: a calendar hold whose title is a template, as any real one is. */
const HOLD = { id: 'c', type: 'deliver', config: {
  channel: 'calendar_create_event',
  title: '{{compute_event.event_title}}',
  start: '2026-07-31T10:00:00-05:00', end: '2026-07-31T10:30:00-05:00',
} };
const MAIL  = { id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: 'sam@acme.com', subject: 's', body: 'b' } };
const SHEET = { id: 's', type: 'deliver', config: { channel: 'sheets_append', spreadsheetId: 'Leads', range: 'A:C' } };
const SLACK = { id: 'k', type: 'deliver', config: { channel: 'slack', target: '#ops', body: 'hi' } };

const receipt = (node) => normalizeDelivery(node, { dryRun: true, wouldDeliver: true });

/** Both halves of the one question, so a disagreement cannot hide. */
function verdicts(target, kind, node) {
  catalog();
  const a = { id: 'a1', kind, target };
  return { build: satisfiesAssertion(a, node), run: checkAssertionAtRuntime(a, [receipt(node)]).ok };
}

describe('THE PROD CASE', () => {
  test('a calendar hold keeps a promise written as google:Calendar', () => {
    assert.deepEqual(verdicts('google:Calendar', 'record_exists', HOLD), { build: true, run: true });
  });

  test('the sentence a person was shown is gone', () => {
    catalog();
    const r = checkAssertionAtRuntime({ id: 'a1', kind: 'record_exists', target: 'google:Calendar' }, [receipt(HOLD)]);
    assert.equal(r.ok, true, r.reason ?? '');
  });

  test('the wording of the promise no longer decides the verdict', () => {
    // Every one of these is the same workflow and the same delivery.
    for (const target of ['google:Calendar', 'calendar:Calendar', 'google:calendar',
                          'calendar:Google Calendar', 'google:Google Calendar']) {
      const v = verdicts(target, 'record_exists', HOLD);
      assert.equal(v.build, true, `build: ${target}`);
      assert.equal(v.run, true, `run: ${target}`);
    }
  });

  test('…and holds when the title is a LITERAL, not a template', () => {
    // Load-bearing, and it took a surviving mutation to find: a TEMPLATE title is
    // undecidable and excused by a different rule entirely, so the template fixture
    // above passes even with the build-time half of this fix deleted. Only a literal
    // title actually reaches the locator comparison — and with the build half removed
    // this case goes build=false / run=true, which is the two halves disagreeing about
    // one delivery: the exact defect shape this area has produced three times.
    const standup = { id: 'c', type: 'deliver', config: {
      channel: 'calendar_create_event', title: 'Standup',
      start: '2026-07-31T10:00:00-05:00', end: '2026-07-31T10:30:00-05:00' } };
    assert.deepEqual(verdicts('google:Calendar', 'record_exists', standup), { build: true, run: true });
    assert.deepEqual(verdicts('calendar:Calendar', 'record_exists', standup), { build: true, run: true });
  });

  test('it holds even though the title is an unresolved template', () => {
    // The title is what the event is CALLED. Making it decide WHERE the event went
    // is the defect family this repo has paid for three times; here the promise is
    // about the calendar, and the title is simply not consulted.
    assert.ok(String(HOLD.config.title).includes('{{'), 'the fixture must keep the template');
    assert.equal(verdicts('google:Calendar', 'record_exists', HOLD).build, true);
  });
});

describe('IT DID NOT BECOME A FAIL-OPEN', () => {
  // The rule excuses a locator that merely repeats the product name. Everything that
  // names a REAL destination must still be compared, or the promise means nothing.

  test('a promise about a NAMED calendar event is still checked', () => {
    // "calendar:Standup" names a specific event, not the calendar itself.
    const standup = { id: 'c', type: 'deliver', config: {
      channel: 'calendar_create_event', title: 'Standup',
      start: '2026-07-31T10:00:00-05:00', end: '2026-07-31T10:30:00-05:00' } };
    assert.equal(verdicts('calendar:Standup', 'record_exists', standup).build, true);
    assert.equal(verdicts('calendar:Some Other Event', 'record_exists', standup).build, false,
      'a promise about a different event must still fail');
  });

  test('the WRONG CONNECTOR is still refused', () => {
    for (const [target, kind] of [['gmail:Calendar', 'message_sent'],
                                  ['airtable:Calendar', 'record_exists'],
                                  ['slack:Calendar', 'message_sent']]) {
      const v = verdicts(target, kind, HOLD);
      assert.equal(v.build, false, `build: ${target}`);
      assert.equal(v.run, false, `run: ${target}`);
    }
  });

  test('a named destination on ANOTHER connector is still compared', () => {
    assert.equal(verdicts('sheets:Leads', 'record_exists', SHEET).build, true);
    assert.equal(verdicts('sheets:SomeOtherSheet', 'record_exists', SHEET).build, false);
    assert.equal(verdicts('slack:#ops', 'message_sent', SLACK).build, true);
    assert.equal(verdicts('slack:#random', 'message_sent', SLACK).build, false);
    assert.equal(verdicts('gmail:sam@acme.com', 'message_sent', MAIL).build, true);
    assert.equal(verdicts('gmail:someone-else@acme.com', 'message_sent', MAIL).build, false);
  });

  test('a promise of the WRONG KIND is still refused', () => {
    // The calendar write is a record; it must not settle a promise to SEND.
    assert.equal(verdicts('calendar:Calendar', 'message_sent', HOLD).build, false);
  });

  test('an email does not satisfy a promise about the calendar', () => {
    assert.equal(verdicts('google:Calendar', 'record_exists', MAIL).build, false);
    assert.equal(verdicts('google:Calendar', 'record_exists', MAIL).run, false);
  });

  test('a delivery that did not go through is still not a match', () => {
    catalog();
    const refused = normalizeDelivery(HOLD, { dryRun: true, wouldDeliver: false });
    assert.equal(checkAssertionAtRuntime({ id: 'a1', kind: 'record_exists', target: 'google:Calendar' }, [refused]).ok, false);
  });
});

describe('the two halves still agree', () => {
  // The seventh defect in this family was the halves drifting. Every case above is
  // asserted on BOTH; this states the property directly for the mixed pairings.
  const CASES = [
    ['google:Calendar', 'record_exists', HOLD],
    ['calendar:Calendar', 'record_exists', HOLD],
    ['google:Calendar', 'record_exists', MAIL],
    ['gmail:Calendar', 'message_sent', HOLD],
    ['sheets:Sheets', 'record_exists', SHEET],
    ['slack:Slack', 'message_sent', SLACK],
    ['slack:#ops', 'message_sent', SLACK],
  ];
  for (const [target, kind, node] of CASES) {
    test(`"${target}" vs ${node.config.channel}`, () => {
      const v = verdicts(target, kind, node);
      assert.equal(v.build, v.run, `build says ${v.build}, runtime says ${v.run}`);
    });
  }
});
