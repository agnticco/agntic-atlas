/**
 * THE CHECK THAT ASKS THE WHOLE QUESTION ONCE.
 *
 * Every defect in the destination family has been two things Atlas already knew,
 * disagreeing, with nothing comparing them — and every one was found by a person
 * reading a screen carefully, days later, one at a time. This pins the check that asks
 * all of it at the end of every build.
 *
 * THE FIXTURES ARE THE REAL BUILDS, not invented ones. Three prod builds from
 * 2026-07-30 drive this file:
 *
 *   · `build-platform-1785414984862` — a daily AI-news briefing whose promise said
 *     `hello@agntic.co` while the only send went to `charles@agntic.co`.
 *   · `build-platform-1785419902877` — a Gmail→Sheets logger promising a sheet called
 *     "Pricing Emails" that nobody had ever mentioned; the user said "Pricing Enquiries".
 *   · `build-platform-1785424166123` — a cybersecurity briefing that passed cleanly and
 *     went live.
 *
 * The third is the most important test in the file. **A check that fires on a good
 * build is worse than no check**, because an ignored warning looks like cover. Every
 * assertion about what it does NOT report is doing more work than the ones about what
 * it does.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { setCapabilityCatalog } from '../../src/workflows/outcome-oracle.js';
import { selfContradictions, summariseContradictions, destinationsNamedIn }
  from '../../src/workflows/self-consistency.js';

function catalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  setCapabilityCatalog(reg);
}

const codes = (spec) => selfContradictions(spec).map(f => f.code);
const errors = (spec) => selfContradictions(spec).filter(f => f.severity === 'error');

// ── THE THREE REAL BUILDS ────────────────────────────────────────────────────

/** `build-platform-1785414984862`. Promise says hello@; the only send goes to charles@. */
const AI_NEWS = {
  outcome: {
    statement: 'Every day at 6:00am Central time, search the web for the latest AI news, summarise the top stories into a clean briefing, and send it as an email to hello@agntic.co.',
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' }],
  },
  nodes: [
    { id: 'search', type: 'connector-action', label: 'Search web for AI news', config: { action: 'web_search', query: 'ai news' } },
    { id: 'sum', type: 'llm', label: 'Summarise', config: { mode: 'summarize' } },
    { id: 'send', type: 'deliver', label: 'Email briefing to charles@agntic.co',
      config: { channel: 'gmail_send', to: 'charles@agntic.co', subject: 'Daily AI News Briefing', body: '' } },
  ],
  edges: [],
};

/** `build-platform-1785419902877`. The promise names a sheet nobody mentioned. */
const SHEETS = {
  outcome: {
    statement: "When a new email arrives, check whether it is about pricing and append a row to the 'Pricing Enquiries' Google Sheet.",
    assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Pricing Emails' }],
  },
  nodes: [
    { id: 'row', type: 'deliver', label: 'Append row', config: { channel: 'sheets_append', spreadsheetId: 'Pricing Enquiries', range: 'A:E' } },
  ],
  edges: [],
};

/** `build-platform-1785424166123`. Passed on prod, contract kept, went live. */
const CYBER = {
  outcome: {
    statement: 'Every weekday at 7:00am Central time, search the web for top cybersecurity news, summarize the key stories into a short briefing, and email it to hello@agntic.co with a subject line that includes the current date.',
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' }],
  },
  nodes: [
    { id: 'search', type: 'connector-action', label: 'Search cybersecurity news', config: { action: 'web_search', query: 'cyber' } },
    { id: 'subj', type: 'llm', label: 'Generate subject line', config: { mode: 'rewrite' } },
    { id: 'sum', type: 'llm', label: 'Summarise into email briefing', config: { mode: 'summarize' } },
    { id: 'mail', type: 'deliver', label: 'Email hello@agntic.co',
      config: { channel: 'gmail_send', to: 'hello@agntic.co', subject: 'Your Daily Cybersecurity Briefing', body: '' } },
  ],
  edges: [],
};

describe('THE BUILD THAT PASSED IS SILENT', () => {
  test('a workflow that agrees with itself produces NOTHING', () => {
    // The most important assertion here. A check that fires on a good build teaches
    // people to ignore it, and an ignored check is worse than none because it looks
    // like cover. This build went live on prod with its contract kept.
    catalog();
    assert.deepEqual(selfContradictions(CYBER), []);
    assert.equal(summariseContradictions(selfContradictions(CYBER)), 'this build agrees with itself');
  });

  test('…including the note about writes nothing promised', () => {
    // Its one send IS promised, so even the lowest-severity note must stay quiet.
    catalog();
    assert.deepEqual(codes(CYBER), []);
  });
});

