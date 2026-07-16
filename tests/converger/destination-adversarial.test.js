/**
 * "THE CONVERGER READS THE DESTINATION" — the adversary's pass on P12 Increment F.
 *
 * F's headline is that a workflow which writes to Airtable can be built **by conversation
 * and clicks alone**: the builder lists the tenant's real bases, reads the real columns,
 * and maps the fields the draft INTENDED onto the columns that ACTUALLY EXIST. The defect
 * it exists to kill is named in its own source:
 *
 *   > **Airtable silently ignores an unknown field name.** Post `{ "Budget": 80000 }` to a
 *   > table whose column is `Deal Size` and the record is created, the column is empty,
 *   > `run_completed` fires, and the workflow reports success forever.
 *   > (src/converger/elicitation-graph.js:143-149)
 *
 * NOTHING TESTED THAT MACHINERY. `write-shaped.test.js` — the increment's flagship —
 * tests `airtableListBases()` / `airtableDescribeBase()` in isolation and then asserts
 * over a HAND-WRITTEN spec in which the destination is *already* resolved and the outcome's
 * assertions *already* name the real columns. It never runs the `destinations` node. And
 * `elicitation-graph.js` is not in the mutation sweep's TARGETS, so nothing generated
 * covers it either: `isResolvedId`, `fillDestination`, `mapFieldsToColumns` and
 * `fetchRealExamples` are the increment by line count, and their mutation score is
 * "not measured".
 *
 * So this suite drives the REAL graph, through the PRODUCTION CALL PATH — `createConverger`
 * → `run()` → `resume()`, exactly as `src/api/builder.js:1163-1250` drives it — with the
 * connector stubbed at `invokeCapability`, the seam `makeCapabilityInvoker` hands it.
 *
 * The stub model is REPLAY-STABLE: it answers from the draft in the prompt, never from a
 * call counter, because `CompiledGraph` re-executes a node's body on resume (an
 * `interrupt()` returns the stored answer on the replay). A counter-driven stub would
 * silently test a different program than the one that runs.
 */

import { test, describe, before, after } from 'node:test';
import assert                            from 'node:assert/strict';
import { mkdtempSync, rmSync }           from 'node:fs';
import { tmpdir }                        from 'node:os';
import { join }                          from 'node:path';

import { createConverger }          from '../../src/converger/index.js';
import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { productionCatalog, productionCapabilities } from '../helpers/prod-catalog.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const catalog   = productionCatalog();
const CAPS      = productionCapabilities(catalog);
const validator = new WorkflowValidator({ nodeTypes, channelRegistry: catalog });

// ── The tenant's REAL Airtable ───────────────────────────────────────────────
// The table says "Deal Size". The workflow wants to write "Budget". THAT MISMATCH IS
// THE POINT, and it is the only reason `mapFieldsToColumns` exists.
const REAL_BASE = 'appAAAAAAAAAAAAA1';
const COLUMNS   = ['Name', 'Deal Size'];

/** The three real emails the picker is supposed to pull. */
const INBOX = [
  { id: 'm1', subject: 'Re: Fwd: pricing for 200 seats', from: 'dana@acme.com',  snippet: 'budget is about 80k' },
  { id: 'm2', subject: 'quick question',                  from: 'bo@tyre.com',    snippet: 'no budget yet' },
  { id: 'm3', subject: 'Intro from Sam',                  from: 'sam@globex.com', snippet: 'we have 30k' },
];

const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-dest-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

/**
 * Drive the whole elicitation loop offline.
 *
 * @param {object} o
 * @param {string} o.baseId       what the MODEL puts in the draft's connector-action
 * @param {object} o.mapping      what the mapping model answers with: { <intended field>: <REAL column> }.
 *                              ({} ⇒ it maps nothing.) The prompt asks for this shape so the
 *                              OUTCOME's promise can be restated in the table's own column names.
 * @param {boolean} o.withInvoker wire the connector at all
 */
