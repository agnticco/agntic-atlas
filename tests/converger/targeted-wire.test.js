/**
 * AN UNWIRED DELIVERY IS ONE EDGE, NOT A WHOLE REBUILD.
 *
 * The `process` node seeds a delivery node per promised delivery but not its edges;
 * the model wires them at `generate`, and when it forgets one the delivery has nothing
 * feeding it (DELIVER_NO_INPUT). That was the actual driver of the reported 9-minute
 * build, and the old response was to throw away every node for a fresh Opus pass.
 *
 * The fix asks the model — in a small, cheap, fast-tier call — for JUST the edges that
 * wire the orphaned deliveries. The model still chooses WHICH step feeds each delivery
 * (the same judgement it makes in a full build, so no less safe); it is spared only
 * from re-emitting the whole spec.
 *
 * WHAT THESE PIN:
 *  - a build the model leaves with an unwired delivery converges WITHOUT a whole-spec
 *    rebuild — the delivery is wired by the targeted call (genCalls stays 1);
 *  - the wire is applied and the delivery ends up connected;
 *  - the targeted call may only wire an ORPHANED delivery FROM an EXISTING step — a
 *    hallucinated `from`, a non-orphan `to`, or a self-loop is discarded (safety: a
 *    wire to the wrong source sends the customer the wrong thing);
 *  - when the producing step is genuinely MISSING, the targeted call cannot invent it,
 *    so it falls through to the (bounded) rebuild rather than wiring the wrong thing.
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
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-tw-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

/**
 * A build whose generate emits `save` (a delivery) with NO incoming edge. The wire
 * step's answer is controllable to exercise the safety filters.
 * @param wireAnswer  what the targeted wire call returns (the {edges:[…]} object).
 * @param includeProducer  whether `summarize` (the producing step) exists at all.
 */
