/**
 * A REMOTE SERVER'S TOOLS BECOME ATLAS CAPABILITIES — INDISTINGUISHABLE FROM NATIVE.
 *
 * P13-A's gate. The phase connects to services NOBODY hand-built, so the whole
 * thing rests on one property: a capability sourced from a remote MCP server must
 * be readable by every consumer that reads a native one — the converger, the
 * engine, the destination oracle, the write and approval guards, the plain-English
 * step words. The moment a consumer can tell the difference, all of them need
 * teaching about two kinds of capability, which is the fragmentation
 * `CapabilityRegistry` was built to end.
 *
 * ── The decision most worth defending ───────────────────────────────────────
 *
 * EFFECT FAILS CLOSED TO `write`. MCP's `readOnlyHint` is optional and usually
 * absent, and two guards hang off a declared effect: idempotency and the
 * approval-strength check. A capability that writes but reads as a read skips
 * BOTH.
 *
 * The asymmetry decides it. Wrongly writing costs a spurious idempotency key and
 * an approval nobody needed. Wrongly reading costs a duplicate charge, a
 * duplicate email, a record deleted twice, with no approval anywhere — and this
 * codebase already recorded `airtable_delete_record`, its most destructive
 * capability, escaping both guards because a verb regex did not recognise it.
 *
 * ── Mutations, run by hand (2026-08-03) ─────────────────────────────────────
 *   M1  effect defaults to `read` when unflagged   → 3 red
 *   M2  MCP capabilities may be triggers           → 1 red
 *   M3  an unprojectable tool is guessed at        → 1 red
 *   M4  a non-https transport is accepted          → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import {
  projectMcpTool, projectInputSchema, projectEffect, loadMcpCatalog, registerMcpCatalog, parseRpcBody,
} from '../../src/connectors/mcp-catalog.js';
import { declaresWrite, nodeEffect, setCapabilityCatalog } from '../../src/workflows/outcome-oracle.js';

/** A realistic Notion-shaped catalog, including the shapes that must be refused. */
const TOOLS = [
  { name: 'search', description: 'Search pages and databases.',
    annotations: { readOnlyHint: true, title: 'Search Notion' },
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for' }, page_size: { type: 'integer' } }, required: ['query'] } },
  { name: 'create_page', description: 'Create a page.',
    inputSchema: { type: 'object', properties: { parent: { type: 'string' }, title: { type: 'string' } }, required: ['parent', 'title'] } },
  { name: 'delete_block', description: 'Delete a block.', annotations: { destructiveHint: true },
    inputSchema: { type: 'object', properties: { block_id: { type: 'string' } }, required: ['block_id'] } },
];
/**
 * The real server answers as a Server-Sent Event stream, not plain JSON. The
 * first version of this fixture returned JSON — the shape the author imagined —
 * and production failed on the very first real connect. SSE is now the DEFAULT
 * here for exactly that reason; the JSON framing is exercised separately.
 */
const sse = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
const serve = (tools, { framing = 'sse' } = {}) => async () => {
  const body = { jsonrpc: '2.0', id: 1, result: { tools } };
  return { ok: true, status: 200, text: async () => (framing === 'sse' ? sse(body) : JSON.stringify(body)) };
};

const load = (tools = TOOLS) => registerMcpCatalog(new CapabilityRegistry(),
  { url: 'https://mcp.notion.com/mcp', connector: 'notion', fetchImpl: serve(tools) });

describe('effect fails CLOSED to write', () => {
  test('an explicit readOnlyHint is the ONLY thing that yields a read', () => {
    assert.equal(projectEffect({ readOnlyHint: true }), 'read');
    for (const a of [undefined, {}, { readOnlyHint: false }, { readOnlyHint: 'true' }, { destructiveHint: false }])
      assert.equal(projectEffect(a), 'write', JSON.stringify(a));
  });

  test('an unflagged tool is a write, and reaches the guards as one', () => {
    // Not just "the field says write" — the guard that protects a customer must
    // actually see it. `declaresWrite` feeds idempotency AND approval strength.
    const cap = projectMcpTool(TOOLS[1], { connector: 'notion' });
    assert.equal(cap.effect, 'write');
    const reg = new CapabilityRegistry();
    reg.register(cap);
    setCapabilityCatalog(reg);
    assert.equal(declaresWrite('notion_create_page'), true,
      'an un-flagged MCP write must not skip idempotency and the approval check');
    setCapabilityCatalog(null);
  });

  test('destructiveHint can never soften it', () => {
    assert.equal(projectMcpTool(TOOLS[2], { connector: 'notion' }).effect, 'write');
  });
});

describe('never a trigger — a trigger Atlas cannot arm is a workflow that never fires', () => {
  test('no MCP capability occupies the trigger position', async () => {
    const reg = new CapabilityRegistry();
    await registerMcpCatalog(reg, { url: 'https://mcp.notion.com/mcp', connector: 'notion', fetchImpl: serve(TOOLS) });
    assert.equal(reg.list({ position: 'trigger' }).length, 0,
      'arming, renewal, authenticity and teardown are not in the MCP tool contract');
  });

  test('a read is a step; a write is a step AND a delivery, like every native write', async () => {
    const reg = new CapabilityRegistry();
    await registerMcpCatalog(reg, { url: 'https://mcp.notion.com/mcp', connector: 'notion', fetchImpl: serve(TOOLS) });
    assert.deepEqual(reg.list().find(c => c.id === 'notion_search').positions, ['step']);
    assert.deepEqual(reg.list().find(c => c.id === 'notion_create_page').positions, ['step', 'delivery']);
  });
});

describe('the tool schema becomes a config schema a person can fill in', () => {
  test('required and optional are preserved, with the author\'s own order', () => {
    const fields = projectInputSchema(TOOLS[0].inputSchema);
    assert.deepEqual(fields.map(f => f.key), ['query', 'page_size']);
    assert.equal(fields[0].optional, false);
    assert.equal(fields[1].optional, true);
    assert.equal(fields[0].hint, 'What to look for');
    assert.equal(fields[1].type, 'number', 'an integer is a number to a form');
  });

  test('an unknown type becomes a string rather than vanishing', () => {
    // Dropping it would silently remove a field the tool needs, and the run would
    // fail at the service with no clue why.
    const f = projectInputSchema({ type: 'object', properties: { odd: { type: 'quantum' } } });
    assert.equal(f.length, 1);
    assert.equal(f[0].type, 'string');
  });

  test('a tool with no schema is still usable', () => {
    assert.deepEqual(projectInputSchema(undefined), []);
    assert.deepEqual(projectInputSchema({ type: 'object' }), []);
  });
});

describe('indistinguishable from a native capability', () => {
  test('it registers through the SAME contract, or throws', async () => {
    // Not a second registry. A projection that does not satisfy the contract must
    // fail here, not produce a capability nothing downstream can read.
    const out = await load();
    assert.equal(out.count, 3);
  });

  test('and the oracle reads its effect exactly as it reads a native one', async () => {
    const reg = new CapabilityRegistry();
    await registerMcpCatalog(reg, { url: 'https://mcp.notion.com/mcp', connector: 'notion', fetchImpl: serve(TOOLS) });
    setCapabilityCatalog(reg);
    const eff = nodeEffect({ id: 'n', type: 'connector-action', config: { action: 'notion_create_page' } });
    assert.ok(eff, 'the destination oracle must see an MCP write as a write');
    assert.equal(eff.kind != null, true);
    setCapabilityCatalog(null);
  });

  test('the id names its connector, which is what credential resolution reads', () => {
    assert.equal(projectMcpTool({ name: 'search' }, { connector: 'linear' }).id, 'linear_search');
  });
});

describe('the reply may arrive in either wire format', () => {
  /**
   * WITNESSED IN PRODUCTION, 2026-08-03, on the first real connect: the sign-in
   * succeeded and the catalog read threw `Unexpected token 'e'`, so the workspace
   * read CONNECTED WITH ZERO TOOLS — a service that looks like it can do nothing.
   */
  test('a streamed reply is read (this is what Notion actually sends)', async () => {
    const out = await loadMcpCatalog({ url: 'https://mcp.notion.com/mcp', connector: 'notion', fetchImpl: serve(TOOLS, { framing: 'sse' }) });
    assert.equal(out.count, 3);
  });

  test('a plain JSON reply is read too — the server chooses, not us', async () => {
    const out = await loadMcpCatalog({ url: 'https://mcp.notion.com/mcp', connector: 'notion', fetchImpl: serve(TOOLS, { framing: 'json' }) });
    assert.equal(out.count, 3);
  });

  test('the LAST result frame wins, so a progress notification is not the answer', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'
      + 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"real"}]}}\n\n';
    assert.equal(parseRpcBody(body).result.tools[0].name, 'real');
  });

  test('keep-alives and comments are skipped, not mistaken for the answer', () => {
    const body = ': keep-alive\ndata: \nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body).result, { ok: true });
  });

  test('a stream carrying no result FAILS rather than reading as an empty catalog', () => {
    // "No tools" and "we could not read the tools" are different answers, and
    // reporting the second as the first is how a working service looks broken.
    assert.throws(() => parseRpcBody('event: ping\ndata: {"jsonrpc":"2.0"}\n\n'), /streamed no result/);
    assert.throws(() => parseRpcBody('   '), /empty reply/);
  });
});

describe('what it refuses', () => {
  test('an unprojectable tool is dropped AND reported, never guessed at', async () => {
    const out = await loadMcpCatalog({
      url: 'https://mcp.notion.com/mcp', connector: 'notion',
      fetchImpl: serve([...TOOLS, { description: 'no name' }]),
    });
    assert.equal(out.count, 3);
    assert.equal(out.skipped.length, 1, 'a capability half-understood is worse than one absent');
    assert.match(out.skipped[0].reason, /no name/i);
  });

  test('a non-https transport is refused — this is not the stdio pool by another name', async () => {
    await assert.rejects(
      () => loadMcpCatalog({ url: 'stdio:///usr/local/bin/server', connector: 'x', fetchImpl: serve([]) }),
      /remote-only/);
  });

  test('a server error surfaces rather than yielding an empty catalog', async () => {
    // Silently returning nothing would read as "this server has no tools", which
    // is the certifying-the-absence-of-evidence shape.
    await assert.rejects(
      () => loadMcpCatalog({ url: 'https://x.test/mcp', connector: 'x',
        fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) }),
      /HTTP 503/);
  });
});
