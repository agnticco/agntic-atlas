/**
 * NO WORD IS SHOWN AS THE CUSTOMER'S UNLESS IT APPEARS IN WHAT THEY ACTUALLY TYPED.
 *
 * Before Atlas builds, it shows a plan card. Each line carries a mark — **you said** /
 * **I found** / **I inferred** — and that mark is the whole mechanism by which a
 * non-technical person knows which lines to check.
 *
 * QA, three builds, 2026-07-27. All three failed the same way:
 *   · "Runs every morning at 8:00 AM local time" — YOU SAID. The tester said "every
 *     morning" and never named a time; 8:00 AM was Atlas's own suggestion.
 *   · "non-urgent emails … the workflow ends silently" — YOU SAID. Never mentioned,
 *     sitting directly beside a correctly amber line for equally unstated content.
 *   · the trigger's "unread" and "Gmail" specifics — YOU SAID. Neither was typed.
 *
 * WHY THE EXISTING GUARD DOES NOT CATCH IT. `plan-provenance.js` closes the SET of
 * allowed labels, so an unrecognised value falls to the weaker mark — and that is why
 * the `#ops` case stopped recurring. But it validates the label's VOCABULARY, not its
 * TRUTH: a well-formed `"stated"` attached to invented content passes by construction.
 * The model becomes the laundering hop, which is the shape CLAUDE.md warns about —
 * a check scoped to WHO PRODUCED the value rather than WHAT THE VALUE CAN BE.
 *
 * THE INVARIANT PINNED HERE. No span of text is displayed as the customer's own words
 * unless those words appear in what the customer actually typed. **When in doubt it
 * fails toward the WEAKER claim.** A false amber is safe; a false "you said" is the bug.
 *
 * THE THREE HALVES EXERCISED:
 *
 *   · THE MATCHER — `src/converger/said-words.js`, pure and importable. Both jobs come
 *     out of one match: which spans are theirs (the highlighting), and whether the
 *     line's claim is supportable at all (the demotion).
 *
 *   · THE SERVER, THROUGH THE REAL GRAPH — `createConverger` → run → resume, driven the
 *     way `builder.js` drives it, including the typed turns the browser now sends. The
 *     plan the CLIENT receives is already checked, so a renderer that never ran this
 *     cannot be handed an unverified strong claim. This is also where the corpus trap
 *     is pinned: `clarifications[]` is partly MACHINE-authored (the `gaps` node pushes
 *     the model's own suggested answers), and a claim matching only that must not be
 *     certified.
 *
 *   · THE BROWSER — `public/index.html` has no module boundary, so these tests SLICE
 *     the real shipped source of the span helpers out of the file and EXECUTE it,
 *     asserting the spans and colours a person actually sees. Fail-loud: a rename fails
 *     the test rather than quietly proving nothing.
 */

import { test, describe, after, before } from 'node:test';
import assert                    from 'node:assert/strict';
import express                   from 'express';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir }                from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath }         from 'node:url';

import { createConverger }    from '../../src/converger/index.js';
import { mountBuilderRoutes } from '../../src/api/builder.js';
import { realCatalog }        from '../helpers/catalog.js';
import {
  buildSaidCorpus, markSaidSpans, markPlanSaidWords, normalizeToken, saidCorpusFrom,
} from '../../src/converger/said-words.js';

// ── helpers ────────────────────────────────────────────────────────────────────

/** The text a reader would see highlighted as their own words, in order. */
const saidText = (spans) => spans.filter(s => s.said).map(s => s.text).join('|');
/** Everything the spans put on screen, concatenated. */
const allText  = (spans) => spans.map(s => s.text).join('');

// ── THE MATCHER ────────────────────────────────────────────────────────────────

