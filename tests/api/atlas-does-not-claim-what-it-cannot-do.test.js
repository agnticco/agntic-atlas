/**
 * ATLAS MAY NOT AFFIRM A CAPABILITY IT DOES NOT HAVE.
 *
 * CLAUDE.md calls this "the most demo-dangerous behaviour found". Twice in one QA
 * campaign, asked for something the product cannot do, Atlas agreed and then
 * explained the mechanism in confident detail:
 *
 *   "Perfect — I can pull from your Knowledge docs in the workflow."
 *   "your form POSTs to a webhook URL that Atlas generates when the workflow is
 *    built. That URL becomes the trigger…"
 *
 * Neither exists. And it happens on the FIRST turn, in the most confident
 * register, upstream of the plan, the promise, the self-check and the publish
 * guard — every mechanism that could otherwise catch it. The product's thesis is
 * that it does not lie about what it DID; this is lying about what it CAN DO.
 *
 * BOTH ALREADY HAD PROMPT COVERAGE AND IT DID NOT HOLD. The Knowledge block said
 * "if asked, say none are set up" — the user had not asked, they had described a
 * workflow. The webhook trigger was removed from the prompt entirely and the model
 * described it anyway, because it is a plausible thing for a product like this to
 * do. A prompt is a belief about model behaviour; this is the mechanism.
 *
 * MOST OF THIS FILE IS THE OTHER DIRECTION. A guard that fires on a correct answer
 * is worse than no guard — this codebase was caught by exactly that twice in one
 * week — so the list of things it checks is CLOSED and short, and a refusal, an
 * unknown count, or a real delivery to a webhook must all pass untouched.
 *
 * ── Mutations, run by hand (2026-08-03) ─────────────────────────────────────
 *   M1  refusals no longer recognised (fires on the right answer) → 2 red
 *   M2  the knowledge count is ignored                            → 2 red
 *   M3  an unknown count is treated as zero                       → 1 red
 *   M4  the guard is not wired into the reply path                → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { capabilityClaimDecision } from '../../src/api/chat-capability-claim.js';
import { RUNNABLE_TRIGGER_TYPES } from '../../src/workflows/trigger-runnable.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILDER = readFileSync(path.join(ROOT, 'src/api/builder.js'), 'utf8');

const NONE = { knowledge: { documentCount: 0 } };
const SOME = { knowledge: { documentCount: 4 } };
const d = (reply, caps) => capabilityClaimDecision(reply, caps);

describe('the two claims that were actually witnessed', () => {
  test('a webhook URL Atlas generates', () => {
    const r = d('Your form POSTs to a webhook URL that Atlas generates when the workflow is built. That URL becomes the trigger.');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NO_WEBHOOK_TRIGGER');
    assert.match(r.reply, /schedule|email|connected app/i, 'it must say what CAN start a workflow, not only what cannot');
    assert.doesNotMatch(r.reply, /webhook trigger|RUNNABLE|trigger type/i, 'no code words in a customer-facing correction');
  });

  test('Knowledge documents in a workspace that has none', () => {
    const r = d('Perfect — I can pull from your Knowledge docs in the workflow.', NONE);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NO_KNOWLEDGE_DOCUMENTS');
    assert.match(r.reply, /Knowledge is in the left sidebar/i,
      'the ONE place the assistant may name — and it must say how to fix it');
    assert.match(r.reply, /carry on|still build/i, 'an empty shelf is not a dead end');
  });

  test('the webhook rule is derived from the runnable set, not asserted beside it', () => {
    // If a webhook trigger is ever built, this guard must stop firing on its own.
    assert.ok(!RUNNABLE_TRIGGER_TYPES.includes('webhook'),
      'a webhook trigger now exists — the guard must be removed, not left lying');
  });
});

describe('and everything a correct reply may say', () => {
  test('a REFUSAL is the sentence we want, and must survive', () => {
    // The single most important case. Punishing the right answer would train the
    // model out of the behaviour the guard exists to produce.
    for (const s of [
      "Atlas can't generate a webhook URL for you.",
      "There's no way to give you an endpoint URL — a workflow starts on a schedule or from a connected app.",
      "I don't have any documents in your Knowledge base to work from.",
    ]) assert.equal(d(s, NONE).ok, true, s);
  });

  test('a workspace that HAS documents is left alone', () => {
    assert.equal(d('I can pull from your Knowledge docs in the workflow.', SOME).ok, true);
  });

  test('an unknown count never fires — silence is not an empty shelf', () => {
    // The mirror of the defect: refusing on a number we do not have.
    for (const caps of [{}, { knowledge: {} }, { knowledge: { documentCount: null } }, undefined])
      assert.equal(d('I can use your Knowledge docs.', caps).ok, true);
  });

  test('posting TO a webhook is a real delivery channel', () => {
    // What does not exist is Atlas HANDING OUT an address; sending to one the
    // customer owns is a capability the product genuinely has.
    for (const s of [
      'I can post the summary to a webhook when it finishes.',
      'The last step sends it to your webhook.',
    ]) assert.equal(d(s).ok, true, s);
  });

  test('an ordinary reply passes untouched', () => {
    for (const s of [
      'I will email you a summary every weekday at 9am.',
      'Which Slack channel should the summary land in?',
      'Every Monday I will read your unread mail and write a digest.',
      '',
    ]) assert.equal(d(s, NONE).ok, true, s);
  });
});

describe('it is wired where the reply is composed', () => {
  test('into the chat route, on the withdraw-and-replace path', () => {
    assert.match(BUILDER, /correctInventedCapability/, 'the guard must actually run');
    assert.match(BUILDER, /if \(!correctInventedCapability\(\)\) correctInventedNavigation\(\);/,
      'it runs BEFORE the navigation backstop — a withdrawn reply has no navigation left to scrub');
  });

  test('on BOTH done paths — this endpoint has two', () => {
    // CLAUDE.md records a previous fix to this endpoint that was blind to the
    // forced-final emitter and left four guards green while the real path was
    // unprotected.
    assert.equal((BUILDER.match(/correctInventedCapability\(\)\) correctInventedNavigation/g) || []).length, 2,
      'the ordinary turn AND the forced-final turn must both be covered');
  });

  test('and it withdraws rather than appends', () => {
    const i = BUILDER.indexOf('const correctInventedCapability');
    const fn = BUILDER.slice(i, BUILDER.indexOf('};', i));
    assert.match(fn, /withdrawPartial\(\)/,
      'a correction printed under a confident design leaves the reader believing the confident part');
    assert.match(fn, /sendChunk\(d\.reply\)/);
  });
});