async function converge({ baseId = 'appPLACEHOLDER', mapping = { Name: 'Name', Budget: 'Deal Size' }, withInvoker = true } = {}) {
  const calls = [];
  const invokeCapability = async (id, params = {}) => {
    calls.push({ id, params });
    if (id === 'airtable_list_bases')    return { bases: [{ id: REAL_BASE, name: 'Sales CRM' }] };
    if (id === 'airtable_describe_base') return { baseId: params.baseId, tables: [
      { id: 'tblLeads', name: 'Leads', fields: COLUMNS.map((name, i) => ({ id: `f${i}`, name, type: 'singleLineText', choices: [] })) },
    ] };
    if (id === 'gmail_search')           return { messages: INBOX };
    throw new Error(`the converger called a capability nobody stubbed: ${id}`);
  };

  const draftIn = (p) => { const m = /CURRENT DRAFT:\n(\{[\s\S]*?\n\})\n/.exec(p); try { return JSON.parse(m[1]); } catch { return {}; } };
  const J = (o) => ({ content: JSON.stringify(o) });

  const llm = { invoke: async (messages) => {
    const p = String(messages[messages.length - 1].content);

    if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{
      id: 'c1',
      statement: 'Every inbound lead email becomes a Leads record with the budget, and #ops is told.',
      // The model promises what the USER said — "budget". It cannot promise "Deal Size":
      // it has not read the table yet, and nor has the user.
      assertions: [
        { id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name', 'Budget'] },
        { id: 'a2', kind: 'message_sent',  target: 'slack:#ops' },
      ],
    }] });

    if (p.includes('CONCRETE example cases')) return J({ examples: [
      { id: 'e1', label: 'A MODELLED lead (invented by the model)', given: { subject: 'Hi', from: 'x@y.com', body: 'we have budget' } },
    ] });

    if (p.includes('What starts this workflow')) return J({ trigger: { type: 'email', filter: 'to:leads@acme.com' } });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('cases nobody has decided about')) return J({ suggestions: [] });
    if (p.includes("REAL columns are"))               return J({ map: mapping });

    // The whole-spec `generate` pass is now the PRIMARY builder (converger
    // rearchitecture, Increment 3): `analyze` routes the first build here, emitting the
    // complete { triggers, nodes, edges } in one call instead of the one-at-a-time
    // propose drip. It leaves the model's PLACEHOLDER base id and the intended `Budget`
    // field on the write node — the `destinations` tail, which still runs AFTER
    // generate, resolves both against the live connector (base lookup, table, columns).
    if (p.includes('Build the COMPLETE workflow')) {
      return J({
        name: 'Inbound lead triage',
        triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
        nodes: [
          { id: 'extract', type: 'llm', label: 'Extract the lead',
            config: { mode: 'extract', fields: 'name: the sender\nbudget: the stated budget' } },
          { id: 'save', type: 'connector-action', label: 'Save the lead',
            config: { action: 'airtable_create_record', baseId, tableId: 'Leads',
                      fields: { Name: '{{extract.output}}', Budget: '{{extract.output}}' } },
            idempotency: { key: '{{extract.output}}', on_conflict: 'skip' } },
          { id: 'notify', type: 'deliver', label: 'Tell #ops',
            config: { channel: 'slack', target: '#ops' } },
        ],
        edges: [{ from: 'extract', to: 'save' }, { from: 'save', to: 'notify' }],
      });
    }

    if (p.includes('Build the next component')) {
      const d       = draftIn(p);
      const has     = (id) => (d.nodes ?? []).some(n => n.id === id);
      const hasEdge = (f, t) => (d.edges ?? []).some(e => e.from === f && e.to === t);
      const deliver = (d.nodes ?? []).find(n => n.type === 'deliver');
      if (!(d.triggers ?? []).length) return J({ component: 'trigger', spec: { type: 'email', filter: 'to:leads@acme.com' } });
      if (!has('extract'))            return J({ component: 'node', spec: { id: 'extract', type: 'llm', label: 'Extract the lead',
        config: { mode: 'extract', fields: 'name: the sender\nbudget: the stated budget' } } });
      if (!has('save'))               return J({ component: 'node', spec: { id: 'save', type: 'connector-action', label: 'Save the lead',
        config: { action: 'airtable_create_record', baseId, tableId: 'Leads',
                  fields: { Name: '{{extract.output}}', Budget: '{{extract.output}}' } },
        idempotency: { key: '{{extract.output}}', on_conflict: 'skip' } } });
      if (!hasEdge('extract', 'save'))               return J({ component: 'edge', spec: { from: 'extract', to: 'save' } });
      if (deliver && !hasEdge('save', deliver.id))   return J({ component: 'edge', spec: { from: 'save', to: deliver.id } });
      return J({ component: 'name', spec: 'Inbound lead triage' });
    }
    return J({});
  } };

  const conv = createConverger({
    llm, capabilities: CAPS, checkpointerDir: scratch(),
    invokeCapability: withInvoker ? invokeCapability : null,
  });

  const seen = {};
  let iv;
  try { await conv.run('t1', 'when a lead emails us, save it to Airtable and tell #ops'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }

  const reply = {
    outcome_check:   () => ({ id: 'c1' }),
    example_request: () => ({ type: 'skip' }),
    proposal:        () => ({ type: 'accept' }),
    clarification:   () => ({ answer: 'Sales CRM, the Leads table' }),
    gap_review:      () => ({ acceptDefaults: true }),
    ratify:          () => ({ type: 'approve' }),
  };
  for (let i = 0; i < 60 && iv?.type !== 'done'; i++) {
    seen[iv.type] = iv;
    iv = await conv.resume('t1', (reply[iv.type] ?? (() => ({ type: 'accept' })))(iv));
  }
  assert.equal(iv?.type, 'done', 'the harness must reach a finished spec, or it is testing nothing');

  const spec = iv.spec;
  return {
    spec, seen,
    calls:  calls.map(c => c.id),
    save:   spec?.nodes?.find(n => n.config?.action === 'airtable_create_record'),
    ratify: seen.ratify,
  };
}

