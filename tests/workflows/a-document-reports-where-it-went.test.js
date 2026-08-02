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
