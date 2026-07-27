/**
 * THE PRODUCT DOES NOT DESCRIBE ITS OWN TEST RESULTS IN FREE PROSE.
 *
 * ── What was observed (2026-07-26, screenshotted) ────────────────────────────
 * After a PASSING test of a spam-triage workflow, the chat told a tester the
 * workflow
 *
 *   "…classified it as spam, routed it to the correct path, and then summarized
 *    and delivered it to both the #ops channel and to charles@agntic.co as
 *    promised."
 *
 * Spam is the branch whose entire promise is to do NOTHING. Two inches above, in
 * the same screenshot, the engineered evidence panel — reading the same run —
 * said it correctly: "it took a path that doesn't cover… Nothing was proved
 * either way."
 *
 * ── Why it invented, and why the previous fix did not hold ───────────────────
 * This is the SECOND round of the same defect. The first (2026-07-22: a clean but
 * unverified run described as a failure, with an invented cause, twice in one
 * message) was fixed at the prompt and at the boundary — the client began sending
 * the three-way verdict instead of a boolean. It came back through a different
 * door, because the boundary was still lossy in the same way: the client computed
 * `outcomeResults` — one `evaluateExampleRun()` result per example, each carrying
 * the oracle's `verdict` — and DROPPED it, sending instead `deliveries` from the
 * LAST run of the sequence. A model handed a delivery receipt and told to "be
 * specific" fills the gap it was left.
 *
 * The old version of this file could only assert WHAT THE NARRATOR WAS TOLD,
 * because the sentence itself was model-generated and unassertable. The sentence
 * is now COMPOSED (src/workflows/run-summary.js) from the same objects the panel
 * renders, so every pin below is now on THE SENTENCE A PERSON READS.
 *
 * ── The pins carried over from the 2026-07-22 suite, now stronger ────────────
 *   · an unverified run is NEVER described as a failure          (was: in the context)
 *   · the real reason is given, so nothing has to be guessed     (was: in the context)
 *   · failure-only material is not attached to a run that did
 *     not fail — it was the raw material of the invention        (was: in the context)
 *   · a genuine failure still reads as one, with its own cause   (was: in the context)
 *   · a pass says the promise was KEPT, not merely that it ran   (was: in the context)
 *   · an older client that sends no verdict still works          (was: in the context)
 *   · the client sends the evidence it computed                  (payload, re-pointed)
 *
 * ── How the subjects are constructed ─────────────────────────────────────────
 * Every `outcomeResults` fixture below is produced by the REAL oracle
 * (`evaluateExampleRun`) over a real spec and a real run shape, and the lane
 * coverage by the REAL `laneCoverage()`. Hand-written result objects would let a
 * pin pass against a shape production never produces. The client's payload is
 * LIFTED from public/index.html rather than re-implemented, for the same reason
 * the old suite lifted the context builder: a second copy passes while production
 * keeps sending the old thing.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

import { evaluateExampleRun, laneCoverage } from '../../src/workflows/outcome-oracle.js';
import { composeRunSummary, exampleVerdict } from '../../src/workflows/run-summary.js';
import { mountBuilderRoutes } from '../../src/api/builder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── The workflow from the screenshot, reduced to its two lanes ────────────────
// Real mail is summarised into the Atlas inbox; spam goes down the lane that
// does nothing. The promise is CONDITIONAL on the "normal" lane, which is why a
// spam sample proves nothing at all about it.
function spamTriage() {
  return {
    version: 2,
    name: 'Inbox triage',
    outcome: {
      statement: 'Real mail is summarised into my Atlas inbox; spam is ignored.',
      assertions: [{ id: 'a_norm', kind: 'message_sent', target: 'inbox:Summary', when: 'normal' }],
    },
    triggers: [{ type: 'email', filter: 'is:unread' }],
    nodes: [
      { id: 'classify', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'normal\nspam', instructions: 'Sort the message.' } },
      { id: 'b1', type: 'branch', label: 'Route by category',
        config: { on: 'classify.output', cases: [{ when: 'normal', to: 'summ' }, { when: '*', to: 'stop_spam' }] } },
      { id: 'summ', type: 'llm', label: 'Summarise', config: { mode: 'summarize', instructions: 'One line.' } },
      { id: 'save', type: 'deliver', label: 'Save to inbox', config: { channel: 'inbox_deliver', subject: 'Summary' } },
      { id: 'stop_spam', type: 'assemble', label: 'Stop — spam', config: {} },
    ],
    edges: [
      { from: 'classify', to: 'b1' }, { from: 'b1', to: 'summ' },
      { from: 'b1', to: 'stop_spam' }, { from: 'summ', to: 'save' },
    ],
  };
}

/**
 * A second workflow with TWO delivery promises on TWO different lanes.
 *
 * This exists for one test: a "should not happen" example that the harness runs
 * anyway (it bypasses the trigger) DELIVERS for real, and its delivery must never
 * be credited as something the workflow proved. That is the shape that once put a
 * green tick reading "should not fire" directly above "every promise held",
 * moments after a real Slack DM had gone out for it. With one shared target the
 * lie is invisible — the honest example proves the same string — so the two lanes
 * deliver to two different places.
 */