// ── 1. The machinery: it really does read the destination ────────────────────

describe('the destination is READ from the connector, not asked for', () => {
  let r;
  before(async () => { r = await converge(); });

  test('the connector is actually called — bases, then that base\'s columns', () => {
    assert.deepEqual(r.calls.filter(c => c.startsWith('airtable_')), ['airtable_list_bases', 'airtable_describe_base'],
      'no call means the base id in the spec came from the model, which cannot know it');
    // …and the picker really does read the inbox now. It never did: `examples` ran
    // before anything put a trigger in the draft, so it had no query and fell back to
    // modelled cases in EVERY session. (That is why this list did not contain it.)
    assert.ok(r.calls.includes('gmail_search'),
      'the example picker must actually search the user\'s mail — it is half the increment');
  });

  test('the model\'s placeholder base id is REPLACED by the tenant\'s real one', () => {
    assert.equal(r.save.config.baseId, REAL_BASE);
  });

  test('and the promised field lands on the column that EXISTS', () => {
    // The whole increment, in one assertion. "Budget" is not a column; "Deal Size" is.
    assert.ok('Deal Size' in r.save.config.fields,
      'the record must use the column the table actually has');
    assert.equal('Budget' in r.save.config.fields, false,
      'Airtable would ACCEPT "Budget" and silently ignore it — record created, column empty, run_completed');
  });
});

// ── 2. …and then the spec cannot be saved ────────────────────────────────────

describe('complete ⇒ publishable, ACROSS the destination resolution', () => {
  test('the spec the converger ratifies PUBLISHES', async () => {
    // `mapFieldsToColumns` rewrites the NODE (elicitation-graph.js:775-777 —
    // `fillDestination(nodes, …)`); NOTHING rewrites the OUTCOME, which was frozen at the
    // `outcome` node (:385-389) — the graph's ENTRY point, three phases before any schema
    // was read. So the contract still promises "Budget" while the step now writes
    // "Deal Size", and `UNSATISFIED_ASSERTION` fires ON THE SUCCESS PATH: the mapping did
    // exactly what it was built to do, and the result is a workflow the save button
    // refuses.
    //
    // This is the Increment C blocker verbatim — "the builder says done and the save
    // button says no" — reintroduced by the increment's own headline feature. And it does
    // not self-heal: the gap review offers no answer to a blocking gap (see
    // `the gap review can even ASK about it` below), so the loop hands the user a spec it
    // has already marked `publishable: false`.
    const r = await converge();

    assert.equal(r.ratify?.publishable, true,
      `the converger knows: blockers = ${JSON.stringify((r.ratify?.blockers ?? []).map(b => b.code ?? b))}`);

    const res = validator.validate(r.spec);
    assert.equal(res.ok, true,
      `a ratified spec must publish; got: ${res.errors.map(e => `${e.code}(${e.message})`).join(' | ')}`);
  });

  test('a promise the resolution RENAMED is renamed in the contract too', async () => {
    // The narrow statement of the same fact, independent of the loop: after the
    // destination is resolved, the outcome must promise the columns the workflow will
    // actually write. Either the assertion is remapped with the node, or the contract is
    // a lie about the workflow directly beneath it.
    const r = await converge();
    const a1 = r.spec.outcome.assertions.find(a => a.kind === 'record_exists');
    assert.deepEqual([...a1.fields].sort(), ['Deal Size', 'Name'],
      'the contract still promises a column that does not exist, so nothing can ever satisfy it');
  });
});