describe('THE AI-NEWS BUILD: the promise and the only send name different people', () => {
  test('it is reported, naming the address the customer was shown', () => {
    catalog();
    const e = errors(AI_NEWS);
    assert.equal(e.length, 1);
    assert.equal(e[0].code, 'STATEMENT_NAMES_ELSEWHERE');
    assert.match(e[0].message, /hello@agntic\.co/);
  });

  test('the message says what a person can act on, not what a function returned', () => {
    catalog();
    const [e] = errors(AI_NEWS);
    assert.match(e.message, /no step in it does/);
    assert.doesNotMatch(e.message, /assertion|locator|UNSATISFIED/i);
  });

  test('and the send nobody promised is noted separately', () => {
    catalog();
    assert.ok(codes(AI_NEWS).includes('WRITE_UNPROMISED'));
  });

  test('a trailing full stop is not part of an address', () => {
    // A false positive the checker invented on its FIRST run against this build: the
    // sentence ends "…to hello@agntic.co." and the address matcher swallowed the stop,
    // so the promise was reported as differing from itself. Precision is the whole
    // point of this file — an invented contradiction costs more than a missed one.
    assert.deepEqual(destinationsNamedIn('send it to hello@agntic.co.'), ['hello@agntic.co']);
    assert.ok(!errors(AI_NEWS).some(e => e.code === 'PROMISE_AND_SENTENCE_DIFFER'),
      'the sentence and the promise BOTH say hello@ — there is no contradiction between them');
  });
});

describe('THE SHEETS BUILD: the two halves of one promise name different places', () => {
  test('it is reported, naming both sides', () => {
    catalog();
    const e = errors(SHEETS);
    assert.equal(e.length, 1);
    assert.equal(e[0].code, 'PROMISE_AND_SENTENCE_DIFFER');
    assert.match(e[0].message, /Pricing Enquiries/);
    assert.match(e[0].message, /Pricing Emails/);
  });

  test('this is the defect that cost three Opus passes and a refusal', () => {
    catalog();
    assert.ok(errors(SHEETS).length > 0,
      'the build was internally valid and publishable — only this comparison finds it');
  });
});

describe('what it refuses to guess at', () => {
  // Silence on anything undecidable. Each of these was a real source of noise or of a
  // wrong verdict elsewhere in the oracle's history.

  test('a template destination is not a contradiction', () => {
    catalog();
    const spec = {
      outcome: { statement: 'Email the sender at their address.',
                 assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:{{extract.sender}}' }] },
      nodes: [{ id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: '{{extract.sender}}', subject: 's', body: 'b' } }],
      edges: [],
    };
    // It IS flagged as uncheckable — that is a different and true statement — but never
    // as the two halves disagreeing.
    assert.ok(!codes(spec).includes('STATEMENT_NAMES_ELSEWHERE'));
    assert.ok(codes(spec).includes('PROMISE_UNCHECKABLE'));
  });

  test('an opaque provider id is not compared with a human name', () => {
    // "airtable:Table 1" against `tblbQ0PmkA2o1P17Q` names one table; only Airtable can
    // say so. Reporting it would repeat the 2026-07-28 defect as a warning.
    catalog();
    const spec = {
      outcome: { statement: "Add a row to the 'Companies' table.",
                 assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Companies' }] },
      nodes: [{ id: 'r', type: 'connector-action', config: { action: 'airtable_create_record', tableId: 'tblbQ0PmkA2o1P17Q', baseId: 'appXXXXXXXXXXXXXX' } }],
      edges: [],
    };
    assert.ok(!codes(spec).includes('STATEMENT_NAMES_ELSEWHERE'));
  });

  test('prose that names no destination produces nothing', () => {
    // "the sheet", "my calendar", "them" — nothing comparable. Mining free prose is how
    // a check starts crying wolf.
    assert.deepEqual(destinationsNamedIn('Log it in the sheet and put a hold on my calendar, then tell them.'), []);
  });

  test('a workflow with no promise at all is not accused of anything', () => {
    catalog();
    assert.deepEqual(errors({ outcome: null, nodes: [{ id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: 'a@b.co', subject: 's', body: 'b' } }], edges: [] }), []);
  });

  test('junk in does not throw', () => {
    catalog();
    for (const spec of [null, undefined, {}, { nodes: null }, { outcome: { assertions: 'no' }, nodes: [] }]) {
      assert.doesNotThrow(() => selfContradictions(spec), JSON.stringify(spec));
    }
  });
});

