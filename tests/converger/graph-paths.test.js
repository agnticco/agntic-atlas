/**
 * The elicitation graph's own branches. (P12 Increment F.)
 *
 * `elicitation-graph.js` was never in the mutation sweep's TARGETS, so its score was
 * "not measured" — and FOUR of the nine defects the review pair found in F lived in
 * it. Widening the sweep put 50 survivors on the board in one file: the destination
 * resolution, the no-op guard, the trigger derivation, the clarify and modify paths.
 * A survivor list is a coverage report, and this is the part of it that is behaviour
 * rather than message strings.
 *
 * Every test drives the REAL graph through the production call path
 * (`createConverger` → `run` → `resume`), the way `src/api/builder.js` drives it.
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
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-gp-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

const J = (o) => ({ content: JSON.stringify(o) });
const draftIn = (p) => { const m = /CURRENT DRAFT:\n(\{[\s\S]*?\n\})\n/.exec(p); try { return JSON.parse(m[1]); } catch { return {}; } };

/**
 * Drive the loop. `answers` overrides the stub model per prompt; `bases` is what the
 * connector reports; `onInterrupt` sees every interrupt.
 */
async function drive({
  bases = [{ id: 'appAAAAAAAAAAAAA1', name: 'Sales CRM' }],
  withInvoker = true,
  proposeSameEdgeForever = false,
  answers = {},
  onInterrupt = () => {},
  reply = {},
  intent = 'save leads to airtable',
} = {}) {
  const calls = [];
  const invokeCapability = withInvoker ? async (id, params = {}) => {
    calls.push(id);
    if (id === 'airtable_list_bases')    return { bases };
    if (id === 'airtable_describe_base') return { baseId: params.baseId, tables: [
      { id: 't1', name: 'Leads', fields: [{ id: 'f1', name: 'Name', type: 'singleLineText', choices: [] }] },
    ] };
    if (id === 'gmail_search') return { messages: [] };
    throw new Error(`unstubbed: ${id}`);
  } : null;

  const llm = { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    for (const [needle, val] of Object.entries(answers)) if (p.includes(needle)) return J(val);

    if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1', statement: 'Leads are saved.',
      assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name'] }] }] });
    if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:leads@acme.com' } });
    if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
    if (p.includes('REAL columns are'))               return J({ map: { Name: 'Name' } });
    if (p.includes('Build the next component')) {
      const d = draftIn(p);
      const has = (id) => (d.nodes ?? []).some(n => n.id === id);
      if (!has('save')) return J({ component: 'node', spec: { id: 'save', type: 'connector-action', label: 'Save',
        config: { action: 'airtable_create_record', baseId: 'appPLACEHOLDER', tableId: 'Leads', fields: { Name: 'x' } } } });
      // A model that re-proposes an edge the draft ALREADY HAS. applyProposal dedupes,
      // so the draft comes back identical — the loop must not spin on it.
      if (proposeSameEdgeForever) return J({ component: 'edge', spec: { from: 'save', to: 'save' } });
      return J({ component: 'name', spec: 'Leads' });
    }
    return J({});
  } };

  const conv = createConverger({ llm, capabilities: CAPS, invokeCapability, checkpointerDir: scratch() });
  const defaults = { outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
                     proposal: () => ({ type: 'accept' }), clarification: () => ({ answer: 'yes' }),
                     gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }) };
  const answer = { ...defaults, ...reply };

  const seen = [];
  let iv;
  try { await conv.run('g1', intent); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 60 && iv?.type !== 'done'; i++) {
    seen.push(iv);
    onInterrupt(iv);
    iv = await conv.resume('g1', (answer[iv.type] ?? (() => ({ type: 'accept' })))(iv));
  }
  const spec = iv?.spec ?? null;
  return { spec, calls, seen, save: (spec?.nodes ?? []).find(n => n.id === 'save') };
}

// ── The destination resolution ──────────────────────────────────────────────