describe('the matcher: what the customer typed, and only that, is marked as theirs', () => {
  test('THE MIXED LINE — the words they said are marked; the time Atlas chose is not', () => {
    const corpus = buildSaidCorpus(['send me a digest every morning']);
    const r = markSaidSpans('Runs every morning at 8:00 AM local time', corpus);

    assert.equal(allText(r.spans), 'Runs every morning at 8:00 AM local time',
      'the spans must reconstruct the line exactly — a renderer that drops or invents a word is worse than no marking');
    assert.equal(saidText(r.spans), 'every morning',
      `the tester said "every morning" and nothing about a time — got ${JSON.stringify(saidText(r.spans))}`);
    assert.equal(r.allSaid, false,
      'a line carrying a time nobody named is not the customer\'s words, so its badge cannot claim to be');
    for (const s of r.spans) {
      if (!s.said) continue;
      assert.doesNotMatch(s.text, /8:00|AM|local/i,
        'the invented time was highlighted as something the customer typed');
    }
  });

  test('THE INVENTED LINE — content that appears nowhere is marked as theirs nowhere', () => {
    const corpus = buildSaidCorpus(['summarize my shipping emails and post them to slack']);
    const r = markSaidSpans('For non-urgent items the workflow ends silently', corpus);

    assert.equal(saidText(r.spans), '',
      'nothing on this line was typed by the customer, so nothing may be shown as theirs');
    assert.equal(r.allSaid, false);
    assert.equal(r.saidWords, 0);
  });

  test('THE HONEST LINE — a line they genuinely typed still reads as theirs', () => {
    const corpus = buildSaidCorpus(['summarize my shipping emails and post them to Slack']);
    const r = markSaidSpans('Summarize the shipping emails', corpus);

    assert.equal(r.allSaid, true,
      'the check must not demote everything — a screen that always warns is a screen nobody reads');
    assert.equal(saidText(r.spans), 'Summarize the shipping emails',
      'the whole line is theirs, so the whole line highlights as one phrase, not word-by-word flicker');
  });

  test('EMPTY CORPUS — nothing can be certified as the customer\'s', () => {
    for (const empty of [[], undefined, null, [''], ['   ']]) {
      const r = markSaidSpans('Summarize the shipping emails', buildSaidCorpus(empty));
      assert.equal(saidText(r.spans), '',
        `with no record of what was typed (${JSON.stringify(empty)}) nothing may be claimed as theirs`);
      assert.equal(r.allSaid, false, 'an empty corpus must not mean "everything passes"');
    }
  });

  test('STOPWORDS NEVER CERTIFY — a corpus of glue words proves nothing', () => {
    // Every corpus in the world contains "the", "and", "to". If those could certify a
    // span, half of every line would render as the customer's words on no evidence.
    const corpus = buildSaidCorpus(['the and to of it is a for with on']);
    const r = markSaidSpans('The report is sent to the practice manager', corpus);

    assert.equal(saidText(r.spans), '',
      'stopwords present in the corpus certified a span — this is the vacuous match');
    assert.equal(r.allSaid, false);
  });

  test('a line made ONLY of glue words certifies nothing — "all matched" over zero words is an empty set', () => {
    const corpus = buildSaidCorpus(['the and to of it is']);
    const r = markSaidSpans('and then it is', corpus);
    assert.equal(r.contentWords, 0);
    assert.equal(r.allSaid, false,
      'certifying the absence of evidence: a line with no checkable words has proved nothing');
  });

  test('a plain plural still counts as the same word, and nothing more aggressive does', () => {
    const corpus = buildSaidCorpus(['file the invoice and check my email']);
    assert.equal(markSaidSpans('File the invoices', corpus).allSaid, true,
      '"invoices" against a typed "invoice" is the same word — refusing it would demote every honest line');
    assert.equal(saidText(markSaidSpans('Emailing the customer', corpus).spans), '',
      'stemming past plurals ADDS matches, and every added match is a stronger claim about a person');
    assert.equal(saidText(markSaidSpans('Filed under invoices', corpus).spans), 'invoices',
      '"filed" is not "file" — an -ed fold is not allowed');
  });

  test('punctuation, case and possessives do not change whose words they are', () => {
    const corpus = buildSaidCorpus(["post it to #ops, and cc charles@agntic.co — the Manager's copy"]);
    assert.equal(normalizeToken('#ops,'), '#ops');
    assert.equal(normalizeToken("Manager's"), 'manager');
    assert.equal(saidText(markSaidSpans('Posts to #ops.', corpus).spans), 'Posts to #ops',
      'the trailing full stop is not the customer\'s — the highlight stops at the word');
    assert.equal(saidText(markSaidSpans('Sends it to charles@agntic.co', corpus).spans), 'charles@agntic.co',
      'an address is ONE word a person typed, not three — and the words around it that they did NOT type stay unmarked');
  });
});

// ── THE PLAN, AND THE DEMOTION ─────────────────────────────────────────────────

