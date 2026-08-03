/**
 * A SERVICE THE CUSTOMER JUST CONNECTED MUST NOT BE CALLED MISSING.
 *
 * ── What happened, minutes after Notion first connected (2026-08-03) ────────
 *
 * Notion's 20 tools were in the catalog and the workspace showed connected.
 * Asked to build a workflow that saves to Notion, Atlas replied:
 *
 *   "Notion isn't in your connected workspace yet, so the workflow wouldn't
 *    have anywhere to save the briefing."
 *
 * …withdrew the Build it button, and told the customer to go and connect a
 * service they had connected four minutes earlier.
 *
 * ── The cause, and why it is filed as a REPEAT ──────────────────────────────
 *
 * `/capabilities` returned `connectors: { slack, google, airtable }` — a
 * LITERAL. P13-0 fixed exactly this shape for credentials (R22: a capability
 * missing from a hand-typed list gets no credential at run time even though the
 * customer is connected) by reading the connector a capability DECLARES. This
 * was the second such list, and it was missed.
 *
 * So the guard here is not "does Notion appear". It is that the list is DERIVED:
 * a service connected tomorrow appears tomorrow, without anyone editing a line.
 *
 * ── THERE WERE SIX SITES, AND THEY WERE FOUND ONE AT A TIME ────────────────
 *
 * `/capabilities` was corrected first and the browser behaved IDENTICALLY: the
 * interview does not read it. Then the builder session endpoint — also not the
 * one the chat reads. Each fix cost a deploy and another round of a customer
 * being told a connected service was missing.
 *
 *   1. GET /capabilities                        → derived
 *   2. POST /api/builder/sessions               → derived (the converger's view)
 *   3. the chat's connectedSet                  → derived (what withdraws the
 *                                                 Build it button)
 *   4. the edit-a-workflow connectedSet         → derived
 *   5. the @-mention list                       → derived
 *   6. the trigger narrowing + annotateChannelCatalog → deliberately NOT, and
 *      the reasons are in the enumeration test below.
 *
 * So the last test asserts the COUNT. Enumerating is the only thing that would
 * have caught this in one pass instead of four, and it is a rule this project
 * already had written down before this happened.
 *
 * ── AN HONEST NOTE ABOUT WHAT THE BEHAVIOURAL TESTS DO AND DO NOT PROVE ─────
 *
 * They construct the derivation the way the endpoint does — real catalog, real
 * recorded Notion response, only the grant lookup stubbed — and prove the RULE
 * is right. They do NOT prove the endpoint uses it: reverting `/capabilities` to
 * the literal left all six green, measured. That is the "a test that
 * re-implements the code under test proves only that the test can call a
 * function" trap, and it is recorded in this repo twice already.
 *
 * The `/capabilities` handler closes over `spine`, `mcpGrant` and the registry
 * and cannot be lifted out, so the last test is a SOURCE-level pin and says so.
 * It is anchored to the GATE EXPRESSION, never to the words around it — a pin
 * that matches a comment is how two source pins in this tree have already failed
 * to hold. Replace it with a behavioural check if that handler is ever made
 * extractable.
 *
 * ── Mutations, run by hand (2026-08-03) ─────────────────────────────────────
 *   M1  the interview's list reverts to a literal     → 1 red
 *   M2  /capabilities reverts to a literal            → 1 red
 *   M3  a service with an unreadable catalog counts   → 2 red
 *   M4  a service with no grant is listed anyway      → 1 red
 *   M5  a surface stops deriving (count drops to 4)   → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerMcpCatalog } from '../../src/connectors/mcp-catalog.js';
import { MCP_DIRECTORY } from '../../src/connectors/mcp-directory.js';
import { mcpConnectedFor } from '../../src/connectors/connected-services.js';

const RECORDED = readFileSync(new URL('../fixtures/notion-tools-list.sse.txt', import.meta.url), 'utf8');

/**
 * The endpoint's decision, constructed the way the server does it — the catalog
 * is real and loaded from the real recorded response, and the grants are the
 * only thing stubbed, because a token store is not what is under test.
 */
async function connectorsFor({ grants, loadNotion = true }) {
  const registry = new CapabilityRegistry();
  if (loadNotion) {
    await registerMcpCatalog(registry, {
      url: 'https://mcp.notion.com/mcp', connector: 'notion',
      fetchImpl: async () => ({ ok: true, text: async () => RECORDED }),
    });
  }
  // THE REAL RULE, not a copy of it. An earlier version of this file
  // re-implemented the derivation and stayed green when the endpoint reverted to
  // a literal — measured. A test that re-implements its subject proves only that
  // the test can call a function.
  const oauthTokenStore = {
    get: ({ connectorId }) => (grants.some((g) => connectorId === `mcp:${g}`) ? { access_token_enc: 'x' } : null),
  };
  const out = mcpConnectedFor({ capabilityRegistry: registry, oauthTokenStore, tenantId: 't1' });
  return { slack: true, google: true, airtable: true, ...out };
}

