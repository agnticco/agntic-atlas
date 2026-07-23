/**
 * THE CASE THE FIX DELIBERATELY DOES NOT AUTO-REPAIR — driven deterministically.
 *
 * The runaway-build fix (perf: repair a fixable blocker instead of rebuilding) does
 * NOT auto-wire a delivery that has nothing feeding it, because guessing which content
 * feeds a delivery risks sending the customer the wrong thing. That is the right call,
 * but it means the fix does not touch the exact blocker that drove the reported
 * 9-minute build: `DELIVER_NO_INPUT`. A single live build could not stress it — the
 * model happened to wire everything on the first pass. So this forces it.
 *
 * The stub model emits a delivery with NO incoming edge on the first `generate`, then
 * (like a real model told "fix this") wires it on the retry. We measure what the
 * converger does in between.
 *
 * WHAT THIS PROVES, and why it is the honest test of the unfixed case:
 *  1. the auto-repair NEVER invents an edge into the delivery (the safety line holds);
 *  2. the build still CONVERGES — the model's own retry wires it, and the loop lets it;
 *  3. it takes ONE rebuild, not the three the reference build paid for and not the cap;
 *  4. when the model NEVER wires it, the loop is BOUNDED — it stops and surfaces the
 *     blocker rather than spinning or hanging (the failure this whole loop must avoid).
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConverger } from '../../src/converger/index.js';
import { realCatalog } from '../helpers/catalog.js';

const CAPS = { channels: realCatalog().getAll().map(c => ({ ...c, available: true })) };
const J = (o) => ({ content: JSON.stringify(o) });
const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-uw-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

/**
 * Drive a full build of an email → summarize → save-to-inbox workflow.
 * @param wireOn  the generate pass number (1-based) on which the model finally wires
 *                the delivery. Infinity = it never wires it.
 */