describe('a plan claim survives only when the words behind it were typed', () => {
  const TYPED = ['summarize my shipping emails every morning and post them to Slack'];

  test('a "you said" over content nobody said is demoted; the words they DID say stay marked', () => {
    const p = markPlanSaidWords({
      trigger: { text: 'Runs every morning at 8:00 AM local time', confidence: 'stated' },
      steps: [
        { text: 'Summarize the shipping emails',                       confidence: 'stated' },
        { text: 'For non-urgent items the workflow ends silently',     confidence: 'stated' },
      ],
      branches: [{ when: 'it is urgent', then: 'page the on-call engineer', confidence: 'stated' }],
      error_handling: { text: 'Retry once, then flag it', confidence: 'stated' },
    }, TYPED);

    assert.equal(p.trigger.confidence, 'inferred',
      'the time was Atlas\'s own suggestion — the line may not be shown under the customer\'s name');
    assert.equal(saidText(p.trigger.spans), 'every morning',
      'the half they DID say must stay marked as theirs — that is what makes the amber readable');

    assert.equal(p.steps[0].confidence, 'stated', 'a line they genuinely typed keeps its mark');
    assert.equal(p.steps[1].confidence, 'inferred',
      'a whole sentence nobody said was shown as the customer\'s words — the reported bug');
    assert.equal(saidText(p.steps[1].spans), '',
      'and it carries NO "you said" marking anywhere on it');

    assert.equal(p.branches[0].confidence, 'inferred');
    assert.ok(Array.isArray(p.branches[0].whenSpans) && Array.isArray(p.branches[0].thenSpans),
      'a branch is two pieces of prose and each is marked on its own');
    assert.equal(p.error_handling.confidence, 'inferred');
    assert.equal(p.saidWordsChecked, true, 'the plan records that the check actually ran');
  });

  test('THE CHECK ONLY EVER DEMOTES — a tool-grounded line keeps its mark, an inferred one is never raised', () => {
    const p = markPlanSaidWords({
      steps: [
        { text: 'Posts to the existing #ops channel', confidence: 'found' },
        // Every word of this WAS typed, and it is still not promoted.
        { text: 'summarize my shipping emails',       confidence: 'inferred' },
      ],
    }, TYPED);
    assert.equal(p.steps[0].confidence, 'found',
      '"I found" is a claim about a live tool, not about the person — this check has no evidence about tools');
    assert.equal(p.steps[1].confidence, 'inferred',
      'matching well must never manufacture a claim about the user that the plan did not make');
  });

  test('with no record of what was typed, no line is shown as the customer\'s', () => {
    const p = markPlanSaidWords({
      trigger: { text: 'Runs every morning', confidence: 'stated' },
      steps: [{ text: 'Summarize the shipping emails', confidence: 'stated' }],
    }, []);
    assert.equal(p.trigger.confidence, 'inferred');
    assert.equal(p.steps[0].confidence, 'inferred');
    assert.equal(saidText(p.steps[0].spans), '');
  });
});

// ── THE SERVER, THROUGH THE REAL GRAPH ─────────────────────────────────────────
//
// Same harness as plan-gate.test.js / plan-provenance.test.js: `createConverger` →
// run → resume with a stub model, plus the typed turns the browser now posts. A check
// must construct its subject the way production does.

const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-saidwords-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

const J = (o) => ({ content: JSON.stringify(o) });

const CAPS = () => ({
  channels: realCatalog().getAll().map(c => ({ ...c, available: true })),
  connectors: { slack: { connected: true }, airtable: { connected: false } },
  slackChannels: ['ops', 'general'],
});

function makeLLM(plan) {
  return { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1',
      statement: 'Every incoming email is summarized into the Atlas inbox.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Email Summary' }] }] });
    if (p.includes('What starts this workflow')) return J({ trigger: { type: 'email', filter: 'is:unread' } });
    if (p.includes('CONCRETE example cases'))    return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('write the PLAN the user will approve')) return J(plan);
    if (p.includes('cases nobody has decided about')) {
      const ids = [...p.matchAll(/^ {2}- id: (\S+)$/gm)].map(m => m[1]);
      return J({ suggestions: ids.map(id => ({ gapId: id, answer: 'retry then tell a person' })) });
    }
    if (p.includes('Build the COMPLETE workflow')) {
      return J({ name: 'Email digest', triggers: [{ type: 'email', filter: 'is:unread' }],
        nodes: [
          { id: 'sum',  type: 'llm',     label: 'Summarize', config: { mode: 'summarize', instructions: 'Summarize the email.' } },
          { id: 'post', type: 'deliver', label: 'Save',      config: { channel: 'inbox_deliver' } },
        ],
        edges: [{ from: 'sum', to: 'post' }] });
    }
    return J({});
  } };
}

/** Drive the loop until the plan card is raised; hand back the interrupt the CLIENT gets. */
async function planInterrupt(plan, { typedTurns, intent = 'summarize my emails to my inbox' } = {}) {
  const conv = createConverger({ llm: makeLLM(plan), capabilities: CAPS(), invokeCapability: null, checkpointerDir: scratch() });
  const thread = `t${Math.random().toString(36).slice(2)}`;
  const replyFor = (iv) => (iv.type === 'outcome_check' ? { id: 'c1' } : { type: 'accept' });

  let iv;
  try { await conv.run(thread, intent, { typedTurns }); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 60 && iv?.type !== 'done'; i++) {
    if (iv?.type === 'plan_review') return iv;
    iv = await conv.resume(thread, replyFor(iv));
  }
  assert.fail('no plan_review interrupt was raised — the harness, not the guard, is broken');
}

