/**
 * THE SAME COMPLAINT, SAID DIFFERENTLY, IS STILL THE SAME COMPLAINT.
 *
 * The sufficiency route has had a repeat-guard since 2026-07-28, and it compared
 * the first 200 characters of the critic's complaint — so it only ever caught a
 * WORD-FOR-WORD repeat.
 *
 * MEASURED ON PROD, 2026-07-29 (build-platform-1785296845055). Four rebuilds of one
 * workflow, 5m24s, stopped only by the regenerate cap. Every one was the same
 * objection in new words, so every one produced a different key and the guard never
 * fired once. The four are the fixtures below, verbatim.
 *
 * This is the failure shape CLAUDE.md records over and over: a check scoped to the
 * FORM a value takes rather than to what it MEANS, defeated by one rephrasing —
 * the same thing as branching on who produced a value instead of what the value can
 * be. I wrote the exact-match version, so this is the second half of my own fix.
 *
 * The thresholds are MEASURED, not guessed, and the anti-false-positive cases below
 * are the reason: a guard that suppresses genuinely new findings would hide real
 * defects instead of a loop.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sameComplaint, complaintWords, missingKeyOf } from '../../src/converger/elicitation-graph.js';

// The four real complaints, in the order prod produced them.
const PROD = [
  "The workflow classifies the entire batch of emails as a single unit, but the intent requires classifying EACH email individually. After search_emails returns multiple emails, the workflow needs a foreach loop that processes each email separately — extracting its content, classifying it as 'needs rep",
  "Per-email classification: the workflow classifies the batch as a whole ('needs_reply_exists' or 'none'), but the intent requires classifying EACH email individually as 'needs reply' or 'FYI', then filtering to only those marked 'needs reply' before compiling the summary. The current draft has no per",
  "Per-email classification step — the workflow must classify EACH email individually as 'needs reply' or 'FYI', but the current classify_batch node judges the entire batch at once, which cannot reliably sort individual emails into separate categories for the summary.",
  "The workflow must extract individual email details (sender, subject, body) from the search results before classifying each one. Currently, search_emails returns a list of emails, but classify_batch needs to judge each email individually — there is no per-item extraction or loop to process them one a",
];

describe('the loop that actually happened is caught', () => {
  test('every consecutive rebuild is recognised as a repeat', () => {
    for (let i = 1; i < PROD.length; i++) {
      assert.ok(sameComplaint(PROD[i], PROD[i - 1]),
        `rebuild ${i + 1} was the same objection as ${i} and was not caught`);
    }
  });

  test('and so is any pair of them, in either direction', () => {
    // The guard compares against the LAST complaint, but the critic could equally
    // circle back to an earlier phrasing.
    for (let i = 0; i < PROD.length; i++) {
      for (let j = 0; j < PROD.length; j++) {
        if (i === j) continue;
        assert.ok(sameComplaint(PROD[i], PROD[j]), `pair ${i + 1}/${j + 1} escaped`);
      }
    }
  });

  test('the old exact-match key would have missed all of them', () => {
    // Not a hypothetical: this is why the loop ran to the cap.
    for (let i = 1; i < PROD.length; i++) {
      assert.notEqual(missingKeyOf(PROD[i]), missingKeyOf(PROD[i - 1]),
        'if these ever match exactly, this fixture no longer reproduces the defect');
    }
  });
});

describe('a genuinely new finding is NOT suppressed', () => {
  // The cost of getting this wrong is worse than the loop: a real defect silently
  // waved through because it happened to share some words with the last one.
  const DIFFERENT = [
    'No Slack channel is named for the approval message, so the approver would never be told.',
    'The Airtable table has no column for the summary, so the record write would drop it.',
    'There is no step that actually posts anything — the workflow ends after classifying.',
    'The schedule runs daily but the user asked for weekdays only.',
    'The branch has no catch-all, so an unexpected answer matches nothing.',
  ];

  test('none of them reads as a repeat of the per-item complaint', () => {
    for (const d of DIFFERENT) {
      for (const p of PROD) {
        assert.equal(sameComplaint(d, p), false, `suppressed a new finding: "${d}"`);
      }
    }
  });

  test('the near-miss is the one to watch', () => {
    // "There is no step that actually posts anything — the workflow ends after
    // classifying" shares `classify` and is SHORT, which inflates any ratio. It is
    // separated by the absolute shared-word count, not by the ratio.
    const near = DIFFERENT[2];
    assert.equal(sameComplaint(near, PROD[0]), false);
    const shared = [...complaintWords(near)].filter(w => complaintWords(PROD[0]).has(w));
    assert.ok(shared.length < 4, `shares ${shared.length} words (${shared}) — too close to the floor`);
  });
});

describe('the comparison itself', () => {
  test('it stems, so classify / classifies / classification agree', () => {
    const w = complaintWords('classify classifies classification classifying');
    assert.ok(w.size <= 2, `expected these to collapse, got ${[...w]}`);
  });

  test('words every complaint contains carry no signal', () => {
    for (const noise of ['workflow', 'step', 'the', 'must', 'current', 'intent']) {
      assert.ok(!complaintWords(noise).has(noise),
        `"${noise}" appears in nearly every complaint and would match anything`);
    }
  });

  test('an empty or missing complaint never matches', () => {
    // Otherwise the first sufficiency verdict of a build would suppress itself.
    assert.equal(sameComplaint(PROD[0], null), false);
    assert.equal(sameComplaint(PROD[0], ''), false);
    assert.equal(sameComplaint(null, null), false);
  });
});
