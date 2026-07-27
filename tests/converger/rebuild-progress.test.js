/**
 * THE REBUILD LOOP HAS TO BE ABLE TO MAKE PROGRESS.
 *
 * A four-step workflow spent about nine minutes rebuilding itself before a person
 * saw anything. Nothing errored and nothing timed out — it converged, expensively,
 * having thrown the whole spec away and re-derived it from scratch three times over.
 *
 * Measured on the record (`memory/logs/atlas-events.log`, build
 * `build-agntic-1785087187289`, 2026-07-26): after the user answered the last
 * question, `generate` ran three times back to back — 155s + 130s + 203s, 8 minutes
 * 16 seconds of a person waiting, 98% of it inside those three calls — and
 * `converger.pre_regen_repair [DIGEST_MISSING_SECTIONS]` fired after EVERY one of
 * them. The same blank, filled in by the system, thrown away by the next pass, filled
 * in again. Two other builds that afternoon repeated the same repair twice each.
 *
 * THE MECHANISM, which is what these tests pin. `generate` rebuilds the WHOLE spec on
 * every "the spec must change" route, and the previous draft reaches the model as ids,
 * types and labels ONLY — `buildGeneratePrompt` serialises
 * `nodes.map(n => ({id, type, label}))` and drops every `config`. So a value the
 * deterministic repairs had already computed and written into the draft was invisible
 * to the pass that came next. The build could not retain a fix it had already made.
 * That is a loop that cannot make progress by construction; it can only run to its cap.
 *
 * These tests assert on WHAT THE MODEL IS ACTUALLY TOLD — the prompt string handed to
 * the model on the second pass — not on an intermediate variable. A repair recorded in
 * state that never reaches the prompt fixes nothing, and that distinction is the whole
 * bug.
 *
 * The second half pins the budget: a whole-spec pass that emitted nothing still cost a
 * full Opus call, and it used to return WITHOUT advancing either rebuild counter — a
 * free pass against every cap. It is read back out of the checkpoint, which is the
 * same persisted state the cap itself reads.
 */

import { test, describe, after } from 'node:test';
import assert                    from 'node:assert/strict';
import { mkdtempSync, rmSync }   from 'node:fs';
import { tmpdir }                from 'node:os';
import { join }                  from 'node:path';

import { createConverger }     from '../../src/converger/index.js';
import { buildGeneratePrompt } from '../../src/converger/prompts.js';
import { FileCheckpointer }    from '../../src/graph/checkpointer/file-checkpointer.js';
import { realCatalog }         from '../helpers/catalog.js';

const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-rebuild-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

const J = (o) => ({ content: JSON.stringify(o) });

const CAPS = () => ({
  channels: realCatalog().getAll().map(c => ({ ...c, available: true })),
  connectors: { slack: { connected: true } },
  slackChannels: ['ops'],
});

const PLAN = {
  summary: 'Summarize each incoming email into your Atlas inbox',
  trigger: { text: 'A new email arrives in your Gmail' },
  steps: [{ text: 'Summarize the email' }, { text: 'Lay it out as a digest' }],
  branches: [], error_handling: { text: 'Retry once, then flag it to you' },
  knowledge: [], upload_suggestion: null,
};

/**
 * THE SPEC THE MODEL EMITS, AND THE BLANK IT LEAVES.
 *
 * `compose` is a document-assembly step with NO `sections` list — the exact blank the
 * live builds kept producing (`DIGEST_MISSING_SECTIONS`). The system's own repair
 * computes the list (one section per content step feeding it) and writes it into the
 * draft; the question these tests answer is whether the NEXT pass is told.
 *
 * The stub returns this identical object on every call, which models the failure
 * faithfully: a model that cannot see the repair reproduces the blank exactly.
 */
const BLANK_SECTIONS_SPEC = () => ({
  name: 'Email digest',
  triggers: [{ type: 'email', filter: 'is:unread' }],
  nodes: [
    { id: 'sum',     type: 'llm',      label: 'Summarize',     config: { mode: 'summarize', instructions: 'Summarize the email.' } },
    { id: 'compose', type: 'assemble', label: 'Compose digest', config: { title: 'Daily digest' } },
    { id: 'post',    type: 'deliver',  label: 'Save',           config: { channel: 'in_app', title: 'Email Summary' } },
  ],
  edges: [{ from: 'sum', to: 'compose' }, { from: 'compose', to: 'post' }],
});