const QA_PLAN = {
  summary: 'Summarize each incoming email into your Atlas inbox',
  trigger: { text: 'Runs every morning at 8:00 AM local time', confidence: 'stated' },
  steps: [
    { text: 'Summarize the shipping emails',                   confidence: 'stated' },
    { text: 'For non-urgent items the workflow ends silently', confidence: 'stated' },
  ],
  branches: [], error_handling: { text: 'Retry once', confidence: 'stated' },
  knowledge: [], upload_suggestion: null,
};

describe('the plan that LEAVES the server has already been checked against what was typed', () => {
  test('the three lines QA reported arrive marked honestly, word by word', async () => {
    const iv = await planInterrupt(QA_PLAN, {
      typedTurns: ['summarize my shipping emails every morning'],
    });

    assert.equal(iv.plan.saidWordsChecked, true,
      'the client must be able to tell the check ran — an unchecked plan is not a trusted one');
    assert.equal(iv.plan.trigger.confidence, 'inferred',
      '"at 8:00 AM local time" was never typed, so the trigger line may not be shown as the customer\'s');
    assert.equal(saidText(iv.plan.trigger.spans), 'every morning',
      'the words they DID type still read as theirs');
    assert.equal(iv.plan.steps[0].confidence, 'stated',
      'the honest line survives — the check must not demote everything');
    assert.equal(iv.plan.steps[1].confidence, 'inferred');
    assert.equal(saidText(iv.plan.steps[1].spans), '',
      'a sentence nobody said carries no "you said" marking anywhere on it');
    assert.equal(iv.plan.error_handling.confidence, 'inferred');
  });

  test('a turn that is not TEXT is dropped, never coerced — "[object Object]" is not speech', async () => {
    // Found by mutation: replacing the shape filter with `String(t)` was invisible.
    // `String({})` is `"[object Object]"`, whose content words are real words — so a
    // plan line about an "object" would be certified against a value nobody typed.
    // The corpus decides whether Atlas may claim words as the customer's, so anything
    // that is not text is absent, not stringified.
    const iv = await planInterrupt({
      ...QA_PLAN,
      steps: [{ text: 'Marks each object as done', confidence: 'stated' }],
    }, { typedTurns: [{}, ['object'], 42, null, undefined, { text: 'object' }] });

    assert.equal(saidText(iv.plan.steps[0].spans), '',
      'a value that is not text was turned into words and then credited to the customer');
    assert.equal(iv.plan.steps[0].confidence, 'inferred');
  });

  test('a build started WITHOUT the typed turns certifies nothing (the intent is not a substitute)', async () => {
    // `intent` is written by a MODEL — the chat prompt asks it to fold the whole
    // conversation into one paragraph — so checking the model's plan against it would
    // be a second laundering hop. An omitted corpus must fail closed, not fall back.
    const iv = await planInterrupt(QA_PLAN, {
      typedTurns: undefined,
      intent: 'Summarize the shipping emails every morning and put them in the inbox',
    });
    assert.equal(iv.plan.steps[0].confidence, 'inferred',
      'the intent paragraph matches the line word for word and STILL must not certify it');
    assert.equal(saidText(iv.plan.steps[0].spans), '');
  });
});

// ── THE CORPUS IS GENUINE ──────────────────────────────────────────────────────
//
// A NOTE ON WHY THIS IS NOT DRIVEN THROUGH THE GRAPH, written after the first attempt
// FAILED TO CATCH THE MUTATION IT EXISTED FOR. Admitting `state.clarifications` into
// the corpus inside the `plan` node changed NOTHING in a graph-driven test, because
// the plan gate fires BEFORE the elicitation that fills that array — so it was empty,
// and a fixture that cannot tell the two versions apart pins nothing. The mutation
// survived, and the fixture was strengthened rather than the mutation dropped.
//
// So the rule is pinned where production makes the decision: `saidCorpusFrom`, the
// function the `plan` node actually calls, handed a state shaped exactly the way the
// graph shapes one — including the entries the graph writes with its OWN output. That
// is a real behavioural check on the real code path. Stated honestly: it does NOT
// prove the graph is empty of some other route into the corpus; it proves that the one
// function deciding the corpus admits `humanTurns` and nothing else.

