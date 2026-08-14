/**
 * outcome-oracle — the satisfaction oracle, attacked. (Test Adversary, P12-C.)
 *
 * Two holes the mutation sweep exposed, and one property worth hammering.
 *
 * 1. `nodeForAssertion()` — the BACKWARD-CHAINING half of the file, and the one
 *    the elicitation graph actually calls (src/converger/elicitation-graph.js:277)
 *    to derive the graph from the outcome instead of interrogating the user — was
 *    executed by NOTHING. Every `if` in it (outcome-oracle.js:324–343) survived
 *    BOTH `if (true)` and `if (false)`. It could have been `return null` in every
 *    case and the suite would not have noticed: the converger would silently stop
 *    proposing nodes and just ask more questions, which reads as "the LLM is being
 *    chatty today" rather than as a broken feature.
 *
 * 2. `nodeEffect()`'s CHANNEL_EFFECTS lookup for a connector-action
 *    (outcome-oracle.js:149) survived deletion — because for `gmail_send` /
 *    `sheets_append` the verb fallback happens to produce the same answer. It does
 *    NOT for `docs_create` (the verb table has `create_folder`/`create_file`, not
 *    bare `create`), so that path is where the lookup earns its keep.
 *
 * 3. NEVER SILENTLY DROP AN ASSERTION. Hostile shapes: null, a string, a number
 *    target, an empty connector, a template locator, an unknown kind. Each must
 *    land in exactly one of satisfied / unsatisfied / malformed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSERTION_KINDS, nodeEffect, satisfiesAssertion, assertionDefect,
  checkOutcome, missingFields, nodeForAssertion, splitTarget,
} from '../../src/workflows/outcome-oracle.js';

const CAPS = {
  channels: [
    { id: 'slack',         available: true },
    { id: 'slack_dm',      available: true },
    { id: 'gmail_send',    available: true },
    { id: 'inbox_deliver', available: true },
  ],
};
/** A tenant with Slack revoked — the shape the /capabilities endpoint returns. */
const NO_SLACK = {
  channels: [
    { id: 'slack',         available: false, unavailableReason: 'not connected' },
    { id: 'slack_dm',      available: false },
    { id: 'gmail_send',    available: true },
    { id: 'inbox_deliver', available: true },
  ],
};

// ── splitTarget ─────────────────────────────────────────────────────────────
describe('splitTarget', () => {
  test('"<connector>:<locator>"', () => {
    assert.deepEqual(splitTarget('slack:#sales-urgent'), { connector: 'slack', locator: '#sales-urgent' });
  });
  test('a bare connector has no locator — a weaker claim, treated as one', () => {
    assert.deepEqual(splitTarget('slack'), { connector: 'slack', locator: '' });
  });
  test('an email locator keeps everything after the FIRST colon', () => {
    assert.deepEqual(splitTarget('webhook:https://x.dev/h'), { connector: 'webhook', locator: 'https://x.dev/h' });
  });
  test('an empty target names nothing', () => {
    assert.deepEqual(splitTarget(''), { connector: '', locator: '' });
    assert.deepEqual(splitTarget(null), { connector: '', locator: '' });
  });
});