async function driveUnwiredDelivery({ wireAnswer, includeProducer = true } = {}) {
  let genCalls = 0, wireCalls = 0;
  const llm = { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT'))
      return J({ candidates: [{ id: 'c1', statement: 'Save a summary of each email to the inbox.',
        assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Summary' }] }] });
    if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:me@acme.com' } });
    if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
    if (p.includes('one per path'))                   return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('write the PLAN'))                 return J({ name: 'Inbox Summary', steps: [{ text: 'Summarize' }, { text: 'Save' }], branches: [] });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
    // The targeted wire call — identified by the prompt's own words.
    if (p.includes('nothing wired into')) {
      wireCalls++;
      return J(wireAnswer ?? { edges: [{ from: 'summarize', to: 'save' }] });
    }
    if (p.includes('Build the COMPLETE workflow')) {
      genCalls++;
      const nodes = [
        ...(includeProducer ? [{ id: 'summarize', type: 'llm', label: 'Summarize', config: { mode: 'summarize', prompt: 'Summarize. If there is no subject and no body at all, output EXACTLY: ERROR: required data not found' } }] : []),
        { id: 'save', type: 'deliver', label: 'Save', config: { channel: 'in_app', subject: 'Summary' } },
      ];
      // `save` is emitted with NO incoming edge — the defect.
      return J({ triggers: [{ type: 'email', filter: 'to:me@acme.com' }], nodes, edges: [] });
    }
    return J({});
  } };

  const conv = createConverger({ llm, capabilities: CAPS, checkpointerDir: scratch() });
  const answer = {
    outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
    plan_review: () => ({ type: 'approve' }), clarification: () => ({ answer: 'yes' }),
    gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }),
    walkthrough: () => ({ type: 'accept' }),
  };
  let iv;
  try { await conv.run('w1', 'summarize my email to my inbox'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 80 && iv?.type !== 'done'; i++) {
    iv = await conv.resume('w1', (answer[iv.type] ?? (() => ({ type: 'accept' })))(iv));
  }
  return { spec: iv?.spec ?? null, genCalls, wireCalls };
}

const wiredToSave = (spec) => (spec?.edges ?? []).some(e => e.to === 'save');

describe('a targeted wire fixes an unwired delivery without a rebuild', () => {
  test('the model wires it in one small call — no whole-spec regenerate', async () => {
    const r = await driveUnwiredDelivery();
    assert.ok(r.spec, 'the build converges');
    assert.equal(r.wireCalls, 1, 'the targeted wire call fired');
    assert.equal(r.genCalls, 1, 'and the whole spec was NOT rebuilt — one generate, then a cheap wire');
    assert.ok(wiredToSave(r.spec), 'the delivery ends up wired');
  });

  test('a hallucinated source is discarded — never trusted', async () => {
    // The model tries to wire `save` from a step that does not exist. That edge must be
    // dropped; with no valid wire the delivery stays orphaned and it falls through to a
    // rebuild rather than accepting a wire to a phantom source.
    const r = await driveUnwiredDelivery({ wireAnswer: { edges: [{ from: 'ghost_step', to: 'save' }] } });
    assert.ok(!(r.spec?.edges ?? []).some(e => e.from === 'ghost_step'),
      'an edge from a non-existent step must never reach the spec');
  });

  test('a self-loop ON THE ORPHAN is discarded (applyProposal keeps self-loops, so this guard is real)', async () => {
    // to === from === the orphaned delivery: it passes the orphan check and the
    // node-exists check, so ONLY `from !== to` rejects it. A delivery wired to itself
    // delivers nothing and is nonsense.
    const r = await driveUnwiredDelivery({ wireAnswer: { edges: [
      { from: 'save', to: 'save' },          // orphan self-loop — must be rejected
      { from: 'summarize', to: 'save' },     // the legitimate wire
    ] } });
    assert.ok(!(r.spec?.edges ?? []).some(e => e.from === e.to), 'a self-loop must never reach the spec');
    assert.ok(wiredToSave(r.spec), 'the legitimate wire still applies');
  });

  test('a wire to a NON-orphan target is discarded (only the orphan check catches it)', async () => {
    // to is an existing NON-orphan step, from exists, from !== to — so only
    // `unwiredSet.has(to)` rejects it. The wire call may touch only what it was asked to.
    const r = await driveUnwiredDelivery({ wireAnswer: { edges: [
      { from: 'save', to: 'summarize' },     // backward edge into a non-orphan — must be rejected
      { from: 'summarize', to: 'save' },     // the legitimate wire
    ] } });
    assert.ok(!(r.spec?.edges ?? []).some(e => e.from === 'save' && e.to === 'summarize'),
      'the wire call must not rewire steps it was not asked to fix');
    assert.ok(wiredToSave(r.spec), 'the legitimate wire still applies');
  });

  test('wiring only SOME of several orphans does not ship as complete', async () => {
    // Two promised deliveries, both emitted unwired; the model wires only one. The
    // other is still DELIVER_NO_INPUT, so the re-score guard must catch it and fall
    // through to a rebuild — NOT blindly declare the spec complete with an orphan in it.
    const r = await driveTwoOrphans({ wireAnswer: { edges: [{ from: 'summarize', to: 'save_a' }] } });
    // Either it rebuilt (genCalls >= 2) to build the second delivery's wiring, or the
    // final spec has BOTH deliveries wired — never one wired and shipped as done.
    const bothWired = ['save_a', 'save_b'].every(id => (r.spec?.edges ?? []).some(e => e.to === id));
    assert.ok(r.genCalls >= 2 || bothWired,
      'a half-wired spec must not be presented as complete — the re-score guard must catch the remaining orphan');
  });

  test('when the producing step is missing, it does NOT wire the wrong thing', async () => {
    // No `summarize` exists — there is nothing correct to wire `save` from. The model
    // (honestly) returns no usable edge, so the delivery stays orphaned and the build
    // falls through to a rebuild instead of connecting the customer's delivery to a
    // wrong or invented source.
    const r = await driveUnwiredDelivery({ includeProducer: false, wireAnswer: { edges: [] } });
    assert.ok(r.genCalls >= 2 || !wiredToSave(r.spec) || r.spec === null,
      'a missing producer must force a rebuild or surface, never a wrong wire presented as done');
  });
});

/** Like driveUnwiredDelivery but with TWO promised deliveries, both emitted unwired. */
async function driveTwoOrphans({ wireAnswer } = {}) {
  let genCalls = 0;
  const llm = { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT'))
      return J({ candidates: [{ id: 'c1', statement: 'Summarize and save it to two inboxes.',
        assertions: [{ id: 'a', kind: 'message_sent', target: 'inbox:A' }, { id: 'b', kind: 'message_sent', target: 'inbox:B' }] }] });
    if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:me@acme.com' } });
    if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
    if (p.includes('one per path'))                   return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('write the PLAN'))                 return J({ name: 'Two inbox', steps: [{ text: 'Summarize' }, { text: 'Save A' }, { text: 'Save B' }], branches: [] });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
    if (p.includes('nothing wired into'))             return J(wireAnswer ?? { edges: [] });
    if (p.includes('Build the COMPLETE workflow')) {
      genCalls++;
      return J({ triggers: [{ type: 'email', filter: 'to:me@acme.com' }], nodes: [
        { id: 'summarize', type: 'llm',     label: 'Summarize', config: { mode: 'summarize', prompt: 'Summarize. If there is no subject and no body at all, output EXACTLY: ERROR: required data not found' } },
        { id: 'save_a',    type: 'deliver', label: 'Save A',    config: { channel: 'in_app', subject: 'A' } },
        { id: 'save_b',    type: 'deliver', label: 'Save B',    config: { channel: 'in_app', subject: 'B' } },
      ], edges: [] });   // BOTH deliveries orphaned
    }
    return J({});
  } };
  const conv = createConverger({ llm, capabilities: CAPS, checkpointerDir: scratch() });
  const answer = {
    outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
    plan_review: () => ({ type: 'approve' }), clarification: () => ({ answer: 'yes' }),
    gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }),
    walkthrough: () => ({ type: 'accept' }),
  };
  let iv;
  try { await conv.run('t2', 'summarize to two inboxes'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 80 && iv?.type !== 'done'; i++) {
    iv = await conv.resume('t2', (answer[iv.type] ?? (() => ({ type: 'accept' })))(iv));
  }
  return { spec: iv?.spec ?? null, genCalls };
}