/**
 * Drive the converger exactly as `builder.js` does — run, then resume through every
 * interrupt — capturing every whole-spec prompt the model was handed.
 *
 * `onGenerate(callIndex)` decides what the model emits for each whole-spec call, so a
 * test can make a pass come back empty (the truncation mode) without touching any
 * other prompt.
 *
 * `sufficiency(callIndex)` drives the rebuild. It answers the "is this workflow
 * FINISHED?" check, which is the route that ordered five of the seven whole-spec
 * rebuilds on the record — so a scenario built on it is the measured one, not a
 * convenient one.
 */
async function drive({
  onGenerate  = () => BLANK_SECTIONS_SPEC(),
  sufficiency = (n) => (n === 1 ? { complete: false, missing: 'a step that lays out the digest' } : { complete: true }),
  threadId    = 'rp1',
} = {}) {
  let suffCalls = 0;
  const generatePrompts = [];
  const dir = scratch();

  const llm = { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1',
      statement: 'Every incoming email is summarized into the Atlas inbox.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Email Summary' }] }] });
    if (p.includes('What starts this workflow')) return J({ trigger: { type: 'email', filter: 'is:unread' } });
    if (p.includes('CONCRETE example cases'))    return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))      return J(sufficiency(++suffCalls));
    if (p.includes('write the PLAN the user will approve')) return J(PLAN);
    if (p.includes('cases nobody has decided about')) {
      const ids = [...p.matchAll(/^ {2}- id: (\S+)$/gm)].map(m => m[1]);
      return J({ suggestions: ids.map(id => ({ gapId: id, answer: 'retry then tell a person' })) });
    }
    if (p.includes('Build the COMPLETE workflow')) {
      generatePrompts.push(p);
      return J(onGenerate(generatePrompts.length));
    }
    return J({});
  } };

  const conv = createConverger({ llm, capabilities: CAPS(), invokeCapability: null, checkpointerDir: dir });
  const replyFor = (iv) => {
    switch (iv.type) {
      case 'outcome_check':      return { id: 'c1' };
      case 'plan_review':        return { type: 'accept' };
      case 'clarification':      return { answer: 'try again' };
      case 'proposal':           return { type: 'approve' };
      case 'generated_workflow': return { type: 'accept' };
      case 'ratify':             return { type: 'approve' };
      default:                   return { type: 'accept' };
    }
  };

  let iv;
  try { await conv.run(threadId, 'summarize my emails to my inbox'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 60 && iv?.type !== 'done'; i++) iv = await conv.resume(threadId, replyFor(iv));

  // The SAME persisted state the aggregate cap reads when it decides whether another
  // Opus pass may be bought. Read from the store, not from a value the test kept.
  const checkpoint = await new FileCheckpointer({ dir }).load(threadId);
  return { generatePrompts, spec: iv?.spec ?? null, state: checkpoint?.state ?? {} };
}

// ── 1. THE LOOP MAKES PROGRESS ───────────────────────────────────────────────