// ── nodeEffect ──────────────────────────────────────────────────────────────
describe('nodeEffect: what a node actually does to the world', () => {
  test('a deliver via a KNOWN channel has that channel\'s effect', () => {
    const eff = nodeEffect({ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } });
    assert.equal(eff.kind, 'message_sent');
    assert.ok(eff.connectors.has('slack'));
    assert.deepEqual(eff.locators, ['#ops']);
  });

  test('a deliver via an UNKNOWN channel has NO effect — it cannot satisfy anything', () => {
    // A hallucinated channel must never satisfy a promise. This is the second
    // line of defence behind UNKNOWN_CHANNEL, and it is the one that still works
    // when the gap scorer has no catalog to check against.
    assert.equal(nodeEffect({ id: 'd', type: 'deliver', config: { channel: 'teams_send', target: '#ops' } }), null);
  });

  test('a connector-action that is a REGISTERED DELIVERY CAPABILITY keeps that capability\'s effect', () => {
    // `docs_create` makes a DOCUMENT. The verb table (create_folder / create_file
    // / upload / file) does not match `docs_create`, and the record verbs
    // (create_record / create_event / append / …) do not either — so without the
    // CHANNEL_EFFECTS lookup this node has no effect at all and a promised Google
    // Doc is silently dropped.
    const node = { id: 'w', type: 'connector-action', config: { action: 'docs_create', title: 'Q3 review' } };
    const eff = nodeEffect(node);
    assert.ok(eff, 'docs_create must have an effect — the verb fallback cannot see it');
    assert.equal(eff.kind, 'document_exists');
    assert.ok(eff.connectors.has('docs'));
    assert.equal(satisfiesAssertion({ kind: 'document_exists', target: 'docs:Q3 review' }, node), true);
  });

  test('an UNREGISTERED write capability still gets an effect from its VERB', () => {
    // New capabilities must work without an edit here (ENGINEERING-LOG.md: workflow-agnostic).
    const node = { id: 'w', type: 'connector-action', config: { action: 'notion_create_record', table: 'Leads' } };
    const eff = nodeEffect(node);
    assert.equal(eff.kind, 'record_exists');
    assert.ok(eff.connectors.has('notion'));
  });

  test('a `create` on a DOC connector is a document, not a record', () => {
    const eff = nodeEffect({ id: 'w', type: 'connector-action', config: { action: 'drive_create_folder', name: 'Q3' } });
    assert.equal(eff.kind, 'document_exists');
  });

  test('a READ has no effect, and an LLM step has no effect', () => {
    assert.equal(nodeEffect({ id: 'r', type: 'connector-action', config: { action: 'airtable_list_records' } }), null);
    assert.equal(nodeEffect({ id: 'l', type: 'llm', config: { mode: 'summarize' } }), null);
    assert.equal(nodeEffect({ id: 'b', type: 'branch', config: { on: 'x.output' } }), null);
    assert.equal(nodeEffect({ id: 'h', type: 'human', config: {} }), null);
    assert.equal(nodeEffect(null), null);
    assert.equal(nodeEffect('deliver'), null);
  });

  test('a connector-action with no `action` has no effect', () => {
    assert.equal(nodeEffect({ id: 'w', type: 'connector-action', config: {} }), null);
  });
});

// ── satisfiesAssertion ──────────────────────────────────────────────────────
describe('satisfaction', () => {
  const slackOps = { id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } };

  test('the right connector and the right locator (positive)', () => {
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack:#ops' }, slackOps), true);
  });

  test('the right connector, no locator asked for → satisfied (a weaker promise, kept)', () => {
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack' }, slackOps), true);
  });

  test('the right connector but the WRONG locator → not satisfied', () => {
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack:#random' }, slackOps), false);
  });

  test('the right destination but the WRONG KIND → not satisfied', () => {
    // Posting a Slack message does not create a record, however much the target
    // string matches.
    assert.equal(satisfiesAssertion({ kind: 'record_exists', target: 'slack:#ops' }, slackOps), false);
  });

  test('a TEMPLATE locator in the assertion matches anything — it resolves at run time', () => {
    // `if (locator && !isTemplate(locator))` — flip that to `if (true)` and a
    // perfectly good spec whose destination is chosen at run time gets called
    // unsatisfied and can never publish.
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack:{{routing.output}}' }, slackOps), true);
  });

  test('a TEMPLATE locator on the NODE matches anything too', () => {
    const dynamic = { id: 'd', type: 'deliver', config: { channel: 'slack', target: '{{route.output}}' } };
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack:#ops' }, dynamic), true);
  });

  test('a node with NO locator at all still satisfies a located assertion', () => {
    // We have nothing to contradict it with. Refusing here would block a webhook
    // whose url is injected at run time.
    const bare = { id: 'd', type: 'deliver', config: { channel: 'slack' } };
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack:#ops' }, bare), true);
  });

  test('gmail / google / email / mail are the same connector', () => {
    const mail = { id: 'd', type: 'deliver', config: { channel: 'gmail_send', to: 'rep@acme.com' } };
    for (const c of ['gmail', 'email', 'mail', 'google']) {
      assert.equal(satisfiesAssertion({ kind: 'message_sent', target: `${c}:rep@acme.com` }, mail), true, c);
    }
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack:rep@acme.com' }, mail), false);
  });
});

