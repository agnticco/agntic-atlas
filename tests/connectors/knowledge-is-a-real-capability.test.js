/**
 * KNOWLEDGE IS A TOOL THE AGENT CAN SEE, USE, AND BE HONEST ABOUT.
 *
 * Charles, 2026-07-30: *"We are not exposing the tools that are available to the agent,
 * to the agent properly… Knowledge should be writeable, readable, and contents able to
 * be used in workflows."*
 *
 * Before this, the product had a Knowledge page, a per-tenant RAG index, and **zero
 * registered capabilities** — measured that day as `knowledge/rag capabilities: (NONE)`.
 * The cost was a truthfulness defect, not an inconvenience: asked for a support-reply
 * workflow grounded in company documents, Atlas said *"Perfect — I can pull from your
 * Knowledge docs in the workflow"* with an EMPTY knowledge base, having checked nothing,
 * because nothing in its picture of the world mentioned knowledge at all.
 *
 * THE TWO HALVES PINNED HERE:
 *   1. Knowledge is a registered capability, so everything that reads the catalog — the
 *      interview, the oracle, the write guards, the audits — sees it for free.
 *   2. The interview is told the STATE of Knowledge **including when it is empty**,
 *      because silence read as confirmation is what produced the false claim.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerKnowledgeCapabilities, knowledgeState } from '../../src/connectors/knowledge/index.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { buildSystemPrompt } from '../../src/converger/prompts.js';
import { nodeEffect, setCapabilityCatalog, satisfiesAssertion } from '../../src/workflows/outcome-oracle.js';
import { isWritingAction } from '../../src/workflows/workflow-validator.js';

/** A RAG double that records what it was asked. */
function fakeRag({ hits = [] } = {}) {
  const calls = { queries: [], ingests: [] };
  const handle = {
    async query(q, k) { calls.queries.push({ q, k }); return hits; },
    async ingest(text, meta) { calls.ingests.push({ text, meta }); return 3; },
  };
  return { calls, forTenant: async () => handle };
}

function registry({ sources = [], rag = fakeRag() } = {}) {
  const reg = new CapabilityRegistry();
  registerKnowledgeCapabilities(reg, { forTenant: rag.forTenant, readSources: () => sources });
  return { reg, rag };
}

const capOf = (reg, id) => reg.list().find(c => c.id === id);
// `list()` returns the PUBLIC shape (no handler) — the handler comes from the registry's
// own accessor, which is what the engine uses. Testing the public shape alone would have
// proved nothing about whether these capabilities actually run.
const handlerOf = (reg, id) => reg.getHandler(id);

describe('Knowledge is in the catalog like any other connector', () => {
  test('both capabilities are registered', () => {
    const { reg } = registry();
    assert.ok(capOf(reg, 'knowledge_search'), 'knowledge_search is missing');
    assert.ok(capOf(reg, 'knowledge_write'), 'knowledge_write is missing');
  });

  test('they declare what they do, rather than leaving it to a verb regex', () => {
    const { reg } = registry();
    assert.equal(capOf(reg, 'knowledge_search').effect, 'read');
    assert.equal(capOf(reg, 'knowledge_write').effect, 'write');
    assert.equal(capOf(reg, 'knowledge_write').assertionKind, 'document_exists');
  });

  test('the WRITE names one fixed destination, never the document title', () => {
    // Declaring `locatorKeys: ['title']` would make the note's own NAME the place it was
    // written — the defect that cost three rebuilds on Google Tasks and two on Calendar.
    const cap = capOf(registry().reg, 'knowledge_write');
    assert.deepEqual(cap.locatorKeys, []);
    assert.equal(cap.defaultLocator, 'your Knowledge');
  });

  test('the oracle sees the write, and where it goes', () => {
    const { reg } = registry();
    setCapabilityCatalog(reg);
    const eff = nodeEffect({ id: 'n', type: 'connector-action', config: { action: 'knowledge_write', title: 'Q3 notes' } });
    assert.ok(eff, 'the oracle cannot see the write');
    assert.equal(eff.kind, 'document_exists');
    assert.deepEqual(eff.locators, ['your Knowledge'], 'the title must not be the destination');
  });

  test('…and a promise about Knowledge is kept by it', () => {
    const { reg } = registry();
    setCapabilityCatalog(reg);
    const node = { id: 'n', type: 'connector-action', config: { action: 'knowledge_write', title: 'Q3 notes' } };
    assert.equal(satisfiesAssertion({ id: 'a1', kind: 'document_exists', target: 'knowledge:your Knowledge' }, node), true);
  });

  test('the SEARCH satisfies nothing — a read never keeps a promise', () => {
    const { reg } = registry();
    setCapabilityCatalog(reg);
    assert.equal(nodeEffect({ id: 'n', type: 'connector-action', config: { action: 'knowledge_search', query: 'x' } }), null);
  });

  test('saving to Knowledge counts as a writing action for the approval guards', () => {
    // `knowledge_write` matches no verb in the fallback regex — exactly how
    // `airtable_delete_record` escaped both write guards. The DECLARATION is what
    // must carry it.
    assert.ok(isWritingAction('knowledge_write'));
  });
});

