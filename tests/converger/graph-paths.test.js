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
  searchToo = false,       // the draft also has an airtable SEARCH node (no `fields`)
  blockingGap = false,     // the outcome promises Slack and the model never builds it
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
      assertions: blockingGap
        // The contract promises a Slack post the model never builds ⇒ a BLOCKING
        // UNSATISFIED_ASSERTION, which routes back through `propose` and re-enters
        // `destinations`. That is the only way to exercise the latch.
        ? [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name'] },
           { id: 'a2', kind: 'message_sent',  target: 'slack:#ops' }]
        : [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name'] }] }] });
    if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:leads@acme.com' } });
    if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('cases nobody has decided about')) {
      const ids = [...p.matchAll(/^ {2}- id: (\S+)$/gm)].map(m => m[1]);
      return J({ suggestions: ids.map(id => ({ gapId: id, answer: 'send it to #ops' })) });
    }
    if (p.includes('REAL columns are'))               return J({ map: { Name: 'Name' } });
    // The whole-spec `generate` pass is now the PRIMARY builder (converger
    // rearchitecture, Increment 3): `analyze` routes the first build here, not to
    // `propose`. It emits the complete { triggers, nodes, edges } in one call —
    // mirroring what the propose drip used to build cumulatively — leaving a
    // PLACEHOLDER base id + the intended `fields`, which `destinations` then resolves
    // against the live connector (that tail still runs AFTER generate). `propose`
    // survives only for gap-driven single fixes (exercised below via `blockingGap`).
    if (p.includes('Build the COMPLETE workflow')) {
      const nodes = [{ id: 'save', type: 'connector-action', label: 'Save',
        config: { action: 'airtable_create_record', baseId: 'appPLACEHOLDER', tableId: 'Leads', fields: { Name: 'x' } } }];
      if (searchToo) nodes.push({ id: 'find', type: 'connector-action', label: 'Find',
        config: { action: 'airtable_search_records', baseId: 'appPLACEHOLDER', tableId: 'Leads', filterByFormula: '{Status}="New"' } });
      // NOTE: the Slack delivery the `blockingGap` outcome promises is deliberately
      // NOT emitted — that leaves a BLOCKING UNSATISFIED_ASSERTION, the only way to
      // route back through `propose` and exercise the gap-fix path + the latch.
      return J({ name: 'Leads', triggers: [{ type: 'email', filter: 'to:leads@acme.com' }], nodes, edges: [] });
    }
    if (p.includes('Build the next component')) {
      const d = draftIn(p);
      const has = (id) => (d.nodes ?? []).some(n => n.id === id);
      if (!has('save')) return J({ component: 'node', spec: { id: 'save', type: 'connector-action', label: 'Save',
        config: { action: 'airtable_create_record', baseId: 'appPLACEHOLDER', tableId: 'Leads', fields: { Name: 'x' } } } });
      // A READ capability: it has no `fields` param at all, and must not be given one.
      if (searchToo && !has('find')) return J({ component: 'node', spec: { id: 'find', type: 'connector-action', label: 'Find',
        config: { action: 'airtable_search_records', baseId: 'appPLACEHOLDER', tableId: 'Leads', filterByFormula: '{Status}="New"' } } });
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
  const nodes = spec?.nodes ?? [];
  return { spec, calls, seen, save: nodes.find(n => n.id === 'save'), search: nodes.find(n => n.id === 'find') };
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

// ── Every "the spec must change" route REGENERATES — `propose` is retired ─────
// The client retired `propose`'s per-node `{type:'proposal'}` UI surface. Any route
// that reaches `propose` after `generate` emits an interrupt no client can render, so
// the build HANGS at phase:'building' (Run test disabled, never reaching ratify). The
// fix routes the FIRST build AND every later change (a blocking gap, a ratify
// request-changes) to `generate`, which rebuilds the whole, updated, still-validated
// spec from the accumulated clarifications. These tests pin that: no `proposal`
// interrupt is EVER emitted, the change is instead absorbed by a REGENERATE, and the
// loop stays bounded (MAX_REGEN_ROUNDS) so an unsatisfiable intent ends at `ratify`
// with its blockers shown rather than spinning.

describe('a blocking gap the builder cannot close does not spin — it regenerates, bounded', () => {
  test('no `proposal` interrupt is ever emitted, and it still converges to a spec', async () => {
    // The retired `propose` drip is the surface with no client UI. `blockingGap` leaves
    // the promised Slack delivery unbuilt — the production route that USED to re-enter
    // `propose`. It must now route back to `generate` (a REGENERATE), never to the
    // UI-less proposal card, and it must stay bounded rather than rebuild forever.
    const r = await drive({ proposeSameEdgeForever: true, blockingGap: true });
    const proposals  = r.seen.filter(iv => iv.type === 'proposal');
    const regens     = r.seen.filter(iv => iv.type === 'generated_workflow');
    assert.equal(proposals.length, 0,
      'a blocking gap must NEVER route to the retired, UI-less `propose` — that hangs the build');
    assert.ok(regens.length >= 2,
      'the blocking gap must be absorbed by at least one REGENERATE (a second whole-spec pass)');
    assert.ok(regens.length <= 5,
      `the regenerate loop must be bounded; it ran ${regens.length} times on an unsatisfiable gap`);
    assert.ok(r.spec, 'and it still converges to a ratified spec (with the blocker surfaced), never a spin');
  });

  test('POSITIVE: the generate pass builds the node and names the workflow', async () => {
    // The main build goes through `generate` (one whole-spec pass): the write node and
    // the workflow name both come from that single call, with NO propose card shown.
    const r = await drive();
    assert.ok(r.save, 'the node the whole-spec generate pass emitted is in the spec');
    assert.equal(r.spec.name, 'Leads', 'and so is the name it carried');
    assert.equal(r.seen.filter(iv => iv.type === 'proposal').length, 0,
      'the happy build shows NO proposal card — the whole spec is one generate + one review');
  });

  test('a CLEAN spec reaches ratify → END with exactly one build and no propose', async () => {
    // The invariant the brief calls load-bearing: a provably-complete spec walks straight
    // generate → walkthrough(accept) → analyze → gapping → gaps(no blocking) → ratify → done,
    // with NO regenerate and NO propose — a straight path to the test-unlock.
    const r = await drive();
    assert.ok(r.spec, 'the clean spec reaches a ratified spec');
    assert.equal(r.seen.filter(iv => iv.type === 'proposal').length, 0, 'no propose card is ever shown');
    assert.equal(r.seen.filter(iv => iv.type === 'generated_workflow').length, 1,
      'a clean spec is built ONCE — no regenerate round');
    assert.ok(r.seen.some(iv => iv.type === 'ratify'), 'and it reaches the ratify review');
  });

  test('a ratify request-changes REGENERATES the whole spec, it does not route to propose', async () => {
    // The third post-generate route into the retired `propose`: ratify's "request
    // changes". It must regenerate (phase:'proposing' → the ratify edge routes to
    // `generate`), not emit a UI-less proposal card. Mutation: route the ratify edge to
    // `propose` ⇒ a `proposal` interrupt appears and this fails.
    let ratified = false;
    const r = await drive({
      reply: {
        // First ratify → ask for a change; the regenerated spec is then approved.
        ratify: () => (ratified ? { type: 'approve' } : (ratified = true, { type: 'request_changes', feedback: 'tweak the wording' })),
      },
    });
    assert.equal(r.seen.filter(iv => iv.type === 'proposal').length, 0,
      'a ratify request-changes must NEVER route to the retired, UI-less `propose`');
    assert.ok(r.seen.filter(iv => iv.type === 'generated_workflow').length >= 2,
      'the requested change must be absorbed by a REGENERATE (a second whole-spec pass)');
    assert.ok(r.spec, 'and the run reaches a ratified spec after the change');
  });
});

describe('the destination resolution touches only what it should', () => {
  test('a node with NO fields (a search) does not GAIN one', async () => {
    // fillDestination writes the mapped columns into nodes that HAVE fields. A search
    // or a delete has none — injecting `fields` into one adds a config key the
    // capability does not declare, and the spec would then be rejected at publish for
    // a key the builder itself put there.
    const r = await drive({ searchToo: true });
    assert.ok(r.search, 'precondition: the draft has an airtable SEARCH node');
    assert.equal('fields' in r.search.config, false,
      'a read capability must not be handed a `fields` key it never declared');
    assert.equal(r.search.config.baseId, 'appAAAAAAAAAAAAA1', '…but it DOES get the resolved base');
  });

  test('the connector is not re-asked when the gap loop comes back round', async () => {
    // `destinationsResolved` is a latch. Without it, a blocking gap that REGENERATES
    // re-enters `destinations` on the way back to ratify and the user is asked "which
    // base?" a second time — and a question asked twice is one people learn to click past.
    const r = await drive({ blockingGap: true });
    assert.equal(r.calls.filter(c => c === 'airtable_list_bases').length, 1,
      `the base was looked up ${r.calls.filter(c => c === 'airtable_list_bases').length} times across the gap round`);
    assert.ok(r.seen.some(iv => iv.type === 'clarification' && iv.kind === 'gap_review'),
      'precondition: the gap loop actually ran (#24: gaps now surface as a clarification)');
  });
});

describe('unparseable model output becomes a QUESTION, not a tight loop', () => {
  test('a generate pass with no usable nodes asks the user to describe the steps', async () => {
    // `generate` is now the builder, and it carries the same guard the propose drip
    // did: garbage from the model (no nodes) must reach the user as a QUESTION, never a
    // silent spin — the worst failure a conversational builder has is one that looks
    // like it is working. The generate node's defensive branch interrupts with a
    // clarification ("describe, step by step, what it should do") instead of shipping an
    // empty spec. (The invariant is unchanged from the propose era; only the node that
    // owns it moved, because the builder moved.)
    let asked = null;
    await drive({
      answers: { 'Build the COMPLETE workflow': {} },   // the model returns nothing usable
      onInterrupt: (iv) => { if (!asked && iv.type === 'clarification' && /describe.*step by step|couldn't assemble/i.test(iv.question ?? '')) asked = iv; },
    });
    assert.ok(asked, 'unparseable generate output must reach the user as a question, not spin silently');
  });
});

describe('the outcome step degrades honestly', () => {
  test('when the model offers NO contract, the graph carries on rather than dying', async () => {
    // An outcome the model cannot state is not a reason to crash the session — it is a
    // reason to fall back to the ordinary propose loop and keep asking.
    const r = await drive({ answers: { 'OUTCOME CONTRACT': { candidates: [] } } });
    assert.ok(r.seen.length > 0, 'the session must continue and still reach the user');
    assert.equal(r.seen.some(iv => iv.type === 'outcome_check'), false,
      'and it must not show an outcome card with nothing on it');
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

  test('a MODIFIED generated workflow is regenerated with the correction, not discarded', async () => {
    // The modify path is now on `generate`, not `propose`: the whole-spec review
    // interrupt (`generated_workflow`) accepts `{ type: 'modify', modification }`, which
    // is fed back as a clarification and the WHOLE spec is regenerated to honour it. The
    // invariant is unchanged from the propose era: a user's correction is applied, never
    // silently dropped. Here the user renames the delivery step; the second generate pass
    // (whose prompt now carries the modification) emits the renamed label.
    // Mutation: drop the modification from the regenerate prompt ⇒ the label stays
    // 'Tell #ops' and the assertion fails.
    const J = (o) => ({ content: JSON.stringify(o) });
    const invokeCapability = async (id) => {
      if (id === 'airtable_list_bases')    return { bases: [{ id: 'appAAAAAAAAAAAAA1', name: 'Sales CRM' }] };
      if (id === 'airtable_describe_base') return { tables: [{ id: 't1', name: 'Leads', fields: [{ id: 'f1', name: 'Name', type: 'singleLineText', choices: [] }] }] };
      if (id === 'gmail_search')           return { messages: [] };
      throw new Error(`unstubbed: ${id}`);
    };
    const llm = { invoke: async (msgs) => {
      const p = String(msgs[msgs.length - 1].content);
      if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1', statement: 'Leads are saved and #ops is told.',
        assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name'] },
                     { id: 'a2', kind: 'message_sent', target: 'slack:#ops' }] }] });
      if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:leads@acme.com' } });
      if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
      if (p.includes('Analyze this automation intent')) return J({ ready: true });
      if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
      if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
      if (p.includes('REAL columns are'))               return J({ map: { Name: 'Name' } });
      // The whole spec, complete, in one call. The delivery label is 'Tell #ops' on the
      // first pass and 'RENAMED' once the regenerate prompt carries the user's correction.
      if (p.includes('Build the COMPLETE workflow')) {
        const renamed = p.includes('RENAMED');
        return J({ name: 'Leads', triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
          nodes: [
            { id: 'save',   type: 'connector-action', label: 'Save', config: { action: 'airtable_create_record', baseId: 'appPLACEHOLDER', tableId: 'Leads', fields: { Name: 'x' } } },
            { id: 'notify', type: 'deliver', label: renamed ? 'RENAMED' : 'Tell #ops', config: { channel: 'slack', target: '#ops' } },
          ],
          edges: [{ from: 'save', to: 'notify' }] });
      }
      return J({});
    } };

    const conv = createConverger({ llm, capabilities: CAPS, invokeCapability, checkpointerDir: scratch() });
    let reviewed = false;
    const reply = { outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
                    // The FIRST whole-graph review is modified (rename the delivery); the
                    // regenerated one is accepted.
                    generated_workflow: () => (reviewed ? { type: 'accept' } : (reviewed = true, { type: 'modify', modification: 'call the delivery step RENAMED' })),
                    clarification: () => ({ answer: 'yes' }), gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }) };
    let iv;
    try { await conv.run('mod1', 'save leads to airtable and tell ops'); iv = { type: 'done' }; }
    catch (err) { iv = err.interruptValue ?? err; }
    for (let i = 0; i < 60 && iv?.type !== 'done'; i++) iv = await conv.resume('mod1', (reply[iv.type] ?? (() => ({ type: 'accept' })))(iv));

    const notify = iv?.spec?.nodes?.find(n => n.id === 'notify');
    assert.ok(notify, 'the regenerated spec still carries the Slack delivery node');
    assert.equal(notify.label, 'RENAMED',
      'a user who corrects the generated workflow must get their correction — silently dropping it is worse than not offering it');
  });

  test('the trigger is DERIVED, and an existing one is not overwritten', async () => {
    const r = await drive();
    assert.deepEqual(r.spec.triggers, [{ type: 'email', filter: 'to:leads@acme.com' }],
      'the trigger is the entry point of the graph — process derives it, and the example picker needs its filter');
  });
});

