/**
 * THE `verify` NODE — A LOGICAL PASS, NOT A PROMISE TEST.
 *
 * Charles, 2026-08-01, watching a build sit for seven minutes on prod: *"The verify in
 * the converger should simply be a pass that verifies there is a logically built
 * workflow, not that it keeps its promise. That is what the test is for."*
 *
 * WHAT THIS NODE USED TO DO, and why it stopped. It ran the draft through the real
 * engine on every sample, retried each failure up to three times, and on a consistent
 * failure bought a whole-spec Opus rebuild (bounded by MAX_VERIFY_ROUNDS). Then the user
 * pressed Run test and the panel executed the very same samples again. The workflow was
 * tested twice and the first time was invisible — measured on a web-research build:
 * `generate` 110s, then SEVEN MINUTES here, then 3.5 more in the panel.
 *
 * That route was also the largest single source of futile paid rebuilds in this repo's
 * history: whole-spec passes bought for an LLM timeout ("no rebuild can make a model
 * answer faster"), for a locator that was an unresolved template, and for a promise
 * about a path the run never took.
 *
 * WHAT THESE PIN — the new contract, and the mutation each guards:
 *   • verify NEVER executes the draft — `runDryRun` is injected and must go uncalled
 *     (restore the execution loop ⇒ red);
 *   • verify NEVER buys a second whole-spec pass, even for a draft whose promise a run
 *     would have failed — this is the money invariant (restore the fix route ⇒ red);
 *   • the per-path test cases are STILL prepared here, because Run test needs one input
 *     per path or a router can never be proved (drop the top-up ⇒ red);
 *   • the walkthrough is still presented exactly once, on the settled spec;
 *   • the build is never blocked — no tester, no examples, a throwing tester all still
 *     reach ratify;
 *   • the report says `ran:false`, so nothing downstream can call a promise tested on
 *     the strength of this node, and the narration does not claim a run it did not do.
 *
 * The engine's own "a dry run fires nothing real" contract is pinned separately at the
 * engine boundary in `tests/workflows/dry-run-verify.test.js`, and the promise itself is
 * proved by the test panel — see `tests/api/test-panel-certification.test.js`.
 */

import { test, describe, after } from 'node:test';
import assert                    from 'node:assert/strict';
import { mkdtempSync, rmSync }   from 'node:fs';
import { tmpdir }                from 'node:os';
import { join }                  from 'node:path';

import { createConverger } from '../../src/converger/index.js';
import { realCatalog }     from '../helpers/catalog.js';

const CAPS = { channels: realCatalog().getAll().map(c => ({ ...c, available: true })) };

const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-verify-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

const J = (o) => ({ content: JSON.stringify(o) });