describe('it refuses to search across tenants', () => {
  test('no tenant in scope ⇒ it refuses rather than searching unscoped', () => {
    // RAG is PHYSICALLY isolated per tenant (a closed decision). A silent default here
    // would search one workspace's documents on another's behalf.
    const { reg } = registry();
    return assert.rejects(
      () => handlerOf(reg, 'knowledge_search')({ config: { query: 'anything' } }),
      /no tenant in scope/);
  });

  test('the write refuses too', () => {
    const { reg } = registry();
    return assert.rejects(
      () => handlerOf(reg, 'knowledge_write')({ config: { title: 't' }, body: 'x' }),
      /no tenant in scope/);
  });

  test('the tenant it IS given is the one it searches', async () => {
    const rag = fakeRag({ hits: [] });
    const reg = new CapabilityRegistry();
    let asked = null;
    registerKnowledgeCapabilities(reg, {
      forTenant: async (t) => { asked = t; return (await rag.forTenant()); },
      readSources: () => [],
    });
    await handlerOf(reg, 'knowledge_search')({ config: { query: 'x', _tenantId: 'tenant-A' } });
    assert.equal(asked, 'tenant-A');
  });
});

describe('searching and saving actually work', () => {
  test('a search returns the passages it found', async () => {
    const rag = fakeRag({ hits: [
      { pageContent: 'Refunds are issued within 14 days.', metadata: { subject: 'Support Playbook' }, score: 0.9 },
    ] });
    const { reg } = registry({ rag });
    const out = await handlerOf(reg, 'knowledge_search')({ config: { query: 'refund policy', _tenantId: 't1' } });
    assert.equal(out.found, 1);
    assert.equal(out.passages[0].label, 'Support Playbook');
    assert.match(out.text, /Refunds are issued within 14 days/);
  });

  test('finding NOTHING is an honest answer, not an error', async () => {
    // A miss must not read as a failure — "it is not in our documents" is the truth, and
    // the step that consumes it is instructed to say so rather than invent.
    const { reg } = registry({ rag: fakeRag({ hits: [] }) });
    const out = await handlerOf(reg, 'knowledge_search')({ config: { query: 'anything', _tenantId: 't1' } });
    assert.equal(out.found, 0);
    assert.deepEqual(out.passages, []);
  });

  test('a save is written under its title', async () => {
    const rag = fakeRag();
    const { reg } = registry({ rag });
    const out = await handlerOf(reg, 'knowledge_write')({ config: { title: 'Q3 retro', _tenantId: 't1' }, body: 'What we learned…' });
    assert.equal(out.saved, true);
    assert.equal(rag.calls.ingests[0].meta.subject, 'Q3 retro');
    assert.equal(rag.calls.ingests[0].meta.tenant_id, 't1');
  });

  test('saving nothing is refused rather than writing an empty document', async () => {
    const { reg } = registry();
    await assert.rejects(
      () => handlerOf(reg, 'knowledge_write')({ config: { title: 't', _tenantId: 't1' }, body: '   ' }),
      /nothing to save/);
  });

  test('AVAILABILITY IS NOT PER-TENANT, AND MUST NOT PRETEND TO BE', () => {
    // The registry calls `isReady()` with NO ARGUMENTS — a deployment-level question.
    // The first version of this connector asked "does this tenant have documents",
    // which with no tenant in scope resolved to `readSources(undefined)` → `[]` →
    // permanently unavailable for EVERYONE. Measured before shipping: a tenant holding
    // a document still got `available: false, reason: 'dependency not ready'`.
    // Registering a capability nobody can ever use would be a quieter version of the
    // defect this connector exists to fix.
    const perTenant = { 'tenant-A': [{ name: 'Playbook', path: '/srv/kb' }] };
    const reg = new CapabilityRegistry();
    registerKnowledgeCapabilities(reg, {
      forTenant: async () => ({ query: async () => [], ingest: async () => 1 }),
      readSources: (t) => perTenant[t] ?? [],
    });
    assert.equal(reg.get('knowledge_search').available, true,
      'a tenant-scoped readiness check makes this false for everyone');
    assert.equal(reg.get('knowledge_write').available, true);
  });

  test('with no RAG handle at all, nothing is registered', () => {
    // Being registered IS the readiness signal, so the absence must be real.
    const reg = new CapabilityRegistry();
    registerKnowledgeCapabilities(reg, {});
    assert.deepEqual(reg.list().map(c => c.id), []);
  });
});

