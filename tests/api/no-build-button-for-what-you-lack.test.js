/**
 * DO NOT OFFER TO BUILD A WORKFLOW OUT OF SERVICES THE WORKSPACE DOES NOT HAVE.
 *
 * WITNESSED 2026-08-01 on a genuinely fresh tenant (`zz-firstrun-test`) — the first time
 * the product had been driven as someone who has just been handed a login, which is the
 * model in use now that self-serve is off. Nothing connected. First message:
 *
 *     "When a customer emails us asking about pricing, send me a summary in Slack."
 *
 * Atlas asked **which Slack channel** to post to, then said the workflow would run
 * *"whenever a new email lands in your connected inbox"* and put a **Build it** button on
 * screen. Read from `oauth_tokens`, not inferred: **zero rows for that tenant.**
 *
 * A brand-new workspace has no connectors BY DEFINITION, so this was the guaranteed first
 * impression of every customer, and it was a false statement about their own account.
 *
 * The prompt already carried the fact — *"No connectors are connected yet. **If asked**,
 * say none are set up"* — and the user had not asked; they had described a workflow.
 *
 * THE ANTI-FALSE-POSITIVE CASES ARE THE POINT. Wrongly withdrawing the button traps
 * someone at the first message of their first workflow with no way forward; wrongly
 * allowing it only reproduces today's behaviour. So every doubt resolves to ALLOW, and
 * that direction is what most of this file pins.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  missingConnectorsFor, connectFirstMessage, connectorGapDecision,
} from '../../src/api/chat-connector-gap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The exact intent the model produced on the fresh tenant. */
const PROD_INTENT =
  'Whenever a new email lands in your connected inbox that looks like a pricing inquiry, '
  + 'the workflow will summarize it and post that summary to the #sales Slack channel.';

const EMPTY = new Set();                       // a brand-new workspace
const FULL  = new Set(['google', 'slack', 'airtable']);

