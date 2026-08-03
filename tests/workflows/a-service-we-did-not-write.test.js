/**
 * A PROMISE ABOUT A SERVICE NOBODY TAUGHT ATLAS IS MATCHED ON THE SERVICE.
 *
 * ── What happened (witnessed on prod, 2026-08-03) ──────────────────────────
 *
 * The first workflow ever built on a one-click connector: search the web, write
 * a 5-bullet briefing, create a Notion page titled with the date. It tested
 * green — "Contract kept · cleared to go live" — and then COULD NOT PUBLISH:
 *
 *   "The outcome promises "notion:AI Agents Briefing" (document_exists), but no
 *    step in this workflow does that — the request would be silently dropped."
 *
 * The last step does exactly that. Two independent mismatches, both from
 * guessing about a tool we did not write:
 *
 *   · `notion` is not in `DOC_CONNECTORS`, so a page was filed `record_exists`
 *     against a `document_exists` promise — two words for one thing.
 *   · the promise named "AI Agents Briefing"; the step titles the page
 *     "AI Agents Briefing — August 3, 2026", because the customer asked for the
 *     date in the title. Compared as strings, they differ.
 *
 * ── The rule (Charles's call: "match on the service alone") ────────────────
 *
 * We do not know which of an arbitrary tool's inputs names a place, and we do
 * not know whether that service calls the result a page, a record or a message.
 * So a projected capability DECLARES its destination unknowable, and a promise
 * about it is satisfied by ANY write to that service.
 *
 * WEAKER, AND TRUE. The strong version was strong and FALSE, which is the trade
 * this product exists to make. It is the same exemption the Atlas inbox has
 * always had, for the same reason: the locator was never an address.
 *
 * ── Mutations, run by hand (2026-08-03) ────────────────────────────────────
 *   M1  the declaration is dropped from the projection    → 3 red
 *   M2  the registry stops keeping it                     → 3 red
 *   M3  it leaks into a fail-open (any service matches)   → 3 red
 *   M4  the declared-read guard is removed                → UNKILLABLE, and the
 *       reason is recorded rather than contrived into a kill: the legacy verb
 *       patterns require UNDERSCORE boundaries (`create_record`, `add_row`) and
 *       every MCP tool name is hyphenated (`notion-create-pages`), so no MCP
 *       capability can ever reach them. For a projected capability the
 *       DECLARATION is the only thing that produces an effect at all — which is
 *       why `projectEffect` failing closed to `write` is load-bearing and is
 *       pinned separately in mcp-catalog-cimd.test.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerMcpCatalog } from '../../src/connectors/mcp-catalog.js';
import { satisfiesAssertion, setCapabilityCatalog } from '../../src/workflows/outcome-oracle.js';

const RECORDED = readFileSync(new URL('../fixtures/notion-tools-list.sse.txt', import.meta.url), 'utf8');

async function withNotion(fn) {
  const registry = new CapabilityRegistry();
  await registerMcpCatalog(registry, {
    url: 'https://mcp.notion.com/mcp', connector: 'notion',
    fetchImpl: async () => ({ ok: true, text: async () => RECORDED }),
  });
  setCapabilityCatalog(registry);
  try { return await fn(registry); } finally { setCapabilityCatalog(null); }
}

/** The delivery node from the prod spec, verbatim in shape. */
const CREATE_PAGE = {
  id: 'create_page', type: 'deliver',
  config: {
    channel: 'notion_create-pages',
    pages: [{ properties: { title: '{{extract_briefing.title}}' }, content: '{{extract_briefing.briefing}}' }],
  },
};

describe('the promise that blocked a correct workflow now holds', () => {
  test('the exact prod assertion is satisfied by the exact prod step', async () => {
    await withNotion(() => {
      assert.equal(
        satisfiesAssertion({ id: 'a1', kind: 'document_exists', target: 'notion:AI Agents Briefing' }, CREATE_PAGE),
        true,
        'this is the workflow that tested green and could not be published');
    });
  });

  test('the service\'s own word for the result does not matter', async () => {
    // Notion says page, our verb regex says record, the customer said document.
    // None of those three disagree about what happened.
    await withNotion(() => {
      for (const kind of ['document_exists', 'record_exists', 'message_sent']) {
        assert.equal(satisfiesAssertion({ kind, target: 'notion:anything' }, CREATE_PAGE), true, kind);
      }
    });
  });

  test('nor does the specific page name', async () => {
    await withNotion(() => {
      for (const target of ['notion:AI Agents Briefing', 'notion:Something Else', 'notion']) {
        assert.equal(satisfiesAssertion({ kind: 'document_exists', target }, CREATE_PAGE), true, target);
      }
    });
  });
});