// ── 3. isResolvedId — one fake id and the whole defence is skipped ───────────

describe('a base id the connector never listed cannot survive into the spec', () => {
  test('a model-invented id that LOOKS real skips the resolution entirely', async () => {
    // `isResolvedId` (elicitation-graph.js:83-88) accepts anything matching
    // `/^app[A-Za-z0-9]{14}$/` that is not `appXXXXXX…`. An LLM asked for a base id it
    // cannot know does not only produce `appXXXXXXXXXXXXXX` — it produces a
    // PLAUSIBLE one. `appABCDEFGHIJKLMN` passes.
    //
    // And `needsBase` (:704) gates the ENTIRE `destinations` node on that test — so one
    // plausible hallucination skips the base lookup, the table lookup, AND
    // `mapFieldsToColumns`. The spec then publishes with a base that does not exist and
    // columns the table does not have: the silent drop this increment exists to kill,
    // through the door it added.
    //
    // The invariant is not "the regex is stricter". It is: **a base id in a ratified spec
    // is one the connector listed.** That is decidable, we hold the token, and we called
    // the API two lines earlier.
    const r = await converge({ baseId: 'appABCDEFGHIJKLMN' });

    assert.equal(r.save.config.baseId, REAL_BASE,
      `the ratified spec carries "${r.save.config.baseId}", which the tenant's Airtable does not contain ` +
      `(calls made: ${JSON.stringify(r.calls)})`);
    assert.deepEqual(Object.keys(r.save.config.fields).filter(k => !COLUMNS.includes(k)), [],
      'and its columns were never checked against the table, so the write is silently dropped');
  });

  test('POSITIVE: a base id the connector DID list is left alone', async () => {
    const r = await converge({ baseId: REAL_BASE });
    assert.equal(r.save.config.baseId, REAL_BASE);
  });
});

// ── 4. The mapping's own failure mode: no overlap at all ─────────────────────

describe('an unmappable field is never left in place', () => {
  test('when NOTHING maps, the hallucinated columns must not survive', async () => {
    // `mapFieldsToColumns` returns `null` when the safe (real-column) set is empty
    // (elicitation-graph.js:195), and `fillDestination` only rewrites `fields` when the
    // mapping is non-null (:98). So the worst case — the model's intended names overlap
    // the real columns NOT AT ALL — is precisely the case where every hallucinated column
    // is preserved verbatim, and the record is created with every column empty.
    //
    // The failure is inverted: a PARTIAL mismatch is fixed, and a TOTAL mismatch is
    // shipped. `mapFieldsToColumns`'s own docblock promises the opposite ("A column the
    // draft wants and the table does NOT have is left OUT rather than guessed at").
    const r = await converge({ mapping: {} });                 // the model maps nothing

    const bogus = Object.keys(r.save?.config?.fields ?? {}).filter(k => !COLUMNS.includes(k));
    assert.deepEqual(bogus, [],
      `the spec writes ${JSON.stringify(bogus)} into a table whose columns are ${JSON.stringify(COLUMNS)} — ` +
      'Airtable creates the record, leaves them empty, and reports success');
  });

  test('POSITIVE: a column the MAPPING model invents is dropped', async () => {
    // The `real` Set filter (elicitation-graph.js:192-194) — the guard that stops the
    // mapping step from hallucinating a column of its own. Nothing executed it before.
    const r = await converge({ mapping: { Name: 'Name', Budget: 'Deal Size', Notes: 'Nonexistent Column' } });
    assert.deepEqual(Object.keys(r.save.config.fields).sort(), ['Deal Size', 'Name'],
      'the mapper trusts nothing it is told: a name that is not on the table is dropped');
  });
});

