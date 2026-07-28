/**
 * A CHANNEL THE PERSON REJECTED MUST NOT BE NAMED ANYWHERE ON THE SCREEN.
 *
 * Two testers were each offered a Slack channel that does not exist, both DECLINED
 * creating it, and both picked a real channel instead. Both got a workflow that
 * SENDS TO THE RIGHT PLACE while five surfaces still named the channel they had
 * just rejected:
 *
 *   1. the label under the node in the diagram
 *   2. the approval card's title
 *   3. the approval card's description
 *   4. the description of the step BEFORE the delivery
 *   5. the workflow's own promise ("What this must deliver")
 *
 * The machine configuration underneath is CORRECT — `applyResourcePick`
 * (src/converger/elicitation-graph.js) repoints `config.target` and the outcome's
 * assertion targets. Nothing rewrites the prose, deliberately: after a pick the
 * build re-enters gap scoring rather than `generate`, because regenerating would
 * re-hallucinate the very channel that does not exist. So this is prose drifting
 * from truth on the exact screen that was rebuilt so a non-technical person could
 * catch mistakes BY READING — and the promise card contradicted itself, its
 * headline naming the rejected channel while its own bullets underneath named the
 * real one.
 *
 * HOW THE SCENARIO IS BUILT. Not by hand-writing a "post-pick" spec — that would
 * assume the very rewrite under test. The REAL converger graph is driven with a
 * stub model, exactly the way `tests/converger/resource-resolution.test.js` does:
 * the model builds a delivery to `#does-not-exist`, the resource clarification is
 * answered with `#real-channel`, and the converged spec is what the screen is then
 * asked to render.
 *
 * WHY THE UI HALF IS SHAPED THIS WAY. `public/index.html` is one ~10,400-line page
 * with no module boundary and no build step, so there is nothing to import. The
 * REAL method sources are extracted and executed — the pattern
 * `tests/api/step-approval-card.test.js` established. A copy is exactly what would
 * drift, and a grep would pass against broken code.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir }         from 'node:os';
import { fileURLToPath }  from 'node:url';
import path               from 'node:path';

import { createConverger } from '../../src/converger/index.js';
import { realCatalog }     from '../helpers/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const REJECTED = '#does-not-exist';
const PICKED   = '#real-channel';

// ── the page's real derivations, compiled out of the page ─────────────────────

function bodyFrom(i) {
  let j = HTML.indexOf('{', i), depth = 0;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}
function methodSrc(name) {
  const start = HTML.indexOf('\n  ' + name + '(');
  assert.notEqual(start, -1,
    `\`${name}\` is GONE from public/index.html — re-point this extraction, do not delete the test.`);
  const end = bodyFrom(start);
  assert.ok(end > start, `could not find the end of \`${name}\``);
  return HTML.slice(start + 1, end);
}
function functionSrc(name) {
  const start = HTML.indexOf('\nfunction ' + name + '(');
  assert.notEqual(start, -1, `top-level \`${name}\` is GONE from public/index.html`);
  return HTML.slice(start + 1, bodyFrom(start));
}

const METHODS = [
  // the three code paths under test
  '_liveGraphLayout', '_liveCardFor', '_stepDetail', '_outcomeStatementTruly',
  // the reconciliation itself
  '_ownChannelOf', '_realChannelsOf', '_trueChannelText', '_nodeSaidTruly',
  // everything they lean on
  '_plainId', '_stepName', '_stepKind', '_routeDomainOf', '_branchCases', '_onRefId',
  '_normRoute', '_routesOf', '_unroutedValues', '_destinationOf', '_connectorOf',
  '_fact', '_approvalCard', '_approvalHint', '_liveShapeOf', '_nodeShape',
  '_deJargon', '_humanCron', '_titleCase', '_clip', '_dealSegments',
  '_liveNodesFromSpec', '_triggerNodeFrom',
  // `_triggerNodeFrom` delegates its fallback wording and its icon decision to these
  // (2026-07-27). Extracting it without them yields a half-built component that throws
  // — which is the point of extracting the REAL sources rather than copying them.
  '_triggerCaption', '_triggerIsMail',
];

function component() {
  // eslint-disable-next-line no-unused-vars -- read by the evaluated method sources
  const effNodeType = eval('(' + functionSrc('effNodeType') + ')');
  const obj = eval('({\n' + METHODS.map(methodSrc).join(',\n') + '\n})');
  obj.state = { _approvedPlanCache: null };
  obj.setState = (s) => { obj._captured = Object.assign(obj._captured || {}, s); };
  return obj;
}
const C = component();

// ── the scenario, built the way production builds it ──────────────────────────

const J = (o) => ({ content: JSON.stringify(o) });

// The model writes the destination into FIVE places in one pass. Only `config.target`
// is machine-readable; the other four are prose. The diagram clips a node's label to
// 18 characters, so the delivery's label is one a person would actually see whole.
const DELIVER_LABEL   = `To ${REJECTED}`;                                                 // 1 + 2
const DELIVER_DESC    = `Posts the summary into the ${REJECTED} channel in Slack.`;       // 3
const UPSTREAM_DESC   = `Shortens the shipment update so it reads well in ${REJECTED}.`;  // 4
const STATEMENT       = `Every UPS shipment email is summarized and posted to ${REJECTED}.`; // 5

const llm = { invoke: async (msgs) => {
  const p = String(msgs[msgs.length - 1].content);
  if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1',
    statement: STATEMENT,
    assertions: [{ id: 'a1', kind: 'message_sent', target: `slack:${REJECTED}` }] }] });
  if (p.includes('What starts this workflow')) return J({ trigger: { type: 'email', filter: 'from:ups.com' } });
  if (p.includes('CONCRETE example cases'))    return J({ examples: [] });
  if (p.includes('Analyze this automation intent')) return J({ ready: true });
  if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
  if (p.includes('cases nobody has decided about')) {
    const ids = [...p.matchAll(/^ {2}- id: (\S+)$/gm)].map(m => m[1]);
    return J({ suggestions: ids.map(id => ({ gapId: id, answer: 'retry then tell a person' })) });
  }
  if (p.includes('Build the COMPLETE workflow')) {
    return J({ name: 'UPS digest', triggers: [{ type: 'email', filter: 'from:ups.com' }],
      nodes: [
        { id: 'sum',  type: 'llm', label: 'Summarize it', description: UPSTREAM_DESC,
          config: { mode: 'summarize', instructions: 'Summarize the shipment update.' } },
        { id: 'post', type: 'deliver', label: DELIVER_LABEL, description: DELIVER_DESC,
          config: { channel: 'slack', target: REJECTED, title: 'Shipment update' } },
      ],
      edges: [{ from: 'sum', to: 'post' }] });
  }
  return J({});
} };

/**
 * Run the real graph, decline creating `#does-not-exist`, pick `#real-channel`,
 * and return the converged spec — i.e. exactly what the screen is handed.
 */
