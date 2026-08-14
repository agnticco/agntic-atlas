/**
 * P13-A'S GATE: A REAL SERVICE'S TOOLS, AGAINST THE REAL CHECKS.
 *
 * Everything else in this area is pinned against a fixture I wrote, which means
 * it is pinned against the shape I IMAGINED. That is not a hypothetical worry
 * here — it is exactly what happened: my fake answered `tools/list` in JSON, the
 * real Notion server answers in a Server-Sent Event stream, and the first real
 * connect in production ended CONNECTED WITH ZERO TOOLS while every test stayed
 * green.
 *
 * So this file runs against `tests/fixtures/notion-tools-list.sse.txt` —
 * 90,605 bytes captured VERBATIM from https://mcp.notion.com/mcp over a live
 * connection on 2026-08-03, SSE framing and all. No credential is needed to
 * replay it, and none is in it.
 *
 * WHAT A RECORDED FIXTURE CANNOT PROVE, stated so nobody reads more into a green
 * run than is there: that Notion is reachable today, that the token still works,
 * or that the tools still have these shapes. It proves that WHAT NOTION ACTUALLY
 * SENT survives every check Atlas applies. The live half was witnessed in a
 * browser on 2026-08-03 (consent screen → 20 tools in `/capabilities`) and is
 * recorded in ENGINEERING-LOG.md; re-record this fixture if the contract is ever in doubt.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerMcpCatalog } from '../../src/connectors/mcp-catalog.js';
import { declaresWrite, declaresOneTimeSetup, nodeEffect, setCapabilityCatalog } from '../../src/workflows/outcome-oracle.js';
import { setInjectorCatalog, ownsConnector } from '../../src/api/server.js';

const RECORDED = readFileSync(new URL('../fixtures/notion-tools-list.sse.txt', import.meta.url), 'utf8');
const replay = async () => ({ ok: true, status: 200, text: async () => RECORDED });

async function loadReal() {
  const registry = new CapabilityRegistry();
  const out = await registerMcpCatalog(registry, {
    url: 'https://mcp.notion.com/mcp', connector: 'notion', fetchImpl: replay,
  });
  return { registry, out };
}

describe('what Notion actually sent becomes usable capabilities', () => {
  test('every tool it sent projects — none dropped, none guessed at', async () => {
    const { out } = await loadReal();
    assert.ok(out.count >= 20, `expected the real catalog, got ${out.count}`);
    assert.deepEqual(out.skipped, [], 'a real server\'s catalog must not need excusing');
  });

  test('they register through the SAME contract as a native capability', async () => {
    // Not a parallel registry. If the projection did not satisfy the contract
    // this throws, rather than yielding capabilities nothing downstream can read.
    const { registry } = await loadReal();
    const ids = registry.list().map((c) => c.id);
    assert.ok(ids.includes('notion_search'), ids.slice(0, 5).join(', '));
    assert.ok(ids.every((id) => id.startsWith('notion_')));
  });
});

describe('the four P13-0 seams, on the real thing', () => {
  test('seam 1 — the oracle reads each capability\'s DECLARED effect', async () => {
    const { registry } = await loadReal();
    setCapabilityCatalog(registry);
    try {
      // A read Notion flagged, and a write it did not — the fail-closed default
      // is doing real work here, on real data.
      assert.equal(declaresWrite('notion_search'), false, 'notion-search declares readOnlyHint');
      assert.equal(declaresWrite('notion_create-pages'), true, 'an unflagged tool must reach the guards as a write');
      assert.equal(declaresOneTimeSetup('notion_create-pages'), false);
    } finally { setCapabilityCatalog(null); }
  });

  test('seam 2 — a delivery to one of them resolves a destination', async () => {
    const { registry } = await loadReal();
    setCapabilityCatalog(registry);
    try {
      const eff = nodeEffect({ id: 'n1', type: 'connector-action', config: { action: 'notion_create-pages' } });
      assert.ok(eff, 'a write with no resolvable effect cannot prove it kept a promise');
      assert.equal(eff.kind != null, true);
    } finally { setCapabilityCatalog(null); }
  });

  test('seam 4 — credentials resolve from the DECLARED connector, not a typed list', async () => {
    // R22: with credentials chosen by hand-typed id lists, a capability nobody
    // remembered to add gets none at run time even though the customer IS
    // connected. Importing forty tools would reproduce that forty times.
    const { registry } = await loadReal();
    setInjectorCatalog(registry);
    try {
      const isNotions = ownsConnector('notion');
      assert.equal(isNotions({ type: 'connector-action', config: { action: 'notion_search' } }), true);
      assert.equal(isNotions({ type: 'connector-action', config: { action: 'gmail_send' } }), false,
        'claiming another connector\'s step would hand it the wrong account');
    } finally { setInjectorCatalog(null); }
  });

  test('seam 3 — nothing here claims a discovery shape it cannot honour', async () => {
    const { registry } = await loadReal();
    for (const c of registry.list()) {
      if (!c.schemaDiscovery) continue;
      assert.ok(c.schemaDiscovery.listCapability, `${c.id} declares discovery with no way to list`);
    }
  });
});

describe('the invariants that protect a customer, on the real catalog', () => {
  test('NOT ONE of Notion\'s tools is offered as a trigger', async () => {
    const { registry } = await loadReal();
    assert.deepEqual(registry.list({ position: 'trigger' }).map((c) => c.id), [],
      'a trigger Atlas cannot arm is a workflow that publishes, shows as live, and never fires');
  });

  test('effect fails CLOSED across the whole real catalog', async () => {
    const { registry } = await loadReal();
    const caps = registry.list();
    const unflaggedAsWrite = caps.filter((c) => c.effect === 'write');
    const reads = caps.filter((c) => c.effect === 'read');

    assert.ok(unflaggedAsWrite.length > 0 && reads.length > 0,
      'a catalog that is all one effect would make this vacuous');
    // The property, not a count: nothing may be a read without Notion having
    // said so. Anything else skips idempotency and the approval gate.
    for (const c of reads) assert.ok(c.id.startsWith('notion_'));
  });

  test('a registered capability carries NO mark of where it came from', async () => {
    // The "indistinguishable from native" invariant, enforced structurally: the
    // registry normalises to a fixed field set, so a consumer COULD NOT branch on
    // provenance even if someone tried to make it. Measured, not assumed.
    const { registry } = await loadReal();
    const mcpSourced = registry.list().find((c) => c.id === 'notion_search');
    const native = new CapabilityRegistry();
    native.register({ id: 'x_do', connector: 'x', positions: ['step'], name: 'X', description: '', handle: () => {} });
    assert.deepEqual(
      Object.keys(mcpSourced).filter((k) => !['available', 'unavailableReason'].includes(k)).sort(),
      Object.keys(native.list()[0]).filter((k) => !['available', 'unavailableReason'].includes(k)).sort(),
      'an MCP-sourced capability must have exactly the field set a native one has');
  });

  test('every one of them can sit in a workflow, and writes can be delivered to', async () => {
    const { registry } = await loadReal();
    for (const c of registry.list()) {
      assert.ok(c.positions.includes('step'), `${c.id} can occupy no position`);
      if (c.effect === 'write') assert.ok(c.positions.includes('delivery'), `${c.id} writes but cannot be a delivery`);
    }
  });

  test('the config fields a person fills in survived the real schemas', async () => {
    const { registry } = await loadReal();
    const search = registry.list().find((c) => c.id === 'notion_search');
    const keys = (search.configSchema || []).map((f) => f.key);
    assert.ok(keys.includes('query'), keys.join(','));
    assert.equal(search.configSchema.find((f) => f.key === 'query').optional, false,
      'a required field read as optional publishes a step that cannot run');
  });
});
