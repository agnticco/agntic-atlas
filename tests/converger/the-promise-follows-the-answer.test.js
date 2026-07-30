/**
 * THE PROMISE NAMED A SPREADSHEET THE PERSON HAD NEVER HEARD OF.
 *
 * WITNESSED ON PROD, 2026-07-30 (`build-platform-1785419902877`), driving a
 * Gmail → Google Sheets logger. The contract promised:
 *
 *     record_exists → sheets:Pricing Emails
 *
 * The sheet the user named — when Atlas asked them, one turn later — was
 * **Pricing Enquiries**. Nobody ever said "Pricing Emails"; the `outcome` node made
 * it up from the opening intent, before the destination question was asked.
 *
 * So the promise could not match the step built from their answer:
 * `UNSATISFIED_ASSERTION` → THREE paid whole-spec Opus passes trying to fix a
 * workflow that was already correct → the rebuild gate refusing the fourth. The
 * workflow could not go live, and the panel showed the user
 * *"Adds a row to your spreadsheet (Pricing Emails)"*.
 *
 * THE MECHANISM. Assertions are written ONCE, by `outcome`, from the opening intent —
 * before Atlas asks which destination to use. The answer updates the STEP and nothing
 * else, so the contract keeps its opening guess forever. `refreshedOutcome`, added the
 * same morning, does NOT cover this: it fires on a user REVISION, and answering a
 * question you were asked is not a revision. Being asked is the commoner path.
 *
 * THE SAFETY PROPERTY THIS FILE EXISTS TO PROVE. Retargeting an unsatisfied promise to
 * whatever the spec happens to do would destroy the promise system: every workflow that
 * failed its contract would rewrite the contract and pass. The promise moves ONLY onto a
 * destination the person demonstrably typed. The "it must never break this" cases are
 * the second describe block, and they matter more than the fix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { setCapabilityCatalog } from '../../src/workflows/outcome-oracle.js';
import { autoRepairStructural, retargetStaleAssertion, userSuppliedValues }
  from '../../src/converger/elicitation-graph.js';

function catalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  setCapabilityCatalog(reg);
}

/** The prod spec, reduced to what decides this: one promise, one write. */
const draftWith = (target, sheet) => ({
  outcome: { statement: 'Log pricing emails', assertions: [{ id: 'a1', kind: 'record_exists', target }] },
  nodes: [
    { id: 'trig', type: 'trigger', config: {} },
    { id: 'row', type: 'deliver', config: { channel: 'sheets_append', spreadsheetId: sheet, range: 'A:E' } },
  ],
  edges: [],
});

const gapFor = (target) => ({
  id: 'g1', code: 'UNSATISFIED_ASSERTION', target,
  message: `The outcome promises "${target}" (record_exists), but no step in this workflow does that.`,
});

/** What the person typed, the way the graph records it. */
const answered = (...pairs) => pairs.map(([q, a]) => ({ q, a }));

describe('THE PROD CASE', () => {
  const ASKED = 'Which Google Sheet should I append the rows to?';

  test('the promise follows the sheet the person actually named', () => {
    catalog();
    const said = userSuppliedValues(answered([ASKED, 'Pricing Enquiries']));
    const move = retargetStaleAssertion(draftWith('sheets:Pricing Emails', 'Pricing Enquiries'), gapFor('sheets:Pricing Emails'), said);
    assert.deepEqual(move, { index: 0, target: 'sheets:Pricing Enquiries', from: 'sheets:Pricing Emails' });
  });

  test('…and the repair applies it, with no question and no rebuild', () => {
    catalog();
    const d = draftWith('sheets:Pricing Emails', 'Pricing Enquiries');
    const r = autoRepairStructural(d, [gapFor('sheets:Pricing Emails')],
      { userSaid: userSuppliedValues(answered([ASKED, 'Pricing Enquiries'])) });
    assert.equal(r.draft.outcome.assertions[0].target, 'sheets:Pricing Enquiries');
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].op, 'set_assertion_target');
    assert.equal(r.applied[0].from, 'sheets:Pricing Emails');
  });

  test('the rest of the promise is untouched — only WHERE moves', () => {
    catalog();
    const d = draftWith('sheets:Pricing Emails', 'Pricing Enquiries');
    const r = autoRepairStructural(d, [gapFor('sheets:Pricing Emails')],
      { userSaid: userSuppliedValues(answered([ASKED, 'Pricing Enquiries'])) });
    const a = r.draft.outcome.assertions[0];
    assert.equal(a.id, 'a1');
    assert.equal(a.kind, 'record_exists');
    assert.equal(r.draft.outcome.statement, 'Log pricing emails', 'their words are not ours to edit');
  });

  test('an answer that LISTS options still identifies the one that was built', () => {
    catalog();
    // People answer "Pricing Enquiries, Renewals Log" when asked. Indexing only the
    // whole answer would recognise neither, so the promise would stay stale.
    const said = userSuppliedValues(answered([ASKED, 'Pricing Enquiries, Renewals Log']));
    const move = retargetStaleAssertion(draftWith('sheets:Pricing Emails', 'Pricing Enquiries'), gapFor('sheets:Pricing Emails'), said);
    assert.equal(move?.target, 'sheets:Pricing Enquiries');
  });

  test('but a destination buried in a SENTENCE is not recognised — and that is safe', () => {
    catalog();
    // A stated limit, not an oversight. Matching a locator as a substring of free
    // prose would let a one-word destination match almost any answer, which is a
    // silently rewritten promise. Not recognising it leaves the promise stale and the
    // build fails loudly, which is the direction this must fail in.
    const said = userSuppliedValues(answered([ASKED, 'put it in Pricing Enquiries please']));
    assert.equal(retargetStaleAssertion(draftWith('sheets:Pricing Emails', 'Pricing Enquiries'), gapFor('sheets:Pricing Emails'), said), null);
  });
});