describe('THE INTERVIEW IS TOLD THE TRUTH ABOUT KNOWLEDGE', () => {
  test('an EMPTY base is stated, not passed over in silence', () => {
    // The defect: the block returned '' when empty, so the prompt said nothing at all —
    // and every other section reads "here is what you have", so absence read as
    // "not mentioned", never as "none".
    const p = buildSystemPrompt({ knowledge: { documentCount: 0, names: [] } });
    assert.match(p, /NO documents in Knowledge yet/);
  });

  test('…and it is told not to offer what it cannot do, even if the user insists', () => {
    // The exact prod exchange: "I uploaded the documents" → "Perfect — I can pull from
    // your Knowledge docs."
    const p = buildSystemPrompt({ knowledge: { documentCount: 0, names: [] } });
    assert.match(p, /Do not offer to "use your knowledge base"/);
    assert.match(p, /tell them plainly that you cannot see any/);
  });

  test('a populated base is described, with a steer toward a live search', () => {
    const p = buildSystemPrompt({ knowledge: { documentCount: 2, names: ['Support Playbook', 'Pricing'] } });
    assert.match(p, /2 document source\(s\)/);
    assert.match(p, /Support Playbook/);
    assert.match(p, /knowledge_search/);
  });

  test('genuinely UNKNOWN stays silent — it does not claim emptiness either', () => {
    // When the capability probe failed we know nothing, and asserting "you have none"
    // would be the same defect pointing the other way.
    assert.doesNotMatch(buildSystemPrompt({}), /NO documents in Knowledge/);
  });

  test('knowledgeState reports the count even when it is zero', () => {
    assert.deepEqual(knowledgeState(() => [], 't1'), { documentCount: 0, names: [] });
    assert.equal(knowledgeState(() => [{ name: 'A' }, { name: 'B' }], 't1').documentCount, 2);
  });

  test('a broken sources read does not throw — it reports nothing known', () => {
    const boom = () => { throw new Error('disk'); };
    assert.deepEqual(knowledgeState(boom, 't1'), { documentCount: 0, names: [] });
  });
});

describe('it lands in the prompt as a usable capability', () => {
  test('Knowledge appears among what the agent can do', () => {
    const { reg } = registry({ sources: [{ name: 'Playbook', path: '/srv/kb' }] });
    registerGoogleChannels(reg);
    const channels = reg.list()
      .filter(c => (c.positions ?? []).some(p => p === 'step' || p === 'delivery'))
      .map(c => ({ ...c, available: true }));
    const p = buildSystemPrompt({ connectors: { knowledge: { connected: true } }, channels });
    assert.match(p, /KNOWLEDGE: .*knowledge_search/);
  });
});
