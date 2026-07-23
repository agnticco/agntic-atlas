/**
 * THE WORKFLOW IS NAMED ON THE STATE OBJECT AT THE PLAN — not left to the model.
 *
 * The workflow-under-construction is a `draft` object carried through the graph's
 * state (LangGraph-style). A field written at the `plan` node rides along to
 * `generate`, and mergeGeneratedSpec keeps the draft's name over the model's. So a
 * name set at the approved plan can never be forgotten by the build.
 *
 * Before this, the model was asked to emit the name and sometimes dropped it —
 * `MISSING_NAME`, which then triggered a whole 13-node Opus rebuild just to add a
 * title. Setting the field on the object guarantees it; a prompt rule only asks.
 *
 * WHAT THESE PIN:
 *  - after an approved plan, the draft carries a real name (deterministic);
 *  - the name is NOT overwritten by generate — the draft's name survives the merge;
 *  - a name the plan itself produced is preferred over the derived fallback;
 *  - and the build no longer regenerates over a missing name.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConverger } from '../../src/converger/index.js';
import { nameApprovedDraft } from '../../src/converger/elicitation-graph.js';
import { realCatalog } from '../helpers/catalog.js';

const CAPS = { channels: realCatalog().getAll().map(c => ({ ...c, available: true })) };
const J = (o) => ({ content: JSON.stringify(o) });
const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-pn-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

/**
 * Drive a build where the model emits NO top-level name at generate (the exact defect),
 * and the plan HAS real steps (so the plan node runs and names the workflow).
 * @param planTitle  a name the plan itself carries, or null.
 */
async function driveNamed({ planTitle = null } = {}) {
  let genCalls = 0;
  const llm = { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT'))
      return J({ candidates: [{ id: 'c1', statement: 'Save a summary of each email to the inbox.',
        assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Summary' }] }] });
    if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:me@acme.com' } });
    if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
    if (p.includes('one per path'))                   return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('write the PLAN'))
      return J({ ...(planTitle ? { name: planTitle } : {}), steps: [{ text: 'Summarize the email' }, { text: 'Save it to the inbox' }], branches: [] });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
    if (p.includes('Build the COMPLETE workflow')) {
      genCalls++;
      // The model omits `name` — the exact defect this fix prevents. Real specs carry
      // NO trigger node (the trigger is the top-level `triggers[]`; the entry node is
      // seeded from the trigger event), so the entry here is `summarize`.
      return J({ triggers: [{ type: 'email', filter: 'to:me@acme.com' }], nodes: [
        { id: 'summarize', type: 'llm',     label: 'Summarize', config: { mode: 'summarize', prompt: 'Summarize. If there is no subject and no body at all, output EXACTLY: ERROR: required data not found' } },
        { id: 'save',      type: 'deliver', label: 'Save',      config: { channel: 'in_app', subject: 'Summary' } },
      ], edges: [{ from: 'summarize', to: 'save' }] });
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
  try { await conv.run('n1', 'summarize my email to my inbox'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 80 && iv?.type !== 'done'; i++) {
    iv = await conv.resume('n1', (answer[iv.type] ?? (() => ({ type: 'accept' })))(iv));
  }
  return { spec: iv?.spec ?? null, genCalls };
}

describe('the plan names the workflow on the state object', () => {
  test('the built spec has a real name even though the model emitted none', async () => {
    const r = await driveNamed();
    assert.ok(r.spec, 'the build converges');
    assert.ok(r.spec.name && r.spec.name.trim().length > 0,
      'the workflow must be named — the model omitted it, so the plan must have supplied it');
    assert.match(r.spec.name, /summary|email|inbox/i,
      'and the name reflects the outcome the user approved, not a placeholder');
  });

  test('a name the plan itself produced is used', async () => {
    const r = await driveNamed({ planTitle: 'Morning Inbox Digest' });
    assert.equal(r.spec.name, 'Morning Inbox Digest',
      'the plan carried a title — it should win over the derived fallback');
  });

  test('the build does not regenerate over the missing name', async () => {
    const r = await driveNamed();
    assert.equal(r.genCalls, 1,
      'with the name set at the plan, MISSING_NAME never fires, so the model builds once — no rebuild for a title');
  });
});

describe('nameApprovedDraft — the naming precedence', () => {
  const OUT = { outcome: { statement: 'Save a summary of each email to the inbox.' } };

  test('an existing name is KEPT — the edit flow must not rename a named workflow', () => {
    // This is the case the full-build drive can never reach (its draft starts nameless),
    // so it is pinned here: a user editing a workflow they named must not have it
    // silently renamed on the next plan.
    const r = nameApprovedDraft({ ...OUT, name: 'My Careful Name' }, { name: 'Plan Title', steps: [] });
    assert.equal(r.name, 'My Careful Name', 'renaming a named draft is a silent edit to the user\'s choice');
  });

  test('a plan title beats the derived fallback', () => {
    const r = nameApprovedDraft(OUT, { name: 'Morning Digest', steps: [] });
    assert.equal(r.name, 'Morning Digest');
  });

  test('with no name anywhere, it derives from the outcome', () => {
    const r = nameApprovedDraft(OUT, { steps: [] });
    assert.match(r.name, /summary|email|inbox/i);
  });

  test('a blank existing name is treated as no name', () => {
    const r = nameApprovedDraft({ ...OUT, name: '   ' }, { name: 'Fallback', steps: [] });
    assert.equal(r.name, 'Fallback');
  });
});
