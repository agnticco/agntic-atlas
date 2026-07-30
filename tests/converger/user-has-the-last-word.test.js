/**
 * THREE THINGS A PERSON SAID, THAT THE PRODUCT THEN CONTRADICTED.
 *
 * All three witnessed on prod, 2026-07-29, in builds driven from the browser. None
 * of them corrupted a spec; each made Atlas say something that was not true of the
 * workflow it had just built, which is the one kind of wrong this product exists to
 * prevent.
 *
 *  1. THE CRITIC ARGUED WITH THE USER. Asked to stop matching pricing emails on
 *     subject keywords, the build did exactly that — and the fast-tier "is this
 *     finished?" critic ordered a whole-spec Opus rebuild saying: "The email trigger
 *     filter does not match the intent — it should filter for emails containing the
 *     keywords 'pricing', 'plans', 'cost'… not all unread emails." It reached that by
 *     reading the PRE-revision intent. It lost (a machine-ordered rebuild cannot
 *     overwrite the user's trigger) but it cost a full pass, ~$0.70, and left a
 *     contradiction in the reasoning log.
 *
 *  2. THE PROMISE WENT STALE. After that same revision the trigger correctly watched
 *     every unread email while the deal still read "When an email arrives containing
 *     pricing-related keywords". The workflow was right; the sentence describing it
 *     was wrong.
 *
 * (3 — the approval card not showing what the approver sees — is a client concern and
 * lives in `tests/api/approval-card-shows-the-draft.test.js`.)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mergeGeneratedSpec, refreshedOutcome } from '../../src/converger/elicitation-graph.js';

const SRC = readFileSync(new URL('../../src/converger/elicitation-graph.js', import.meta.url), 'utf8');

describe('a fast-tier opinion may not overrule what the person just said', () => {
  const suff = (() => {
    const i = SRC.indexOf('const contradictsUser');
    assert.ok(i > 0, 'the guard is gone — re-point this test');
    return SRC.slice(i - 7000, i + 1200);
  })();

  test('a user revision disproves the verdict, like the other two ways', () => {
    assert.match(suff, /const contradictsUser = userRevisedThisBuild\(state\._regenReason\)/);
    assert.match(suff, /if \(covered \|\| repeated \|\| contradictsUser\)/);
  });

  test('and it is recorded as its own reason, not folded into the others', () => {
    // The route that drove the most rebuilds and recorded the fewest. A third way to
    // discard a verdict that logs as one of the first two is a fourth silent route.
    assert.match(suff, /'user_revised_this_build'/);
  });

  test('the critic still RUNS — only its rebuild is refused', () => {
    // Skipping the check entirely would lose the signal it exists for. It must still
    // be asked and still be logged.
    const askAt = suff.indexOf('buildSufficiencyPrompt');
    const guardAt = suff.indexOf('const contradictsUser');
    assert.ok(askAt > 0 && askAt < guardAt, 'the verdict must be obtained before it is judged');
    assert.match(suff, /converger\.sufficiency_overruled/);
  });

  test('an ordinary build is untouched by this', () => {
    // Scoped to a revision. On every other build the critic keeps its rebuild.
    assert.doesNotMatch(suff, /contradictsUser = true/);
  });
});

describe('the sentence a person reads is brought up to date', () => {
  const DEAL = 'When an email arrives containing pricing-related keywords, draft a reply…';
  const TRUE = 'When any email arrives, AI decides whether it is a pricing enquiry…';
  const base = { statement: DEAL, assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:charles@agntic.co' }] };

  test('THE PROD CASE: a revision refreshes it', () => {
    const r = refreshedOutcome(base, { statement: TRUE }, true);
    assert.equal(r.statement, TRUE);
  });

  test('the ASSERTIONS are never DROPPED', () => {
    // The machine-checkable promise is what the user agreed to. A rebuild that could
    // rewrite it freely could quietly promise less — so a shorter set is refused
    // outright. (Since 2026-07-30 a MOVED DESTINATION is admitted; see the block
    // below for the one edit allowed and why nothing else can slip through it.)
    const r = refreshedOutcome(base, { statement: TRUE, assertions: [] }, true);
    assert.deepEqual(r.assertions, base.assertions);
  });

  test('without a revision nothing moves', () => {
    assert.equal(refreshedOutcome(base, { statement: TRUE }, false).statement, DEAL);
  });

  test('an empty or missing new statement never blanks the deal', () => {
    // A blank promise cannot be kept — the oracle has a whole guard about this.
    for (const g of [{ statement: '' }, { statement: '   ' }, {}, null, undefined]) {
      assert.equal(refreshedOutcome(base, g, true).statement, DEAL, JSON.stringify(g));
    }
  });

  test('an unchanged statement returns the very same object', () => {
    assert.equal(refreshedOutcome(base, { statement: DEAL }, true), base);
  });

  test('no outcome at all stays no outcome', () => {
    assert.equal(refreshedOutcome(null, { statement: TRUE }, true), null);
  });

  /**
   * THE PROMISE MUST DESCRIBE THE WORKFLOW THAT WAS BUILT — WITHOUT EVER
   * DESCRIBING LESS OF IT.
   *
   * Added 2026-07-30. Refreshing only the SENTENCE left the machine-checkable half
   * naming a destination the workflow no longer used. The assertions are what
   * `UNSATISFIED_ASSERTION` is measured against, so a stale one does not merely
   * read wrong — it fails a correct workflow and buys whole-spec Opus rebuilds
   * trying to "fix" what the user actually asked for.
   *
   * Exactly one edit is admitted: the same promises, about a different place.
   */
  describe('a destination the user moved', () => {
    const at = (target, extra = {}) => [{ id: 'a1', kind: 'message_sent', target, ...extra }];
    const from = { statement: DEAL, assertions: at('gmail:hello@agntic.co') };

    test('THE PROD CASE: the promise follows the recipient', () => {
      const r = refreshedOutcome(from, { statement: TRUE, assertions: at('gmail:charles@agntic.co') }, true);
      assert.deepEqual(r.assertions, at('gmail:charles@agntic.co'));
      assert.equal(r.statement, TRUE, 'both halves move together or the two disagree again');
    });

    test('and moves even when the sentence happens not to change', () => {
      // The halves are independent: a reworded destination with the same prose is
      // still a contract that no longer matches the step.
      const r = refreshedOutcome(from, { statement: DEAL, assertions: at('gmail:charles@agntic.co') }, true);
      assert.deepEqual(r.assertions, at('gmail:charles@agntic.co'));
    });

    test('but NOT without a user revision', () => {
      // A machine-ordered rebuild moving the promise is the fail-open this guards.
      const r = refreshedOutcome(from, { statement: TRUE, assertions: at('gmail:someone-else@x.co') }, false);
      assert.deepEqual(r.assertions, from.assertions);
    });

    test('a promise may not change KIND', () => {
      const r = refreshedOutcome(from, { assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads' }] }, true);
      assert.deepEqual(r.assertions, from.assertions, 'a send became a row and nobody agreed to that');
    });

    test('an unconditional promise may not become a conditional one', () => {
      // The leak that looks like a rename: gated on one lane, it is only promised
      // on that lane — weaker, while reading as a moved destination.
      const r = refreshedOutcome(from, { assertions: at('gmail:charles@agntic.co', { when: 'urgent' }) }, true);
      assert.deepEqual(r.assertions, from.assertions);
    });

    test('…and a conditional one keeps its condition', () => {
      const gated = { statement: DEAL, assertions: at('slack:#ops', { when: 'urgent' }) };
      const r = refreshedOutcome(gated, { assertions: at('slack:#alerts') }, true);
      assert.deepEqual(r.assertions, gated.assertions, 'dropping the gate widens the promise silently');
      const ok = refreshedOutcome(gated, { assertions: at('slack:#alerts', { when: 'urgent' }) }, true);
      assert.deepEqual(ok.assertions, at('slack:#alerts', { when: 'urgent' }), 'the same gate elsewhere is fine');
    });

    test('a promise may not be ADDED either', () => {
      // The user agreed to one thing; certifying against two is a different deal.
      const two = [...at('gmail:charles@agntic.co'), { id: 'a2', kind: 'record_exists', target: 'airtable:Log' }];
      assert.deepEqual(refreshedOutcome(from, { assertions: two }, true).assertions, from.assertions);
    });

    test('a template target is refused — it could never be checked', () => {
      for (const t of ['gmail:{{extract.sender}}', '{{prev}}', 'gmail:', '   ']) {
        assert.deepEqual(refreshedOutcome(from, { assertions: at(t) }, true).assertions,
          from.assertions, t);
      }
    });

    test('junk where the assertions should be changes nothing', () => {
      for (const g of [{ assertions: 'nope' }, { assertions: [null] }, { assertions: [{}] }, {}, null]) {
        assert.deepEqual(refreshedOutcome(from, g, true).assertions, from.assertions, JSON.stringify(g));
      }
    });

    test('an outcome with no assertions at all gains none', () => {
      // Silence is not an invitation to write the promise for them.
      const bare = { statement: DEAL, assertions: [] };
      assert.deepEqual(refreshedOutcome(bare, { assertions: at('gmail:x@y.co') }, true).assertions, []);
    });

    test('two promises may both move, paired by kind and gate', () => {
      const pair = { statement: DEAL, assertions: [
        { id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' },
        { id: 'a2', kind: 'record_exists', target: 'airtable:Table 1' },
      ] };
      const moved = [
        { id: 'a1', kind: 'message_sent', target: 'gmail:charles@agntic.co' },
        { id: 'a2', kind: 'record_exists', target: 'airtable:Briefings' },
      ];
      assert.deepEqual(refreshedOutcome(pair, { assertions: moved }, true).assertions, moved);
    });

    test('…and order is not what pairs them', () => {
      // The model rewrites the whole spec; the array order is not a promise.
      const pair = { statement: DEAL, assertions: [
        { id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' },
        { id: 'a2', kind: 'record_exists', target: 'airtable:Table 1' },
      ] };
      const swapped = [
        { id: 'a2', kind: 'record_exists', target: 'airtable:Briefings' },
        { id: 'a1', kind: 'message_sent', target: 'gmail:charles@agntic.co' },
      ];
      assert.deepEqual(refreshedOutcome(pair, { assertions: swapped }, true).assertions, swapped);
    });

    test('but a swap that DROPS a kind is still refused', () => {
      const pair = { statement: DEAL, assertions: [
        { id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' },
        { id: 'a2', kind: 'record_exists', target: 'airtable:Table 1' },
      ] };
      const both = [
        { id: 'a1', kind: 'message_sent', target: 'gmail:a@b.co' },
        { id: 'a2', kind: 'message_sent', target: 'slack:#ops' },
      ];
      assert.deepEqual(refreshedOutcome(pair, { assertions: both }, true).assertions, pair.assertions,
        'the record promise vanished and the count still matched');
    });

    test('an identical set returns the very same object', () => {
      assert.equal(refreshedOutcome(from, { statement: DEAL, assertions: at('gmail:hello@agntic.co') }, true), from);
    });
  });

  test('it is wired into the merge, on the same signal as the trigger', () => {
    const r = mergeGeneratedSpec(
      { triggers: [{ type: 'email', filter: 'is:unread' }], nodes: [], edges: [], outcome: base },
      { triggers: [], nodes: [{ id: 'n1', type: 'llm', config: {} }], edges: [], outcome: { statement: TRUE } },
      { userRevised: true });
    assert.equal(r.outcome.statement, TRUE);
    assert.deepEqual(r.outcome.assertions, base.assertions);
  });

  test('and the merge leaves it alone on a machine rebuild', () => {
    const r = mergeGeneratedSpec(
      { triggers: [{ type: 'email', filter: 'is:unread' }], nodes: [], edges: [], outcome: base },
      { triggers: [], nodes: [{ id: 'n1', type: 'llm', config: {} }], edges: [], outcome: { statement: TRUE } },
      { userRevised: false });
    assert.equal(r.outcome.statement, DEAL);
  });
});