// A stub LLM that builds a simple email→summarize→slack workflow, with an outcome
// that promises a Slack message AND one real modelled example (so `verify` has a
// sample to run). The `generate` output can be varied by round via `generateFor`.
function makeLlm({ generateFor } = {}) {
  let genCall = 0;
  const llm = { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1',
      statement: 'Every report email is summarized and posted to #ops.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] }] });
    if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:reports@acme.com' } });
    // ONE modelled example — carries a `given` sample event for verify to run on.
    if (p.includes('CONCRETE example cases'))         return J({ examples: [
      { id: 'ex1', label: 'A weekly report', given: { subject: 'Weekly report', from: 'a@acme.com', body: 'We shipped 5 things.' } } ] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
    if (p.includes('Build the COMPLETE workflow')) {
      const round = genCall++;
      const g = generateFor ? generateFor(round, p) : null;
      return J(g ?? {
        name: 'Report digest',
        triggers: [{ type: 'email', filter: 'to:reports@acme.com' }],
        nodes: [
          { id: 'sum',    type: 'llm',     label: 'Summarize', config: { mode: 'summarize' } },
          { id: 'notify', type: 'deliver', label: 'Post #ops', config: { channel: 'slack', target: '#ops' } },
        ],
        edges: [{ from: 'sum', to: 'notify' }],
      });
    }
    return J({});
  } };
  // How many times `generate` (the whole-spec build) ran — the INTERNAL regenerate loop.
  // With the walkthrough moved to the end (2026-07-16) this is no longer 1:1 with the
  // `generated_workflow` interrupt, so tests measure regenerations HERE, not by counting
  // walkthrough interrupts.
  llm.generateCount = () => genCall;
  return llm;
}

// Drive the loop to completion. `runDryRun` is the injected stub; `beats` collects
// every narrate beat; returns the ratified spec + the interrupts seen.
async function drive({ llm, runDryRun, intent = 'summarize report emails to ops' } = {}) {
  const beats = [];
  const narrate = (b) => beats.push(b);
  const conv = createConverger({ llm, capabilities: CAPS, checkpointerDir: scratch(),
    invokeCapability: async (id) => { if (id === 'gmail_search') return { messages: [] }; throw new Error(`unstubbed: ${id}`); },
    narrate, runDryRun });
  const reply = { outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
                  generated_workflow: () => ({ type: 'accept' }), proposal: () => ({ type: 'accept' }),
                  clarification: () => ({ answer: 'yes' }), gap_review: () => ({ acceptDefaults: true }),
                  ratify: () => ({ type: 'approve' }) };
  const seen = [];
  let iv;
  try { await conv.run('v1', intent); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 80 && iv?.type !== 'done'; i++) {
    seen.push(iv);
    iv = await conv.resume('v1', (reply[iv.type] ?? (() => ({ type: 'accept' })))(iv));
  }
  const ratify = seen.find(iv => iv.type === 'ratify');
  return { spec: iv?.spec ?? null, seen, beats, ratify };
}


// ═══════════════════════════════════════════════════════════════════════════════
describe('verify does not run the workflow', () => {
  test('the dry-runner is never invoked, and the build still reaches ratify', async () => {
    const calls = [];
    const runDryRun = async (spec, given) => {
      calls.push({ spec, given });
      return { outputs: [], deliveries: [],
               oracleResult: { contractPassed: true, ran: true, error: null, contract: [] } };
    };
    const r = await drive({ llm: makeLlm(), runDryRun });

    assert.ok(r.spec, 'the run reaches a ratified spec');
    assert.deepEqual(calls, [],
      'verify executed the workflow — that is the TEST’s job, and doing it here means '
      + 'every build pays for the run twice');
    // THE ONE-WALKTHROUGH INVARIANT, unchanged: the step-approval fires exactly once,
    // on the settled spec, never mid-build.
    assert.equal(r.seen.filter(iv => iv.type === 'generated_workflow').length, 1,
      'the walkthrough is presented exactly once');
  });

  test('the report says nothing was run, so nothing downstream can claim it was', async () => {
    const r = await drive({ llm: makeLlm(), runDryRun: async () => ({}) });
    assert.ok(r.ratify?.verification, 'ratify still surfaces a verification report');
    assert.equal(r.ratify.verification.ran, false,
      '`ran:true` here would let a promise be reported as tested when nothing executed');
  });

  test('and it does not TELL the user it ran the workflow', async () => {
    const r = await drive({ llm: makeLlm(), runDryRun: async () => ({}) });
    const claimed = r.beats.filter(b => b.kind === 'check' &&
      /Running your workflow|produced the right result|on \d+ sample cases to check it actually works/i.test(b.text ?? ''));
    assert.deepEqual(claimed, [],
      'this product’s whole thesis is that it does not claim more than it did');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('verify never buys a second whole-spec pass', () => {
  test('a draft whose promise a run WOULD have failed is still built exactly once', async () => {
    // The spec is structurally complete (it has the Slack delivery the contract names),
    // so `gaps` is satisfied and nothing upstream regenerates. Under the old contract
    // this is precisely the case that cost a rebuild: the oracle would have said the
    // promise was broken and verify would have re-generated the whole spec.
    const llm = makeLlm();
    const runDryRun = async () => ({
      outputs: [], deliveries: [],
      oracleResult: { contractPassed: false, ran: true, error: null,
        contract: [{ id: 'a1', target: 'slack:#ops', kind: 'message_sent', ok: false }] },
    });
    const r = await drive({ llm, runDryRun });

    assert.ok(r.spec, 'the build still completes and is presented');
    assert.equal(llm.generateCount(), 1,
      'a failing promise bought another whole-spec pass — that spend belongs to the user '
      + 'pressing Run test, not to the build');
  });

  test('a tester that THROWS cannot block or rebuild either', async () => {
    const llm = makeLlm();
    const r = await drive({ llm, runDryRun: async () => { throw new Error('tester exploded'); } });
    assert.ok(r.spec, 'the build is never blocked on the self-test');
    assert.equal(llm.generateCount(), 1, 'and never pays for a rebuild over it');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('the test cases are still prepared here', () => {
  // The top-up is the ONLY thing that produces one input per path. Without it a router
  // reaches the panel with a single sample, cannot cover its own routes, and correctly
  // refuses to certify — so the user is asked to write test cases by hand, which is the
  // typing the zero-typing path exists to remove.
  test('the ratified spec carries the sample examples', async () => {
    const r = await drive({ llm: makeLlm(), runDryRun: async () => ({}) });
    const examples = r.spec?.outcome?.examples ?? [];
    assert.ok(examples.length >= 1, 'the panel has nothing to run without these');
    assert.ok(examples.every(e => e && e.given != null),
      'an example with no input cannot be run against anything');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('fail-safe pass-throughs — the build is NEVER blocked', () => {
  test('no tester wired at all still reaches ratify', async () => {
    const r = await drive({ llm: makeLlm(), runDryRun: undefined });
    assert.ok(r.spec, 'a converger with no dry-runner still finishes the build');
  });
});
