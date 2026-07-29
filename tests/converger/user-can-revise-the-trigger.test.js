/**
 * THE PLAN A PERSON APPROVED MUST BE THE WORKFLOW THAT GETS BUILT.
 *
 * WITNESSED ON PROD, 2026-07-29. Asked to stop matching pricing emails on subject
 * keywords — "'Re: project plan for Q3' isn't a pricing question, and 'How much for
 * the team package?' is one but wouldn't match" — Atlas re-planned and showed a plan
 * saying, verbatim:
 *
 *     TRIGGER  Fires when a new unread email arrives in the connected Gmail account
 *              (no subject-keyword filter — the AI reads every email and decides
 *              whether it's a real pricing enquiry).
 *
 * The BUILT workflow's first step still read:
 *
 *     Only     emails that are unread, with "(pricing|price|cost|plan|subscription)"
 *              in the subject
 *
 * So the workflow contained its own contradiction: a classifier instructed with
 * "How much for the team package?" as a POSITIVE example, sitting behind a trigger
 * that would never let that email through. Verify passed. It would have gone live
 * doing something other than what its own approved plan said.
 *
 * WHY NOTHING THE USER SAID COULD MOVE IT. The trigger is derived ONCE, in
 * `process` (`if (!triggers.length)`), from the intent as it stood before the
 * interview finished — and it is never revisited. Two mechanisms then pinned it:
 *
 *   · `mergeGeneratedSpec` prefers the draft's triggers over the model's;
 *   · `buildGeneratePrompt` seeds the model with them under "ALREADY DERIVED
 *     (reuse these exact ids and triggers — do not contradict them)".
 *
 * Both exist to stop a MACHINE rebuild overwriting what the user said, and both are
 * right for that. Neither distinguished the machine from the person, so between them
 * the trigger became the one part of a spec its owner could not change.
 *
 * Relaxed for a user revision, and ONLY for a user revision.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mergeGeneratedSpec, userRevisedThisBuild } from '../../src/converger/elicitation-graph.js';

/** The trigger `process` derived early — with the keyword filter the user rejected. */
const STALE = [{ type: 'email', filter: 'is:unread subject:(pricing|price|cost|plan|subscription)' }];
/** What `generate` emits once it is no longer told to reuse the stale one. */
const FRESH = [{ type: 'email', filter: 'is:unread' }];

const draftWith = (triggers) => ({ triggers, nodes: [], edges: [], outcome: null, name: 'W' });
const generated = (triggers) => ({ triggers, nodes: [{ id: 'n1', type: 'llm', config: {} }], edges: [] });

const mergeAs = (userRevised) =>
  mergeGeneratedSpec(draftWith(STALE), generated(FRESH), { userRevised }).triggers;

describe('the prod case', () => {
  test('a user revision lets the rebuilt trigger through', () => {
    assert.deepEqual(mergeAs(true), FRESH);
  });

  test('the filter the person rejected is gone', () => {
    assert.ok(!JSON.stringify(mergeAs(true)).includes('subject:('),
      'this is the exact string that survived on prod');
  });

  test('without a revision the draft still wins — the rule this protects', () => {
    // A whole-spec regenerate the MODEL ordered must never overwrite what the user
    // said. Losing this is a much worse bug than the one being fixed.
    assert.deepEqual(mergeAs(false), STALE);
    assert.deepEqual(mergeAs(undefined), STALE);
  });
});

describe('which passes count as a person revising something', () => {
  test('a plan approved WITH A CHANGE does', () => {
    // The prod path: "Request a change" on the plan, which reports through the
    // first_build route with its own wording.
    assert.equal(userRevisedThisBuild({ route: 'first_build', detail: 'plan approved with a change' }), true);
  });

  test('a plan approved unchanged does NOT', () => {
    assert.equal(userRevisedThisBuild({ route: 'first_build', detail: 'plan approved' }), false);
  });

  test('a change asked for at the walkthrough or at ratify does', () => {
    assert.equal(userRevisedThisBuild({ route: 'user_change_request', detail: 'add the sender' }), true);
    assert.equal(userRevisedThisBuild({ route: 'ratify_feedback', detail: 'wrong channel' }), true);
  });

  test('a rebuild the MACHINE ordered does not', () => {
    for (const route of ['verify_failed', 'blocking_gaps', 'gap_answer', 'sufficiency']) {
      assert.equal(userRevisedThisBuild({ route, detail: 'nothing reached slack:#ops' }), false, route);
    }
  });

  test('silence is not a revision', () => {
    for (const r of [null, undefined, {}, { route: '' }]) assert.equal(userRevisedThisBuild(r), false);
  });
});

describe('it cannot lose a trigger', () => {
  test('a revision with no generated trigger keeps the draft\'s', () => {
    // The model emitting nothing must never leave the workflow unstartable.
    assert.deepEqual(mergeGeneratedSpec(draftWith(STALE), generated([]), { userRevised: true }).triggers, STALE);
  });

  test('a revision does not promote an UNRUNNABLE generated trigger', () => {
    // `event` with no connector is refused by checkTriggersRunnable — swapping a
    // working trigger for one that cannot fire would publish a dead workflow.
    const junk = [{ type: 'event' }];
    assert.deepEqual(mergeGeneratedSpec(draftWith(STALE), generated(junk), { userRevised: true }).triggers, STALE);
  });

  test('an empty draft still takes the generated trigger, revision or not', () => {
    assert.deepEqual(mergeGeneratedSpec(draftWith([]), generated(FRESH), { userRevised: false }).triggers, FRESH);
  });
});

describe('the model is not told to reuse a trigger the person just changed', () => {
  const SRC = readFileSync(new URL('../../src/converger/elicitation-graph.js', import.meta.url), 'utf8');

  test('the generate prompt is seeded without it on a revision', () => {
    // Fixing only the merge leaves the prompt saying "reuse these exact triggers —
    // do not contradict them", so the model dutifully re-emits the stale filter and
    // the merge has nothing better to choose.
    assert.match(SRC, /draft:\s+userRevised \? \{ \.\.\.draft, triggers: \[\] \} : draft/);
  });

  test('both halves read ONE value', () => {
    // Computed once in the node. Two independent reads of "is this a revision?" is
    // how the prompt and the merge would come to disagree.
    assert.match(SRC, /const userRevised\s+= userRevisedThisBuild\(state\._regenReason\)/);
    assert.match(SRC, /mergeGeneratedSpec\(draft, generated, \{[\s\S]{0,120}userRevised,/);
  });
});
