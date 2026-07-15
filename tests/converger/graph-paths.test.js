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

// ── The propose loop — now the GAP-FIX path, not the main builder ────────────
// After the rearchitecture (Increment 3) `generate` builds the whole spec in one
// pass; `propose` survives only for gap-driven single fixes. So these tests drive it
// through a BLOCKING gap (`blockingGap` — the outcome promises Slack, which `generate`
// deliberately never builds), which is the production route back into `propose`.

describe('a proposal that changes nothing is not a proposal', () => {
  test('the loop does not spin on a re-proposed edge', async () => {
    // applyProposal DEDUPES, so a duplicate edge leaves the draft identical and the
    // model proposes it again — forever. Against the live model this produced
    // FOURTEEN consecutive identical "add this connection" cards. The gap-fix propose
    // path (reached here via the unsatisfied Slack assertion) must still not spin.
    const r = await drive({ proposeSameEdgeForever: true, blockingGap: true });
    const proposals = r.seen.filter(iv => iv.type === 'proposal');
    assert.ok(proposals.length <= 4,
      `the propose loop spun ${proposals.length} times on a proposal that changed nothing`);
    assert.ok(r.spec, 'and it still converges to a spec');
  });

  test('POSITIVE: the generate pass builds the node and names the workflow', async () => {
    // The main build now goes through `generate` (one whole-spec pass), not the propose
    // drip: the write node and the workflow name both come from that single call.
    const r = await drive();
    assert.ok(r.save, 'the node the whole-spec generate pass emitted is in the spec');
    assert.equal(r.spec.name, 'Leads', 'and so is the name it carried');
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
    // `destinationsResolved` is a latch. Without it, a blocking gap that routes back
    // through `propose` re-enters `destinations` and the user is asked "which base?"
    // a second time — and a question asked twice is one people learn to click past.
    const r = await drive({ blockingGap: true });
    assert.equal(r.calls.filter(c => c === 'airtable_list_bases').length, 1,
      `the base was looked up ${r.calls.filter(c => c === 'airtable_list_bases').length} times across the gap round`);
    assert.ok(r.seen.some(iv => iv.type === 'gap_review'), 'precondition: the gap loop actually ran');
  });
});

describe('unparseable model output becomes a QUESTION, not a tight loop', () => {
  test('a proposal with no component asks the user for more detail', async () => {
    // The graph's own note: this "guarantees we always interrupt so the graph never
    // tight-loops through analyze→propose without pausing". Without the interrupt the
    // model's garbage is treated as a proposal and the loop spins with nothing on
    // screen — the user watches a spinner forever, which is the worst failure a
    // conversational builder has: it looks like it is working.
    let asked = null;
    await drive({
      // Reach the gap-fix `propose` path (blockingGap), then feed it garbage.
      blockingGap: true,
      answers: { 'Build the next component': {} },   // the model returns nothing usable
      onInterrupt: (iv) => { if (!asked && iv.type === 'clarification' && /more detail/i.test(iv.question ?? '')) asked = iv; },
    });
    assert.ok(asked, 'unparseable output must reach the user as a question, not spin silently');
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

  test('a MODIFIED proposal is merged, not discarded', async () => {
    // `propose`'s modify path is now the GAP-FIX path: `generate` builds the Airtable
    // write and leaves the promised Slack delivery unbuilt (a BLOCKING gap), so `propose`
    // is asked to add it — and the user MODIFIES that proposal (renames the delivery
    // step). The invariant is unchanged from before the rearchitecture: a user's
    // correction is MERGED, never silently dropped. A dedicated inline harness so the
    // proposed component is a NODE we can rename and the run then converges (the added
    // delivery satisfies the gap). Mutation: discard the modification ⇒ the label stays
    // 'Tell #ops' and the assertion fails.
    const J = (o) => ({ content: JSON.stringify(o) });
    const draftIn = (p) => { const m = /CURRENT DRAFT:\n(\{[\s\S]*?\n\})\n/.exec(p); try { return JSON.parse(m[1]); } catch { return {}; } };
    const invokeCapability = async (id) => {
      if (id === 'airtable_list_bases')    return { bases: [{ id: 'appAAAAAAAAAAAAA1', name: 'Sales CRM' }] };
      if (id === 'airtable_describe_base') return { tables: [{ id: 't1', name: 'Leads', fields: [{ id: 'f1', name: 'Name', type: 'singleLineText', choices: [] }] }] };
      if (id === 'gmail_search')           return { messages: [] };
      throw new Error(`unstubbed: ${id}`);
    };
    const llm = { invoke: async (msgs) => {
      const p = String(msgs[msgs.length - 1].content);
      if (p.includes("USER'S MODIFICATION REQUEST")) return J({ component: 'node', spec: { id: 'notify', type: 'deliver', label: 'RENAMED', config: { channel: 'slack', target: '#ops' } } });
      if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1', statement: 'Leads are saved and #ops is told.',
        assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name'] },
                     { id: 'a2', kind: 'message_sent', target: 'slack:#ops' }] }] });
      if (p.includes('What starts this workflow'))      return J({ trigger: { type: 'email', filter: 'to:leads@acme.com' } });
      if (p.includes('CONCRETE example cases'))         return J({ examples: [] });
      if (p.includes('Analyze this automation intent')) return J({ ready: true });
      if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
      if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
      if (p.includes('REAL columns are'))               return J({ map: { Name: 'Name' } });
      // generate builds the Airtable write ONLY — the Slack delivery stays unbuilt.
      if (p.includes('Build the COMPLETE workflow')) return J({ triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
        nodes: [{ id: 'save', type: 'connector-action', label: 'Save', config: { action: 'airtable_create_record', baseId: 'appPLACEHOLDER', tableId: 'Leads', fields: { Name: 'x' } } }], edges: [] });
      // the gap-fix propose round proposes the missing Slack delivery (which the user then renames)
      if (p.includes('Build the next component')) {
        const d = draftIn(p);
        if (!(d.nodes ?? []).some(n => n.id === 'notify')) return J({ component: 'node', spec: { id: 'notify', type: 'deliver', label: 'Tell #ops', config: { channel: 'slack', target: '#ops' } } });
        if (!(d.edges ?? []).some(e => e.from === 'save' && e.to === 'notify')) return J({ component: 'edge', spec: { from: 'save', to: 'notify' } });
        return J({ component: 'name', spec: 'Leads' });
      }
      return J({});
    } };

    const conv = createConverger({ llm, capabilities: CAPS, invokeCapability, checkpointerDir: scratch() });
    const reply = { outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
                    proposal: (iv) => (iv.proposal?.component === 'node' && iv.proposal?.spec?.id === 'notify'
                      ? { type: 'modify', modification: 'call the delivery step RENAMED' }
                      : { type: 'accept' }),
                    clarification: () => ({ answer: 'yes' }), gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }) };
    let iv;
    try { await conv.run('mod1', 'save leads to airtable and tell ops'); iv = { type: 'done' }; }
    catch (err) { iv = err.interruptValue ?? err; }
    for (let i = 0; i < 60 && iv?.type !== 'done'; i++) iv = await conv.resume('mod1', (reply[iv.type] ?? (() => ({ type: 'accept' })))(iv));

    const notify = iv?.spec?.nodes?.find(n => n.id === 'notify');
    assert.ok(notify, 'the gap-fix proposal added the Slack delivery node');
    assert.equal(notify.label, 'RENAMED',
      'a user who corrects a proposal must get their correction — silently dropping it is worse than not offering it');
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