function twoLaneTriage() {
  return {
    version: 2,
    name: 'Two-lane triage',
    outcome: {
      statement: 'Normal mail is summarised to my inbox; urgent mail is escalated to my inbox as Urgent.',
      assertions: [
        { id: 'a_norm', kind: 'message_sent', target: 'inbox:Summary', when: 'normal' },
        { id: 'a_urg',  kind: 'message_sent', target: 'inbox:Urgent',  when: 'urgent' },
      ],
    },
    triggers: [{ type: 'email', filter: 'is:unread' }],
    nodes: [
      { id: 'classify', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'normal\nurgent', instructions: 'Sort the message.' } },
      { id: 'b1', type: 'branch', label: 'Route by category',
        config: { on: 'classify.output', cases: [{ when: 'normal', to: 'summ' }, { when: '*', to: 'esc' }] } },
      { id: 'summ', type: 'llm', label: 'Summarise', config: { mode: 'summarize', instructions: 'One line.' } },
      { id: 'save', type: 'deliver', label: 'Save to inbox', config: { channel: 'inbox_deliver', subject: 'Summary' } },
      { id: 'esc', type: 'llm', label: 'Escalate', config: { mode: 'rewrite', instructions: 'Flag it.' } },
      { id: 'save_urg', type: 'deliver', label: 'Save as urgent', config: { channel: 'inbox_deliver', subject: 'Urgent' } },
    ],
    edges: [
      { from: 'classify', to: 'b1' }, { from: 'b1', to: 'summ' }, { from: 'b1', to: 'esc' },
      { from: 'summ', to: 'save' }, { from: 'esc', to: 'save_urg' },
    ],
  };
}

const INBOX_DELIVERY = { delivered: true, channel: 'inbox_deliver', subject: 'Summary' };
const URGENT_DELIVERY = { delivered: true, channel: 'inbox_deliver', subject: 'Urgent' };

// Mirror the engine: only EXECUTED nodes appear in steps, and a delivery rides on
// its node. The spam lane performs no delivery at all — that is the whole point.
const spamRun = () => ({
  completed: true, error: null, deliveries: [],
  steps: [
    { nodeId: 'classify', output: 'spam' },
    { nodeId: 'b1', output: { value: 'spam', matched: '*', to: 'stop_spam' } },
    { nodeId: 'stop_spam', output: { done: true } },
  ],
});
const normalRun = (deliver = true) => {
  const steps = [
    { nodeId: 'classify', output: 'normal' },
    { nodeId: 'b1', output: { value: 'normal', matched: 'normal', to: 'summ' } },
    { nodeId: 'summ', output: 'A one-line summary.' },
  ];
  const deliveries = [];
  if (deliver) { steps.push({ nodeId: 'save', output: INBOX_DELIVERY }); deliveries.push(INBOX_DELIVERY); }
  return { completed: true, error: null, steps, deliveries };
};

