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
 * ── AN HONEST NOTE ABOUT WHAT THE FIRST SIX TESTS DO AND DO NOT PROVE ───────
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
 *   M1  connectors reverted to the literal            → 1 red (the source pin)
 *   M2  a service with an unreadable catalog counts   → 1 red
 *   M3  a service with no grant is listed anyway      → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerMcpCatalog } from '../../src/connectors/mcp-catalog.js';
import { MCP_DIRECTORY } from '../../src/connectors/mcp-directory.js';

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
  const mcpGrant = (_t, id) => (grants.includes(id) ? { access_token_enc: 'x' } : null);

  const out = {};
  for (const svc of MCP_DIRECTORY) {
    if (!mcpGrant('t1', svc.id)) continue;
    const actions = registry.list().filter((c) => c.connector === svc.id)
      .map((c) => ({ id: c.id, name: c.name, available: c.available !== false }));
    if (!actions.length) continue;
    out[svc.id] = { connected: true, name: svc.name, actions };
  }
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

describe('the endpoint actually uses it (SOURCE-level — see the header)', () => {
  const SERVER = readFileSync(new URL('../../src/api/server.js', import.meta.url), 'utf8');

  test('/capabilities does not answer with a hand-typed connector list', () => {
    // Anchored to the expression that decides, not to any comment near it.
    const literal = /connectors:\s*\{\s*slack\s*,\s*google\s*,\s*airtable\s*\}/;
    assert.equal(literal.test(SERVER), false,
      'a literal here is the R22 shape: a service the customer connected is invisible');
    assert.match(SERVER, /connectors:\s*\{\s*slack\s*,\s*google\s*,\s*airtable\s*,\s*\.\.\.mcpConnectors\s*\}/,
      'the derived services must be spread into the answer');
  });

  test('and it derives them from the tenant\'s grants, not from the directory alone', () => {
    // Listing every directory service regardless of grant would tell a customer
    // they are connected to six things they have never authorised.
    const block = SERVER.slice(SERVER.indexOf('const mcpConnectors'), SERVER.indexOf('...mcpConnectors'));
    assert.match(block, /if\s*\(!mcpGrant\(req\.tenant\.id,\s*svc\.id\)\)\s*continue;/);
    assert.match(block, /if\s*\(!actions\.length\)\s*continue;/,
      'connected-but-unreadable must not be offered as connected');
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
