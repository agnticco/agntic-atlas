/**
 * THE PLAN MUST NEVER MARK SOMETHING "YOU SAID" THAT THE USER DID NOT SAY.
 *
 * Before Atlas builds, it shows a plan card. Every line carries a small provenance
 * mark — **you said** / **I found** / **I inferred** — and the card tells the user in
 * as many words that the amber items are the ones Atlas filled in and are worth a
 * glance. That mark is the entire mechanism by which a non-technical person knows
 * which parts to check.
 *
 * QA run 2026-07-26. A tester asked for a Slack channel called `#ops`. The plan then
 * asserted **"Atlas will create the #ops channel"**, marked **YOU SAID** — and the
 * builder skipped doing the work, because the plan read as settled. The user never
 * said Atlas would create a channel. They named a channel.
 *
 * THE INVARIANT PINNED HERE. "You said" is a claim ABOUT THE USER, and Atlas may only
 * make it when the plan explicitly declares the line was `stated`. Everything else —
 * missing, empty, `null`, an unrecognised value the model invented — is Atlas's own
 * inference and must render as "I inferred". **The default is the WEAKER claim.** A
 * mark that is usually right is worse than no mark at all, because it teaches the user
 * to trust the occasional false one.
 *
 * WHY THIS SHAPE. The rule lives in two places on purpose and both are exercised here:
 *
 *   · SERVER — `normalizePlanConfidences` (src/converger/plan-provenance.js), applied
 *     in the `plan` node, so a client that never ran cannot even RECEIVE an unlabelled
 *     item that a future renderer would default to "you said". Driven through the REAL
 *     converger graph (same harness as plan-gate.test.js), not by calling the helper —
 *     a check must construct its subject the way production does.
 *
 *   · BROWSER — the plan card's chip. `public/index.html` is a ~9,700-line file with no
 *     module boundary, so there is nothing to import and a grep would pass against the
 *     broken code. These tests SLICE the real source of `planProvenanceLabel` and of the
 *     plan card's `chip` helper out of the shipped file and EXECUTE them, asserting the
 *     label and the colour a person would actually see. Fail-loud: a rename fails the
 *     test rather than quietly proving nothing.
 */

import { test, describe, after } from 'node:test';
import assert                    from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir }                from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath }         from 'node:url';

import { createConverger }       from '../../src/converger/index.js';
import { buildPlanPrompt }       from '../../src/converger/prompts.js';
import { coercePlanConfidence, normalizePlanConfidences } from '../../src/converger/plan-provenance.js';
import { realCatalog }           from '../helpers/catalog.js';

// ── the browser half: run the REAL client source ───────────────────────────────

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

/** The shipped source of the pure label decision. Fail-loud. */
function labelSource() {
  const start = HTML.indexOf('function planProvenanceLabel(');
  assert.notEqual(start, -1,
    '`planProvenanceLabel` is GONE from public/index.html — re-point this extraction, do not delete the test.');
  return HTML.slice(start, blockEnd(start));
}

/** The shipped source of the plan card's chip helper, from INSIDE the plan_review branch. */
function chipSource() {
  const branch = HTML.indexOf('iv.type === "plan_review"');
  assert.notEqual(branch, -1,
    'the plan_review branch is GONE from public/index.html — re-point this extraction.');
  const start = HTML.indexOf('const chip = (conf) => {', branch);
  assert.notEqual(start, -1,
    'the plan card\'s `chip` helper is GONE — re-point this extraction, do not delete the test.');
  return HTML.slice(start, blockEnd(start)) + ';';
}

/** Compile the real client functions and hand back the chip the plan card renders with. */
function clientChip() {
  //! nosemgrep: eval-and-function-constructor
  const build = new Function(`
    const CHIP_BASE = "CHIP_BASE;";
    const DOT = "DOT;";
    ${labelSource()}
    ${chipSource()}
    return { chip, planProvenanceLabel };
  `);
  return build();
}

// The three values a person can actually be shown.
const YOU_SAID   = 'you said';
const I_FOUND    = 'I found';
const I_INFERRED = 'I inferred';

/** Every way a confidence can arrive that is NOT the literal declaration of "stated". */
const NOT_STATED = [
  ['missing',           undefined],
  ['empty string',      ''],
  ['null',              null],
  ['an invented value', 'guessed'],
  ['a near-miss typo',  'stated '],
  ['the phrase the old prompt asked for', 'you said'],
  ['a number',          1],
  ['an object',         {}],
  ['a prototype key',   'constructor'],
  ['another prototype key', '__proto__'],
];

