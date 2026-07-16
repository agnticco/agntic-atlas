/**
 * The converger's self-verification loop — the `verify` node. (Increment #23.)
 *
 * The converger now behaves like a coding agent: after it builds a spec it runs its
 * OWN draft through the real engine (in DRY-RUN mode — no real sends) on the sample
 * examples, reads the outcome-oracle verdict, and, on a failure, regenerates a fix and
 * re-runs. "Run test" becomes a demonstration of something already watched pass.
 *
 * These tests drive the REAL graph through the production call path (`createConverger`
 * → run → resume, the way `src/api/builder.js` drives it), injecting a STUB `runDryRun`
 * so the routing/narration/bounds are exercised deterministically. The engine's own
 * "dry-run causes zero real sends" contract is pinned separately, at the engine
 * boundary, in `tests/workflows/dry-run-verify.test.js`.
 *
 * WHAT THESE PIN (and the mutation each guards):
 *   • a would-satisfy sample → verify routes to ratify with a PASS report, and the
 *     dry-runner was actually invoked (delete the verify call ⇒ never invoked);
 *   • a failing sample → verify NARRATES the failure and REGENERATES a fix (a second
 *     whole-spec pass), bounded — never an endless build/fix spin;
 *   • no examples / runDryRun THROWS / no tester wired → PASS-THROUGH to ratify (the
 *     build is never blocked on the self-test);
 *   • the loop feeds the engine through `runDryRun` and NEVER fires a real delivery —
 *     the stub records every call; a spec that reaches ratify has run only in dry mode.
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
describe('a would-satisfy sample → verified, presented, ZERO real sends', () => {
  test('verify runs the draft, reports a pass, and reaches ratify', async () => {
    const calls = [];
    // The oracle says the contract is kept. (Its shape mirrors evaluateExampleRun.)
    const runDryRun = async (spec, given) => {
      calls.push({ spec, given });
      return { outputs: [], deliveries: [{ delivered: true, channel: 'slack', target: '#ops' }],
               oracleResult: { contractPassed: true, ran: true, error: null,
                 contract: [{ id: 'a1', target: 'slack:#ops', kind: 'message_sent', ok: true }] } };
    };
    const r = await drive({ llm: makeLlm(), runDryRun });

    assert.ok(r.spec, 'the run reaches a ratified spec');
    // THE ONE-WALKTHROUGH INVARIANT: a clean first-try build shows the step-approval
    // walkthrough EXACTLY ONCE — on the final, verified spec — never mid-build.
    assert.equal(r.seen.filter(iv => iv.type === 'generated_workflow').length, 1,
      'the walkthrough is presented exactly once, on the settled spec');
    assert.ok(calls.length >= 1, 'the converger actually RAN its own draft — verify invoked runDryRun');
    // The sample it ran on is the example gathered onto the outcome, not a blank.
    assert.ok(calls[0].given && (calls[0].given.subject || calls[0].given.body),
      'the draft was run on the sample example event, not on nothing');
    // A pass beat was narrated.
    assert.ok(r.beats.some(b => b.kind === 'check' && /produced the right result|passed/i.test(b.text ?? '')),
      'the pass is narrated to the reasoning panel');
    // ratify carries the honest verification report.
    assert.ok(r.ratify?.verification, 'ratify surfaces the verification report');
    assert.equal(r.ratify.verification.ran, true);
    assert.equal(r.ratify.verification.note, null, 'a clean pass carries no failure note');
    // ZERO real deliveries: the ONLY execution path used was the dry-runner stub.
    // (The stub is where dryRunDeliveries lives; the engine-level pin is separate.)
    assert.ok(r.seen.every(iv => iv.type !== 'real_delivery'), 'sanity: nothing fired a real delivery interrupt');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('a failing sample → the converger fixes its own work, bounded', () => {
  test('a RUNTIME failure NARRATES and REGENERATES a corrected spec (a second whole-spec pass)', async () => {
    // The spec is STRUCTURALLY complete throughout (it has the Slack delivery, so the
    // gap scorer is happy and never regenerates). The failure is at RUNTIME — the kind
    // only `verify` can catch, because it actually RUNS the workflow: the oracle fails
    // the first sample run and passes the second (simulating the converger's fix
    // working). So the ONLY reason a second whole-spec pass happens is verify's fix
    // path — the gap loop would have had no reason to rebuild a complete spec.
    let runs = 0;
    const runDryRun = async () => {
      runs++;
      // verify retries a FAILED sample once (llm nodes flake), so a PERSISTENT failure is
      // what regenerates: fail BOTH attempts of the first spec (runs 1,2), then the
      // regenerated spec passes (run 3+). A single-flake first-then-pass would be absorbed
      // by the retry with NO regenerate — which is the point of the retry.
      const ok = runs > 2;
      return { outputs: [], deliveries: ok ? [{ delivered: true, channel: 'slack', target: '#ops' }] : [],
               oracleResult: { contractPassed: ok, ran: true, error: null,
                 contract: [{ id: 'a1', target: 'slack:#ops', kind: 'message_sent', ok,
                   reason: ok ? undefined : 'a message was delivered, but its content was an error' }] } };
    };

    const llm = makeLlm();
    const r = await drive({ llm, runDryRun });

    // The fix regenerate happens INTERNALLY now (the walkthrough moved to the end), so
    // it is measured by counting `generate` passes, NOT walkthrough interrupts: build (1)
    // + one verify fix (1) = 2.
    assert.equal(llm.generateCount(), 2,
      'a structurally-complete spec that FAILS at runtime must trigger exactly one internal fix regenerate (build + fix)');
    // …and the user is shown the step-approval only ONCE — on the final, fixed spec.
    assert.equal(r.seen.filter(iv => iv.type === 'generated_workflow').length, 1,
      'the internal fix regenerate is SILENT — the walkthrough is presented exactly once');
    assert.ok(r.beats.some(b => b.kind === 'thinking' && /rebuild|didn't keep its promise|promise/i.test(b.text ?? '')),
      'the fix reasoning is narrated (kind:thinking)');
    assert.ok(r.beats.some(b => b.kind === 'check' && /didn't pass|only \d+\/\d+/i.test(b.text ?? '')),
      'the failure is narrated (kind:check)');
    assert.ok(runs >= 2, 'the loop re-ran the draft after fixing it (at least one build + one re-verify)');
    // It converged with a passing verification report.
    assert.ok(r.spec, 'the run converges to a ratified spec');
    assert.equal(r.ratify?.verification?.note, null, 'the final report is a clean pass — the fix worked');
  });

  test('a sample it can NEVER make pass ends at ratify with an honest note — no infinite loop', async () => {
    // The oracle ALWAYS fails. The fix loop is bounded by MAX_VERIFY_ROUNDS, so the
    // build must still terminate at ratify — carrying a give-up note, never claiming
    // success, never spinning. (Mutation: drop the verifyRounds cap ⇒ this hangs.)
    let runs = 0;
    const runDryRun = async () => {
      runs++;
      return { outputs: [], deliveries: [],
               oracleResult: { contractPassed: false, ran: true, error: null,
                 contract: [{ id: 'a1', target: 'slack:#ops', kind: 'message_sent', ok: false, reason: 'nothing reached slack:#ops' }] } };
    };
    const r = await drive({ llm: makeLlm(), runDryRun });

    assert.ok(r.spec, 'even an unfixable sample still converges to a ratified spec — never a spin');
    // Bounded still holds; the retry (a failed sample re-runs once) roughly doubles the
    // dry-run count per round, so the ceiling is ~2× the round cap — still finite, no spin.
    assert.ok(runs <= 8, `the fix loop is bounded; it re-ran ${runs} times`);
    assert.ok(r.ratify?.verification?.gaveUp === true, 'the report honestly says it could not get a sample to pass');
    assert.ok(r.ratify.verification.note, 'and it carries the reason, never a false success');
    assert.ok(r.beats.some(b => b.kind === 'check' && /couldn't get a sample to (fully )?pass|review it before going live/i.test(b.text ?? '')),
      'the give-up is narrated honestly');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE AGGREGATE REGENERATE CAP — reproduces the live deploy-blocker, re-pointed.
//
// `verifyRounds` bounds ONLY the verify fix loop. But the whole spec is ALSO
// re-generated by the analyze sufficiency/regen loop, a decision-table correction, and a
// gap fix — each with its OWN counter. In a live headed build the model kept producing a
// spec that failed verification AND the sufficiency check kept saying "not finished", so
// the two loops COMPOUNDED. Pre-2026-07-16 the walkthrough fired at the END of `generate`,
// so every compounded regenerate re-presented it and the user was looped through
// re-approvals ("4 walkthroughs past a cap of 2"). `buildPresentations` +
// MAX_BUILD_REGENERATIONS is the total cap on those regenerations.
//
// The walkthrough now fires ONCE, at the very end (its own node), so it can no longer
// loop the USER — but the SILENT internal regenerate loop still compounds and must still
// terminate. This test drives repeated verify-fail + sufficiency-not-finished cycles and
// asserts: (a) the walkthrough is shown EXACTLY ONCE, and (b) the build STOPS after at
// most the cap (≤ 4 generate passes = the first build + 3 capped regenerates), with a
// gave-up note. It FAILS on the pre-cap code (the loops compound unbounded).
describe('the aggregate regenerate cap — compounding regenerate loops always terminate', () => {
  // makeLlm, but the sufficiency check ALWAYS says "not finished" — so the analyze
  // regen loop fires on top of the verify fix loop, exactly as it did live.
  function makeLlmNeverFinished() {
    const llm = makeLlm();
    const base = llm.invoke;
    llm.invoke = async (msgs) => {
      const p = String(msgs[msgs.length - 1].content);
      if (p.includes('Is this workflow FINISHED')) return J({ complete: false, missing: 'another step' });
      return base(msgs);
    };
    return llm;
  }

  test('verify ALWAYS fails AND sufficiency ALWAYS says not-finished → ratify, bounded, no user loop', async () => {
    // The oracle always fails (verify wants to fix forever) and the sufficiency check
    // always says not-finished (analyze wants to regenerate forever). With no aggregate
    // cap these compound; the user is stuck re-approving the walkthrough. The cap must
    // force termination at ratify.
    let runs = 0;
    const runDryRun = async () => {
      runs++;
      return { outputs: [], deliveries: [],
               oracleResult: { contractPassed: false, ran: true, error: null,
                 contract: [{ id: 'a1', target: 'slack:#ops', kind: 'message_sent', ok: false, reason: 'nothing reached slack:#ops' }] } };
    };

    const llm = makeLlmNeverFinished();
    const r = await drive({ llm, runDryRun });

    // THE ONE-WALKTHROUGH INVARIANT UNDER COMPOUNDING LOOPS: no matter how many internal
    // regenerates the verify-fix + sufficiency loops drive, the user is shown the
    // step-approval EXACTLY ONCE — on the final, settled spec. (Pre-2026-07-16 this
    // scenario presented the walkthrough 7 times; that is the regression this pins.)
    const walkthroughs = r.seen.filter(iv => iv.type === 'generated_workflow').length;
    assert.equal(walkthroughs, 1,
      `the walkthrough must be presented EXACTLY ONCE regardless of internal regenerates; it was shown ${walkthroughs} times`);
    // THE AGGREGATE CAP, RE-POINTED: it now bounds the SILENT internal regenerate loop,
    // not walkthrough presentations. The cap is the first build (1) +
    // MAX_BUILD_REGENERATIONS (3) = 4 generate passes. Above 4 means the aggregate cap is
    // not holding and the model is burning unbounded Opus rebuilds.
    assert.ok(llm.generateCount() <= 4,
      `the internal regenerate loop must be bounded by the aggregate cap; generate ran ${llm.generateCount()} times`);
    // And the compounding loops genuinely fired (this is not passing because nothing
    // regenerated) — the first build plus a couple of regenerates.
    assert.ok(llm.generateCount() >= 3,
      `the compounding loops must actually have fired (generate ran ${llm.generateCount()} times)`);
    // It TERMINATED at ratify — never spun to the recursion limit / hung the build.
    assert.ok(r.spec, 'the build converges to a ratified spec — it never loops the user forever');
    assert.ok(r.ratify, 'the build reached ratify');
    // And it said so honestly — a give-up note, never a false success.
    assert.equal(r.ratify?.verification?.gaveUp, true, 'ratify carries an honest give-up note, not a false pass');
    assert.ok(r.ratify?.verification?.note, 'the give-up note carries a reason');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('fail-safe pass-throughs — the build is NEVER blocked on the self-test', () => {
  test('no tester wired ⇒ verify is inert; the build ratifies unchanged', async () => {
    // runDryRun omitted entirely — the production default when the server wrapper is
    // absent. verify must be a pass-through; no beats, straight to ratify.
    const r = await drive({ llm: makeLlm(), runDryRun: undefined });
    assert.ok(r.spec, 'the build still reaches a ratified spec');
    assert.equal(r.ratify?.verification ?? null, null, 'no self-test ran, so ratify carries no verification report');
    assert.equal(r.beats.filter(b => b.kind === 'check').length, 0, 'nothing was narrated by verify');
  });

  test('no examples ⇒ verify passes through (nothing to run it on)', async () => {
    // The example node yields none, so outcome.examples is empty — verify cannot run.
    const llm = makeLlm();
    const base = llm.invoke;
    llm.invoke = async (msgs) => {
      const p = String(msgs[msgs.length - 1].content);
      if (p.includes('CONCRETE example cases')) return J({ examples: [] });
      return base(msgs);
    };
    let called = 0;
    const runDryRun = async () => { called++; return { outputs: [], oracleResult: { contractPassed: true, ran: true, contract: [] } }; };
    const r = await drive({ llm, runDryRun });
    assert.ok(r.spec, 'the build ratifies');
    assert.equal(called, 0, 'with no example to run, the tester is never called');
  });

  test('runDryRun THROWS ⇒ verify does not block the build (honest note, still ratifies)', async () => {
    const runDryRun = async () => { throw new Error('engine exploded'); };
    const r = await drive({ llm: makeLlm(), runDryRun });
    assert.ok(r.spec, 'a tester that throws is an infra hiccup, not a build blocker — the spec still ratifies');
    assert.equal(r.ratify?.verification?.ran, false, 'the report says the self-test could not run');
    assert.ok(/could not run/i.test(r.ratify?.verification?.note ?? ''), 'and says so honestly');
  });
});