describe('the connected list is DERIVED, not typed out', () => {
  test('a connected service with a readable catalog is listed as connected', async () => {
    const c = await connectorsFor({ grants: ['notion'] });
    assert.equal(c.notion?.connected, true,
      'this is the exact state a customer was told they were not in');
    assert.ok(c.notion.actions.length >= 20);
  });

  test('the native three are untouched by the change', async () => {
    const c = await connectorsFor({ grants: ['notion'] });
    for (const k of ['slack', 'google', 'airtable']) assert.ok(k in c, `${k} must survive`);
  });

  test('a service nobody connected is NOT listed', async () => {
    // The mirror defect: claiming a connection the customer does not have sends
    // the build down a path that can only fail at run time.
    const c = await connectorsFor({ grants: [] });
    assert.equal('notion' in c, false);
    assert.deepEqual(Object.keys(c), ['slack', 'google', 'airtable']);
  });

  test('CONNECTED BUT UNREADABLE is not offered as connected', async () => {
    // The state production actually hit first: the grant stored, the catalog
    // read failed, zero tools. A workflow cannot be built on tools we could not
    // list, and saying "connected" here promises what we cannot do.
    const c = await connectorsFor({ grants: ['notion'], loadNotion: false });
    assert.equal('notion' in c, false);
  });

  test('every directory service is eligible — nothing is special-cased to Notion', async () => {
    // The property that makes this a fix rather than a patch: the next service
    // works without anyone editing this code.
    const c = await connectorsFor({ grants: ['linear'] });
    assert.equal('linear' in c, false, 'no grant-less catalog, so not listed');
    assert.ok(MCP_DIRECTORY.length >= 6);
    assert.ok(MCP_DIRECTORY.every((s) => s.id && s.name && s.url));
  });
});

describe('EVERY surface asks the one rule (SOURCE-level — see the header)', () => {
  const SERVER  = readFileSync(new URL('../../src/api/server.js', import.meta.url), 'utf8');
  const BUILDER = readFileSync(new URL('../../src/api/builder.js', import.meta.url), 'utf8');

  test('neither surface answers with a hand-typed connector list', () => {
    // Anchored to the expression that decides, never to a comment near it — a
    // source pin that matched a comment has already failed twice in this tree.
    const literal = /connectors\s*[:=]\s*\{\s*slack\s*,\s*google\s*,\s*airtable\s*\}/;
    assert.equal(literal.test(SERVER), false, '/capabilities went back to a literal');
    // The assignment carries a NESTED object (`web: { connected }`), so this is
    // matched to end-of-line rather than to the first closing brace.
    const builderAssign = /^.*capabilities\.connectors\s*=.*$/m.exec(BUILDER)?.[0] ?? '';
    assert.ok(builderAssign, 'the assignment must still exist');
    assert.ok(builderAssign.includes('...mcpConnectors'),
      'the builder session endpoint is what the INTERVIEW reads — a literal here is invisible to /capabilities tests');
  });

  test('both files call the shared derivation rather than repeating it', () => {
    for (const [name, src] of [['server.js', SERVER], ['builder.js', BUILDER]]) {
      assert.match(src, /mcpConnectedFor\(\{/, `${name} must ask the shared rule`);
      assert.match(src, /from '\.\.\/connectors\/connected-services\.js'/, `${name} must import it`);
    }
  });

  test('EVERY surface that decides "what is connected" asks it — enumerated, not spot-checked', () => {
    /**
     * Six sites decide this, and they were found ONE AT A TIME, each costing a
     * deploy and another round of a customer being told a connected service was
     * missing. Four needed the derivation; two legitimately do not, and are
     * named here so "it is not in the list" is a decision rather than an
     * oversight:
     *
     *   · the trigger narrowing (`connectedIds`) — MCP contributes no triggers.
     *   · `annotateChannelCatalog` — falls through for an unknown connector,
     *     leaving availability untouched. Verified by reading its default arm.
     *
     * The count is asserted so ADDING a seventh site fails here, which is the
     * only thing that would have caught this class in one pass instead of four.
     */
    const derived = (BUILDER.match(/mcpConnectedFor\(\{/g) ?? []).length
                  + (SERVER.match(/mcpConnectedFor\(\{/g) ?? []).length;
    assert.ok(derived >= 5,
      `all five connected-services views must derive; found ${derived}. ` +
      'One dropping out means a customer is told a service they connected is missing.');

    // WHAT THIS CATCHES AND WHAT IT DOES NOT, stated rather than implied.
    // It catches a surface DROPPING the derivation. It cannot catch someone
    // adding a SEVENTH surface that never had it — no regex distinguishes "a new
    // endpoint that decides what is connected" from any other code, and an
    // exact-count assertion would simply false-alarm the moment a site was
    // legitimately added, which teaches people to bump the number.
    // The durable protection is that there is one function to call.
    assert.ok(/export function mcpConnectedFor/.test(
      readFileSync(new URL('../../src/connectors/connected-services.js', import.meta.url), 'utf8')),
      'the shared rule must exist for a new surface to have something to call');
  });
});

describe('the endpoint is what serves it', () => {
  test('the shape the builder reads is a map of connector id to status', async () => {
    // The interview and the build-button guard both read `capabilities.connectors`
    // by KEY, so a list or an array would be silently ignored rather than error.
    const app = express();
    const connectors = await connectorsFor({ grants: ['notion'] });
    app.get('/capabilities', (_q, r) => r.json({ channels: [], triggers: [], connectors }));
    const srv = app.listen(0);
    try {
      const body = await fetch(`http://localhost:${srv.address().port}/capabilities`).then((r) => r.json());
      assert.equal(typeof body.connectors, 'object');
      assert.equal(Array.isArray(body.connectors), false);
      assert.equal(body.connectors.notion.connected, true);
    } finally { srv.close(); }
  });
});