describe('IT MUST NEVER REWRITE A PROMISE THE PERSON MADE', () => {
  // This block is the reason the fix is shaped the way it is. If any of these start
  // passing a retarget, the promise system is gutted: a workflow that breaks its
  // contract would simply rewrite the contract.
  const ASKED = 'Who should I email?';

  test('a destination the person NAMED is never moved — even when BOTH are theirs', () => {
    catalog();
    // They said sam@acme.com; the model built a step to bob@acme.com. The promise is
    // right and the WORKFLOW is wrong — this must stay broken.
    //
    // BOTH addresses are in the corpus on purpose. With only one of them there, the
    // "no candidate was ever typed" test also blocks the move, and this case passes
    // without exercising the guard it exists for — measured by mutation, 2026-07-30:
    // deleting the guard left the weaker version of this test green.
    const d = {
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:sam@acme.com' }] },
      nodes: [{ id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: 'bob@acme.com', subject: 's', body: 'b' } }],
      edges: [],
    };
    const said = userSuppliedValues(answered([ASKED, 'sam@acme.com'], ['Who else is on the team?', 'bob@acme.com']));
    assert.ok(said.has('sam@acme.com') && said.has('bob@acme.com'), 'the fixture must arm the guard');
    assert.equal(retargetStaleAssertion(d, gapFor('gmail:sam@acme.com'), said), null,
      'the person named this address — moving the promise would hide a real defect');
  });

  test('when NEITHER side is in the answers, nothing moves', () => {
    catalog();
    // The commonest safe case: the destination was named in the opening message,
    // which is model-written and deliberately not admitted as evidence. With no
    // evidence either way the promise stands and the build fails, correctly.
    const d = draftWith('sheets:Q1 Leads', 'Some Other Sheet');
    const said = userSuppliedValues(answered(['What should it log?', 'date, sender, subject']));
    assert.equal(retargetStaleAssertion(d, gapFor('sheets:Q1 Leads'), said), null);
  });

  test('no answers at all means no retarget', () => {
    catalog();
    const d = draftWith('sheets:Pricing Emails', 'Pricing Enquiries');
    for (const said of [new Set(), null, undefined, userSuppliedValues([])]) {
      assert.equal(retargetStaleAssertion(d, gapFor('sheets:Pricing Emails'), said ?? new Set()), null);
    }
  });

  test('ATLAS\'S OWN bookkeeping is not evidence about the person', () => {
    catalog();
    // `clarifications` carries machine-authored entries — the gaps node's own
    // suggested answers, "(setup: …)", "(still missing)", "(plan change)". Admitting
    // them would let Atlas corroborate its own guess, which is the laundering hop
    // this codebase has paid for repeatedly.
    const said = userSuppliedValues(answered(
      ['(plan change)', 'Pricing Enquiries'],
      ['(still missing)', 'Pricing Enquiries'],
      ['(setup: sheets_append)', 'Pricing Enquiries'],
      ['(user modified deliver)', 'Pricing Enquiries'],
    ));
    assert.equal(said.size, 0, 'every one of those is Atlas talking to itself');
    assert.equal(retargetStaleAssertion(draftWith('sheets:Pricing Emails', 'Pricing Enquiries'), gapFor('sheets:Pricing Emails'), said), null);
  });

  test('two candidate destinations are ambiguous, so nothing moves', () => {
    catalog();
    // Guessing which of several the promise meant is a silently rewritten promise.
    const d = {
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Pricing Emails' }] },
      nodes: [
        { id: 'r1', type: 'deliver', config: { channel: 'sheets_append', spreadsheetId: 'Pricing Enquiries', range: 'A:E' } },
        { id: 'r2', type: 'deliver', config: { channel: 'sheets_append', spreadsheetId: 'Renewals Log', range: 'A:E' } },
      ],
      edges: [],
    };
    const said = userSuppliedValues(answered(['Which sheets?', 'Pricing Enquiries, Renewals Log']));
    assert.equal(retargetStaleAssertion(d, gapFor('sheets:Pricing Emails'), said), null);
  });

  test('a promise about a DIFFERENT kind is not retargeted, even on the SAME connector', () => {
    catalog();
    // A promise to SEND must never be settled by moving it onto a document that was
    // created. The connector matches here on purpose: with a different connector the
    // connector test blocks it anyway and the kind test is never reached — measured by
    // mutation, 2026-07-30, where deleting the kind test left the weaker version green.
    const d = {
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'docs:Nobody Reads This' }] },
      nodes: [{ id: 'doc', type: 'deliver', config: { channel: 'docs_create', title: 'Weekly Briefing' } }],
      edges: [],
    };
    const said = userSuppliedValues(answered(['What should the doc be called?', 'Weekly Briefing']));
    assert.equal(retargetStaleAssertion(d, gapFor('docs:Nobody Reads This'), said), null);
  });

  test('a promise about a different CONNECTOR is not retargeted either', () => {
    catalog();
    const d = {
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads' }] },
      nodes: [{ id: 'row', type: 'deliver', config: { channel: 'sheets_append', spreadsheetId: 'Pricing Enquiries', range: 'A:E' } }],
      edges: [],
    };
    const said = userSuppliedValues(answered(['Which sheet?', 'Pricing Enquiries']));
    assert.equal(retargetStaleAssertion(d, gapFor('airtable:Leads'), said), null);
  });

  test('a gap with no target data is never acted on', () => {
    catalog();
    // The target is DATA on the issue. Parsing it back out of the English sentence is
    // what this codebase keeps being burned by, so absent data means do nothing.
    const said = userSuppliedValues(answered(['Which sheet?', 'Pricing Enquiries']));
    const d = draftWith('sheets:Pricing Emails', 'Pricing Enquiries');
    for (const g of [{ code: 'UNSATISFIED_ASSERTION' }, { code: 'UNSATISFIED_ASSERTION', target: '' }, {}]) {
      assert.equal(retargetStaleAssertion(d, g, said), null);
    }
  });

  test('a gap of another code is left to its own repair', () => {
    catalog();
    const d = draftWith('sheets:Pricing Emails', 'Pricing Enquiries');
    const r = autoRepairStructural(d, [{ id: 'g1', code: 'DIGEST_MISSING_SECTIONS', target: 'sheets:Pricing Emails' }],
      { userSaid: userSuppliedValues(answered(['Which sheet?', 'Pricing Enquiries'])) });
    assert.deepEqual(r.applied, []);
    assert.equal(r.draft.outcome.assertions[0].target, 'sheets:Pricing Emails');
  });

  test('a promise that is ALREADY right is not churned', () => {
    catalog();
    const d = draftWith('sheets:Pricing Enquiries', 'Pricing Enquiries');
    const said = userSuppliedValues(answered(['Which sheet?', 'Pricing Enquiries']));
    assert.equal(retargetStaleAssertion(d, gapFor('sheets:Pricing Enquiries'), said), null);
  });
});