async function pickedSpec() {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-rcn-'));
  try {
    const conv = createConverger({
      llm,
      capabilities: {
        channels: realCatalog().getAll().map(c => ({ ...c, available: true })),
        connectors: { slack: { connected: true }, airtable: { connected: false } },
        slackChannels: ['real-channel'],          // #does-not-exist is NOT one of them
      },
      invokeCapability: null,
      checkpointerDir: dir,
    });
    const replyFor = (iv) => {
      switch (iv.type) {
        case 'outcome_check':   return { id: 'c1' };
        case 'example_request': return { type: 'skip' };
        // The client sends a chip click as the chip's LABEL. This is the decline:
        // the Create chip is on offer and the person picks the real channel instead.
        case 'clarification':   return iv.kind === 'resource_fix'
          ? { answer: PICKED }
          : { answer: 'retry then tell a person' };
        case 'proposal':        return { type: 'approve' };
        case 'ratify':          return { type: 'approve' };
        default:                return { type: 'accept' };
      }
    };
    let iv;
    try { await conv.run('rcn', 'summarize UPS emails to slack'); iv = { type: 'done' }; }
    catch (err) { iv = err.interruptValue ?? err; }
    for (let i = 0; i < 60 && iv?.type !== 'done'; i++) iv = await conv.resume('rcn', replyFor(iv));
    return iv?.spec ?? null;
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

const SPEC = await pickedSpec();

// The screen is driven exactly as the view-model drives it (public/index.html:
// `liveGraph` builds `nodes` from `S.liveNodes`, which is `_liveNodesFromSpec(spec)`).
const LIVE     = C._liveNodesFromSpec(SPEC);
const idxOf    = (id) => LIVE.findIndex(n => n.id === id);
const diagram  = () => C._liveGraphLayout(SPEC, LIVE, LIVE.length, -1, false, true, null).nodes;
const cardFor  = (id) => C._approvalCard(SPEC, LIVE, idxOf(id), true);

describe('the scenario really is the one the testers hit', () => {
  test('the pick landed: the workflow is CONFIGURED to send to the real channel', () => {
    assert.ok(SPEC, 'the build converged to a spec');
    const post = SPEC.nodes.find(n => n.id === 'post');
    assert.equal(post.config.target, PICKED,
      'the real configuration must be repointed — if this fails the premise is gone, not the fix');
    const a = (SPEC.outcome?.assertions ?? []).find(x => /^slack:/.test(x.target || ''));
    assert.equal(a.target, `slack:${PICKED}`, 'the outcome assertion follows the delivery');
  });

  test('and the model really did write the rejected channel into the prose', () => {
    // Guards the fixture itself: if the graph ever stops carrying node descriptions
    // through, this test would pass vacuously against nothing.
    const post = SPEC.nodes.find(n => n.id === 'post');
    const sum  = SPEC.nodes.find(n => n.id === 'sum');
    assert.equal(post.label, DELIVER_LABEL);
    assert.equal(post.description, DELIVER_DESC);
    assert.equal(sum.description, UPSTREAM_DESC);
    assert.equal(SPEC.outcome.statement, STATEMENT);
  });
});

describe('every surface names the channel the person actually picked', () => {
  test('1 · the label under the node in the diagram', () => {
    const card = diagram().find(c => c.id === 'post');
    assert.ok(card, 'the delivery has a card in the diagram');
    assert.equal(card.title, `To ${PICKED}`,
      'the diagram still labels the node with the channel the person rejected');
  });

  test('2 · the approval card\'s title', () => {
    assert.equal(cardFor('post').title, `To ${PICKED}`,
      'this is the name the person is being asked to approve');
  });

  test('3 · the approval card\'s description', () => {
    const what = cardFor('post').what;
    assert.match(what, /#real-channel/);
    assert.equal(what, `Posts the summary into the ${PICKED} channel in Slack.`);
  });

  test('4 · the description of the step BEFORE the delivery', () => {
    const what = cardFor('sum').what;
    assert.match(what, /#real-channel/);
    assert.equal(what, `Shortens the shipment update so it reads well in ${PICKED}.`);
  });

  test('5 · the workflow\'s own promise', () => {
    const statement = C._outcomeStatementTruly(SPEC.outcome, SPEC);
    assert.equal(statement, `Every UPS shipment email is summarized and posted to ${PICKED}.`,
      'the promise card named the rejected channel while its own bullets named the real one');
  });

  test('5b · and the promise follows the SPEC, not the assertions, when they disagree', () => {
    // `applyResourcePick` keeps the two in step, but it is not the only thing that
    // repoints a delivery — `fillDestination` writes `config.target` and does NOT
    // touch the contract. Truth lives in the configuration, so the statement must
    // read the spec and only fall back to the assertions when there is no graph.
    const stale = { ...SPEC.outcome,
                    assertions: [{ id: 'a1', kind: 'message_sent', target: `slack:${REJECTED}` }] };
    assert.equal(C._outcomeStatementTruly(stale, SPEC),
      `Every UPS shipment email is summarized and posted to ${PICKED}.`,
      'the promise must name where the workflow is CONFIGURED to send, not what the contract still claims');
  });

  test('✅ the honest one still works — "Sends to" is unchanged', () => {
    assert.deepEqual(cardFor('post').facts.find(f => f.k === 'Sends to'),
      { k: 'Sends to', v: PICKED });
  });
});

describe('the rejected channel appears NOWHERE a person can read', () => {
  test('not in the diagram, not on any card, not in the promise', () => {
    const said = [];
    diagram().forEach(c => said.push(c.title, c.tag));
    LIVE.forEach((n, i) => {
      const card = C._approvalCard(SPEC, LIVE, i, true);
      if (!card) return;
      said.push(card.title, card.kind, card.what, card.position);
      (card.facts   ?? []).forEach(f => said.push(f.k, f.v));
      (card.routes  ?? []).forEach(r => said.push(r.label, r.to, r.note));
      (card.alerts  ?? []).forEach(a => said.push(a.text));
    });
    const statement = C._outcomeStatementTruly(SPEC.outcome, SPEC);
    said.push(statement);
    // …and the certification panel, which emphasises the same sentence in segments.
    C._dealSegments(statement).forEach(seg => said.push(seg.text));

    const offenders = said.filter(s => typeof s === 'string' && s.includes('does-not'));
    assert.deepEqual(offenders, [],
      'a person declined this channel; the product must stop naming it back to them');
  });
});

// ── the rule that refuses to guess ────────────────────────────────────────────
// This is what makes the substitution safe to do at render time. Getting it wrong
// in the other direction — asserting a channel the workflow does not post to —
// would be the same defect with a different name.

describe('it never invents a destination', () => {
  const twoWays = {
    triggers: [{ type: 'manual' }],
    nodes: [
      { id: 'a', type: 'deliver', label: 'Post it', config: { channel: 'slack', target: '#ops' } },
      { id: 'b', type: 'deliver', label: 'Post it', config: { channel: 'slack', target: '#billing' } },
    ],
    edges: [],
  };

  test('a channel the workflow REALLY posts to is left alone', () => {
    const real = C._realChannelsOf(twoWays);
    assert.deepEqual(real, ['#ops', '#billing']);
    assert.equal(C._trueChannelText('Goes to #billing every morning.', real, ''),
      'Goes to #billing every morning.');
  });

  test('with two destinations and no way to tell, it says so rather than name one', () => {
    assert.equal(C._trueChannelText('Goes to #gone every morning.', C._realChannelsOf(twoWays), ''),
      'Goes to a Slack channel every morning.');
  });

  test('but a step that HAS its own destination uses it, even among many', () => {
    assert.equal(
      C._trueChannelText('Goes to #gone every morning.', C._realChannelsOf(twoWays), '#billing'),
      'Goes to #billing every morning.');
  });

  test('when nothing is known, the sentence is left exactly as the user ratified it', () => {
    // The outcome contract is written BEFORE the graph exists. There is no evidence
    // of drift yet, so touching it would be inventing a correction.
    assert.equal(C._outcomeStatementTruly({ statement: `Posts to ${REJECTED}.`, assertions: [] }, null),
      `Posts to ${REJECTED}.`);
    // …and while only the assertions exist, they are the live source.
    assert.equal(
      C._outcomeStatementTruly(
        { statement: `Posts to ${REJECTED}.`, assertions: [{ target: `slack:${PICKED}` }] }, null),
      `Posts to ${PICKED}.`);
  });

  test('a number in prose is not a channel, and a full stop is not part of one', () => {
    const real = ['#ops'];
    assert.equal(C._trueChannelText('Priority #1 goes out at #2400.', real, ''),
      'Priority #1 goes out at #2400.');
    assert.equal(C._trueChannelText('It lands in #gone.', real, ''), 'It lands in #ops.');
  });

  // THE BLAST RADIUS, pinned rather than asserted in prose. This reconciliation is a
  // text rewrite of sentences a person may have ratified, so the set of workflows it
  // can touch at all must be small and provable: a workflow that posts to no Slack
  // channel is never touched, whatever its sentences say.
  test('a workflow with no Slack destination is left completely alone', () => {
    const noSlack = {
      triggers: [{ type: 'manual' }],
      nodes: [
        { id: 'tag', type: 'llm', label: 'Tag it #urgent', description: 'Marks it #urgent.',
          config: { mode: 'freeform', prompt: 'Tag it.' } },
        { id: 'save', type: 'deliver', label: 'Save it', config: { channel: 'in_app' } },
      ],
      edges: [{ from: 'tag', to: 'save' }],
    };
    assert.deepEqual(C._realChannelsOf(noSlack), []);
    const card = C._approvalCard(noSlack, C._liveNodesFromSpec(noSlack),
      C._liveNodesFromSpec(noSlack).findIndex(n => n.id === 'tag'), true);
    assert.equal(card.title, 'Tag it #urgent');
    assert.equal(card.what, 'Marks it #urgent.');
  });

  test('a delivery nested inside a foreach counts as a real destination', () => {
    assert.deepEqual(C._realChannelsOf({ nodes: [
      { id: 'each', type: 'foreach', config: { steps: [
        { id: 'send', type: 'deliver', config: { channel: 'slack', target: '#ops' } }] } },
    ] }), ['#ops']);
  });
});

// ── it is actually wired to the screen ────────────────────────────────────────

describe('the screen feeds the real derivations, not a copy', () => {
  test('the diagram builds its cards through the reconciliation', () => {
    assert.match(HTML, /nodes = \(Array\.isArray\(nodes\) \? nodes : \[\]\)\.map\(\(n\) =>\s*\n\s*this\._nodeSaidTruly\(n, realChans, this\._ownChannelOf\(specById\[n && n\.id\]\)\)\);/);
  });

  test('the promise card renders the derived statement, not the stored one', () => {
    assert.match(HTML, /statement: this\._outcomeStatementTruly\(S\.outcome, S\.spec\),/);
    assert.match(HTML, /\{\{ outcomePin\.statement \}\}/);
  });

  // THE SIXTH SURFACE, which the brief did not list. The certification panel's
  // "THE DEAL" line renders the SAME `outcome.statement`, and it takes the right
  // panel at the moment `outcomePin` goes away — so a person who presses Run test
  // was shown the rejected channel again, directly above "cleared to go live".
  test('the certification panel reads the same derived statement', () => {
    assert.match(HTML, /const deal = this\._outcomeStatementTruly\(dealOutcome, S\.spec\);/);
    assert.match(HTML, /dealSegments: this\._dealSegments\(deal\)/);
    assert.match(HTML, /<sc-for list="\{\{ contract\.dealSegments \}\}"/);
  });
});
