/**
 * Atlas may not offer to produce something the workflow will not produce.
 *
 * OPERATOR, 2026-07-28: "This can never happen, especially if a google doc is a
 * piece of the contract."
 *
 * Witnessed on a two-source briefing build. Nobody asked for a Google Doc; Atlas
 * introduced one in the reply the user reads — "summarise both into a single
 * Google Doc with a section for each, and post the doc (or its content) to
 * #atlas-test-temp" — and then built an AI compose step and a Slack post. No
 * document was created anywhere. The hedge, "(or its content)", is the tell that
 * the sentence was never grounded in anything.
 *
 * Nothing the user asked for was lost, which is what makes it dangerous: it fails
 * the "looks like success" test. Someone who reads that offer and approves it
 * believes a document exists.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { unbackedArtifacts, artifactCorrectionFor } from '../../src/api/chat-artifact-guard.js';

// Verbatim from the build that prompted the directive.
const REPLY = 'Every Monday at 8am it will: (1) search the web for the top AI automation '
  + 'headlines, (2) pull your unread Gmail from the previous Friday evening through to '
  + 'Monday morning, (3) summarise both into a single Google Doc with a section for each, '
  + 'and (4) post the doc (or its content) to #atlas-test-temp.';
const INTENT = 'Every Monday at 8am, search the web for AI automation headlines and '
  + 'summarise unread weekend email, combine them into a two-section briefing and post it '
  + 'to #atlas-test-temp.';

describe('the witnessed case', () => {
  test('the ungrounded Google Doc is caught', () => {
    const found = unbackedArtifacts(REPLY, INTENT);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 'google_doc');
  });

  test('the correction names the artifact and both honest ways out', () => {
    const c = artifactCorrectionFor(unbackedArtifacts(REPLY, INTENT));
    assert.match(c, /google doc/i);
    assert.match(c, /add the .* to build_intent/i, 'either really build it…');
    assert.match(c, /stop mentioning it/i, '…or stop promising it');
  });
});

describe('a grounded promise is left completely alone', () => {
  test('when the build really will create the doc, the offer stands', () => {
    const intent = INTENT.replace('a two-section briefing', 'a Google Doc');
    assert.deepEqual(unbackedArtifacts(REPLY, intent), []);
    assert.equal(artifactCorrectionFor(unbackedArtifacts(REPLY, intent)), null);
  });

  test('an artifact named in the intent under a different word still counts', () => {
    const reply = 'I will compile it all into a Google Document and share it.';
    const intent = 'compile the results into a google doc';
    assert.deepEqual(unbackedArtifacts(reply, intent), []);
  });
});

describe('it does not fire on things that are not being created', () => {
  test('READING a document is not promising to make one', () => {
    const reply = 'I will read the pricing PDF you connected and pull the figures out.';
    assert.deepEqual(unbackedArtifacts(reply, 'read the pricing file and extract figures'), []);
  });

  test('refusing to make one is not promising to make one', () => {
    const reply = 'Atlas cannot produce a PDF yet. I will post the summary to Slack instead.';
    const found = unbackedArtifacts(reply, 'post the summary to slack');
    // KNOWN AND ACCEPTED: the clause really does pair "produce" with "PDF", so a
    // refusal is flagged like a promise. The cost is one unnecessary re-ask, and
    // the model's second attempt says the same true thing. Erring the other way
    // would let a real promise through, which is the failure this exists to stop.
    assert.equal(found.length, 1, 'a false positive here costs a re-ask, not a lie');
  });

  test('naming the service without creating an artifact is fine', () => {
    const reply = 'Your Google Workspace account is connected, so I can read your mail.';
    assert.deepEqual(unbackedArtifacts(reply, 'read mail'), []);
  });
});

describe('it never destroys the reply', () => {
  test('an empty or missing reply is handled', () => {
    assert.deepEqual(unbackedArtifacts('', INTENT), []);
    assert.deepEqual(unbackedArtifacts(null, INTENT), []);
    assert.equal(artifactCorrectionFor([]), null);
  });

  test('the reply is never mutated — enforcement is a re-ask, not an edit', () => {
    // Cutting the sentence deletes the whole offer; cutting the clause leaves
    // "post the doc" referring to something no longer mentioned. A mangled offer
    // is not an improvement on a wrong one, so the model rewrites it instead.
    const c = artifactCorrectionFor(unbackedArtifacts('I will create a Google Doc.', 'post to slack'));
    assert.match(c, /Rewrite the reply/i);
  });

  test('a missing build_intent does not make everything ungrounded', () => {
    // With no intent to check against we cannot prove absence, and guessing would
    // strip legitimate offers. Proof of absence, not absence of proof.
    const found = unbackedArtifacts(REPLY, '');
    assert.equal(found.length, 1, 'with no intent to check against, the noun still stands out');
  });
});