// ── missingFields ───────────────────────────────────────────────────────────
describe('missingFields', () => {
  const save = (fields) => ({ id: 's', type: 'connector-action',
                              config: { action: 'airtable_create_record', tableId: 'Leads', fields } });

  test('a promised field the node never sets is named', () => {
    assert.deepEqual(
      missingFields({ kind: 'record_exists', target: 'airtable:Leads', fields: ['Name', 'Budget'] },
                    save({ Name: 'x' })),
      ['Budget']);
  });

  test('field names compare case- and whitespace-insensitively (positive)', () => {
    assert.deepEqual(
      missingFields({ kind: 'record_exists', target: 'airtable:Leads', fields: [' budget '] },
                    save({ Budget: 'x' })),
      []);
  });

  test('an UNREADABLE fields value produces NO accusation', () => {
    // `fields: "{{extract.output}}"` — we cannot see the keys. Reporting them as
    // missing would block a valid workflow, and a false positive teaches people
    // to ignore the check.
    assert.deepEqual(
      missingFields({ kind: 'record_exists', target: 'airtable:Leads', fields: ['Budget'] },
                    save('{{extract.output}}')),
      []);
  });

  test('an assertion that promises no fields demands none', () => {
    assert.deepEqual(missingFields({ kind: 'record_exists', target: 'airtable:Leads' }, save({ Name: 'x' })), []);
  });
});

// ── assertionDefect: the closed vocabulary ──────────────────────────────────
describe('assertionDefect — an assertion we cannot check is MALFORMED, never ignored', () => {
  test('every declared kind is accepted (positive)', () => {
    for (const kind of ASSERTION_KINDS) {
      assert.equal(assertionDefect({ id: 'a', kind, target: 'slack:#ops' }), null, kind);
    }
  });

  test('an unknown kind is rejected, and the error lists the ones that exist', () => {
    const why = assertionDefect({ id: 'a', kind: 'vibes_improved', target: 'slack:#ops' });
    assert.ok(why);
    for (const kind of ASSERTION_KINDS) assert.match(why, new RegExp(kind));
  });

  test('the kind vocabulary is CLOSED and case-sensitive', () => {
    assert.ok(assertionDefect({ id: 'a', kind: 'Message_Sent', target: 'slack:#ops' }));
  });

  test('hostile shapes are all malformed, not crashes and not passes', () => {
    for (const a of [null, undefined, 'slack:#ops', 42, [],
                     { target: 'slack:#ops' },                       // no kind
                     { kind: 'message_sent' },                       // no target
                     { kind: 'message_sent', target: '   ' },        // blank target
                     { kind: 'message_sent', target: ':#ops' }]) {   // no connector
      assert.ok(assertionDefect(a), `${JSON.stringify(a)} should be malformed`);
    }
  });
});

