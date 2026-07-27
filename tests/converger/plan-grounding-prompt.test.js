/**
 * THE PLAN MUST NOT SETTLE A QUESTION ANOTHER STAGE ASKS PROPERLY.
 *
 * Before Atlas builds, it shows a plan card. When the plan's grounding pass finds that
 * a Slack channel the user NAMED does not exist in their workspace, the plan must say
 * so truthfully and STOP there — it must not announce that Atlas will create it.
 *
 * QA run 2026-07-26. A tester asked for a Slack channel called `#ops`. The plan asserted
 * **"Atlas will create the #ops channel"** — and the builder then SKIPPED doing the work,
 * because the plan read as settled. Atlas already has a create-or-pick conversation for
 * exactly this (`RESOURCE_NOT_FOUND` in `gap-scorer.js`, resolved in the `gaps` node of
 * `elicitation-graph.js`), and it gets a REAL answer from the user, after the build.
 *
 * WHY THIS FILE STILL EXISTS. It was `plan-provenance.test.js`: it pinned the plan card's
 * `you said / I found / I inferred` marks, which were REMOVED on 2026-07-27 by the
 * operator's decision. The marks are gone; **this rule is not**, and it was welded into
 * the same prompt string as the confidence instruction that went with them. This file is
 * one of exactly TWO places that pin it (the other is the grounding describe in
 * `tests/converger/plan-gate.test.js`). Deleting either leaves it pinned by nothing.
 *
 * The pin is an assertion on PROMPT TEXT, and that is honest about what it can prove: it
 * pins the INSTRUCTION, not the model's compliance. Whether the model obeys is a belief
 * no test can settle.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { buildPlanPrompt } from '../../src/converger/prompts.js';

describe('a destination the user NAMED but does not have is left for the create-or-pick step', () => {
  const outcome = { statement: 's', assertions: [{ kind: 'message_sent', target: 'slack:#ops' }] };
  const prompt  = () => buildPlanPrompt({ intent: 'post summaries to #ops', outcome, triggers: [],
    grounding: { slack: { checked: true, known: [], absent: ['#ops'] } } });

  test('the plan is not told to state that Atlas will create the channel', () => {
    const p = prompt();
    assert.doesNotMatch(p, /Atlas will CREATE the channel/,
      'that decision has not been made yet — it is asked by the create-or-pick step after the build');
    assert.match(p, /Do NOT state that Atlas will create it/,
      'the instruction must say so out loud — the model reached for that sentence on its own');
    assert.match(p, /that decision has not been made yet and is asked separately, after the build/,
      'the REASON travels with the rule; an instruction with no reason is the one a later edit drops');
  });

  test('the missing channel is still named, and the honest wording is still demanded', () => {
    const p = prompt();
    assert.match(p, /do NOT exist in the workspace yet: #ops/,
      'the model must be told WHICH channel is missing, or it cannot write the truthful line');
    assert.match(p, /the channel does not exist yet and that you will confirm what to do about it/,
      'the plan says the situation and promises the question — that is the whole contract');
  });

  test('a channel that DOES exist is still grounded as the existing one', () => {
    const p = buildPlanPrompt({ intent: 'x', outcome, triggers: [],
      grounding: { slack: { checked: true, known: ['#ops'], absent: [] } } });
    assert.match(p, /EXIST in the connected workspace: #ops/);
    assert.match(p, /say it posts to the EXISTING channel/,
      'the grounding is not merely removed with the marks: a real channel is still described as real');
    assert.doesNotMatch(p, /Atlas will CREATE the channel/);
  });
});

// ── THE MARKS ARE GONE, AND MUST STAY GONE ─────────────────────────────────────
//
// The plan prompt used to demand a `stated|found|inferred` tag on every item, and the
// grounding block used to set it. Both went on 2026-07-27. A prompt that quietly grew
// the instruction back would put half a feature back on the wire — a field nothing
// renders — so it is pinned here rather than left to a reviewer's eye.

describe('the plan prompt no longer asks the model to mark anything', () => {
  const grounded = () => buildPlanPrompt({
    intent: 'post summaries to #ops',
    outcome: { statement: 's', assertions: [
      { kind: 'message_sent', target: 'slack:#ops' },
      { kind: 'record_exists', target: 'airtable:Leads' },
    ] },
    triggers: [],
    grounding: {
      slack:    { checked: true, known: ['#support'], absent: ['#ops'] },
      airtable: { base: 'CRM', table: 'Leads', columns: ['Name', 'Email'] },
    },
  });

  test('no confidence tag is requested anywhere in the plan prompt', () => {
    const p = grounded();
    assert.doesNotMatch(p, /confidence/i,
      'the plan card draws no marks, so a prompt still asking for them produces a field nobody renders');
    assert.doesNotMatch(p, /"stated"|"inferred"|you said/,
      'the vocabulary of the removed marks must not survive in the instruction either');
  });

  test('the grounding facts themselves survive — this removed the label, not the grounding', () => {
    const p = grounded();
    assert.match(p, /GROUNDING — verified live against the connected tools/);
    assert.match(p, /base "CRM" has a table "Leads"/);
    assert.match(p, /columns: Name, Email/);
    assert.match(p, /name the REAL table and its columns in the step text/,
      'the Airtable line still tells the model to use the real names it verified');
  });

  test('the plan JSON the model returns has no per-line mark field', () => {
    const p = grounded();
    assert.match(p, /"steps":\s*\[ \{ "text"/, 'a step is text and nothing else now');
    assert.doesNotMatch(p, /"trigger": \{ "text": "<when it starts>", "confidence"/);
  });
});
