/**
 * A PERSON MUST NEVER BE ASKED TO APPROVE A STEP THEY HAVE NOT BEEN SHOWN.
 *
 * Step approval is the product's designated human safety check, and it was
 * carrying almost no information: a 58px shape, a name clipped to 18 characters
 * ("Extract email fie…", "Post to #nursing-…") and a 19px tick that appears on
 * hover. Two testers were walked through approving 11 and 13 steps and were shown
 * no card, no detail and no expansion. They clicked through every one.
 *
 * THAT IS WHY A WORSE DEFECT SAILED THROUGH. In the same run, a plan that listed
 * FOUR paths produced a workflow with THREE — from a classifier that could still
 * emit the fourth value — and the screen reported "13 / 13 APPROVED · every step
 * approved" with no hint anything was missing. The branch's mandatory catch-all
 * silently absorbed the fourth kind of work. CLAUDE.md: "The mandatory catch-all
 * is a silent-misroute DETECTOR — never let it become a masker."
 *
 * WHAT IS PINNED HERE
 *   1. the FULL, untruncated name of the step being approved;
 *   2. a plain-language sentence saying what it does;
 *   3. its concrete configuration — a delivery's real destination, an AI step's
 *      instruction, an approval's question and timeout;
 *   4. for a step that routes: EVERY route, including a value the upstream step
 *      can produce that no route names — and that case must remain visible after
 *      the last step is approved.
 *
 * WHY THIS SHAPE. `public/index.html` is one ~9,900-line page with no module
 * boundary and no build step, so there is nothing to import. These extract the
 * REAL method sources and execute them; a copy is exactly what would drift, and a
 * grep would pass against broken code. Fail-loud: a rename fails the extraction
 * rather than quietly proving nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { closedDomainOf } from '../../src/workflows/workflow-validator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/** Brace-match forward from `i` (which must sit at or before the opening brace). */