describe('THE PROD CASE — a fresh workspace with nothing connected', () => {
  test('Slack is reported missing', () => {
    const missing = missingConnectorsFor(PROD_INTENT, EMPTY);
    assert.ok(missing.some(m => m.connector === 'slack'), 'the Slack gap was not noticed');
  });

  test('the Build it button is withdrawn', () => {
    const d = connectorGapDecision({ readyToBuild: true, buildIntent: PROD_INTENT }, EMPTY);
    assert.equal(d.readyToBuild, false, 'a build button was offered for a workflow that cannot run');
    assert.equal(d.buildIntent, null, 'the intent must not ride along with the button withdrawn');
  });

  test('and the person is told what to connect, in plain words', () => {
    const d = connectorGapDecision({ readyToBuild: true, buildIntent: PROD_INTENT }, EMPTY);
    assert.match(d.reply, /Slack/);
    assert.match(d.reply, /Connections/);
    assert.doesNotMatch(d.reply, /connector|OAuth|capability|registry/i, 'no jargon on a line a customer reads');
  });

  test('the reply names Connections and stops there', () => {
    // The ONE place in Atlas the product may name (2026-07-26). It must never grow a
    // description of what is inside it — that is how a user gets sent hunting.
    const d = connectorGapDecision({ readyToBuild: true, buildIntent: PROD_INTENT }, EMPTY);
    assert.doesNotMatch(d.reply, /settings|integrations|tab|section|menu/i);
  });

  test('THE CORRECTION — it must not affirm building, or describe a setup that is absent', () => {
    /**
     * Charles, 2026-08-01, reading the first version's output on a fresh workspace:
     * *"it already affirmed building was possible without slack being connected."*
     *
     * That version APPENDED a notice and kept the model's prose, so the bubble read
     * "hit 'Build it' and I'll walk you through each step" — an action that had just been
     * withdrawn — above "whenever a new email arrives in your connected inbox", which is
     * false when nothing is connected, above the correction. A correction underneath a
     * contradiction is not a correction: the reader believes the confident part.
     */
    const d = connectorGapDecision({ readyToBuild: true, buildIntent: PROD_INTENT }, EMPTY);
    assert.doesNotMatch(d.reply, /Build it/i, 'it still points at a button that is not there');
    assert.doesNotMatch(d.reply, /your connected|already connected/i,
      'it still describes a setup the workspace does not have');
    assert.match(d.reply, /can't build this yet/i, 'it must open by saying it cannot build this');
  });

  test('the model\'s words are REPLACED, not decorated', () => {
    // The decision carries a whole reply, not a fragment to bolt on. If this ever goes
    // back to being a suffix, the contradiction comes back with it.
    const d = connectorGapDecision({ readyToBuild: true, buildIntent: PROD_INTENT }, EMPTY);
    assert.equal(typeof d.reply, 'string');
    assert.ok(d.reply.length > 80, 'a replacement reply must stand on its own');
    assert.equal(d.notice, undefined, 'the append-style field is gone; callers must use `reply`');
  });
});

describe('IT MUST NOT TRAP SOMEONE WHO CAN BUILD', () => {
  test('everything connected ⇒ the turn is untouched', () => {
    const d = connectorGapDecision({ readyToBuild: true, buildIntent: PROD_INTENT }, FULL);
    assert.equal(d.readyToBuild, true);
    assert.equal(d.buildIntent, PROD_INTENT);
    assert.equal(d.reply, null);
  });

  test('a workflow needing NOTHING connected still gets its button on an empty workspace', () => {
    // Schedule + web research + delivery to the Atlas inbox genuinely works with no
    // connectors at all. Blocking it would deny a new user the one shape available to
    // them, which is worse than the defect being fixed.
    const d = connectorGapDecision({
      readyToBuild: true,
      buildIntent: 'Every weekday morning, research the latest AI news on the web and send me a summary in my Atlas inbox.',
    }, EMPTY);
    assert.equal(d.readyToBuild, true, 'an inbox-and-web workflow was blocked on an empty workspace');
    assert.equal(d.reply, null);
  });

  test('email as a DESTINATION never implies Gmail', () => {
    // "Email me the summary" can mean the Atlas inbox, which needs nothing connected.
    // Treating the word as a Gmail requirement would block the one shape a new user can
    // actually build on day one.
    for (const intent of [
      'Email me a summary every morning.',
      'Send an email with the results.',
      'Research the web and email the report to my Atlas inbox.',
      'Reply by email with the answer.',
    ]) assert.deepEqual(missingConnectorsFor(intent, EMPTY), [], intent);
  });

  test('but email as a TRIGGER is unambiguously Gmail', () => {
    /**
     * The other half of the same distinction, and the reason the first version missed
     * the real case. "When a new email ARRIVES" can only mean a mailbox Atlas reads, and
     * the only one it can read is the connected Google account — nothing else in the
     * product starts a workflow from incoming mail. Witnessed 2026-08-01: a workspace
     * with nothing connected was told its workflow would run "whenever a new email
     * arrives in your connected inbox".
     */
    for (const intent of [
      'When a new email arrives, summarise it and file it.',
      'Whenever a new email lands in your connected inbox that looks like a pricing inquiry.',
      'When a customer emails us asking about pricing, send me a summary.',
      'Any time an incoming email is received, log it.',
    ]) {
      assert.deepEqual(missingConnectorsFor(intent, EMPTY).map(m => m.connector), ['google'], intent);
      // …and it says nothing once Google IS connected.
      assert.deepEqual(missingConnectorsFor(intent, new Set(['google'])), [], intent);
    }
  });

  test('a service Atlas cannot connect at all is not reported as missing', () => {
    // Salesforce is not a connector; saying "connect it in Connections" would send them
    // looking for something that is not there. The prompt's own "cannot connect to that
    // yet" path owns this case.
    assert.deepEqual(missingConnectorsFor('Post it to Salesforce and Microsoft Teams.', EMPTY), []);
  });

  test('no intent, empty intent, or nothing proposed ⇒ nothing to say', () => {
    for (const intent of [null, undefined, '', '   ']) {
      assert.deepEqual(missingConnectorsFor(intent, EMPTY), []);
      const d = connectorGapDecision({ readyToBuild: false, buildIntent: intent }, EMPTY);
      assert.equal(d.reply, null);
      assert.equal(d.readyToBuild, false);
    }
  });

  test('a turn that was not offering to build is left alone', () => {
    const d = connectorGapDecision({ readyToBuild: false, buildIntent: null }, EMPTY);
    assert.equal(d.readyToBuild, false);
    assert.equal(d.reply, null);
  });
});

describe('what it reports, and how it reads', () => {
  test('one connector is named once, however many of its services are mentioned', () => {
    // "a Google Sheet and Gmail" is ONE thing to connect. Listing it twice reads as two
    // and makes the job look bigger than it is.
    const missing = missingConnectorsFor('Log it to a Google Sheet and also send it via Gmail.', EMPTY);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].connector, 'google');
  });

  test('two different services read as a list', () => {
    const missing = missingConnectorsFor('Read Gmail, then post to Slack and log to Airtable.', EMPTY);
    assert.deepEqual(missing.map(m => m.connector).sort(), ['airtable', 'google', 'slack']);
    assert.match(connectFirstMessage(missing), /, .* and /);
  });

  test('only the MISSING half is asked for', () => {
    const missing = missingConnectorsFor('Read Gmail and post to Slack.', new Set(['google']));
    assert.deepEqual(missing.map(m => m.connector), ['slack']);
    assert.doesNotMatch(connectFirstMessage(missing), /Gmail/);
  });

  test('the sentence agrees with itself for one and for many', () => {
    const one  = connectFirstMessage([{ connector: 'slack', label: 'Slack' }]);
    const many = connectFirstMessage([{ connector: 'slack', label: 'Slack' }, { connector: 'google', label: 'Gmail' }]);
    assert.match(one,  /it needs Slack, and that is not connected/);
    assert.match(one,  /connect it\b/);
    assert.match(many, /it needs Slack and Gmail, and those are not connected/);
    assert.match(many, /connect them\b/);
  });

  test('nothing missing ⇒ no sentence at all', () => {
    assert.equal(connectFirstMessage([]), null);
    assert.equal(connectFirstMessage(null), null);
  });
});