describe('the promise that can never be checked', () => {
  test('a connector with no destination after it is called out', () => {
    catalog();
    const spec = {
      outcome: { statement: 'Put it somewhere in Gmail.', assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:' }] },
      nodes: [{ id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: 'a@b.co', subject: 's', body: 'b' } }],
      edges: [],
    };
    const f = selfContradictions(spec).find(x => x.code === 'PROMISE_UNCHECKABLE');
    assert.ok(f, 'any delivery to gmail would satisfy this — the promise proves nothing');
    assert.equal(f.severity, 'warning');
  });
});

describe('a write inside a loop is still a write', () => {
  test('the check looks inside a foreach', () => {
    // Three separate P12 defects were "added to the top-level executor, not the foreach
    // sub-loop". A check that cannot see into a loop would be blind to the shape the
    // loop exists for.
    catalog();
    const spec = {
      outcome: { statement: 'Email every lead at hello@agntic.co.',
                 assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' }] },
      nodes: [{ id: 'loop', type: 'foreach', config: { steps: [
        { id: 's', type: 'deliver', label: 'Email each lead', config: { channel: 'gmail_send', to: 'someone-else@acme.com', subject: 's', body: 'b' } },
      ] } }],
      edges: [],
    };
    assert.ok(codes(spec).includes('STATEMENT_NAMES_ELSEWHERE'),
      'the only send is inside the loop, and it goes somewhere the promise never mentions');
  });
});

describe('AN APPROVAL STEP\'S QUESTION IS A DELIVERY', () => {
  // Found by mutation before this check ever ran on prod. A `human` node sends its own
  // DM — which is why an approval workflow has no separate send for it, established
  // 2026-07-28 when a kept promise was certified as unproven for exactly this reason.
  // It has no `nodeEffect`, so the commonest approval shape in the product reported its
  // own approver as "a destination no step uses".
  const APPROVAL = {
    outcome: {
      statement: 'When a pricing email arrives, draft a reply and ask charles@agntic.co on Slack to approve it before sending.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:charles@agntic.co' }],
    },
    nodes: [
      { id: 'draft', type: 'llm', label: 'Draft reply', config: { mode: 'rewrite' } },
      { id: 'ask', type: 'human', label: 'Ask Charles to approve',
        config: { prompt: 'Approve?', channels: [{ type: 'slack', target: 'charles@agntic.co' }] } },
    ],
    edges: [],
  };

  test('a correct approval workflow is silent', () => {
    catalog();
    assert.deepEqual(selfContradictions(APPROVAL), [],
      'the approver is reached by the question itself — that is not a contradiction');
  });

  test('but an approval sent to someone the promise never named is still caught', () => {
    catalog();
    const wrong = { ...APPROVAL, nodes: [APPROVAL.nodes[0],
      { ...APPROVAL.nodes[1], config: { prompt: 'Approve?', channels: [{ type: 'slack', target: 'someone-else@agntic.co' }] } }] };
    assert.ok(codes(wrong).includes('STATEMENT_NAMES_ELSEWHERE'),
      'excusing the ask must not excuse asking the WRONG person');
  });

  test('an EMAIL ask is not counted as a connector delivery', () => {
    // Inherited whole from the oracle's own rule: an email ask is a platform magic
    // link, not the tenant's Gmail connector. Counting it here would contradict the
    // half that refuses it.
    catalog();
    const byEmail = { ...APPROVAL, nodes: [APPROVAL.nodes[0],
      { ...APPROVAL.nodes[1], config: { prompt: 'Approve?', channels: [{ type: 'email', target: 'charles@agntic.co' }] } }] };
    assert.ok(codes(byEmail).includes('STATEMENT_NAMES_ELSEWHERE'));
  });
});

describe('A PLACE THE WORKFLOW LISTENS TO IS NOT A PLACE IT WRITES', () => {
  /**
   * WITNESSED ON PROD 2026-07-30 — by this check, about a correct workflow, on its
   * second day live. "When someone posts in #atlas-test-temp with the word urgent,
   * email me" produced *"The promise tells the customer this workflow delivers to
   * "#atlas-test-temp", but no step in it does"*. The channel is the SOURCE; the only
   * destination is the email.
   *
   * That is the crying-wolf failure this file's header warns about, produced by this
   * file. A destination named in the promise's sentence is only missing if the workflow
   * does not mention it AT ALL — naming where it listens is not a contradiction.
   */
  const SLACK_TRIGGERED = {
    triggers: [{ type: 'event', connector: 'slack', event: 'slack_message',
                 channel: '#atlas-test-temp', keywords: 'urgent' }],
    outcome: {
      statement: "When a message containing the word 'urgent' is posted in #atlas-test-temp, extract the sender's name and message text, then email hello@agntic.co with the subject 'Urgent message in #atlas-test-temp'.",
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' }],
    },
    nodes: [
      { id: 'extract', type: 'llm', label: 'Extract sender and text', config: { mode: 'extract' } },
      { id: 'mail', type: 'deliver', label: 'Email hello@agntic.co',
        config: { channel: 'gmail_send', to: 'hello@agntic.co', subject: 'Urgent message' } },
    ],
    edges: [{ from: 'extract', to: 'mail' }],
  };

  test('the channel a workflow LISTENS to is not reported as a missing destination', () => {
    catalog();
    assert.deepEqual(selfContradictions(SLACK_TRIGGERED), []);
  });

  test('but a destination named NOWHERE in the workflow is still caught', () => {
    catalog();
    const wrong = { ...SLACK_TRIGGERED, outcome: { ...SLACK_TRIGGERED.outcome,
      statement: "…then email hello@agntic.co and also post it to #somewhere-else." } };
    assert.ok(codes(wrong).includes('STATEMENT_NAMES_ELSEWHERE'),
      'excusing the trigger must not excuse a channel nothing mentions');
  });
});