function bodyFrom(i) {
  let j = HTML.indexOf('{', i), depth = 0;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

/** The source text of one class method, by name. */
function methodSrc(name) {
  const start = HTML.indexOf('\n  ' + name + '(');
  assert.notEqual(start, -1,
    `\`${name}\` is GONE from public/index.html — re-point this extraction, do not delete the test.`);
  const end = bodyFrom(start);
  assert.ok(end > start, `could not find the end of \`${name}\``);
  return HTML.slice(start + 1, end);
}

/** The source text of one top-level function, by name. */
function functionSrc(name) {
  const start = HTML.indexOf('\nfunction ' + name + '(');
  assert.notEqual(start, -1, `top-level \`${name}\` is GONE from public/index.html`);
  const end = bodyFrom(start);
  return HTML.slice(start + 1, end);
}

const METHODS = [
  '_plainId', '_stepName', '_stepKind', '_routeDomainOf', '_branchCases', '_onRefId',
  // The ONE step-type vocabulary and the value-plaining helpers (2026-07-29).
  // `_nodeShape` delegates its wording to `_stepTypeWords`, and the cards render
  // route values through `_plainLabel`; extracting the callers without these
  // yields a half-built component that throws — which is the point of executing
  // the REAL sources rather than copying them.
  '_stepTypeWords', '_plainLabel', '_plainFilter', '_plainAge', '_plainTarget', '_plainInstruction', '_plainPreview', '_refPhrase', '_plainAsk', '_plainEventFilter', '_plainText', '_stringify', '_answersAPersonCanGive',
  '_normRoute', '_routesOf', '_unroutedValues', '_destinationOf', '_connectorOf',
  '_fact', '_stepDetail', '_approvalCard', '_approvalHint',
  '_deJargon', '_humanCron', '_tzLabel', '_titleCase', '_clip',
  '_liveNodesFromSpec', '_triggerNodeFrom',
  // `_triggerNodeFrom` delegates its fallback wording and its icon decision to these
  // (2026-07-27). Extracting it without them yields a half-built component that throws
  // — which is the point of extracting the REAL sources rather than copying them.
  '_triggerCaption', '_triggerIsMail',
  // A step's NAME and DESCRIPTION are stored sentences; "Sends to" is derived. When a
  // user rejects a proposed Slack channel and picks a real one, only the derived field
  // followed, so the card named the rejected channel while sending to the right one.
  // `_stepDetail` now reconciles the stored sentences against the live configuration
  // through these. Pinned by tests/api/rejected-channel-naming.test.js.
  '_ownChannelOf', '_realChannelsOf', '_trueChannelText', '_nodeSaidTruly',
];

/**
 * Compile the real method sources onto a stub. `effNodeType` is a module-level
 * function in the page, so it is extracted too and bound in this function's scope
 * — the DIRECT eval below can see it, exactly as the page's methods do.
 */
function component() {
  // eslint-disable-next-line no-unused-vars -- read by the evaluated method sources
  const effNodeType = eval('(' + functionSrc('effNodeType') + ')');
  const obj = eval('({\n' + METHODS.map(methodSrc).join(',\n') + '\n})');
  obj.state = { _approvedPlanCache: null };
  obj.setState = (s) => { obj._captured = Object.assign(obj._captured || {}, s); };
  return obj;
}

const C = component();

// ── the shape the defect actually had ────────────────────────────────────────
// A referral inbox: classify the email four ways, route it, approve the urgent
// ones, post them. The classifier can answer FOUR ways; the branch wires THREE.
const LONG_NAME = "Extract the patient's name, date of birth and reason for referral from the email";

function referralSpec({ wireSpam = false } = {}) {
  const cases = [
    { when: 'urgent', to: 'ask_nurse' },
    { when: 'billing', to: 'to_inbox' },
    { when: 'referral', to: 'extract_fields' },
  ];
  if (wireSpam) cases.push({ when: 'spam', to: 'ignore_it' });
  cases.push({ when: '*', to: 'ignore_it' });
  return {
    name: 'Referral triage',
    triggers: [{ type: 'email', filter: 'to:referrals@clinic.example' }],
    nodes: [
      { id: 'sort_it', type: 'llm', label: 'Sort the email',
        config: { mode: 'classify', categories: 'urgent, billing, referral, spam',
                  prompt: 'Read the email and answer with exactly one label.' } },
      { id: 'route_it', type: 'branch', label: 'Send it down the right path',
        config: { on: 'sort_it.output', cases } },
      { id: 'ask_nurse', type: 'human', label: 'Ask the duty nurse to approve it',
        config: { prompt: 'Is this referral safe to forward?', assignee: 'duty.nurse@clinic.example',
                  timeout: { after: '4h', then: 'reject' } } },
      { id: 'extract_fields', type: 'llm', label: LONG_NAME,
        config: { mode: 'extract', fields: [{ name: 'patient_name' }, { name: 'dob' }, { name: 'reason' }] } },
      { id: 'to_inbox', type: 'deliver', label: 'Save it to your Atlas inbox',
        config: { channel: 'in_app' } },
      { id: 'post_it', type: 'deliver', label: 'Post it to the urgent channel',
        config: { channel: 'slack', target: '#nursing-urgent', title: 'Urgent referral' } },
      { id: 'ignore_it', type: 'stop', label: 'Ignore it' },
    ],
    edges: [
      { from: 'sort_it', to: 'route_it' },
      { from: 'route_it', to: 'ask_nurse' }, { from: 'route_it', to: 'to_inbox' },
      { from: 'route_it', to: 'extract_fields' }, { from: 'route_it', to: 'ignore_it' },
      { from: 'ask_nurse', to: 'post_it' },
    ],
  };
}

/** The live node list the approval queue actually walks — built the production way. */
const liveNodes = (spec) => C._liveNodesFromSpec(spec);
/** The card for step `i`, built the production way (`ready` = build finished). */
const cardAt = (spec, i) => C._approvalCard(spec, liveNodes(spec), i, true);
/** Index of a step in the approval queue, by spec node id. */
const queueIndex = (spec, id) => liveNodes(spec).findIndex(n => n.id === id);

describe('the step being approved is actually shown', () => {
  const spec = referralSpec();

  test('the name is the FULL name — a name cut off mid-word is not a name', () => {
    const card = cardAt(spec, queueIndex(spec, 'extract_fields'));
    assert.equal(card.title, LONG_NAME,
      'the person is approving this step; they must see all of its name');
    assert.ok(!card.title.includes('…'), 'the name must not be truncated');
  });

  test('every step in the queue gets a card — including the trigger', () => {
    const nodes = liveNodes(spec);
    assert.equal(nodes.length, spec.nodes.length + 1, 'the trigger is an approvable step');
    nodes.forEach((n, i) => {
      const card = cardAt(spec, i);
      assert.ok(card, `step ${i + 1} (${n.id}) offered nothing to approve`);
      assert.ok(card.title && card.title.trim(), `step ${i + 1} has no name`);
      assert.ok(card.what && card.what.trim().length > 12,
        `step ${i + 1} (${n.id}) has no plain-language description`);
      assert.equal(card.position, 'STEP ' + (i + 1) + ' OF ' + nodes.length);
    });
  });

  test('a delivery names its REAL destination, not just "a delivery"', () => {
    const slack = cardAt(spec, queueIndex(spec, 'post_it'));
    assert.deepEqual(slack.facts.find(f => f.k === 'Sends to'),
      { k: 'Sends to', v: '#nursing-urgent' },
      'a person can only spot the wrong channel if the channel is on the screen');

    const emailSpec = {
      triggers: [{ type: 'manual' }],
      nodes: [{ id: 'send', type: 'deliver', label: 'Email the summary',
                config: { channel: 'gmail_send', to: 'practice.manager@clinic.example' } }],
      edges: [],
    };
    const card = cardAt(emailSpec, queueIndex(emailSpec, 'send'));
    assert.equal(card.facts.find(f => f.k === 'Sends to').v, 'practice.manager@clinic.example');
  });

  test('an AI step shows the instruction it will follow', () => {
    const card = cardAt(spec, queueIndex(spec, 'sort_it'));
    assert.equal(card.facts.find(f => f.k === 'Instruction').v,
      'Read the email and answer with exactly one label.');
    // Sentence case since 2026-07-29: the answers a classifier may give are rendered
    // through `_plainLabel`, so a lane named `urgent_complaint` reads "Urgent
    // complaint" on the card a non-technical person is asked to approve. The pin is
    // still that EVERY answer is listed, in order — only the casing moved.
    assert.equal(card.facts.find(f => f.k === 'Possible answers').v,
      'Urgent · Billing · Referral · Spam');
  });

  test('an approval step shows what is asked, of whom, and what silence means', () => {
    const card = cardAt(spec, queueIndex(spec, 'ask_nurse'));
    const f = (k) => (card.facts.find(x => x.k === k) || {}).v;
    assert.equal(f('Asks'), 'Is this referral safe to forward?');
    assert.equal(f('Who is asked'), 'duty.nurse@clinic.example');
    assert.match(f('If nobody answers'), /after 4h/);
    assert.match(f('If nobody answers'), /reject/,
      'silence is not consent — the person approving must be told what a timeout does');
  });

  test('the step is described in English, not in identifiers', () => {
    const idSpec = {
      triggers: [{ type: 'manual' }],
      nodes: [{ id: 'format_message', type: 'llm', config: { mode: 'freeform', prompt: 'Tidy it up.' } }],
      edges: [],
    };
    const card = cardAt(idSpec, queueIndex(idSpec, 'format_message'));
    // SUPERSEDED 2026-07-28 (operator: "never raw text, only plain english to
    // users"). The identifier used to be appended in parentheses so a person could
    // find the step in the spec. In practice it put `urgent_complaint`,
    // `normal_enquiry` and `spam` on the one screen whose entire purpose is that a
    // non-technical person can check the workflow BY READING it.
    assert.equal(card.title, 'Format message',
      'an unnamed step is named by what it does — the identifier stays in the codebase');
    assert.doesNotMatch(card.title, /format_message/,
      'no raw identifier reaches the person being asked to approve the step');
    assert.equal(card.kind, 'AI step — follows an instruction you wrote');
  });
});

describe('a step that routes shows EVERY route', () => {
  const spec = referralSpec();
  const card = cardAt(spec, queueIndex(spec, 'route_it'));

  test('each wired route is listed, named by the step it goes to', () => {
    const wired = card.routes.filter(r => !r.missing);
    assert.deepEqual(wired.map(r => r.label),
      ['Urgent', 'Billing', 'Referral', 'Anything else']);
    assert.deepEqual(wired.map(r => r.to),
      ['Ask the duty nurse to approve it', 'Save it to your Atlas inbox', LONG_NAME, 'Ignore it'],
      'a route names the step it reaches, not that step\'s identifier');
  });

  test('it says which step\'s answer decides the path', () => {
    assert.equal((card.facts.find(f => f.k === 'Chooses using') || {}).v,
      'the answer from “Sort the email”');
  });
});

describe('THE DEFECT: four answers, three paths — it must be impossible to miss', () => {
  const spec = referralSpec();          // spam is NOT wired
  const nodes = liveNodes(spec);

  test('the unrouted answer is named on the routing step\'s card', () => {
    const card = cardAt(spec, queueIndex(spec, 'route_it'));
    const missing = card.routes.filter(r => r.missing);
    assert.equal(missing.length, 1, 'exactly one answer has no path of its own');
    assert.equal(missing[0].label, 'Spam');
    assert.match(missing[0].to, /Anything else/,
      'the person must be told where the unhandled work would actually go');
  });

  test('and it is spelled out in a sentence, not left as a colour', () => {
    const card = cardAt(spec, queueIndex(spec, 'route_it'));
    assert.equal(card.alerts.length, 1);
    assert.match(card.alerts[0].text, /Spam/);
    assert.match(card.alerts[0].text, /no path for it/);
    assert.match(card.alerts[0].text, /Ignore it/,
      'it must say which path the unhandled work would silently take');
  });

  test('it CANNOT be presented as "every step approved" — the card survives the last tick', () => {
    const card = C._approvalCard(spec, nodes, nodes.length, true);
    assert.ok(card, 'every step approved, and the missing path vanished from the screen');
    assert.equal(card.position, 'NEEDS A LOOK');
    assert.equal(card.alerts.length, 1);
    assert.match(card.alerts[0].text, /Spam/);
  });

  test('and the status line refuses to say "every step approved"', () => {
    const n = C._unroutedValues(spec).length;
    assert.equal(n, 1);
    const hint = C._approvalHint(false, n, true, true);
    assert.notEqual(hint, 'every step approved');
    assert.match(hint, /no path/);
  });

  test('a diagram/spec mismatch still outranks it', () => {
    assert.match(C._approvalHint(true, 1, true, true), /doesn't match this workflow/);
  });
});

describe('it does not cry wolf', () => {
  const whole = referralSpec({ wireSpam: true });   // all four answers wired

  test('a workflow that handles every answer has no warning at all', () => {
    assert.deepEqual(C._unroutedValues(whole), []);
    const card = cardAt(whole, queueIndex(whole, 'route_it'));
    assert.deepEqual(card.routes.filter(r => r.missing), []);
    assert.deepEqual(card.alerts, []);
    assert.deepEqual(card.routes.map(r => r.label),
      ['Urgent', 'Billing', 'Referral', 'Spam', 'Anything else']);
  });

  test('once every step is approved there is nothing left to look at', () => {
    const nodes = liveNodes(whole);
    assert.equal(C._approvalCard(whole, nodes, nodes.length, true), null);
    assert.equal(C._approvalHint(false, 0, true, true), 'every step approved');
  });

  test('nothing is offered for approval while the build is still running', () => {
    assert.equal(C._approvalCard(whole, liveNodes(whole), 0, false), null,
      'the operator\'s 2026-07-17 rule: nothing is approvable until the build lands');
    assert.equal(C._approvalHint(false, 0, false, false), 'building…');
  });

  test('a routed-on value whose domain is NOT declared makes no coverage claim', () => {
    // A branch reading a `human` answer: approve / reject / timeout are declared,
    // and all three are wired. Nothing should be reported as unhandled.
    const gate = {
      triggers: [{ type: 'manual' }],
      nodes: [
        { id: 'ask', type: 'human', label: 'Ask a person', config: { prompt: 'OK to send?' } },
        { id: 'gate', type: 'branch', label: 'Act on the answer',
          config: { on: 'ask.decision', cases: [
            { when: 'approve', to: 'send' }, { when: 'reject', to: 'halt' },
            { when: 'timeout', to: 'halt' }, { when: '*', to: 'halt' }] } },
        { id: 'send', type: 'deliver', label: 'Send it', config: { channel: 'in_app' } },
        { id: 'halt', type: 'stop', label: 'Do nothing' },
      ],
      edges: [],
    };
    assert.deepEqual(C._unroutedValues(gate), []);

    // Now drop the timeout path: silence would quietly take the catch-all.
    gate.nodes[1].config.cases = [
      { when: 'approve', to: 'send' }, { when: 'reject', to: 'halt' }, { when: '*', to: 'halt' }];
    assert.deepEqual(C._unroutedValues(gate).map(u => u.value), ['timeout']);
  });
});

describe('the client and the engine agree on what a step can answer', () => {
  // CLAUDE.md records a rule grammar living in two functions diverging TWICE. The
  // page cannot import the engine, so the mirror is checked against the real
  // `closedDomainOf` here rather than trusted.
  const fixtures = [
    { what: 'a classifier with four labels',
      node: { id: 'a', type: 'llm', config: { mode: 'classify', categories: 'urgent, billing, referral, spam' } } },
    { what: 'a classifier with labels on separate lines',
      node: { id: 'a', type: 'llm', config: { mode: 'classify', categories: 'yes\nno\nmaybe' } } },
    { what: 'a classifier with only one label (declares nothing)',
      node: { id: 'a', type: 'llm', config: { mode: 'classify', categories: 'urgent' } } },
    { what: 'an AI step that is not a classifier',
      node: { id: 'a', type: 'llm', config: { mode: 'summarize', instructions: 'short' } } },
    { what: 'an approval step with the default answers',
      node: { id: 'a', type: 'human', config: { prompt: 'ok?' } } },
    { what: 'an approval step with declared answers',
      node: { id: 'a', type: 'human', config: { prompt: 'ok?', decisions: ['send', 'hold'] } } },
    { what: 'a decision table (first match wins)',
      node: { id: 'a', type: 'decision',
              config: { inputs: [{ key: 'amount' }], output: { key: 'tier', values: ['low', 'high'] },
                        rules: [], hitPolicy: 'FIRST' } } },
    { what: 'a decision table that collects every match',
      node: { id: 'a', type: 'decision',
              config: { inputs: [{ key: 'amount' }], output: { key: 'tier', values: ['low', 'high'] },
                        rules: [], hitPolicy: 'COLLECT' } } },
    { what: 'a delivery', node: { id: 'a', type: 'deliver', config: { channel: 'in_app' } } },
  ];

  fixtures.forEach(({ what, node }) => {
    test(what, () => {
      assert.deepEqual(C._routeDomainOf(node), closedDomainOf(node) ?? [],
        'the approval screen would claim a different set of answers than the engine enforces');
    });
  });
});

describe('the card is actually on the screen', () => {
  // `graphCanvas` in this same file is a fully-built view-model that no template
  // ever binds — dead since the live graph replaced it. A view-model nothing
  // renders is exactly how this work could be silently reverted, so the binding
  // is checked, not assumed.
  test('the template binds the card the view-model builds', () => {
    assert.match(HTML, /<sc-if value="\{\{ liveGraph\.card \}\}"/);
    assert.match(HTML, /\{\{ liveGraph\.card\.title \}\}/);
    assert.match(HTML, /\{\{ liveGraph\.card\.what \}\}/);
    assert.match(HTML, /<sc-for list="\{\{ liveGraph\.card\.facts \}\}"/);
    assert.match(HTML, /<sc-for list="\{\{ liveGraph\.card\.routes \}\}"/);
    assert.match(HTML, /<sc-for list="\{\{ liveGraph\.card\.alerts \}\}"/);
  });

  test('the view-model feeds the real derivations, not a copy', () => {
    assert.match(HTML, /card: this\._approvalCard\(S\.spec, nodes, confirmed, ready\)/);
    assert.match(HTML, /const unrouted = this\._unroutedValues\(S\.spec\)/);
    assert.match(HTML, /hint: this\._approvalHint\(lg\.mismatch, unrouted\.length, done, ready\)/);
  });
});
