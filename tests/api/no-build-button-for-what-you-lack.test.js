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
    assert.match(d.notice, /Slack/);
    assert.match(d.notice, /Connections in the left sidebar/);
    assert.doesNotMatch(d.notice, /connector|OAuth|capability|registry/i, 'no jargon on a line a customer reads');
  });

  test('the notice names Connections and stops there', () => {
    // The ONE place in Atlas the product may name (2026-07-26). It must never grow a
    // description of what is inside it — that is how a user gets sent hunting.
    const d = connectorGapDecision({ readyToBuild: true, buildIntent: PROD_INTENT }, EMPTY);
    assert.doesNotMatch(d.notice, /settings|integrations|tab|section|button|menu/i);
  });
});

describe('IT MUST NOT TRAP SOMEONE WHO CAN BUILD', () => {
  test('everything connected ⇒ the turn is untouched', () => {
    const d = connectorGapDecision({ readyToBuild: true, buildIntent: PROD_INTENT }, FULL);
    assert.equal(d.readyToBuild, true);
    assert.equal(d.buildIntent, PROD_INTENT);
    assert.equal(d.notice, null);
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
    assert.equal(d.notice, null);
  });

  test('a bare "email" NEVER implies Gmail', () => {
    // "Email me the summary" can mean the Atlas inbox. Treating the word as a Gmail
    // requirement would block the one shape a new user can actually build.
    assert.deepEqual(missingConnectorsFor('Email me a summary every morning.', EMPTY), []);
    assert.deepEqual(missingConnectorsFor('Send an email with the results.', EMPTY), []);
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
      assert.equal(d.notice, null);
      assert.equal(d.readyToBuild, false);
    }
  });

  test('a turn that was not offering to build is left alone', () => {
    const d = connectorGapDecision({ readyToBuild: false, buildIntent: null }, EMPTY);
    assert.equal(d.readyToBuild, false);
    assert.equal(d.notice, null);
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
    assert.match(connectFirstMessage([{ connector: 'slack', label: 'Slack' }]), /Slack needs to be connected/);
    assert.match(
      connectFirstMessage([{ connector: 'slack', label: 'Slack' }, { connector: 'google', label: 'Gmail' }]),
      /Slack and Gmail need to be connected/);
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
   * It exists because CLAUDE.md records a previous fix to this exact endpoint that was
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

  test('the prompt no longer says "if asked"', () => {
    // Four words that were the whole defect: the fact was present and conditional on a
    // question the user had no reason to ask.
    const at = SRC.indexOf('NOTHING IS CONNECTED TO THIS WORKSPACE YET');
    assert.ok(at > 0, 'the empty-workspace block is gone — re-point this test');
    assert.doesNotMatch(SRC.slice(at, at + 700), /If asked/);
  });

  test('and it tells the model what CAN be built with nothing connected', () => {
    // Refusing without an alternative would make an empty workspace feel like a dead end.
    const at = SRC.indexOf('NOTHING IS CONNECTED TO THIS WORKSPACE YET');
    assert.match(SRC.slice(at, at + 700), /Atlas inbox/);
  });
});