describe('it is wired into BOTH doors, and the prompt no longer waits to be asked', () => {
  /**
   * SOURCE-level, and weaker than the rest — said plainly. The chat endpoint streams
   * through a closure over the response and cannot be lifted and executed here.
   *
   * It exists because ENGINEERING-LOG.md records a previous fix to this exact endpoint that was
   * blind to the SECOND `done` emitter (the forced-final path taken when the model burns
   * its tool budget): four guards stayed green while the real path was unprotected.
   */
  const SRC = readFileSync(path.join(ROOT, 'src/api/builder.js'), 'utf8');

  test('there is one helper and both done-emitters call it', () => {
    assert.equal((SRC.match(/const applyConnectorGap = /g) ?? []).length, 1);
    assert.equal((SRC.match(/applyConnectorGap\(readyToBuild, buildIntent\)/g) ?? []).length, 2,
      'a done-emitter was added or changed without the connector gap');
  });

  test('the flag that draws the button comes from the DECISION, not the model', () => {
    const dones = SRC.match(/sseWrite\(\{ type: 'done'[^}]*\}\)/g) ?? [];
    assert.equal(dones.length, 2);
    for (const d of dones) {
      assert.match(d, /readyToBuild: gap\.readyToBuild/, `a done event still trusts the model: ${d}`);
      assert.match(d, /buildIntent: gap\.buildIntent/);
    }
  });

  test('the prompt states what is NOT connected, not only what is', () => {
    // Listing only the connected services left the model to infer absence, and it
    // inferred wrongly every time.
    assert.match(SRC, /NOT CONNECTED TO THIS WORKSPACE: \$\{missingNames\.join/);
  });

  test('it forbids asking for settings of a service they do not have', () => {
    const at = SRC.indexOf('NOT CONNECTED TO THIS WORKSPACE:');
    assert.ok(at > 0, 're-point this test');
    const block = SRC.slice(at, at + 900);
    assert.match(block, /SAY SO IN YOUR FIRST REPLY/);
    assert.match(block, /Do NOT ask which channel/);
    assert.match(block, /FALSE\s*\n?STATEMENT|FALSE STATEMENT/);
    assert.doesNotMatch(block, /If asked/);
  });

  test('and it tells the model what CAN be built with nothing connected', () => {
    // Refusing without an alternative would make an empty workspace feel like a dead end.
    const at = SRC.indexOf('NOT CONNECTED TO THIS WORKSPACE:');
    assert.match(SRC.slice(at, at + 900), /Atlas inbox/);
  });

  test('the reply is WITHDRAWN and replaced, never appended', () => {
    const at = SRC.indexOf('const applyConnectorGap');
    assert.ok(at > 0, 're-point this test');
    const body = SRC.slice(at, at + 900);
    assert.match(body, /withdrawPartial\(\)/, 'the model\'s design is still left on screen above the correction');
    assert.match(body, /sendChunk\(d\.reply\)/);
  });
});