describe('the corpus is genuine — only a human\'s keystrokes may prove a claim about them', () => {
  /** A converger state at the plan node, with the entries the graph writes itself. */
  const stateAtPlan = () => ({
    intent: 'Summarize the shipping emails every morning and put them in the inbox',
    humanTurns: ['put a digest in my inbox'],
    clarifications: [
      // The `gaps` node: the MODEL's own suggested answer to its own question.
      { q: 'What should happen if a step fails?', a: 'retry once then tell a person' },
      // `resourceSetup`: a JSON-stringified result of an action Atlas took.
      { q: '(setup: google_drive_create_folder)', a: '{"folderId":"abc","name":"Shipping digests"}' },
      // The sufficiency route: Atlas's own note about what it could not settle.
      { q: '(still missing)', a: 'the workflow ends silently for non-urgent items' },
    ],
    draft: { outcome: { statement: 'Every incoming email is summarized.' } },
  });

  test('Atlas\'s own suggested wording does not become the customer\'s words', () => {
    const corpus = buildSaidCorpus(saidCorpusFrom(stateAtPlan()));
    for (const line of [
      'Retry once then tell a person',
      'Creates a folder called Shipping',
      'For non-urgent items the workflow ends silently',
    ]) {
      const r = markSaidSpans(line, corpus);
      assert.equal(saidText(r.spans), '',
        `"${line}" was certified against ATLAS'S OWN text — that is the laundering hop, one level down`);
      assert.equal(r.allSaid, false);
    }
  });

  test('the words the customer DID type still certify — the corpus is not merely empty', () => {
    const corpus = buildSaidCorpus(saidCorpusFrom(stateAtPlan()));
    assert.equal(markSaidSpans('Puts a digest in my inbox', corpus).allSaid, true,
      'the check must still work: this is the one line the customer actually typed');
  });

  test('the model-written intent paragraph is not the customer speaking either', () => {
    // `intent` is `build_intent`, written by the chat model. It sits right there on the
    // state and reads like a perfect summary of the conversation, which is exactly what
    // makes it tempting and exactly why it must not be admitted.
    const corpus = buildSaidCorpus(saidCorpusFrom(stateAtPlan()));
    assert.equal(saidText(markSaidSpans('Summarize the shipping emails', corpus).spans), '',
      'a model\'s paraphrase of the conversation is not what the customer typed');
  });

  test('a plan is marked against THAT corpus and no other, end to end', () => {
    const p = markPlanSaidWords({
      steps: [
        { text: 'Retry once then tell a person', confidence: 'stated' },
        { text: 'Puts a digest in my inbox',     confidence: 'stated' },
      ],
    }, saidCorpusFrom(stateAtPlan()));
    assert.equal(p.steps[0].confidence, 'inferred', 'Atlas\'s own sentence loses the claim about the customer');
    assert.equal(p.steps[1].confidence, 'stated',   'the customer\'s own sentence keeps it');
  });
});

// ── THE WHOLE TRIP: BROWSER → ENDPOINT → PLAN CARD ─────────────────────────────
//
// The failure this pins is the one CLAUDE.md records twice: a client COMPUTES the
// evidence and DROPS IT AT THE POST, and the server, handed nothing, fills the gap.
// The typed turns exist only in the browser, so if `POST /api/builder/sessions`
// ignores them, every guard above still passes and the plan card still lies. So this
// drives the REAL endpoint on a real express app — only the model is stubbed — and
// asserts the plan a person is shown at the other end.