describe('the guards that stop it crying wolf', () => {
  test('a promise about a SHEET is not compared with an address in the sentence', () => {
    // Two destinations of different shapes are not two versions of one destination. A
    // workflow that emails someone AND logs a row legitimately names both.
    catalog();
    const spec = {
      outcome: { statement: 'Email sam@acme.com and log it in the tracker.',
                 assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Tracker' }] },
      nodes: [
        { id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: 'sam@acme.com', subject: 's', body: 'b' } },
        { id: 'r', type: 'deliver', config: { channel: 'sheets_append', spreadsheetId: 'Tracker', range: 'A:C' } },
      ],
      edges: [],
    };
    assert.ok(!codes(spec).includes('PROMISE_AND_SENTENCE_DIFFER'),
      'an address and a sheet name are not rival spellings of one place');
  });

  test('a write INSIDE a loop counts as satisfying the promise', () => {
    // The other direction of the foreach walk. Without it the loop's write is invisible,
    // so a correct workflow is reported as delivering nowhere.
    catalog();
    const spec = {
      outcome: { statement: "Add each lead to the 'Leads' sheet.",
                 assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Leads' }] },
      nodes: [{ id: 'loop', type: 'foreach', config: { steps: [
        { id: 's', type: 'deliver', label: 'Add row', config: { channel: 'sheets_append', spreadsheetId: 'Leads', range: 'A:C' } },
      ] } }],
      edges: [],
    };
    assert.deepEqual(selfContradictions(spec), [],
      'the write is inside the loop, and it is exactly what was promised');
  });
});

describe('the check that guards the two halves', () => {
  /**
   * SOURCE-LEVEL, AND WEAKER THAN EVERYTHING ELSE IN THIS FILE — said plainly so nobody
   * mistakes it for a behavioural pin.
   *
   * `HALVES_DISAGREE` compares the build-time and run-time answers about the same
   * promise. Today they agree on every capability, spelling and pairing — that is what
   * `build-and-runtime-agree-everywhere.test.js` proves — so no fixture built from real
   * capabilities can make this fire. It exists as a REGRESSION detector: the moment the
   * two drift again (eight times so far), it fires on the actual build instead of a
   * person finding it days later.
   *
   * Replace this with a behavioural check if a legitimate disagreement ever becomes
   * constructible; do not delete it because it cannot be exercised.
   */
  test('both halves are actually consulted, and their answers compared', () => {
    const src = readFileSync(new URL('../../src/workflows/self-consistency.js', import.meta.url), 'utf8');
    const at = src.indexOf('HALVES_DISAGREE');
    assert.ok(at > 0, 'the check is gone — re-point this test, do not delete it');
    const body = src.slice(Math.max(0, at - 700), at);
    assert.match(body, /satisfiesAssertion\(a, node\)/, 'the build-time half must be asked');
    assert.match(body, /checkAssertionAtRuntime\(a, \[normalizeDelivery\(/, 'the run-time half must be asked');
    assert.match(body, /if \(build === run\) continue;/, 'and the two answers compared');
  });

  test('it is reported as an error, because it certifies what it will later fail', () => {
    const src = readFileSync(new URL('../../src/workflows/self-consistency.js', import.meta.url), 'utf8');
    assert.match(src, /finding\('HALVES_DISAGREE', 'error'/);
  });
});

describe('the summary a person reads', () => {
  test('it counts what was found', () => {
    catalog();
    assert.match(summariseContradictions(selfContradictions(AI_NEWS)), /1 error/);
  });

  test('and says so plainly when there is nothing', () => {
    assert.equal(summariseContradictions([]), 'this build agrees with itself');
  });
});
