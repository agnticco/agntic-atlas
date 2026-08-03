/**
 * A CAPABILITY THAT CAN BE PUBLISHED MUST BE ABLE TO RUN.
 *
 * ── What happened (prod, 2026-08-03) ───────────────────────────────────────
 *
 * The first workflow ever built on a one-click connector was built, approved
 * step by step, tested — "Contract kept · every promise held · cleared to go
 * live" — published, and then its first real run failed:
 *
 *     create_page: Channel "notion_create-pages" has no handler
 *
 * The catalog gave the capability a shape and the connect gave it a token.
 * Nothing gave it a way to ACT. So it could be chosen, validated, tested and
 * published, and did nothing.
 *
 * THE TEST COULD NOT HAVE CAUGHT IT, and that is the part worth keeping: a dry
 * run stubs the send and reported `wouldDeliver: true`. That is correct — a test
 * run sends nothing by design — which is precisely why "it passed the test" is
 * never the same as "it works", and why this file drives the handler itself.
 *
 * ── Mutations, run by hand (2026-08-03) ────────────────────────────────────
 *   M1  the handler is removed again                → 3 red
 *   M2  a tool's own error reads as success         → 1 red
 *   M3  it calls the service with no token          → 1 red
 *   M4  Atlas's bookkeeping is forwarded as an arg  → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerMcpCatalog, callMcpTool } from '../../src/connectors/mcp-catalog.js';

const RECORDED = readFileSync(new URL('../fixtures/notion-tools-list.sse.txt', import.meta.url), 'utf8');

/** A server that records what it was asked to do. */
function service({ isError = false, text = 'created' } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    if (body.method === 'tools/list') return { ok: true, status: 200, text: async () => RECORDED };
    calls.push({ url, auth: opts.headers?.authorization, method: body.method, params: body.params });
    return { ok: true, status: 200, text: async () => 'event: message\ndata: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { isError, content: [{ type: 'text', text }] },
    }) + '\n\n' };
  };
  return { fetchImpl, calls };
}

async function notionCatalog(svc) {
  const registry = new CapabilityRegistry();
  await registerMcpCatalog(registry, { url: 'https://mcp.notion.com/mcp', connector: 'notion', fetchImpl: svc.fetchImpl });
  return registry;
}

describe('every projected capability can actually act', () => {
  test('each one HAS a handler — the absence of this shipped a dead workflow', async () => {
    // Asked through `getHandler` — the accessor the EXECUTORS use. `list()`
    // deliberately returns public shapes with no handler on them, so checking
    // there would have reported every native capability as broken too.
    const registry = await notionCatalog(service());
    const missing = registry.list().filter((c) => typeof registry.getHandler(c.id) !== 'function');
    assert.deepEqual(missing.map((c) => c.id), [],
      'a capability with no handler can be published and then fail on its first real run');
  });

  test('the handler calls the tool on the real service, with the tenant\'s token', async () => {
    const svc = service();
    const registry = await notionCatalog(svc);
    const handle = registry.getHandler('notion_create-pages');

    const out = await handle({ config: { mcpToken: 'tok_abc', pages: [{ properties: { title: 'X' } }] } });
    assert.equal(out.ok, true);

    assert.equal(svc.calls.length, 1);
    assert.equal(svc.calls[0].method, 'tools/call');
    assert.equal(svc.calls[0].url, 'https://mcp.notion.com/mcp', 'it must call the server it came from');
    assert.equal(svc.calls[0].auth, 'Bearer tok_abc', 'the tenant\'s credential, not a shared one');
    assert.equal(svc.calls[0].params.name, 'notion-create-pages',
      'the SERVICE\'s own tool name, not the id Atlas namespaced it under');
  });

  test('the tool\'s inputs are forwarded verbatim; Atlas\'s bookkeeping is not', async () => {
    // Filtering inputs to a list we maintain would be the hand-typed-list shape
    // this whole projection exists to remove. But the credential and the routing
    // keys are OURS and must never reach the service as arguments.
    const svc = service();
    const registry = await notionCatalog(svc);
    const handle = registry.getHandler('notion_create-pages');

    await handle({ config: { mcpToken: 't', channel: 'notion_create-pages', action: 'x', _tenantId: 'platform',
      pages: [{ properties: { title: 'X' } }], parent: 'p', somethingNew: 1 } });

    const args = svc.calls[0].params.arguments;
    assert.deepEqual(Object.keys(args).sort(), ['pages', 'parent', 'somethingNew']);
    for (const ours of ['mcpToken', 'channel', 'action', '_tenantId'])
      assert.equal(ours in args, false, `${ours} is Atlas's, not the service's`);
  });
});

describe('what it refuses', () => {
  test('a tool that REFUSES the write is a failure, not a success', async () => {
    // MCP reports a tool's own failure inside the result, not as a transport
    // error. Reading only the transport would call a refused write a success —
    // the silent failure this product exists to prevent.
    const svc = service({ isError: true, text: 'insufficient permissions for this page' });
    const registry = await notionCatalog(svc);
    const handle = registry.getHandler('notion_create-pages');
    await assert.rejects(() => handle({ config: { mcpToken: 't', pages: [] } }), /insufficient permissions/);
  });

  test('with no credential it refuses rather than calling anonymously', async () => {
    // An unauthenticated call 401s, and a 401 reads to a customer as "the service
    // is broken" instead of "this workspace is not connected".
    const svc = service();
    const registry = await notionCatalog(svc);
    const handle = registry.getHandler('notion_create-pages');
    await assert.rejects(() => handle({ config: { pages: [] } }), /not connected/i);
    assert.equal(svc.calls.length, 0, 'nothing may reach the service without a token');
  });

  test('a reply carrying no text still succeeds rather than looking empty', async () => {
    const svc = service({ text: '' });
    const registry = await notionCatalog(svc);
    const handle = registry.getHandler('notion_create-pages');
    assert.equal((await handle({ config: { mcpToken: 't', pages: [] } })).ok, true);
  });
});

describe('callMcpTool on its own', () => {
  test('it refuses without a token before any request is made', async () => {
    let called = false;
    await assert.rejects(() => callMcpTool({
      url: 'https://x.test/mcp', tool: 't', args: {}, token: null,
      fetchImpl: async () => { called = true; return { ok: true, text: async () => '{}' }; },
    }), /not connected/i);
    assert.equal(called, false);
  });
});