describe('the plan card: an unknown provenance is shown as INFERRED, never as the user\'s words', () => {
  for (const [name, value] of NOT_STATED) {
    test(`${name} renders as "${I_INFERRED}"`, () => {
      const { chip } = clientChip();
      const got = chip(value);
      assert.equal(got.label, I_INFERRED,
        `a confidence of ${JSON.stringify(value)} was shown to the user as "${got.label}" — ` +
        'Atlas may only say "you said" when the plan declares "stated".');
      assert.match(got.style, /231,178,94/,
        'the unknown-provenance chip must be the AMBER "worth a glance" chip');
      assert.match(got.style, /dashed/,
        'the inferred chip is dashed — the visual cue that it is a guess');
    });
  }

  test('a line the plan declares as STATED still shows "you said"', () => {
    const { chip } = clientChip();
    const got = chip('stated');
    assert.equal(got.label, YOU_SAID,
      'the feature is broken the other way: a line the user really did say no longer says so');
    assert.doesNotMatch(got.style, /231,178,94/, 'a stated line must not be marked as a guess');
  });

  test('a line grounded in a live tool still shows "I found"', () => {
    const { chip } = clientChip();
    const got = chip('found');
    assert.equal(got.label, I_FOUND);
    assert.match(got.style, /95,199,138/, 'the grounded chip is the green one');
  });

  test('the label decision itself is total — it answers with one of exactly three marks', () => {
    const { planProvenanceLabel } = clientChip();
    for (const [, value] of NOT_STATED) {
      assert.ok([YOU_SAID, I_FOUND, I_INFERRED].includes(planProvenanceLabel(value)));
    }
    assert.equal(planProvenanceLabel('stated'), YOU_SAID);
    assert.equal(planProvenanceLabel('found'),  I_FOUND);
    assert.equal(planProvenanceLabel('inferred'), I_INFERRED);
  });
});

// ── the server half: the closed domain, and the graph that applies it ──────────

describe('the server clamps every confidence to the closed set, defaulting to inferred', () => {
  test('only the literal "stated" survives as the claim about the user', () => {
    for (const [, value] of NOT_STATED) {
      assert.equal(coercePlanConfidence(value), 'inferred',
        `${JSON.stringify(value)} must not be allowed to mean "the user said this"`);
    }
    assert.equal(coercePlanConfidence('stated'),   'stated');
    assert.equal(coercePlanConfidence('found'),    'found');
    assert.equal(coercePlanConfidence('inferred'), 'inferred');
  });

  test('every part of a plan is clamped — trigger, steps, branches and the failure line', () => {
    const p = normalizePlanConfidences({
      summary: 's',
      trigger: { text: 't' },                                     // no confidence at all
      steps: [{ text: 'a', confidence: 'stated' }, { text: 'b', confidence: 'guessed' }, { text: 'c' }],
      branches: [{ when: 'w', then: 'x', confidence: '' }],
      error_handling: { text: 'e', confidence: null },
    });
    assert.equal(p.trigger.confidence, 'inferred');
    assert.deepEqual(p.steps.map(s => s.confidence), ['stated', 'inferred', 'inferred']);
    assert.equal(p.branches[0].confidence, 'inferred');
    assert.equal(p.error_handling.confidence, 'inferred');
    assert.equal(p.summary, 's', 'nothing else about the plan is touched');
  });
});

// ── the server half, through the REAL graph ────────────────────────────────────
//
// The same harness plan-gate.test.js uses: `createConverger` → run → resume, with a
// stub model. The point is that the interrupt the CLIENT receives is already clean —
// so a renderer that never ran this coercion still cannot be handed an unlabelled item.

const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-planprov-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

const J = (o) => ({ content: JSON.stringify(o) });

const CAPS = () => ({
  channels: realCatalog().getAll().map(c => ({ ...c, available: true })),
  connectors: { slack: { connected: true }, airtable: { connected: false } },
  slackChannels: ['ops', 'general'],
});

/**
 * A model that answers the plan prompt the way the LIVE one was seen to: some lines
 * honestly `stated`, and the rest with values that are NOT in the declared set —
 * including the literal `"you said"` the grounding block used to ask for.
 */
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