const twoLaneRun = (lane) => {
  const normal = lane === 'normal';
  const delivery = normal ? INBOX_DELIVERY : URGENT_DELIVERY;
  return {
    completed: true, error: null, deliveries: [delivery],
    steps: [
      { nodeId: 'classify', output: lane },
      { nodeId: 'b1', output: { value: lane, matched: normal ? 'normal' : '*', to: normal ? 'summ' : 'esc' } },
      { nodeId: normal ? 'summ' : 'esc', output: 'Some text.' },
      { nodeId: normal ? 'save' : 'save_urg', output: delivery },
    ],
  };
};

const SPEC     = spamTriage();
const EX_SPAM  = { id: 'e_spam', label: 'Spam — a crypto blast', given: { subject: 'YOU HAVE WON' } };
const EX_NORM  = { id: 'e_norm', label: 'A normal enquiry',      given: { subject: 'Quote please' } };

const R_SPAM   = evaluateExampleRun(SPEC, EX_SPAM, spamRun());
const R_NORM   = evaluateExampleRun(SPEC, EX_NORM, normalRun());
const R_MISS   = evaluateExampleRun(SPEC, EX_NORM, normalRun(false));   // the promise really was missed

/**
 * WORDS THAT ASSERT SOMETHING HAPPENED TO THE OUTSIDE WORLD.
 *
 * The invented sentence was built out of exactly these: "routed it to the correct
 * path… summarized and delivered it… as promised". None of them may appear about a
 * run whose evidence records the lane as not exercised.
 */
const CLAIM_WORDS = [
  /\bdeliver(ed|s|ing|y)?\b/i,
  /\bsent\b/i,
  /\bposted\b/i,
  /\bemailed\b/i,
  /\brouted\b/i,
  /\bas promised\b/i,
  /\bkept\b/i,
  /\bheld\b/i,
];