describe('POST /api/builder/sessions — what the customer typed survives the trip', () => {
  let server, port, spine;

  before(async () => {
    const app = express();
    app.use(express.json());
    spine = {
      llm: makeLLM(QA_PLAN),
      engine: { channelRegistry: realCatalog(), capabilityRegistry: { list: () => [] } },
      auth:     { oauthTokenStore: null, tokenCipher: null },
      // The SHAPE production hands back — an object with an actions list, never
      // null. A `null` here made the system prompt throw on `c.actions`, which is
      // the "a check that constructs its subject differently from production is
      // testing a program nobody runs" trap, met head on inside this very suite.
      slack:    { resolveForTenant: async () => ({ connector: 'slack',  connected: false, grantedScopes: [], actions: [] }) },
      google:   { resolveForTenant: async () => ({ connector: 'google', connected: false, grantedScopes: [], actions: [] }) },
      airtable: { resolveForTenant: () => ({ connector: 'airtable', connected: false, grantedScopes: [], actions: [] }) },
      interactionStore: {
        startSession() {}, appendEvent() {},
        getSession: () => ({ completed_at: null }),
      },
      costTracker: { setSessionUser() {} },
    };
    // The auth stub MUST be async, like the real `requireAuth` — a synchronous one
    // changes when handlers see request lifecycle events. Same note as
    // tests/api/build-offer-actionable.test.js, which found that the hard way.
    const tenantMiddleware = async (req, _res, next) => {
      await new Promise((r) => setImmediate(r));
      req.tenant = { id: 'tenantA' };
      req.user   = { id: 'u1', email: 'op@example.com', display_name: 'Op' };
      next();
    };
    mountBuilderRoutes(app, { spine, requireActiveTenant: tenantMiddleware, requireAuth: tenantMiddleware });
    await new Promise((r) => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  });

  after(() => { try { server?.close(); } catch { /* ignore */ } });

  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());

  /** Start a build the way the browser does, then poll to the plan card. */
  async function planCardFor(body) {
    const started = await post('/api/builder/sessions', body);
    assert.ok(started.threadId, `the build did not start: ${JSON.stringify(started)}`);
    for (let i = 0; i < 200; i++) {
      const s = await fetch(`http://127.0.0.1:${port}/api/builder/sessions/${started.threadId}/status`)
        .then(r => r.json());
      if (s.status === 'ready' && s.interrupt?.type === 'plan_review') return s.interrupt.plan;
      if (s.status === 'error') assert.fail(`the build errored: ${s.error}`);
      await new Promise(r => setTimeout(r, 25));
    }
    assert.fail('the plan card never arrived — the harness, not the guard, is broken');
  }

  test('the typed turns reach the plan card and decide what is marked as the customer\'s', async () => {
    const plan = await planCardFor({
      intent: 'Summarize the shipping emails every morning at 8:00 AM and put them in the inbox',
      typedTurns: ['summarize my shipping emails every morning'],
    });
    assert.equal(plan.saidWordsChecked, true);
    assert.equal(plan.steps[0].confidence, 'stated', 'the line they typed keeps its mark all the way to the card');
    assert.equal(plan.trigger.confidence, 'inferred', 'the time nobody typed loses its claim about them');
    assert.equal(saidText(plan.trigger.spans), 'every morning',
      'and the half they DID say arrives highlighted as theirs');
  });

  test('a build posted with NO typed turns marks nothing as the customer\'s, however good the intent looks', async () => {
    // The intent paragraph below contains every word of the plan's lines. It is
    // written by a model, and it is not the customer speaking.
    const plan = await planCardFor({
      intent: 'Summarize the shipping emails every morning at 8:00 AM local time; for non-urgent items the workflow ends silently.',
    });
    assert.equal(plan.steps[0].confidence, 'inferred');
    assert.equal(plan.trigger.confidence, 'inferred');
    assert.equal(saidText(plan.steps[0].spans), '',
      'the endpoint fell back to something the customer did not type');
  });
});

// ── THE BROWSER ────────────────────────────────────────────────────────────────

const HTML = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');