async function driveUnwired({ wireOn = 2 } = {}) {
  let genCalls = 0;
  const specForPass = (pass) => {
    const nodes = [
      { id: 'trigger',   type: 'trigger', label: 'Email',     config: { type: 'email', filter: 'to:me@acme.com' } },
      { id: 'summarize', type: 'llm',     label: 'Summarize', config: { mode: 'summarize', prompt: 'Summarize. If there is no subject and no body at all, output EXACTLY: ERROR: required data not found' } },
      { id: 'save',      type: 'deliver', label: 'Save',      config: { channel: 'in_app', subject: 'Summary' } },
    ];
    const edges = [{ from: 'trigger', to: 'summarize' }];
    if (pass >= wireOn) edges.push({ from: 'summarize', to: 'save' });   // the wire the model forgot
    return { name: 'Inbox summary', triggers: [{ type: 'email', filter: 'to:me@acme.com' }], nodes, edges };
  };

  const llm = { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT'))
      return J({ candidates: [{ id: 'c1', statement: 'Save a summary of each email to the inbox.',
        assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Summary' }] }] });
    if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:me@acme.com' } });
    if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
    if (p.includes('one per path'))                   return J({ examples: [] });   // lane top-up
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('write the PLAN'))                 return J({ steps: [{ text: 'Summarize the email' }, { text: 'Save it to the inbox' }], branches: [] });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
    if (p.includes('Build the COMPLETE workflow')) { genCalls++; return J(specForPass(genCalls)); }
    return J({});
  } };

  const conv = createConverger({ llm, capabilities: CAPS, checkpointerDir: scratch() });
  const answer = {
    outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
    plan_review: () => ({ type: 'approve' }), clarification: () => ({ answer: 'yes' }),
    gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }),
    walkthrough: () => ({ type: 'accept' }),
  };

  const seen = [];
  let iv;
  try { await conv.run('u1', 'summarize my email to my inbox'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 80 && iv?.type !== 'done'; i++) {
    seen.push(iv);
    iv = await conv.resume('u1', (answer[iv.type] ?? (() => ({ type: 'accept' })))(iv));
  }
  const spec = iv?.spec ?? null;
  return { spec, genCalls, seen };
}

describe('an unwired delivery — the case left to the model on purpose', () => {
  test('the model wires it on retry: converges in ONE rebuild, not three', async () => {
    const r = await driveUnwired({ wireOn: 2 });
    assert.ok(r.spec, 'the build must converge to a spec, not hang');
    // The reference build paid for three generate passes; this must not.
    assert.ok(r.genCalls <= 2,
      `expected ≤2 generate passes (initial + one rebuild), got ${r.genCalls}`);
    assert.ok(r.genCalls >= 2, 'the first pass WAS unwired, so exactly one rebuild is expected');
    // And the delivery ended up wired — the workflow actually delivers.
    const wired = (r.spec.edges ?? []).some(e => e.to === 'save');
    assert.ok(wired, 'the converged spec must have the delivery wired');
  });

  test('the auto-repair never invents the edge itself', async () => {
    // If the repair had wired it, the build would converge on genCalls === 1 (no
    // rebuild needed). It needing a second generate is the proof the repair kept its
    // hands off and left the wiring to the model.
    const r = await driveUnwired({ wireOn: 2 });
    assert.equal(r.genCalls, 2,
      'converging on the FIRST pass would mean the repair auto-wired the delivery — the one thing it must not do');
  });

  test('the model NEVER wires it, IDENTICALLY each time: the "unchanged blockers" guard stops it fast', async () => {
    const r = await driveUnwired({ wireOn: Infinity });
    // When the failing spec is identical each pass, `blockerKey === _lastBlockerKey`
    // fires and the loop goes to `gaps` after a single wasted rebuild.
    assert.ok(r.genCalls <= 2, `an identical-blocker loop should cut off fast, got ${r.genCalls}`);
    assert.ok(r.spec || r.seen.some(iv => iv.type === 'ratify' || iv.type === 'generated_workflow'),
      'it must end in a surfaced spec, never an infinite spin');
  });

  test('the WORST case — the blockers SHIFT each pass (defeating the fast guards) — is still hard-capped', async () => {
    // This is what the reference 9-minute build actually did: each rebuild left a
    // DIFFERENT delivery unwired (different node id), so the blocker set changed every
    // round and neither the survivor nor the unchanged-key guard could fire. Only the
    // HARD cap (MAX_REGEN_ROUNDS) bounds it. This is the case my repair does NOT
    // improve — DELIVER_NO_INPUT is deliberately not auto-fixed — so the honest bar is
    // "bounded, not spinning", not "cheap".
    const r = await driveShiftingUnwired();
    assert.ok(r.genCalls <= 4,
      `even with shifting blockers the loop must hit the hard cap (≤4 generate passes), got ${r.genCalls}`);
    assert.ok(r.genCalls >= 2, 'it did rebuild — this case is genuinely not repaired for free');
    assert.ok(r.spec || r.seen.some(iv => iv.type === 'ratify' || iv.type === 'generated_workflow'),
      'and it still terminates with a surfaced spec');
  });
});

/**
 * The reference build's actual pathology: each rebuild leaves a delivery unwired, but
 * a DIFFERENT one each time, so the blocker fingerprint changes every round and the
 * cheap guards cannot catch it. Only the hard MAX_REGEN_ROUNDS cap stops it.
 */
async function driveShiftingUnwired() {
  let genCalls = 0;
  const specForPass = (pass) => {
    // Three deliveries; on each pass a different one is left unwired, so the blocker
    // set is {DELIVER_NO_INPUT:save<pass>} — never the same key twice.
    const which = pass % 3;
    const nodes = [
      { id: 'trigger', type: 'trigger', label: 'E', config: { type: 'email', filter: 'to:me@acme.com' } },
      { id: 'sum',     type: 'llm',     label: 'S', config: { mode: 'summarize', prompt: 'Summarize. If there is no subject and no body at all, output EXACTLY: ERROR: required data not found' } },
    ];
    const edges = [{ from: 'trigger', to: 'sum' }];
    for (let k = 0; k < 3; k++) {
      const id = `save_p${pass}_${k}`;   // fresh ids each pass ⇒ fingerprint always changes
      nodes.push({ id, type: 'deliver', label: `Save ${k}`, config: { channel: 'in_app', subject: `S${k}` } });
      if (k !== which) edges.push({ from: 'sum', to: id });   // one is always left unwired
    }
    return { name: 'Shifting', triggers: [{ type: 'email', filter: 'to:me@acme.com' }], nodes, edges };
  };

  const llm = { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT'))
      return J({ candidates: [{ id: 'c1', statement: 'Save summaries to the inbox.',
        assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:S0' }] }] });
    if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:me@acme.com' } });
    if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
    if (p.includes('one per path'))                   return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('write the PLAN'))                 return J({ steps: [{ text: 'Summarize' }, { text: 'Save' }], branches: [] });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
    if (p.includes('Build the COMPLETE workflow'))    { genCalls++; return J(specForPass(genCalls)); }
    return J({});
  } };
  const conv = createConverger({ llm, capabilities: CAPS, checkpointerDir: scratch() });
  const answer = {
    outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
    plan_review: () => ({ type: 'approve' }), clarification: () => ({ answer: 'yes' }),
    gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }),
    walkthrough: () => ({ type: 'accept' }),
  };
  const seen = [];
  let iv;
  try { await conv.run('s1', 'summaries'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 80 && iv?.type !== 'done'; i++) {
    seen.push(iv);
    iv = await conv.resume('s1', (answer[iv.type] ?? (() => ({ type: 'accept' })))(iv));
  }
  return { spec: iv?.spec ?? null, genCalls, seen };
}