function assertClaimsNothing(sentence, why) {
  for (const re of CLAIM_WORDS) {
    assert.doesNotMatch(sentence, re, `${why} — but the sentence matched ${re}: ${sentence}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the spam case — a do-nothing lane is never narrated as a delivery', () => {
  test('after a PASSING run, the example that took the do-nothing lane is reported as proving nothing', () => {
    // The exact live shape: both lanes covered across the set, the real example
    // kept the promise, the spam example took the lane that does nothing. The panel
    // shows ✓ then ○ and the run is cleared to go live.
    const results = [R_NORM, R_SPAM];
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: results,
      laneCoverage: laneCoverage(SPEC, results),
    });

    // The spam example is named, and named as unproved — not as a delivery.
    assert.match(s, /Spam — a crypto blast/,
      'the example that proved nothing must be named, not silently folded into the ones that did');
    assert.match(s, /didn't exercise the promise/);
    assert.match(s, /proved nothing either way/);

    // And the ONE delivery claim in the sentence is attributed to the promise that
    // was actually checked, never to the spam example.
    assertClaimsNothing(s.slice(s.indexOf('Spam — a crypto blast')), 'the do-nothing lane delivered nothing');
  });

  test('a run whose ONLY example took the do-nothing lane claims no delivery at all', () => {
    const results = [R_SPAM];
    const s = composeRunSummary({
      spec: SPEC, verdict: 'unverified', outcomeResults: results,
      laneCoverage: laneCoverage(SPEC, results),
    });

    assertClaimsNothing(s, 'nothing was delivered, routed or promised on this run');
    assert.match(s, /nothing broke/i, 'the run executed cleanly — calling it a failure is the other lie');
    assert.match(s, /isn't cleared to go live/i);
  });

  test('a delivery made by a "should not happen" example is never credited as proof', () => {
    // The harness bypasses the trigger, so a "should not fire" sample runs like any
    // other and DELIVERS like any other. That delivery proves nothing — it happened
    // because the test skipped the filter, not because the workflow is right — and
    // the sentence must not list it among what the run proved.
    const spec2 = twoLaneTriage();
    const honest  = evaluateExampleRun(spec2, { id: 'p', label: 'A normal enquiry', given: {} }, twoLaneRun('normal'));
    const negative = evaluateExampleRun(
      spec2,
      { id: 'n', label: 'Weekend urgent — should not fire', given: {}, shouldTrigger: false, expect: {} },
      twoLaneRun('urgent'),
    );
    assert.equal(honest.verdict, 'kept');
    assert.equal(negative.verdict, 'not_exercised');
    // …even though its urgent promise really was satisfied by the run.
    assert.ok(negative.contract.find(c => c.id === 'a_urg').ok);

    const results = [honest, negative];
    const s = composeRunSummary({
      spec: spec2, verdict: 'passed', outcomeResults: results,
      laneCoverage: laneCoverage(spec2, results),
    });

    assert.match(s, /what came back reached "Summary" in your Atlas inbox/,
      'the honest example proved the normal promise and must still say so');
    assert.doesNotMatch(s, /"Urgent" in your Atlas inbox/,
      'the should-not-fire example delivered, but nothing about that is proof');
    assert.match(s, /Weekend urgent — should not fire/);
    assert.match(s, /didn't exercise the promise/);
  });

  test("the oracle's own verdict for that example is 'not_exercised', and the composer reads that field", () => {
    assert.equal(R_SPAM.verdict, 'not_exercised');
    assert.equal(R_SPAM.enforced, 0);
    assert.equal(exampleVerdict(R_SPAM), 'not_exercised');
    assert.ok(R_SPAM.contract.every(c => c.applicable === false),
      'the spam lane skips every delivery assertion — that is what the sentence must not paper over');
  });
});

describe('the sentence and the panel cannot disagree — both read `verdict`', () => {
  test('`contractPassed` is TRUE on the unexercised run, and certifying on it is the bug', () => {
    // This is the trap. `contract.every(c => c.ok)` is true over a set of skips, so
    // the boolean says "passed" for a run that proved nothing. The panel refuses to
    // read it and so does the composer.
    assert.equal(R_SPAM.contractPassed, true);
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: [R_SPAM],
      laneCoverage: { applicable: true, total: 2, uncovered: [] },
    });
    assertClaimsNothing(s, 'contractPassed being true does not make a promise kept');
    assert.match(s, /Nothing was proved either way/);
  });

  test('changing the verdict field changes the sentence with it', () => {
    // The panel's row mark and this sentence are driven by the SAME field. Move the
    // field and the sentence must move — otherwise the agreement is a coincidence
    // between two hand-written code paths.
    const asKept = { ...R_SPAM, verdict: 'kept' };
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: [asKept],
      laneCoverage: { applicable: true, total: 2, uncovered: [] },
    });
    assert.match(s, /every promise it makes held/,
      'a result the oracle calls kept must read as kept — the sentence follows the field, not a second rule');
  });

  test('a caller claiming more than the evidence supports is refused, not obeyed', () => {
    // Fail closed. The panel would show ○; a "passed" from the client cannot
    // manufacture a certification out of a set with nothing proved in it.
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: [R_SPAM],
      laneCoverage: laneCoverage(SPEC, [R_SPAM]),
    });
    assert.doesNotMatch(s, /It's cleared to go live/);
    assert.match(s, /isn't cleared to go live/i);
  });
});

describe('an unverified run (carried over from the 2026-07-22 suite)', () => {
  const results = [R_SPAM];
  const cov     = laneCoverage(SPEC, results);

  test('it is NOT described as a failure', () => {
    const s = composeRunSummary({ spec: SPEC, verdict: 'unverified', outcomeResults: results, laneCoverage: cov });
    assert.doesNotMatch(s, /\bfailed\b|\bfell short\b|\bbroke\b(?!\.)|went wrong|\berror\b/i,
      'the run executed cleanly — calling it a failure is what produced the invented cause last time');
    assert.match(s, /nothing broke/i);
  });

  test('it gives the real reason, so nothing has to be guessed', () => {
    const s = composeRunSummary({ spec: SPEC, verdict: 'unverified', outcomeResults: results, laneCoverage: cov });
    assert.match(s, /nothing went down one path: “normal”/,
      'naming the untested path is what replaces speculation with a fact');
  });

  test('with no examples at all it still gives a reason rather than silence', () => {
    const s = composeRunSummary({ spec: SPEC, verdict: 'unverified', outcomeResults: [], laneCoverage: null });
    assert.match(s, /no worked examples/i);
    assert.match(s, /nothing was proved either way/i);
  });

  test('failure-only material is NOT attached to a run that did not fail', () => {
    const s = composeRunSummary({
      spec: SPEC, verdict: 'unverified', outcomeResults: results, laneCoverage: cov,
      runError: 'connection reset',
    });
    assert.doesNotMatch(s, /connection reset/,
      'a stale error carried into a clean run is exactly the raw material the narrator invented from');
  });

  test('a blank promise is called a blank promise, not an unexercised one', () => {
    const blank = { ...SPEC, outcome: { ...SPEC.outcome, statement: '' } };
    const r = evaluateExampleRun(blank, EX_NORM, normalRun());
    assert.equal(r.contractIncomplete, true);
    const s = composeRunSummary({
      spec: blank, verdict: 'unverified', outcomeResults: [r],
      laneCoverage: { applicable: true, total: 2, uncovered: [] },
    });
    assert.match(s, /no stated outcome/i);
  });

  test('a "should not happen" example says it cannot be proved here', () => {
    const neg = { id: 'e_neg', label: 'Weekend mail — should not fire', given: { subject: 'x' }, shouldTrigger: false, expect: {} };
    const r = evaluateExampleRun(SPEC, neg, normalRun());
    assert.equal(r.verdict, 'not_exercised');
    const s = composeRunSummary({
      spec: SPEC, verdict: 'unverified', outcomeResults: [r],
      laneCoverage: { applicable: true, total: 2, uncovered: [] },
    });
    assert.match(s, /should not happen/i);
    assert.match(s, /without checking the trigger/i);
    assertClaimsNothing(s, 'a negative example delivered nothing that counts');
  });
});

describe('the other two verdicts are unharmed', () => {
  test('a real failure still reads as one, with the cause the run recorded', () => {
    assert.equal(R_MISS.verdict, 'broken');
    const s = composeRunSummary({
      spec: SPEC, verdict: 'failed', outcomeResults: [R_MISS],
      laneCoverage: laneCoverage(SPEC, [R_MISS]),
    });
    assert.match(s, /didn't keep its promise/);
    assert.match(s, /A normal enquiry/, 'name the example that fell short');
    assert.match(s, /nothing reached "Summary" in your Atlas inbox/,
      'a genuine failure must still carry its own recorded cause');
    assert.match(s, /Nothing goes live until that's fixed/);
  });

  test('a failure with NO recorded cause says so rather than inventing one', () => {
    const causeless = { ...R_MISS, verdict: 'broken', contract: [], error: null, ran: true };
    const s = composeRunSummary({ spec: SPEC, verdict: 'failed', outcomeResults: [causeless] });
    assert.match(s, /recorded no reason/i);
    assert.doesNotMatch(s, /timed out|was rejected|cut off|approval/i,
      'the previous round of this defect invented exactly these');
  });

  test('a run-level failure with no example evidence is not called a broken promise', () => {
    const s = composeRunSummary({ spec: SPEC, verdict: 'failed', outcomeResults: [], runError: 'Slack unreachable' });
    assert.match(s, /Slack unreachable/, 'a genuine failure must still carry its cause');
    assert.doesNotMatch(s, /didn't keep its promise/,
      'nothing checked a promise on this run, so nothing may say one was broken');
  });

  test('a pass says the promise was KEPT, and names what was actually checked', () => {
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: [R_NORM],
      laneCoverage: { applicable: true, total: 2, uncovered: [] },
    });
    assert.match(s, /every promise it makes held/);
    assert.match(s, /what came back reached "Summary" in your Atlas inbox/,
      'assert what was DELIVERED, not that a step ran');
    assert.match(s, /It's cleared to go live/);
  });

  test('an older client that sends no verdict still works — the evidence answers', () => {
    const kept = composeRunSummary({ spec: SPEC, outcomeResults: [R_NORM], laneCoverage: { applicable: true, total: 2, uncovered: [] } });
    assert.match(kept, /every promise it makes held/);
    const broken = composeRunSummary({ spec: SPEC, outcomeResults: [R_MISS] });
    assert.match(broken, /didn't keep its promise/);
    const quiet = composeRunSummary({ spec: SPEC, outcomeResults: [R_SPAM], laneCoverage: { applicable: true, total: 2, uncovered: [] } });
    assertClaimsNothing(quiet, 'no verdict from the client is not a licence to certify');
  });
});

// ── The client boundary, lifted from the browser it runs in ───────────────────

/**
 * Build the payload the test panel actually posts, by EXECUTING the object
 * literal out of public/index.html. Re-implementing it here would pass while the
 * browser kept dropping the evidence — which is precisely what happened.
 */
function clientPayload({ spec, passed, verdict, outcomeResults, coverage, d }) {
  const html  = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const i     = html.indexOf("fetch('/api/builder/test-summary'");
  assert.ok(i > 0, 'the test-summary POST moved — re-point this test, do not delete it');
  const start = html.lastIndexOf('const payload = {', i);
  const end   = html.indexOf('};', start);
  assert.ok(start > 0 && end > start,
    'the test-summary payload literal moved — re-point this test, do not delete it');
  const body = html.slice(start, end + 2);
  const fn = new Function('spec', 'passed', 'verdict', 'outcomeResults', 'coverage', 'd',
    `${body}\nreturn payload;`);
  return fn(spec, passed, verdict, outcomeResults, coverage, d);
}

describe('the client sends the evidence the panel used', () => {
  test('the payload carries the per-example verdicts and the lane coverage', () => {
    const results = [R_NORM, R_SPAM];
    const cov = laneCoverage(SPEC, results);
    const p = clientPayload({ spec: SPEC, passed: true, verdict: 'passed', outcomeResults: results, coverage: cov, d: {} });

    assert.equal(p.result.verdict, 'passed');
    assert.ok(Array.isArray(p.result.outcomeResults),
      'the per-example verdicts are the whole evidence — a payload without them is the defect');
    assert.equal(p.result.outcomeResults.length, 2,
      'the per-example verdicts are computed by the panel and were being discarded at this boundary');
    assert.equal(p.result.outcomeResults[1].verdict, 'not_exercised');
    assert.deepEqual(p.result.laneCoverage, cov);
  });

  test('the run\'s deliveries, steps and output are NOT sent to be narrated', () => {
    // The old payload sent `deliveries` from the LAST run of the sequence, which is
    // how one example's delivery got told as the whole run's. Nothing to narrate
    // means nothing to narrate wrongly.
    const d = { deliveries: [{ channel: '#ops', ts: '1' }], steps: [{ nodeId: 'save' }], output: 'a summary' };
    const p = clientPayload({ spec: SPEC, passed: true, verdict: 'passed', outcomeResults: [R_SPAM], coverage: null, d });

    assert.equal(p.result.deliveries, undefined, 'a delivery receipt is what the invention was built from');
    assert.equal(p.result.steps, undefined);
    assert.equal(p.result.output, undefined);
  });
});

// ── The real endpoint, end to end ─────────────────────────────────────────────

async function tenantMiddleware(req, _res, next) {
  await new Promise(r => setImmediate(r));   // the real requireAuth awaits a lookup here
  req.tenant = { id: 'tenantA' };
  req.user   = { id: 'u1', email: 'op@example.com' };
  next();
}

function postJson(port, pathName, body) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = http.request({
      port, path: pathName, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', () => resolve({ status: 0, data: null, raw: '' }));
    req.end(payload);
  });
}

describe('POST /api/builder/test-summary — the sentence a user reads', () => {
  let server, port, modelCalls;

  before(async () => {
    const app = express();
    app.use(express.json());
    modelCalls = 0;
    // THE MODEL IS BOOBY-TRAPPED. If anything in this path still asks a model to
    // describe the run, the request fails loudly instead of quietly returning
    // prose nobody checked.
    const spine = {
      llm: {
        invoke: async () => { modelCalls++; throw new Error('the run summary must not be written by a model'); },
      },
    };
    mountBuilderRoutes(app, { spine, requireActiveTenant: tenantMiddleware, requireAuth: tenantMiddleware });
    await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  });

  after(() => { try { server?.close(); } catch { /* ignore */ } });

  test('the browser\'s own payload, posted for real, produces the honest sentence', async () => {
    const results = [R_NORM, R_SPAM];
    const body = clientPayload({
      spec: SPEC, passed: true, verdict: 'passed', outcomeResults: results,
      coverage: laneCoverage(SPEC, results), d: {},
    });

    const { status, data } = await postJson(port, '/api/builder/test-summary', body);
    assert.equal(status, 200);
    assert.equal(modelCalls, 0, 'no model may be asked what this run did');
    assert.ok(data.summary, 'the endpoint must return a sentence');

    const at = data.summary.indexOf('Spam — a crypto blast');
    assert.ok(at >= 0,
      `the unproved example must appear in what the user reads — got: ${data.summary}`);
    assertClaimsNothing(data.summary.slice(at), 'the spam example delivered nothing');
  });

  test('a delivery receipt smuggled into the body cannot become a claim', async () => {
    // Even if a client (or a replayed old client) posts the material the invented
    // sentence was built from, the sentence is composed from the evidence only.
    const { status, data } = await postJson(port, '/api/builder/test-summary', {
      spec: SPEC,
      result: {
        completed: true, verdict: 'passed',
        outcomeResults: [R_SPAM],
        laneCoverage: { applicable: true, total: 2, uncovered: [] },
        deliveries: [{ channel: '#ops', ts: '1712.1', delivered: true }],
        output: 'Summary sent to #ops and charles@agntic.co',
        steps: [{ nodeId: 'save' }],
      },
    });
    assert.equal(status, 200);
    assert.equal(modelCalls, 0);
    assert.doesNotMatch(data.summary, /#ops|charles@agntic\.co/,
      'the destination from a delivery receipt is exactly what the invented sentence named');
    assertClaimsNothing(data.summary, 'the run proved nothing, whatever else was in the body');
  });

  test('a genuine failure still reads as a failure through the endpoint', async () => {
    const { status, data } = await postJson(port, '/api/builder/test-summary', {
      spec: SPEC,
      result: { completed: false, verdict: 'failed', outcomeResults: [R_MISS], laneCoverage: null, error: null },
    });
    assert.equal(status, 200);
    assert.match(data.summary, /didn't keep its promise/);
    assert.match(data.summary, /nothing reached "Summary" in your Atlas inbox/);
  });

  test('the endpoint still refuses a request with no spec or no result', async () => {
    const a = await postJson(port, '/api/builder/test-summary', { spec: SPEC });
    assert.equal(a.status, 400);
    const b = await postJson(port, '/api/builder/test-summary', { result: {} });
    assert.equal(b.status, 400);
  });
});