describe('what counts as something the person typed', () => {
  test('the answer to a real question does', () => {
    const s = userSuppliedValues([{ q: 'Which sheet?', a: 'Pricing Enquiries' }]);
    assert.ok(s.has('pricing enquiries'));
  });

  test('case and a leading # do not decide a match', () => {
    // "#ops" typed, "ops" stored, or the other way round.
    const s = userSuppliedValues([{ q: 'Which channel?', a: '#Ops' }]);
    const d = {
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#wrong' }] },
      nodes: [{ id: 'p', type: 'deliver', config: { channel: 'slack', target: '#ops', body: 'hi' } }],
      edges: [],
    };
    catalog();
    const move = retargetStaleAssertion(d, gapFor('slack:#wrong'), s);
    assert.equal(move?.target, 'slack:#ops');
  });

  test('an empty or missing answer is not evidence', () => {
    const s = userSuppliedValues([{ q: 'Which sheet?', a: '' }, { q: 'And?', a: '   ' }, { q: 'Hm?' }]);
    assert.equal(s.size, 0);
  });

  test('a question that is missing entirely is not admitted', () => {
    // No question means we cannot tell whether a person was answering one.
    assert.equal(userSuppliedValues([{ a: 'Pricing Enquiries' }]).size, 0);
  });

  test('junk in does not throw', () => {
    for (const input of [null, undefined, [], [null], ['nope'], [{}]]) {
      assert.doesNotThrow(() => userSuppliedValues(input));
    }
  });
});
