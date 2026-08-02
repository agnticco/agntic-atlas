/**
 * A DOCUMENT WHOSE TITLE IS BUILT AT RUN TIME COULD NEVER KEEP ITS OWN PROMISE.
 *
 * WITNESSED ON PROD, 2026-08-01, driving the AI-briefing shape end to end in a browser:
 * every weekday, search the web, synthesize a briefing, save it as a Google Doc titled
 * with that day's date, email the link. The workflow DID all of it — the Doc was created
 * and the email sent — and the panel said:
 *
 *     Contract not met. 4 of 4 promises fell short.
 *     nothing reached "AI Automation Briefing" in gdocs — this run delivered to
 *     {{generate_title.output}} (Google Docs) and firstrun@example.test (Gmail)
 *
 * So a correct workflow could never go live, and the customer was shown a template
 * reference as the place their document went. All four examples failed identically,
 * including the negative one, which is why the whole run read as broken.
 *
 * THE CAUSE, and it is one line. `docs_create` declares `locatorKeys: ['title']` — which
 * is RIGHT: a Doc IS the destination and its name is where the write landed, the same
 * bargain `sheets_create` documents for itself. `normalizeDelivery` reads those keys off
 * the RUN's own output first, precisely so a real run can correct a wrong declaration…
 * but `docsCreate` returned only `{documentId, link}`. Nothing to read. So it fell
 * through to the node's raw CONFIG and produced the uninterpolated `{{…}}`.
 *
 * `sheetsCreate` has always returned its `title`. `docsCreate` simply never did.
 *
 * WHAT THIS TEST MUST NOT BECOME. The obvious alternative fix is to excuse a template
 * on the delivery side of `checkAssertionAtRuntime` the way one on the ASSERTION side is
 * excused. That is a FAIL-OPEN — it lets "right connector, wrong document" pass — and it
 * is already guarded by `both-halves-agree-on-the-connector.test.js` → "it did not become
 * a fail-open". It has now been attempted twice by two different people. The comparison
 * stays literal; the run just has to report the truth.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { FlowTester } from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { runSpecDryRun } from '../../src/workflows/dry-run-runner.js';
import {
  normalizeDelivery, checkAssertionAtRuntime, setCapabilityCatalog,
} from '../../src/workflows/outcome-oracle.js';

function catalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  setCapabilityCatalog(reg);
  return reg;
}

// The prod node, verbatim in shape: the title is a reference to an upstream AI step, so
// its value is not knowable until the workflow runs. That is the whole point of the case.
const DOC = {
  id: 'save_briefing',
  type: 'deliver',
  config: { channel: 'docs_create', title: '{{generate_title.output}}' },
};

// What the run ACTUALLY produced once the reference was resolved. The dated title is the
// user's own instruction ("titled with that day's date"), so it can never equal the
// promise's fixed wording character-for-character — it has to match by containment.
const RESOLVED = 'AI Automation Briefing — August 1, 2026';

const PROMISE = { id: 'a1', kind: 'document_exists', target: 'gdocs:AI Automation Briefing' };

describe('the handler reports the title it actually wrote', () => {
  test('docs_create declares title as its locator — so the run must supply one', () => {
    const cap = catalog().get('docs_create');
    assert.deepEqual(cap.locatorKeys, ['title'],
      'if this stops being the declared locator, this whole test is about the wrong thing');
  });

  test('a run that reports its title satisfies the promise', () => {
    catalog();
    const receipt = normalizeDelivery(DOC, { dryRun: true, wouldDeliver: true, title: RESOLVED });
    const r = checkAssertionAtRuntime(PROMISE, [receipt]);
    assert.equal(r.ok, true, r.reason ?? '');
  });

  test('the resolved title is what the receipt carries, not the {{reference}}', () => {
    catalog();
    const receipt = normalizeDelivery(DOC, { dryRun: true, wouldDeliver: true, title: RESOLVED });
    assert.ok(receipt.locators.includes(RESOLVED),
      'the run\'s own answer must be in the receipt: ' + JSON.stringify(receipt.locators));
    assert.equal(receipt.locators[0], RESOLVED,
      'and it must come FIRST — a real run outranks the declaration, which is the only '
      + 'way a wrong declaration is ever caught');
  });

  test('THE WITNESSED FAILURE: with no title reported, the raw template is all there is', () => {
    // This is the pre-fix state reproduced exactly — the handler returning only an id and
    // a link. It is NOT excused (see the header: excusing it is the fail-open), which is
    // precisely why the handler has to report.
    catalog();
    const receipt = normalizeDelivery(DOC, { dryRun: true, wouldDeliver: true, documentId: 'abc' });
    const r = checkAssertionAtRuntime(PROMISE, [receipt]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /\{\{generate_title\.output\}\}/,
      'the sentence the customer was shown, preserved here so the cause stays legible');
  });
});

describe('docsCreate returns the title', () => {
  // Driven through the real function with `fetch` stubbed, because the return SHAPE is
  // the entire fix — asserting it from a hand-written object would prove nothing.
  const realFetch = globalThis.fetch;

  async function callDocsCreate(driveResponse) {
    const { docsCreate } = await import('../../src/connectors/google/index.js');
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => driveResponse,
    });
    try { return await docsCreate('tok', { title: RESOLVED, content: 'body' }); }
    finally { globalThis.fetch = realFetch; }
  }

  test('it returns what Drive stored the document as', async () => {
    const out = await callDocsCreate({ id: 'file1', name: RESOLVED });
    assert.equal(out.title, RESOLVED);
    assert.equal(out.documentId, 'file1');
  });

  test('and falls back to the title it asked for when Drive echoes no name', async () => {
    const out = await callDocsCreate({ id: 'file2' });
    assert.equal(out.title, RESOLVED,
      'a missing echo must not put `undefined` in the receipt — that reads as "went nowhere"');
  });

  test('end to end: the handler\'s own output keeps the promise', async () => {
    catalog();
    const out = await callDocsCreate({ id: 'file3', name: RESOLVED });
    const r = checkAssertionAtRuntime(PROMISE, [normalizeDelivery(DOC, { ...out, wouldDeliver: true })]);
    assert.equal(r.ok, true, r.reason ?? '');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE HALF THAT ACTUALLY GATES GO LIVE.
//
// Teaching `docsCreate` to return its title fixes a REAL run — and did nothing for the
// case that was witnessed, because EVERY TEST IS DRY. The handler is never called, so
// the receipt is built by `_dryRunDeliver`, which carried `target` and the content
// preview but none of the capability's DECLARED locator keys. `normalizeDelivery` then
// fell back to the node's raw config and reported the template.
//
// Witnessed on prod 2026-08-01 AFTER the handler fix shipped: a correct web-research
// build was told *"nothing reached "Daily AI Briefing" in gdrive — this run delivered
// to {{write_briefing.date_title}}"*, 2 of 3 promises "fell short", and it could not go
// live. I had verified the handler fix against the oracle directly instead of through
// the dry runner — the "construct the subject the way PRODUCTION does" rule, catching
// the person who had just invoked it.
//
// This drives the REAL engine, so it fails if the receipt stops carrying the resolved
// value for any reason — not merely if this one line is deleted.
describe('a DRY run reports the destination it resolved, not the template', () => {
  const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

  /** docs_create, declaring `title` as its locator, exactly as the real catalog does. */
  function registry() {
    const sent = [];
    return {
      sent,
      get: (id) => ({ id, available: true, locatorKeys: id === 'docs_create' ? ['title'] : [], effect: 'write' }),
      getHandler: (id) => async (args) => { sent.push({ id, args }); return { delivered: true }; },
      getProbe: () => null,
    };
  }

  // The title is a reference to an upstream step — unknowable until the run happens,
  // which is the entire case.
  const docSpec = () => ({
    name: 'Daily briefing', version: 2, triggers: [{ type: 'schedule' }],
    outcome: {
      statement: 'A briefing is saved as a Google Doc.',
      assertions: [{ id: 'a1', kind: 'document_exists', target: 'gdocs:Daily AI Briefing' }],
    },
    nodes: [
      { id: 'write', type: 'llm',     label: 'Write briefing', config: { mode: 'summarize' } },
      { id: 'save',  type: 'deliver', label: 'Save as Doc',
        config: { channel: 'docs_create', title: 'Daily AI Briefing — {{write.output}}' } },
    ],
    edges: [{ from: 'write', to: 'save' }],
  });

  test('the receipt carries the RESOLVED title, and nothing was really sent', async () => {
    const reg = registry();
    const ft = new FlowTester({ nodeTypes, channelRegistry: reg,
      llm: { invoke: async () => ({ content: 'August 1, 2026' }) } });
    const r = await runSpecDryRun({ flowTester: ft, spec: docSpec(), initialContext: 'go' });

    assert.equal(reg.sent.length, 0, 'a dry run must still fire no real handler');
    const receipt = (r.deliveries ?? []).find(d => d.channel === 'docs_create');
    assert.ok(receipt, 'the doc delivery produced a receipt');
    assert.ok(typeof receipt.title === 'string' && receipt.title.includes('Daily AI Briefing'),
      'the receipt must name where it WOULD have landed, resolved: ' + JSON.stringify(receipt.title));
    assert.doesNotMatch(String(receipt.title), /\{\{/,
      'a template is not a destination — this is the sentence the customer was shown');
  });

  // RE-POINTED 2026-08-02. This used to assert `contractPassed` — the promise's
  // `target` string matching the receipt's locator. That comparison is gone
  // (src/workflows/delivery-verdict.js). The fix it guards is UNCHANGED and now
  // more directly load-bearing: `docsCreate` resolving its title is what puts a
  // real document name in `landed`, which is the destination quoted to the
  // customer in the panel row and the chat sentence. A template there was the
  // sentence a person actually read.
  test('and the resolved title is what the run reports it reached', async () => {
    const reg = registry();
    const ft = new FlowTester({ nodeTypes, channelRegistry: reg,
      llm: { invoke: async () => ({ content: 'August 1, 2026' }) } });
    const r = await runSpecDryRun({ flowTester: ft, spec: docSpec(), initialContext: 'go' });
    assert.equal(r.oracleResult?.verdict, 'kept', 'a correct workflow could not go live');
    const doc = (r.oracleResult?.landed ?? []).find(d => d.channel === 'docs_create');
    assert.ok(doc, 'the document delivery is reported as having landed');
    assert.ok(String(doc.target).includes('Daily AI Briefing'),
      'and it names the real document, resolved: ' + JSON.stringify(doc.target));
    assert.doesNotMatch(String(doc.target), /\{\{/, 'a template is not a destination');
  });

  test('a reference that resolves to NOTHING is not reported as a destination', async () => {
    // The fail-safe direction, on a REACHABLE input. An unresolved reference substitutes
    // to empty, so a title that is nothing but a dead reference must leave the receipt
    // silent and let the existing raw-config fallback report it — quietly inventing a
    // destination would be the fail-open this file's last section guards.
    const reg = registry();
    const spec = docSpec();
    spec.nodes[1].config.title = '{{nowhere.output}}';   // a step that does not exist
    const ft = new FlowTester({ nodeTypes, channelRegistry: reg,
      llm: { invoke: async () => ({ content: 'x' }) } });
    const r = await runSpecDryRun({ flowTester: ft, spec, initialContext: 'go' });
    const receipt = (r.deliveries ?? []).find(d => d.channel === 'docs_create');
    assert.equal(receipt?.title, undefined,
      'an empty destination must not be claimed as one');
  });

  test('THE SENTENCE names a real place — the receipt leads with the RESOLVED value', async () => {
    // Attaching the resolved title was not enough on its own. `deliveryTarget` was being
    // asked about the SPEC node, whose config is still `{{...}}`, so the raw template
    // went into the receipt's `target` — and `target` is pushed FIRST into the locator
    // list, which is what `deliveryWhere` reads. Measured on prod after the title fix
    // shipped: locators came out
    //   ["{{write_briefing.date_title}}", "August 1, 2026", …]
    // and the customer was told "this run delivered to {{write_briefing.date_title}}"
    // about a document genuinely titled "August 1, 2026". The right answer was present
    // and outranked by the wrong one.
    const reg = registry();
    const spec = docSpec();
    const ft = new FlowTester({ nodeTypes, channelRegistry: reg,
      llm: { invoke: async () => ({ content: 'August 1, 2026' }) } });
    const r = await runSpecDryRun({ flowTester: ft, spec, initialContext: 'go' });
    const receipt = (r.deliveries ?? []).find(d => d.channel === 'docs_create');
    assert.ok(Array.isArray(receipt?.locators) && receipt.locators.length, 'the receipt names somewhere');
    assert.doesNotMatch(String(receipt.locators[0]), /\{\{/,
      'the FIRST locator is what the failure sentence prints — a template there is the '
      + 'defect a customer actually reads: ' + JSON.stringify(receipt.locators));
  });

  // REMOVED 2026-08-02: 'and a promise naming what is REALLY created is kept'.
  // It pinned that a correctly-worded promise matched the resolved title — a
  // property of the promise-matching rule, which no longer exists. The half that
  // mattered (the title IS resolved, and a template never reaches a reader) is
  // pinned by the two tests above and by the receipt assertions.

  test('only DECLARED locator keys are copied — a config value is not a destination', async () => {
    // The receipt must carry what the capability SAYS is its destination, not whatever
    // happens to be in its config. Copying every key would let an unrelated value be
    // read as a place by any capability that declares a key of that name — the
    // guess-from-the-shape-of-a-name defect this repo has paid for repeatedly.
    const reg = registry();
    const spec = docSpec();
    // `slack` declares NO locator keys in this registry, yet its config carries `title`.
    spec.nodes[1] = { id: 'save', type: 'deliver', label: 'Post',
                      config: { channel: 'slack', target: '#ops', title: 'Not a destination' } };
    const ft = new FlowTester({ nodeTypes, channelRegistry: reg,
      llm: { invoke: async () => ({ content: 'x' }) } });
    const r = await runSpecDryRun({ flowTester: ft, spec, initialContext: 'go' });
    const receipt = (r.deliveries ?? []).find(d => d.channel === 'slack');
    assert.ok(receipt, 'the slack delivery produced a receipt');
    assert.equal(receipt.title, undefined,
      'a capability that declares no locator must not have one invented from its config');
  });

  test('and a PARTLY-resolved title reports what actually resolved, never braces', async () => {
    // Measured: `"Doc {{nowhere.output}}"` arrives here as `"Doc "` — non-empty, so it IS
    // reported. The invariant a person relies on is that whatever the receipt names, it
    // is never a template: that sentence ("this run delivered to {{write.date_title}}")
    // is the one they were shown.
    const reg = registry();
    const spec = docSpec();
    spec.nodes[1].config.title = 'Briefing {{nowhere.output}}';
    const ft = new FlowTester({ nodeTypes, channelRegistry: reg,
      llm: { invoke: async () => ({ content: 'x' }) } });
    const r = await runSpecDryRun({ flowTester: ft, spec, initialContext: 'go' });
    const receipt = (r.deliveries ?? []).find(d => d.channel === 'docs_create');
    assert.ok(receipt?.title, 'a partly-resolved title is still a destination');
    assert.doesNotMatch(String(receipt.title), /\{\{/,
      'the receipt must never hand a raw template to the customer as a place');
  });
});

describe('it did not become a fail-open', () => {
  test('a document with the WRONG title still breaks the promise', () => {
    catalog();
    const receipt = normalizeDelivery(DOC, { wouldDeliver: true, title: 'Some Other Document' });
    assert.equal(checkAssertionAtRuntime(PROMISE, [receipt]).ok, false,
      'reporting a title must not become a way to satisfy any promise at all');
  });

  test('a delivery that never went through is still not a match', () => {
    catalog();
    const receipt = normalizeDelivery(DOC, { dryRun: true, wouldDeliver: false, title: RESOLVED });
    assert.equal(checkAssertionAtRuntime(PROMISE, [receipt]).ok, false);
  });
});