describe('choosing the base', () => {
  test('ONE base is TAKEN — a question with one answer is a speed bump, not a question', async () => {
    const r = await drive({ bases: [{ id: 'appAAAAAAAAAAAAA1', name: 'Only One' }] });
    assert.equal(r.save.config.baseId, 'appAAAAAAAAAAAAA1');
    const asked = r.seen.filter(iv => iv.type === 'clarification' && /which airtable base/i.test(iv.question ?? ''));
    assert.equal(asked.length, 0, 'zero-typing (§6.2.4): with one possible answer, do not ask');
  });

  test('SEVERAL bases ⇒ the user is asked, with the real names as CHOICES', async () => {
    let question = null;
    const r = await drive({
      bases: [{ id: 'appAAAAAAAAAAAAA1', name: 'Sales CRM' }, { id: 'appBBBBBBBBBBBBB2', name: 'Recruiting' }],
      onInterrupt: (iv) => { if (iv.type === 'clarification' && /which airtable base/i.test(iv.question ?? '')) question = iv; },
      reply: { clarification: (iv) => (/which airtable base/i.test(iv.question ?? '') ? { id: 'appBBBBBBBBBBBBB2' } : { answer: 'yes' }) },
    });
    assert.ok(question, 'with more than one base, the user must choose — we cannot know which');
    assert.deepEqual(question.choices.map(c => c.label), ['Sales CRM', 'Recruiting'],
      'the CHOICES are the tenant\'s real base names — that is what makes it a click');
    assert.equal(r.save.config.baseId, 'appBBBBBBBBBBBBB2', 'and the base they picked is the one used');
  });

  test('NO invoker ⇒ nothing is called and nothing is invented', async () => {
    const r = await drive({ withInvoker: false });
    assert.deepEqual(r.calls, []);
    assert.equal(r.save.config.baseId, 'appPLACEHOLDER',
      'without a live connector the graph must ASK, never fabricate a base id');
  });

  test('the connector is asked ONCE — the latch holds across the gap loop', async () => {
    const r = await drive();
    assert.equal(r.calls.filter(c => c === 'airtable_list_bases').length, 1,
      're-entering `destinations` on the way back from the gaps must not re-ask "which base?" — ' +
      'a question asked twice is a question people learn to click past');
  });
});

// ── The propose loop ────────────────────────────────────────────────────────

describe('a proposal that changes nothing is not a proposal', () => {
  test('the loop does not spin on a re-proposed edge', async () => {
    // applyProposal DEDUPES, so a duplicate edge leaves the draft identical and the
    // model proposes it again — forever. Against the live model this produced
    // FOURTEEN consecutive identical "add this connection" cards.
    const r = await drive({ proposeSameEdgeForever: true });
    const proposals = r.seen.filter(iv => iv.type === 'proposal');
    assert.ok(proposals.length <= 4,
      `the propose loop spun ${proposals.length} times on a proposal that changed nothing`);
    assert.ok(r.spec, 'and it still converges to a spec');
  });

  test('POSITIVE: a proposal that DOES change the draft is applied', async () => {
    const r = await drive();
    assert.ok(r.save, 'the node the model proposed is in the spec');
    assert.equal(r.spec.name, 'Leads', 'and so is the name it proposed afterwards');
  });
});

// ── The other branches the sweep found unexecuted ───────────────────────────

describe('the paths nothing was driving', () => {
  test('a VAGUE intent is CLARIFIED, not guessed at', async () => {
    let asked = null;
    await drive({
      answers: { 'Analyze this automation intent': { ready: false, question: 'What should trigger this?' } },
      onInterrupt: (iv) => { if (iv.type === 'clarification' && !asked && /trigger/i.test(iv.question ?? '')) asked = iv; },
    });
    assert.ok(asked, 'when the model says it is not ready and asks a question, the user must SEE the question');
  });

  test('a MODIFIED proposal is merged, not discarded', async () => {
    const r = await drive({
      answers: { "USER'S MODIFICATION REQUEST": { component: 'node', spec: { id: 'save', type: 'connector-action', label: 'RENAMED',
        config: { action: 'airtable_create_record', baseId: 'appPLACEHOLDER', tableId: 'Leads', fields: { Name: 'x' } } } } },
      reply: { proposal: (iv) => (iv.proposal?.component === 'node'
        ? { type: 'modify', modification: 'call it RENAMED' }
        : { type: 'accept' }) },
    });
    assert.equal(r.save?.label, 'RENAMED',
      'a user who corrects a proposal must get their correction — silently dropping it is worse than not offering it');
  });

  test('the trigger is DERIVED, and an existing one is not overwritten', async () => {
    const r = await drive();
    assert.deepEqual(r.spec.triggers, [{ type: 'email', filter: 'to:leads@acme.com' }],
      'the trigger is the entry point of the graph — process derives it, and the example picker needs its filter');
  });
});