/** Drive the loop until the plan card is raised; hand back the interrupt the client gets. */
async function planInterrupt(plan) {
  const conv = createConverger({ llm: makeLLM(plan), capabilities: CAPS(), invokeCapability: null, checkpointerDir: scratch() });
  const thread = `t${Math.random().toString(36).slice(2)}`;
  const replyFor = (iv) => (iv.type === 'outcome_check' ? { id: 'c1' } : { type: 'accept' });

  let iv;
  try { await conv.run(thread, 'summarize my emails to my inbox'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 60 && iv?.type !== 'done'; i++) {
    if (iv?.type === 'plan_review') return iv;
    iv = await conv.resume(thread, replyFor(iv));
  }
  assert.fail('no plan_review interrupt was raised — the harness, not the guard, is broken');
}

describe('the plan that LEAVES the server carries no unlabelled item', () => {
  test('a model-invented confidence is already "inferred" by the time the client sees it', async () => {
    const iv = await planInterrupt({
      summary: 'Summarize each incoming email into your Atlas inbox',
      trigger: { text: 'A new email arrives', confidence: 'you said' },   // the old prompt's phrase
      steps: [
        { text: 'Summarize the email',        confidence: 'stated'  },
        { text: 'Create the #ops channel',    confidence: 'guessed' },    // invented
        { text: 'Post the summary to #ops'                          },    // omitted entirely
      ],
      branches: [{ when: 'anything else', then: 'no action is taken', confidence: null }],
      error_handling: { text: 'Retry once', confidence: '' },
      knowledge: [], upload_suggestion: null,
    });

    assert.equal(iv.plan.trigger.confidence, 'inferred',
      '"you said" is not in the declared set and must not reach the client as a claim about the user');
    assert.deepEqual(iv.plan.steps.map(s => s.confidence), ['stated', 'inferred', 'inferred'],
      'an invented or omitted confidence must arrive as "inferred"');
    assert.equal(iv.plan.branches[0].confidence, 'inferred');
    assert.equal(iv.plan.error_handling.confidence, 'inferred');

    // The decisive one, stated as the invariant rather than as three field checks:
    // NOTHING outside the closed set leaves the server.
    const every = [iv.plan.trigger, ...iv.plan.steps, ...iv.plan.branches, iv.plan.error_handling]
      .map(x => x.confidence);
    for (const c of every) {
      assert.ok(['stated', 'found', 'inferred'].includes(c), `an unlabelled item escaped: ${JSON.stringify(c)}`);
    }
  });

  test('a line the user really did say still arrives as "stated" — the feature is not merely broken', async () => {
    const iv = await planInterrupt({
      summary: 'Summarize each incoming email into your Atlas inbox',
      trigger: { text: 'A new email arrives', confidence: 'stated' },
      steps: [{ text: 'Summarize the email', confidence: 'stated' }, { text: 'Post it', confidence: 'found' }],
      branches: [], error_handling: { text: 'Retry once', confidence: 'inferred' },
      knowledge: [], upload_suggestion: null,
    });
    assert.equal(iv.plan.trigger.confidence, 'stated');
    assert.equal(iv.plan.steps[0].confidence, 'stated');
    assert.equal(iv.plan.steps[1].confidence, 'found',
      'a line grounded in a live tool must keep its green "I found" mark');
  });
});

// ── the instruction that manufactured the false mark ───────────────────────────

describe('a destination the user NAMED but does not have is not presented as their words', () => {
  const outcome = { statement: 's', assertions: [{ kind: 'message_sent', target: 'slack:#ops' }] };
  const prompt  = () => buildPlanPrompt({ intent: 'post summaries to #ops', outcome, triggers: [],
    grounding: { slack: { checked: true, known: [], absent: ['#ops'] } } });

  test('the model is told to mark it INFERRED, not to keep it as the user\'s words', () => {
    const p = prompt();
    assert.match(p, /do NOT exist in the workspace yet: #ops/);
    assert.match(p, /tag it confidence "inferred"/,
      'a channel the tenant does not have is Atlas\'s inference about what to do, not the user\'s statement');
    assert.doesNotMatch(p, /confidence "you said"/,
      'the plan must never be instructed to mark this as the user\'s own words');
    assert.doesNotMatch(p, /Keep confidence "you said"/);
  });

  test('the plan is not told to state that Atlas will create the channel', () => {
    const p = prompt();
    assert.doesNotMatch(p, /Atlas will CREATE the channel/,
      'that decision has not been made yet — it is asked by the create-or-pick step after the build');
    assert.match(p, /Do NOT state that Atlas will create it/,
      'the instruction must say so out loud — the model reached for that sentence on its own');
  });

  test('a channel that DOES exist is still grounded as "found"', () => {
    const p = buildPlanPrompt({ intent: 'x', outcome, triggers: [],
      grounding: { slack: { checked: true, known: ['#ops'], absent: [] } } });
    assert.match(p, /EXIST in the connected workspace: #ops/);
    assert.match(p, /tag it confidence "found"/);
  });
});