// ── checkOutcome: the accounting property ───────────────────────────────────
describe('checkOutcome never silently drops an assertion', () => {
  const nodes = [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }];

  test('satisfied + unsatisfied + malformed accounts for every DISTINCT assertion', () => {
    const outcome = { assertions: [
      { id: 'a1', kind: 'message_sent',   target: 'slack:#ops' },       // satisfied
      { id: 'a2', kind: 'message_sent',   target: 'gmail:a@b.com' },    // unsatisfied
      { id: 'a3', kind: 'nonsense',       target: 'slack:#ops' },       // malformed
      { id: 'a4', kind: 'record_exists',  target: 'airtable:Leads' },   // unsatisfied
      { id: 'a5', kind: 'document_exists', target: 'docs:Report' },     // unsatisfied
    ] };
    const { satisfied, unsatisfied, malformed } = checkOutcome(outcome, nodes);
    assert.equal(satisfied.size, 1);
    assert.equal(unsatisfied.length, 3);
    assert.equal(malformed.length, 1);
    assert.equal(satisfied.size + unsatisfied.length + malformed.length, outcome.assertions.length);
  });

  test('a non-array assertions list yields nothing, and never throws', () => {
    for (const bad of [{ assertions: 'slack' }, { assertions: null }, {}, null, undefined]) {
      const r = checkOutcome(bad, nodes);
      assert.deepEqual([r.satisfied.size, r.unsatisfied.length, r.malformed.length], [0, 0, 0]);
    }
    // …and the VALIDATOR is what turns "no checkable assertions" into an error
    // (MISSING_OUTCOME). See tests/workflows/validator-rules.test.js.
  });

  test('a null entry inside the list is malformed, not skipped', () => {
    const r = checkOutcome({ assertions: [null, { id: 'a', kind: 'message_sent', target: 'slack:#ops' }] }, nodes);
    assert.equal(r.malformed.length, 1);
    assert.equal(r.satisfied.size, 1);
  });
});