describe('it did NOT become a fail-open', () => {
  test('a promise about a DIFFERENT service is still broken', async () => {
    await withNotion(() => {
      assert.equal(satisfiesAssertion({ kind: 'document_exists', target: 'linear:Anything' }, CREATE_PAGE), false);
      assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack:#ops' }, CREATE_PAGE), false);
      assert.equal(satisfiesAssertion({ kind: 'record_exists', target: 'airtable:Leads' }, CREATE_PAGE), false);
    });
  });

  test('a READ satisfies nothing, exactly as before', async () => {
    await withNotion(() => {
      const read = { id: 'r', type: 'connector-action', config: { action: 'notion_search', query: 'x' } };
      assert.equal(satisfiesAssertion({ kind: 'document_exists', target: 'notion:X' }, read), false,
        'a search is not a write, whoever wrote the tool');
    });
  });

  test('a read whose NAME says "create" is still a read', () => {
    /**
     * A remote service may perfectly well ship a READ called `create-view`.
     * This asserts the outcome, not the mechanism: measured 2026-08-03, removing
     * the declared-read guard does not change it, because the verb patterns
     * underneath require underscore boundaries and MCP names are hyphenated. So
     * this is a REGRESSION DETECTOR for the day either of those changes, not a
     * proof that the guard is what stops it. Stated plainly rather than left to
     * read as stronger than it is.
     */
    const registry = new CapabilityRegistry();
    registry.register({
      id: 'acme_create-report', connector: 'acme', positions: ['step'],
      name: 'Create a report view', description: 'Builds a read-only view.',
      effect: 'read', locatorFree: true, handle: () => {},
    });
    setCapabilityCatalog(registry);
    try {
      const node = { id: 'r', type: 'connector-action', config: { action: 'acme_create-report' } };
      assert.equal(satisfiesAssertion({ kind: 'document_exists', target: 'acme:anything' }, node), false,
        'the DECLARATION must beat the verb in the name — otherwise a read keeps a promise');
    } finally { setCapabilityCatalog(null); }
  });

  test('a promise nothing delivers to is still broken', async () => {
    await withNotion(() => {
      assert.equal(satisfiesAssertion({ kind: 'document_exists', target: 'notion:X' }, null), false);
      assert.equal(satisfiesAssertion({ kind: 'document_exists', target: 'notion:X' },
        { id: 'x', type: 'llm', config: {} }), false);
    });
  });

  test('OUR OWN connectors are untouched — their locators are still compared', async () => {
    // The whole point is that this applies only where we cannot know. A native
    // capability declares its destination, and a wrong one must still fail.
    await withNotion(() => {
      const sheets = { id: 's', type: 'deliver', config: { channel: 'sheets_append', spreadsheetId: 'Leads' } };
      assert.equal(satisfiesAssertion({ kind: 'record_exists', target: 'sheets:Something Else' }, sheets), false,
        'a native connector must not inherit the exemption');
    });
  });
});

describe('the declaration is what carries it', () => {
  test('every projected capability declares its destination unknowable', async () => {
    await withNotion((registry) => {
      const caps = registry.list();
      assert.ok(caps.length >= 20);
      assert.ok(caps.every((c) => c.locatorFree === true),
        'a capability that forgets to declare it gets the guessing behaviour back');
    });
  });

  test('and a NATIVE capability does not', async () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: 'sheets_append', connector: 'google', positions: ['step', 'delivery'],
      name: 'Append', description: '', effect: 'write', locatorKeys: ['spreadsheetId'], handle: () => {},
    });
    assert.equal(registry.list()[0].locatorFree, false,
      'declaring nothing must mean "we know where this writes", not the exemption');
  });
});