// ── The whole-spec generate pass, through the REAL graph ─────────────────────
// The headline of the rearchitecture (Increment 3): the production path now runs
// `outcome → process → examples → analyze → GENERATE → analyze → gapping → …`, and
// the ratified spec is a COMPLETE, connected, branch-fed graph — even when the model
// drops a structural edge, because `generate → mergeGeneratedSpec → wireEdges` repairs
// it. This drives the compiled graph end-to-end (not the merge helper in isolation),
// with `generate` emitting a lead-router whose branch INPUT edge is DELIBERATELY missing
// (the exact live defect that motivated this work).
describe('generate builds a connected, branch-fed spec through the graph', () => {
  // The router the whole-spec pass emits — with classify_lead→route DROPPED.
  const ROUTER = {
    triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
    nodes: [
      { id: 'classify_lead', type: 'llm', label: 'Classify', config: { mode: 'classify', categories: 'hot\nwarm\ncold' } },
      { id: 'route', type: 'branch', label: 'Route', config: { on: 'classify_lead.output', cases: [
        { when: 'hot',  to: 'summ_hot' },
        { when: 'warm', to: 'summ_hot' },
        { when: '*',    to: 'summ_cold' } ] } },
      { id: 'summ_hot',  type: 'llm', label: 'Summarize hot',  config: { mode: 'summarize', instructions: 'One paragraph. Slack mrkdwn.' } },
      { id: 'summ_cold', type: 'llm', label: 'Note the rest',  config: { mode: 'summarize', length: 'short', instructions: 'One line. Slack mrkdwn.' } },
      { id: 'notify_sales', type: 'deliver', label: 'Post #sales', config: { channel: 'slack', target: '#sales' } },
      { id: 'notify_ops',   type: 'deliver', label: 'Post #ops',   config: { channel: 'slack', target: '#ops' } },
    ],
    // classify_lead→route is DELIBERATELY MISSING — wireEdges must add it.
    edges: [
      { from: 'route', to: 'summ_hot' },
      { from: 'route', to: 'summ_cold' },
      { from: 'summ_hot',  to: 'notify_sales' },
      { from: 'summ_cold', to: 'notify_ops' },
    ],
  };

  async function driveRouter() {
    const J = (o) => ({ content: JSON.stringify(o) });
    const invokeCapability = async (id) => {
      if (id === 'gmail_search') return { messages: [] };
      throw new Error(`unstubbed: ${id}`);      // no Airtable — a pure delivery router
    };
    const llm = { invoke: async (msgs) => {
      const p = String(msgs[msgs.length - 1].content);
      if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1', statement: 'Every lead is routed to the right Slack channel.',
        assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#sales' },
                     { id: 'a2', kind: 'message_sent', target: 'slack:#ops' }] }] });
      if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:leads@acme.com' } });
      if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
      if (p.includes('Analyze this automation intent')) return J({ ready: true });
      if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
      if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
      if (p.includes('Build the COMPLETE workflow'))    return J(ROUTER);
      if (p.includes('Build the next component'))       return J({ component: 'name', spec: 'Lead Router' });
      return J({});
    } };
    const conv = createConverger({ llm, capabilities: CAPS, invokeCapability, checkpointerDir: scratch() });
    const reply = { outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
                    proposal: () => ({ type: 'accept' }), clarification: () => ({ answer: 'yes' }),
                    gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }) };
    const seen = [];
    let iv;
    try { await conv.run('r1', 'route inbound leads to the right slack channel'); iv = { type: 'done' }; }
    catch (err) { iv = err.interruptValue ?? err; }
    for (let i = 0; i < 60 && iv?.type !== 'done'; i++) { seen.push(iv); iv = await conv.resume('r1', (reply[iv.type] ?? (() => ({ type: 'accept' })))(iv)); }
    return { spec: iv?.spec ?? null, seen };
  }

  test('the ratified spec exists and carries the branch and its classifier', async () => {
    const { spec } = await driveRouter();
    assert.ok(spec, 'the run reaches a ratified spec through the generate → wire path');
    const ids = spec.nodes.map(n => n.id);
    assert.ok(ids.includes('classify_lead') && ids.includes('route'), 'the router shape survives into the spec');
    const branch = spec.nodes.find(n => n.type === 'branch');
    assert.ok(branch?.config?.cases?.some(c => c.when === '*'), 'the branch keeps its mandatory catch-all');
  });

  test('the DROPPED branch INPUT edge is wired — the branch is actually fed', async () => {
    const { spec } = await driveRouter();
    assert.ok(spec.edges.some(e => e.from === 'classify_lead' && e.to === 'route'),
      'wireEdges must add classify_lead→route even though generate dropped it — otherwise the branch has no feed');
  });

  test('no non-entry node is an orphan; the entry has no inbound edge', async () => {
    const { spec } = await driveRouter();
    const entry = 'classify_lead';                       // fed by the email trigger, not by an edge
    const hasInbound = (id) => spec.edges.some(e => e.to === id);
    for (const n of spec.nodes) {
      if (n.id === entry) assert.equal(hasInbound(n.id), false, 'the entry classifier is fed by the trigger, not an edge');
      else assert.ok(hasInbound(n.id), `${n.id} must have an inbound edge (no orphan)`);
    }
  });

  test('both lanes stay routed, each ending in its own delivery', async () => {
    const { spec } = await driveRouter();
    assert.ok(spec.edges.some(e => e.from === 'route' && e.to === 'summ_hot'),  'lane A routed');
    assert.ok(spec.edges.some(e => e.from === 'route' && e.to === 'summ_cold'), 'lane B routed');
    assert.ok(spec.edges.some(e => e.from === 'summ_hot'  && e.to === 'notify_sales'), 'lane A ends in a delivery');
    assert.ok(spec.edges.some(e => e.from === 'summ_cold' && e.to === 'notify_ops'),   'lane B ends in a delivery');
  });
});