// ── 5. No connector ⇒ we ASK. We never GUESS. ────────────────────────────────

describe('without a live connector the graph degrades to asking, never to guessing', () => {
  test('nothing is invented, and no capability is called', async () => {
    const r = await converge({ withInvoker: false });
    assert.deepEqual(r.calls, []);
    assert.equal(r.save.config.baseId, 'appPLACEHOLDER',
      'the graph must not fabricate a base id when it cannot read one (elicitation-graph.js:694-698)');
  });
});

// ── 6. The example picker: `source: 'gmail'` is a PROVENANCE CLAIM ───────────

describe('the example picker shows the user their OWN mail, or says it did not', () => {
  test('an email-triggered workflow pulls real examples from the inbox', async () => {
    // §6.4, "the biggest single unlock": three REAL emails, picked with a click.
    //
    // `examples` is the SECOND node the graph runs — `outcome → examples → process →
    // analyze → propose` (elicitation-graph.js:1074-1083). `propose` is the only node that
    // ever puts a trigger in the draft. So when `fetchRealExamples` asks
    // `state.draft?.triggers` for an email trigger (:417, :176) the draft is still
    // `DRAFT_DEFAULT` and `triggers` is `[]` — ALWAYS. `gmail_search` is never called, the
    // fallback fires on every single session, and the user is shown examples the model
    // invented.
    //
    // The feature is not merely untested; it is unreachable.
    const r = await converge();

    assert.ok(r.calls.includes('gmail_search'),
      `the picker never asked Gmail for anything (calls: ${JSON.stringify(r.calls)})`);
    assert.equal(r.seen.example_request?.source, 'gmail',
      '`source` is a provenance claim: it says these came from the user\'s inbox');
    assert.equal(r.seen.example_request?.query, 'to:leads@acme.com',
      "…and the trigger's own filter is the query, so an example that could not fire the workflow cannot appear");
  });

  test('POSITIVE: a MODELLED example is never dressed up as a real one', async () => {
    // The half that already holds, and must keep holding: when there is no live source,
    // the fallback examples carry `source: null`. Inventing a plausible "real" email would
    // be worse than proposing an obviously-modelled one, because the user would believe it.
    const r = await converge({ withInvoker: false });
    assert.equal(r.seen.example_request?.source, null);
  });
});

// ── 7. The gap review cannot even ASK about any of this ──────────────────────