/** Brace-match a block starting at `from`; returns the index just past its `}`. */
function blockEnd(from) {
  let i = HTML.indexOf('{', from), depth = 0;
  for (; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  assert.fail(`could not find the end of the block starting at ${from}`);
}

/** The shipped source of one top-level function. Fail-loud. */
function fnSource(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.notEqual(start, -1,
    `\`${name}\` is GONE from public/index.html — re-point this extraction, do not delete the test.`);
  return HTML.slice(start, blockEnd(start));
}

/**
 * The plan card's own span-colouring, sliced out of the `plan_review` branch and run.
 * A derivation trapped in a render closure is unreachable from outside the render pass
 * — the trap that let the destination fix revert in silence — so the decision lives in
 * the top-level functions above and only the COLOUR is picked here.
 */
function styleSource() {
  const branch = HTML.indexOf('iv.type === "plan_review"');
  assert.notEqual(branch, -1, 'the plan_review branch is GONE from public/index.html — re-point this extraction.');
  const start = HTML.indexOf('const SAID_STYLE = ', branch);
  assert.notEqual(start, -1,
    'the plan card\'s said-word highlight is GONE — re-point this extraction, do not delete the test.');
  const tail = '.map((s) => ({ text: s.text, style: s.said ? SAID_STYLE : restStyle(conf) }));';
  const end = HTML.indexOf(tail, start);
  assert.notEqual(end, -1, 'the plan card\'s span-colouring is GONE — re-point this extraction.');
  return HTML.slice(start, end + tail.length);
}

/** Compile the real client functions and hand back what the plan card renders with. */
function clientPlanCard(saidChecked) {
  //! nosemgrep: eval-and-function-constructor
  const build = new Function('saidChecked', `
    ${fnSource('planSaidChecked')}
    ${fnSource('planSaidConfidence')}
    ${fnSource('planSaidSpans')}
    ${styleSource()}
    return { planSaidChecked, planSaidConfidence, planSaidSpans, lineSpans, SAID_STYLE, restStyle };
  `);
  return build(saidChecked);
}

/** What a person would see highlighted as their own words. */
const renderedSaid = (parts, SAID_STYLE) =>
  parts.filter(p => p.style === SAID_STYLE).map(p => p.text).join('|');

describe('the browser marks the customer\'s words, and refuses to mark anything it cannot prove', () => {
  const CHECKED = { saidWordsChecked: true };

  test('THE MIXED LINE renders each part in its own colour', () => {
    const c = clientPlanCard(true);
    const item = {
      text: 'Runs every morning at 8:00 AM local time',
      confidence: 'inferred',
      spans: [
        { text: 'Runs ',                 said: false },
        { text: 'every morning',         said: true  },
        { text: ' at 8:00 AM local time', said: false },
      ],
    };
    const parts = c.lineSpans(item, 'text', 'spans', 'inferred');

    assert.equal(parts.map(p => p.text).join(''), item.text,
      'the rendered pieces must add back up to the sentence exactly');
    assert.equal(renderedSaid(parts, c.SAID_STYLE), 'every morning',
      'the customer\'s own words are the ONE thing on the card that looks quoted');
    const rest = parts.filter(p => p.style !== c.SAID_STYLE);
    for (const p of rest) {
      assert.match(p.style, /#f3cd86/,
        'on an amber line the words Atlas filled in take the amber colour, so the eye lands on them');
    }
  });

  test('AN UNCHECKED PLAN marks nothing as theirs and drops the claim about them', () => {
    const c = clientPlanCard(false);
    // A plan from before this shipped, or a persisted slice: no `saidWordsChecked`.
    assert.equal(c.planSaidChecked({ steps: [] }), false);
    assert.equal(c.planSaidConfidence({ confidence: 'stated' }, false), 'inferred',
      'nothing proved this claim, so the browser does not make it — the second line, on purpose');
    assert.equal(c.planSaidConfidence({ confidence: 'stated' }, true), 'stated',
      'and the feature is not merely broken: a checked, genuinely stated line still says so');

    const spans = c.planSaidSpans(
      { text: 'Runs every morning', spans: [{ text: 'Runs every morning', said: true }] },
      'text', 'spans', false);
    assert.deepEqual(spans, [{ text: 'Runs every morning', said: false }],
      'spans on an UNCHECKED plan must not be believed — they were produced by nothing');
  });

  test('MISSING OR INCONSISTENT SPANS fail closed rather than marking words', () => {
    const c = clientPlanCard(true);
    const line = 'Runs every morning at 8:00 AM';

    assert.deepEqual(c.planSaidSpans({ text: line }, 'text', 'spans', true),
      [{ text: line, said: false }], 'no spans ⇒ nothing is the customer\'s');
    assert.deepEqual(c.planSaidSpans({ text: line, spans: 'nope' }, 'text', 'spans', true),
      [{ text: line, said: false }], 'a spans field that is not a list ⇒ nothing is the customer\'s');
    assert.deepEqual(
      c.planSaidSpans({ text: line, spans: [{ text: 'Runs every morning', said: true }] }, 'text', 'spans', true),
      [{ text: line, said: false }],
      'spans that do not reconstruct the line could drop or invent words on screen — refuse them whole');
    assert.deepEqual(
      c.planSaidSpans({ text: line, spans: [{ text: line, said: 'yes' }] }, 'text', 'spans', true),
      [{ text: line, said: false }],
      'only a literal true means "the customer typed this" — a truthy string is not a proof');
  });

  test('a tool-grounded line keeps the green mark on the words Atlas found', () => {
    const c = clientPlanCard(true);
    const parts = c.lineSpans(
      { text: 'Posts to the existing #ops channel',
        spans: [{ text: 'Posts to the existing ', said: false }, { text: '#ops', said: true }, { text: ' channel', said: false }] },
      'text', 'spans', 'found');
    assert.equal(renderedSaid(parts, c.SAID_STYLE), '#ops', 'the channel they named is theirs');
    for (const p of parts.filter(x => x.style !== c.SAID_STYLE)) {
      assert.match(p.style, /#7fd6a0/, 'the rest of a "I found" line is the grounded green, not amber');
    }
  });
});

// ── WHAT IS ACTUALLY ON SCREEN ─────────────────────────────────────────────────
//
// The template IS the renderer here: there is nothing to execute without a DOM, so
// these pin its STRUCTURE — that every plan line draws the SPANS and no line draws the
// raw text any more. Stated honestly: this half proves the markup binds the derivation,
// not that a browser paints it. The derivation itself is pinned behaviourally above.

describe('the plan card\'s markup draws the spans, not the raw line', () => {
  const planCard = () => {
    const start = HTML.indexOf('<!-- PLAN CARD (plan_review)');
    assert.notEqual(start, -1, 'the plan card markup is GONE from public/index.html — re-point this extraction.');
    const end = HTML.indexOf('<!-- CoT IN THE CHAT', start);
    assert.notEqual(end, -1, 'the plan card markup no longer ends where this extraction expects — re-point it.');
    return HTML.slice(start, end);
  };

  for (const [what, list] of [
    ['the trigger',      'item.trigger.spans'],
    ['each step',        'st.spans'],
    ['each route',       'br.thenSpans'],
    ['each route\'s condition', 'br.whenSpans'],
    ['the failure line', 'item.errorSpans'],
  ]) {
    test(`${what} is drawn from its spans`, () => {
      assert.match(planCard(), new RegExp(`<sc-for list="\\{\\{ ${list.replace(/\./g, '\\.')} \\}\\}"`),
        `${what} is not rendered word by word — a line bundling said and inferred content can only carry the stronger mark`);
    });
  }

  test('no plan line renders its raw text any more — that is what carried one mark for a mixed line', () => {
    const card = planCard();
    for (const raw of ['{{ item.trigger.text }}', '{{ st.text }}', '{{ br.then }}', '{{ br.when }}', '{{ item.errorText }}']) {
      assert.equal(card.includes(raw), false,
        `${raw} is still drawn directly — the word-level marking is bypassed for that line`);
    }
  });

  test('the legend describes what a reader now sees, and is honest when the check did not run', () => {
    const card = planCard();
    assert.equal(card.includes('The amber items are things I filled in — worth a glance.'), false,
      'the old legend is item-scoped and is wrong at word level — it must not survive');
    assert.match(card, /\{\{ item\.legend \}\}/,
      'the legend is data, because it has to say something different when nothing could be checked');

    const branch = HTML.indexOf('iv.type === "plan_review"');
    const legend = HTML.slice(branch, HTML.indexOf('return true;', branch));
    assert.match(legend, /Your own words are highlighted/,
      'the legend must name the highlight the reader is looking at');
    assert.match(legend, /nothing here is marked as your words/,
      'when the check did not run the legend must say so, not point at a highlight that is not there');
  });

  test('the marks and the legend are both still there — removing them was considered and rejected', () => {
    const card = planCard();
    assert.match(card, /item\.trigger\.chip\.label/, 'the provenance mark stays');
    assert.match(card, /st\.chip\.label/,            'the provenance mark stays on every step');
    assert.match(card, /\{\{ item\.legend \}\}/,     'the legend stays');
  });
});

// ── THE CORPUS THE BROWSER SENDS ───────────────────────────────────────────────

describe('only the customer\'s own keystrokes are sent as what they typed', () => {
  test('a message Atlas composed and the user merely CLICKED is not typing', () => {
    //! nosemgrep: eval-and-function-constructor
    const start = HTML.indexOf('  _typedTurns() {');
    assert.notEqual(start, -1,
      '`_typedTurns` is GONE from public/index.html — re-point this extraction, do not delete the test.');
    const src = HTML.slice(start, blockEnd(start));
    const build = new Function(`
      class C { constructor(s) { this.state = s; } ${src} }
      return (msgs) => new C({ msgs })._typedTurns();
    `);
    const typedTurns = build();

    const got = typedTurns([
      { isOperator: true, text: 'summarize my shipping emails', typed: true },
      // Every one of these wears the user's avatar and was written by Atlas.
      { isOperator: true, text: 'Build it' },
      { isOperator: true, text: 'Skip this setup step.' },
      { isOperator: true, text: 'Not this — show me another option.' },
      { isAtlas: true,    text: 'I will run this every morning at 8:00 AM', typed: true },
      { isOperator: true, text: '   ',  typed: true },
      { isOperator: true, text: 'post them to #ops', typed: true },
    ]);

    assert.deepEqual(got, ['summarize my shipping emails', 'post them to #ops'],
      'a sentence Atlas wrote and the user clicked would let Atlas certify its own words as theirs');
  });

  test('the build actually SENDS them — a corpus computed and dropped at the POST proves nothing', () => {
    const start = HTML.indexOf('  startBuild(intent) {');
    assert.notEqual(start, -1, '`startBuild` is GONE from public/index.html — re-point this extraction.');
    const src = HTML.slice(start, blockEnd(start));
    assert.match(src, /fetch\("\/api\/builder\/sessions",[\s\S]*?typedTurns: this\._typedTurns\(\)/,
      'the typed turns must ride on the POST that starts the build — the browser is the only place they exist');
  });
});
