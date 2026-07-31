/**
 * THE TOOLS THE AGENT HAS MUST BE THE TOOLS THE AGENT IS TOLD ABOUT.
 *
 * Charles, 2026-07-30, after a day in which most defects turned out to sit where
 * something was NOT a registered capability: *"We are not exposing the tools that are
 * available to the agent, to the agent properly… the failures have been centered around
 * tooling."* He was right, and this file pins the half of it that is about the prompt.
 *
 * TWO DEFECTS, BOTH FOUND BY RENDERING WITH REAL REGISTRY OBJECTS RATHER THAN A FIXTURE:
 *
 *   1. The trigger TYPE list rendered `capabilities.triggers` — an ARRAY of capability
 *      objects — as if it were a type→description map, so `Object.entries` produced
 *      INDICES: `- 0: Fires when a new Gmail message arrives…`. The words `email`,
 *      `schedule`, `manual`, `event` never appeared. Pinned next door in
 *      `the-prompt-offers-only-runnable-triggers.test.js`.
 *   2. The per-connector capability list read `c.actions` off the connection-STATUS
 *      objects, and **only Google carries one**. Measured:
 *          SLACK:
 *          GOOGLE: gmail_search, sheets_read
 *          AIRTABLE:
 *          WEB:
 *      Three connected services listed as having no capabilities — worse than omitting
 *      them, because a blank list reads as "this service can do nothing".
 *
 * THE LESSON THAT SHAPES THIS FILE. In both cases a DERIVED path already existed and was
 * silently producing garbage, while a correct hand-written fallback sat underneath it,
 * unreachable. "Derive it from the registry" is therefore necessary but not sufficient:
 * the derivation has to be CHECKED against real registry objects, or hand-written
 * examples elsewhere quietly become the real source of truth — which is exactly how
 * `webhook` and `one_time` became real to the model.
 *
 * So every test here builds the ACTUAL registry and passes the ACTUAL catalog. A fixture
 * shaped the way the author imagines is what hid both defects.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { ChannelRegistry } from '../../src/workflows/channel-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { registerSlackTriggers } from '../../src/connectors/slack/index.js';
import { registerWebCapabilities } from '../../src/connectors/web/index.js';
import { buildSystemPrompt } from '../../src/converger/prompts.js';

/** The real registry, and the real catalog the builder passes. */
function live({ web = true } = {}) {
  const cap = new CapabilityRegistry();
  const ch  = new ChannelRegistry(cap);
  registerGoogleChannels(cap);
  registerAirtableChannels(cap);
  registerSlackTriggers(cap);
  if (web) registerWebCapabilities(cap, { llm: { invoke: async () => ({}) } });
  return { cap, channels: ch.getAll().map(c => ({ ...c, available: true })) };
}

const connectorLines = (prompt) =>
  [...prompt.matchAll(/^([A-Z]+): (.*)$/gm)]
    .filter(m => ['SLACK', 'GOOGLE', 'AIRTABLE', 'WEB'].includes(m[1]))
    .reduce((acc, m) => ({ ...acc, [m[1]]: m[2] }), {});

describe('every connected service is described by what it can DO', () => {
  test('a connected service is never listed with a blank capability list', () => {
    // The defect exactly: "SLACK:" followed by nothing. A blank list is a claim, and a
    // false one — it reads as "this service can do nothing".
    const { channels } = live();
    const p = buildSystemPrompt({
      connectors: { slack: { connected: true }, google: { connected: true },
                    airtable: { connected: true }, web: { connected: true } },
      channels,
    });
    for (const [name, rest] of Object.entries(connectorLines(p))) {
      assert.ok(rest.trim().length > 0, `${name} is listed with nothing after it`);
    }
  });

  test('Google and Airtable list their real capabilities, not a subset of one status object', () => {
    const { channels } = live();
    const p = buildSystemPrompt({ connectors: { google: { connected: true }, airtable: { connected: true } }, channels });
    const lines = connectorLines(p);
    // Before the fix these came from `c.actions`, which Airtable never had at all.
    assert.match(lines.GOOGLE, /gmail_send/);
    assert.match(lines.GOOGLE, /calendar_create_event/);
    assert.match(lines.AIRTABLE, /airtable_create_record/);
    assert.ok(lines.GOOGLE.split(',').length >= 10, `only ${lines.GOOGLE.split(',').length} Google capabilities offered`);
  });

  test('the web connector appears once it is registered', () => {
    const { channels } = live({ web: true });
    const p = buildSystemPrompt({ connectors: { web: { connected: true } }, channels });
    assert.match(connectorLines(p).WEB, /web_search/);
  });

  test('a connector with no STEP capabilities says so in words', () => {
    // Slack's capabilities here are triggers, which are not steps. Saying so is honest;
    // a blank line is not.
    const { channels } = live();
    const p = buildSystemPrompt({ connectors: { slack: { connected: true } }, channels });
    assert.match(connectorLines(p).SLACK, /contributes no workflow steps/);
  });

  test('nothing connected still reads as nothing connected', () => {
    assert.match(buildSystemPrompt({}), /\(none connected\)/);
  });

  test('an UNAVAILABLE capability is not offered', () => {
    // Scope-gated or disconnected capabilities must not be proposed.
    const { channels } = live();
    const gated = channels.map(c => (c.id === 'gmail_send' ? { ...c, available: false } : c));
    const p = buildSystemPrompt({ connectors: { google: { connected: true } }, channels: gated });
    assert.doesNotMatch(connectorLines(p).GOOGLE, /gmail_send/);
    assert.match(connectorLines(p).GOOGLE, /gmail_search/, 'the rest must still be offered');
  });
});

describe('the delivery catalogue was already correct — keep it that way', () => {
  // Checked before changing anything: this block DID derive from the registry and did
  // render properly. It is pinned so the work on its neighbours cannot break it.
  test('deliveries are listed with their real config fields', () => {
    const { channels } = live();
    const p = buildSystemPrompt({ channels });
    assert.match(p, /channel "gmail_send".*config: \{ channel:"gmail_send", to, subject/);
    assert.match(p, /channel "sheets_append"/);
    assert.doesNotMatch(p, /channel "undefined"/);
  });

  test('and the hand-written fallback only appears when there is no catalog', () => {
    // The trigger defect was a correct fallback made unreachable by a broken derived
    // path. The inverse — a stale fallback shown while a catalog exists — is the same
    // failure wearing the other hat.
    const withCatalog = buildSystemPrompt({ channels: live().channels });
    assert.doesNotMatch(withCatalog, /channel "inbox_deliver": Atlas Inbox/,
      'the fallback list is showing even though a real catalog was supplied');
  });
});

describe('the whole prompt names no capability that does not exist', () => {
  test('every connector-action id offered is a registered capability', () => {
    // The generalisation of the webhook/one_time defect, applied to STEPS rather than
    // triggers: the interview may only offer what something can actually run.
    const { cap, channels } = live();
    const known = new Set(cap.list().map(c => c.id));
    const p = buildSystemPrompt({
      connectors: { google: { connected: true }, airtable: { connected: true }, web: { connected: true } },
      channels,
    });
    const offered = Object.values(connectorLines(p))
      .flatMap(line => line.split(',').map(s => s.trim()))
      .filter(id => /^[a-z][a-z0-9_]+$/.test(id));
    assert.ok(offered.length >= 10, `only ${offered.length} ids scraped — the scrape has broken`);
    const bogus = offered.filter(id => !known.has(id));
    assert.deepEqual(bogus, [], `offered but not registered: ${bogus.join(', ')}`);
  });
});