describe('a blocking gap arrives at the user with an answer in the box', () => {
  test('the model CAN key its suggestion to the gap it is answering', async () => {
    // `buildGapPrompt` (prompts.js:664-679) lists the gaps as `1.`, `2.`, … and then asks
    // for `{"suggestions":[{"gapId":"<id>","answer":"…"}]}`. **It never shows the ids.**
    // The lookup (elicitation-graph.js:905-906) matches `s.gapId === g.id`, where `g.id` is
    // `gap_unsatisfied_assertion_save_3` — a string the model has never seen and cannot
    // produce.
    //
    // So `suggestedAnswer` is null for EVERY gap, in every session. The review the whole
    // design rests on ("A gap list with empty boxes is an interrogation; a gap list with
    // defaults is a review. The difference is the whole product." — elicitation-graph.js:898)
    // ships with empty boxes, the paid model call is thrown away, and — because
    // `clarifications` then stays empty (:954) — **"Accept all defaults" on a BLOCKING gap
    // sends nothing back through the propose loop.** The blocker that §2 above produces can
    // therefore never be repaired: it goes straight to ratify.
    //
    // The stub answers by INDEX, because an index is the only handle the prompt gives it.
    const calls = [];
    const invokeCapability = async (id, params = {}) => {
      calls.push(id);
      if (id === 'airtable_list_bases')    return { bases: [{ id: REAL_BASE, name: 'Sales CRM' }] };
      if (id === 'airtable_describe_base') return { baseId: params.baseId, tables: [{ id: 'tblLeads', name: 'Leads', fields: COLUMNS.map((name, i) => ({ id: `f${i}`, name, type: 'singleLineText', choices: [] })) }] };
      if (id === 'gmail_search')           return { messages: INBOX };
      throw new Error(`unstubbed: ${id}`);
    };
    const J = (o) => ({ content: JSON.stringify(o) });
    const draftIn = (p) => { const m = /CURRENT DRAFT:\n(\{[\s\S]*?\n\})\n/.exec(p); try { return JSON.parse(m[1]); } catch { return {}; } };

    const llm = { invoke: async (messages) => {
      const p = String(messages[messages.length - 1].content);
      if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1', statement: 'Leads are saved.',
        assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name', 'Budget'] },
                     { id: 'a2', kind: 'message_sent', target: 'slack:#ops' }] }] });
      if (p.includes('CONCRETE example cases')) return J({ examples: [] });
      if (p.includes('What starts this workflow')) return J({ trigger: { type: 'email', filter: 'to:leads@acme.com' } });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
      if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
      if (p.includes("REAL columns are"))               return J({ map: { Name: 'Name', Budget: 'Deal Size' } });
      if (p.includes('cases nobody has decided about')) {
        // The prompt now GIVES the model each gap's id, so the model can key its
        // answer to the gap it is answering — which is the whole point of the test
        // below. Before, the ids were never shown and no suggestion could be matched.
        const ids = [...p.matchAll(/^ {2}- id: (\S+)$/gm)].map(m => m[1]);
        return J({ suggestions: ids.map(id => ({ gapId: id, answer: 'Set it on that step' })) });
      }
      // The whole-spec `generate` pass builds extract + the Airtable write and
      // DELIBERATELY omits the Slack delivery the outcome promises — leaving a BLOCKING
      // UNSATISFIED_ASSERTION, exactly what this scenario needs to test that a blocking
      // gap reaches the user with an answer already in the box.
      if (p.includes('Build the COMPLETE workflow')) {
        return J({
          triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
          nodes: [
            { id: 'extract', type: 'llm', label: 'E', config: { mode: 'extract', fields: 'budget: the budget' } },
            { id: 'save', type: 'connector-action', label: 'Save',
              config: { action: 'airtable_create_record', baseId: 'appPLACEHOLDER', tableId: 'Leads', fields: { Name: '{{extract.output}}', Budget: '{{extract.output}}' } },
              idempotency: { key: '{{extract.output}}', on_conflict: 'skip' } },
          ],
          edges: [{ from: 'extract', to: 'save' }],
        });
      }
      // `propose` survives for gap-driven single fixes. Here it has nothing left to add
      // (generate already built extract + save), so it just names the workflow.
      if (p.includes('Build the next component')) {
        return J({ component: 'name', spec: 'Leads' });
      }
      return J({});
    } };

    const conv = createConverger({ llm, capabilities: CAPS, checkpointerDir: scratch(), invokeCapability });
    let iv;
    try { await conv.run('t2', 'save leads to airtable'); iv = { type: 'done' }; }
    catch (err) { iv = err.interruptValue ?? err; }

    let review = null;
    const reply = { outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
                    proposal: () => ({ type: 'accept' }), clarification: () => ({ answer: 'yes' }),
                    gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }) };
    for (let i = 0; i < 60 && iv?.type !== 'done'; i++) {
      if (iv.type === 'gap_review' && !review) review = iv;
      iv = await conv.resume('t2', (reply[iv.type] ?? (() => ({ type: 'accept' })))(iv));
    }

    assert.ok(review, 'precondition: the draft has at least one gap to review');
    const blocking = review.gaps.filter(g => g.blocking);
    assert.ok(blocking.length, 'precondition: at least one BLOCKING gap');
    assert.notEqual(blocking[0].suggestedAnswer, null,
      `every blocking gap arrived with an empty box: ${JSON.stringify(review.gaps.map(g => [g.code, g.suggestedAnswer]))}`);
  });
});