describe('a rebuild is told what the last one got wrong and we fixed for it', () => {
  test('the second whole-spec pass is shown the repaired config, verbatim', async () => {
    const { generatePrompts } = await drive();

    assert.ok(generatePrompts.length >= 2,
      `this scenario must rebuild at least once to be a test of rebuilding; it ran ${generatePrompts.length} pass(es)`);

    const [first, second] = generatePrompts;

    // Before the repair has happened there is nothing to carry, and inventing a
    // "already fixed" block on the FIRST build would be a lie.
    assert.doesNotMatch(first, /ALREADY FIXED FOR YOU/,
      'the first build has had nothing repaired yet — it must not be told otherwise');

    // The repair itself: the sections list the system computed. This is the value that
    // was being thrown away on every pass. Assert on the PROMPT — a repair that lives
    // only in state is a repair the model never sees.
    assert.match(second, /ALREADY FIXED FOR YOU/,
      'the rebuild is not told that anything was repaired — it will re-emit the same blank, which is the loop');
    assert.match(second, /"compose"/,
      'the repaired step is not named in the prompt');
    assert.match(second, /needs a sections list/,
      "the prompt does not say what was wrong, in the validator's own words");
    assert.match(second, /\{\{sum\.output\}\}/,
      'the actual repaired VALUE (the computed section content) never reaches the model');
  });

  test('the value in the prompt is the value in the draft — no drift', async () => {
    const { generatePrompts, spec } = await drive();
    const composed = (spec?.nodes ?? []).find(n => n.id === 'compose');
    assert.ok(composed?.config?.sections, 'the built workflow must actually carry the repaired sections list');

    // Every character of the repaired value has to be in the prompt. A summarised or
    // re-derived rendering could disagree with the draft, and the model would then be
    // told to reproduce something that is not what the workflow holds.
    const second = generatePrompts[1];
    for (const fragment of ['Daily digest', '{{sum.output}}', 'heading']) {
      assert.ok(second.includes(fragment),
        `the prompt omits "${fragment}" from the repaired config — it is not the value the draft holds`);
    }
  });

  test('with nothing repaired, no repair block is emitted at all', () => {
    // The block must be earned. A build with no repairs that still prints a repair
    // header would spend tokens saying nothing and teach the model to distrust it.
    const p = buildGeneratePrompt({
      intent: 'route inbound leads', clarifications: [], draft: { triggers: [], nodes: [] },
      capabilities: {}, setupResults: {}, repairs: [],
    });
    assert.doesNotMatch(p, /ALREADY FIXED FOR YOU/);
  });

  test('each kind of repair is stated in terms the model can act on', () => {
    const draft = { triggers: [], nodes: [
      { id: 'compose', type: 'assemble', label: 'Compose', config: { title: 'T', sections: '[{"heading":"T","content":"{{a.output}}"}]' } },
    ] };
    const p = buildGeneratePrompt({
      intent: 'x', clarifications: [], draft, capabilities: {}, setupResults: {},
      repairs: [
        { op: 'set_config', nodeId: 'compose', code: 'DIGEST_MISSING_SECTIONS', message: '"Compose" needs a sections list.' },
        { op: 'add_edge',   from: 'route', to: 'post_urgent', code: 'BRANCH_CASE_NO_EDGE', message: 'the urgent lane has no edge.' },
        { op: 'set_name',   name: 'Lead router', code: 'MISSING_NAME', message: 'the workflow has no name.' },
      ],
    });
    assert.match(p, /\{\{a\.output\}\}/,          'a filled config must be reproduced verbatim');
    assert.match(p, /route → post_urgent/,        'an added edge must be named so the rebuild emits it');
    assert.match(p, /"Lead router"/,              'a derived name must be carried so the next pass does not drop it again');
    assert.match(p, /needs a sections list/,      'the reason must travel with the fix');
  });
});

// ── 2. A PASS THAT PRODUCED NOTHING IS STILL A PASS ──────────────────────────

describe('an empty or truncated emission cannot buy a free rebuild', () => {
  test('the rebuild budget is charged for a pass that emitted no spec', async () => {
    // The first pass builds; every pass after it comes back with no nodes — the
    // truncation mode documented at `GENERATE_MAX_TOKENS`, where a 6.6-minute build
    // ran out of room mid-JSON and the whole pass was discarded.
    const { state, generatePrompts } = await drive({
      threadId: 'rp-empty',
      onGenerate: (n) => (n === 1 ? BLANK_SECTIONS_SPEC() : { nodes: [] }),
      sufficiency: (n) => (n <= 3 ? { complete: false, missing: 'a step that lays out the digest' } : { complete: true }),
    });

    assert.ok(generatePrompts.length >= 3,
      `the scenario must actually re-enter generate after an empty emission; it ran ${generatePrompts.length} pass(es)`);

    // `buildPresentations` is the aggregate cap's counter, read back out of the
    // checkpoint the cap itself reads. The first build never counts (the cap bounds
    // RE-generation, not building) — so every unit here was bought by a pass that
    // produced nothing. Zero means those passes were free, and a cap that a failing
    // pass cannot spend is not a cap.
    assert.ok((state.buildPresentations ?? 0) > 0,
      'a whole-spec pass that emitted nothing still cost a full Opus call and was not charged against the aggregate rebuild cap — it bought a free pass');
    assert.ok((state.regenRounds ?? 0) > 0,
      'the same pass was not charged against the regenerate-round budget either');
  });

  test('a build whose model never emits anything usable still terminates', async () => {
    // The guard must not turn a bounded failure into a spin: counting harder is only
    // correct if the loop still ends.
    const { generatePrompts } = await drive({
      threadId: 'rp-empty2',
      onGenerate: (n) => (n === 1 ? BLANK_SECTIONS_SPEC() : { nodes: [] }),
      sufficiency: () => ({ complete: false, missing: 'a step that lays out the digest' }),
    });
    assert.ok(generatePrompts.length < 20,
      `the loop did not terminate sensibly — ${generatePrompts.length} whole-spec passes`);
  });
});