// ── nodeForAssertion — the backward-chaining half, previously unexecuted ─────
describe('nodeForAssertion: the system proposes the node the outcome implies', () => {
  test('slack:#logistics → a deliver to the slack channel', () => {
    const node = nodeForAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:#logistics' }, { capabilities: CAPS });
    assert.ok(node, 'the converger derives the graph FROM the outcome — returning null here silently disables that');
    assert.equal(node.type, 'deliver');
    assert.equal(node.config.channel, 'slack');
    assert.equal(node.config.target, '#logistics');
  });

  test('a channel named without its # still becomes a #channel', () => {
    const node = nodeForAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:logistics' }, { capabilities: CAPS });
    assert.equal(node.config.target, '#logistics');
  });

  test('slack:@amy → a DM, not a channel post', () => {
    const node = nodeForAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:@amy' }, { capabilities: CAPS });
    assert.equal(node.config.channel, 'slack_dm');
    assert.equal(node.config.user, 'amy', 'the @ is decoration, not part of the handle');
  });

  test('gmail:rep@acme.com → a gmail_send', () => {
    const node = nodeForAssertion({ id: 'a2', kind: 'message_sent', target: 'gmail:rep@acme.com' }, { capabilities: CAPS });
    assert.equal(node.config.channel, 'gmail_send');
    assert.equal(node.config.to, 'rep@acme.com');
  });

  test('inbox → the Atlas inbox, with the locator as the subject', () => {
    const node = nodeForAssertion({ id: 'a3', kind: 'message_sent', target: 'inbox:Weekly digest' }, { capabilities: CAPS });
    assert.equal(node.config.channel, 'inbox_deliver');
    assert.equal(node.config.subject, 'Weekly digest');
  });

  test('a bare "inbox" with no locator still yields a node', () => {
    const node = nodeForAssertion({ id: 'a3', kind: 'message_sent', target: 'inbox' }, { capabilities: CAPS });
    assert.equal(node.config.channel, 'inbox_deliver');
    assert.ok(node.config.subject, 'a delivery with no subject at all is not proposable');
  });

  test('the derived node id is stable and safe to put in a spec', () => {
    const node = nodeForAssertion({ id: 'A-1!', kind: 'message_sent', target: 'slack:#ops' }, { capabilities: CAPS });
    assert.match(node.id, /^[a-z0-9_]+$/, 'an id with punctuation in it breaks every template reference downstream');
  });

  test('a CHANNEL THE TENANT CANNOT USE proposes nothing', () => {
    // Proposing a Slack post to a tenant with no Slack connector builds a spec
    // that cannot publish — the converger would be arguing for something the
    // validator will reject (CHANNEL_UNAVAILABLE). Better to leave it an open gap.
    assert.equal(nodeForAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }, { capabilities: NO_SLACK }), null);
    assert.equal(nodeForAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:@amy' }, { capabilities: NO_SLACK }), null);
    // …but gmail is still connected (positive — this is not "propose nothing, ever").
    assert.ok(nodeForAssertion({ id: 'a2', kind: 'message_sent', target: 'gmail:x@y.com' }, { capabilities: NO_SLACK }));
  });

  test('an UNKNOWN catalog does not block the proposal', () => {
    // No `channels` array = we don't know what this tenant has. Refusing to
    // propose anything would make the whole feature depend on catalog plumbing.
    const node = nodeForAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }, {});
    assert.ok(node);
    assert.equal(node.config.channel, 'slack');
  });

  test('a TEMPLATE locator proposes nothing — we will not bake a template into a channel id', () => {
    assert.equal(nodeForAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:{{route.output}}' }, { capabilities: CAPS }), null);
  });

  test('a DM is NEVER downgraded to a public channel post when DMs are unavailable', () => {
    // The single most damaging thing this function could do: turn "email/DM the
    // rep privately" into "post it in a public channel". `if (!dm)` guards it —
    // flip that to `if (true)` and a Slack workspace with chat:write but no
    // im:write gets an assertion for `slack:@amy` answered with a post to
    // `#@amy`. Propose nothing and leave it an open gap instead.
    const dmOff = { channels: [{ id: 'slack', available: true }, { id: 'slack_dm', available: false }] };
    assert.equal(nodeForAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:@amy' }, { capabilities: dmOff }), null);
    // …and a genuine channel post still works with the same catalog (positive).
    assert.equal(
      nodeForAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }, { capabilities: dmOff })?.config.channel,
      'slack');
  });

  test('a message_sent shape is not proposed for a document_exists assertion', () => {
    // `if (assertion.kind === 'message_sent')` → `if (true)` and a promise to put
    // a FILE in Slack (slack_file) is answered with a chat post — which satisfies
    // nothing, and would then loop forever against its own oracle.
    const a = { id: 'a1', kind: 'document_exists', target: 'slack:report.pdf' };
    assert.equal(nodeForAssertion(a, { capabilities: CAPS }), null);
  });

  test('a MALFORMED assertion proposes nothing', () => {
    assert.equal(nodeForAssertion({ id: 'a1', kind: 'vibes_improved', target: 'slack:#ops' }, { capabilities: CAPS }), null);
    assert.equal(nodeForAssertion(null, { capabilities: CAPS }), null);
  });

  test('record_exists / document_exists propose nothing — the destination schema cannot be invented', () => {
    // An Airtable write needs a baseId. Guessing it ships a broken spec that
    // looks finished. Increment F reads it from the connector; until then this
    // must stay an open gap rather than become a node with a made-up id in it.
    assert.equal(nodeForAssertion({ id: 'a1', kind: 'record_exists',   target: 'airtable:Leads' }, { capabilities: CAPS }), null);
    assert.equal(nodeForAssertion({ id: 'a1', kind: 'document_exists', target: 'docs:Report' },    { capabilities: CAPS }), null);
  });

  test('THE ROUND TRIP: the proposed node satisfies the assertion it was derived from', () => {
    // If these two ever disagree, the converger proposes a node and its own
    // validator immediately calls the assertion unsatisfied — an infinite loop
    // the user cannot escape.
    for (const target of ['slack:#logistics', 'slack:@amy', 'gmail:rep@acme.com', 'inbox:Digest']) {
      const a = { id: 'a1', kind: 'message_sent', target };
      const node = nodeForAssertion(a, { capabilities: CAPS });
      assert.ok(node, target);
      assert.equal(satisfiesAssertion(a, node), true,
        `nodeForAssertion proposed a node for "${target}" that satisfiesAssertion then rejects`);
    }
  });
});
