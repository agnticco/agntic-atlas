/**
 * P13-0 — the catalog is SOURCE-AGNOSTIC.
 *
 * The whole point of this suite: register a capability that NO line of Atlas code
 * has ever heard of — no entry in CHANNEL_EFFECTS, no token WRITE_VERBS recognises,
 * no special case anywhere — and prove the guards still fire on it.
 *
 * Why it exists. Effect used to be inferred from the capability's NAME by testing it
 * against verb regexes. A write whose id contained no known token — `notion_create_page`
 * is the canonical one, because "page" is not in the set — was classified as a READ.
 * It then skipped idempotency and the approval gate, and the run reported success.
 * That is the exact failure class P13 exists to kill: user-reachable, and silent.
 *
 * Each test names the mutation that must turn it red. If you change the seam, revert
 * the fix by hand and watch these fail — a guard whose mutation survives is pinned by
 * nothing (ENGINEERING-LOG.md, "A green suite is evidence of nothing until you have watched it
 * go red"). There is no mutation tooling; this is done by hand, deliberately.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { nodeEffect, setCapabilityCatalog } from '../../src/workflows/outcome-oracle.js';
// The REAL predicate production uses, not a copy of it. A mirrored rule is a
// tautology: revert the seam in server.js and a mirrored test stays green, which is
// exactly the blind spot this suite exists to close.
import { ownsConnector, setInjectorCatalog } from '../../src/api/server.js';
// The REAL guards, imported — these are what WRITE_WITHOUT_IDEMPOTENCY and
// WEAK_APPROVAL_FOR_WRITE are computed from.
import { isWritingAction, isWriteNode } from '../../src/workflows/workflow-validator.js';
// The resolution the destinations node actually calls — not the registry lookup.
import { resolveSchemaDiscovery } from '../../src/converger/elicitation-graph.js';

/**
 * The synthetic connector. `x_create_page` is chosen deliberately:
 *   · "page" appears in NO WRITE_VERBS pattern, so the legacy id-regex calls it a read;
 *   · "x" is in no connector table, no alias map, no CHANNEL_EFFECTS entry.
 * If this classifies as a write, it did so because the capability DECLARED it.
 */
const SYNTHETIC = 'x_create_page';

let registry;

beforeEach(() => {
  registry = new CapabilityRegistry();
  setCapabilityCatalog(registry);
});

afterEach(() => {
  setCapabilityCatalog(null);   // never leak the catalog into another suite
});

describe('P13-0 (a) — a declared write is a write, whatever it is called', () => {
  test('an unfamiliar id declared as a write classifies as a write', () => {
    registry.register({
      id: SYNTHETIC, connector: 'x', positions: ['step'],
      effect: 'write', assertionKind: 'record_exists', locatorKeys: ['pageId'],
    });

    const eff = nodeEffect({
      id: 'w', type: 'connector-action',
      config: { action: SYNTHETIC, pageId: 'Pages' },
    });

    // MUTATION: delete the `declaredEffectOf` branch in nodeEffect's connector-action
    // path so it falls straight through to WRITE_VERBS. "page" matches nothing, the
    // function returns null, and this assertion goes red.
    assert.ok(eff, 'a declared write must produce an effect, not null');
    assert.equal(eff.kind, 'record_exists');
    assert.ok(eff.connectors.has('x'), 'effect must carry its declaring connector');
    assert.deepEqual(eff.locators, ['Pages'], 'locators come from the declared keys');
  });

  test('the SAME id with no declaration is still read by the legacy regex — proving the declaration is what did the work', () => {
    registry.register({ id: SYNTHETIC, connector: 'x', positions: ['step'] });

    // Declares nothing and is step-only, so it falls to the legacy path, where
    // "create_page" matches no verb. This is the OLD behaviour, pinned on purpose:
    // it is the control that stops the test above passing for the wrong reason.
    assert.equal(
      nodeEffect({ id: 'w', type: 'connector-action', config: { action: SYNTHETIC } }),
      null,
    );
  });

  test('a declared READ satisfies nothing, even when its name sounds like a write', () => {
    // `x_send_digest` matches the message_sent verb pattern. The declaration must
    // beat the regex in BOTH directions, or "declared" is only half honoured.
    registry.register({
      id: 'x_send_digest', connector: 'x', positions: ['step'], effect: 'read',
    });

    // MUTATION: make declaredEffectOf ignore effect:'read' and fall through — the
    // verb regex then matches "send", an effect appears, and this goes red.
    assert.equal(
      nodeEffect({ id: 'r', type: 'connector-action', config: { action: 'x_send_digest' } }),
      null,
      'a declared read must never look like it satisfied an assertion',
    );
  });

  test('FAIL CLOSED: a delivery-capable capability that declares no effect is treated as a write', () => {
    // The dangerous direction. A missing idempotency key on a real write is
    // unrecoverable; a spurious one on a read is harmless. So silence must resolve
    // to write, never to read.
    registry.register({ id: 'x_quiet_push', connector: 'x', positions: ['step', 'delivery'] });

    const eff = nodeEffect({
      id: 'w', type: 'connector-action', config: { action: 'x_quiet_push', target: 'somewhere' },
    });

    // MUTATION: change the `positions.includes('delivery')` fail-closed branch in
    // declaredEffectOf to `return undefined` — the id matches no verb, the effect
    // becomes null, and an undeclared write goes unguarded. Red.
    assert.ok(eff, 'an undeclared delivery-capable capability must fail CLOSED to write');
  });
});

describe('P13-0 (b) — a deliver node to an unknown capability can still satisfy its promise', () => {
  test('a declared delivery write produces an effect instead of null', () => {
    registry.register({
      id: SYNTHETIC, connector: 'x', positions: ['delivery'],
      effect: 'write', assertionKind: 'record_exists', locatorKeys: ['pageId'],
    });

    const eff = nodeEffect({
      id: 'd', type: 'deliver',
      config: { channel: SYNTHETIC, pageId: 'Pages' },
    });

    // MUTATION: restore the original `if (!eff) return null;` in the deliver branch,
    // removing the catalog fallback entirely. Effect becomes null, the outcome
    // assertion can never be satisfied, and publish would hard-fail with
    // UNSATISFIED_ASSERTION on a correctly-configured workflow. Red.
    assert.ok(eff, 'a deliver to a declared write capability must have an effect');
    assert.equal(eff.kind, 'record_exists');
    assert.ok(eff.connectors.has('x'));
    assert.deepEqual(eff.locators, ['Pages']);
  });

  test('a deliver to a genuinely unknown channel is still null — the fallback did not become a rubber stamp', () => {
    // Nothing registered. The fallback must not invent an effect for a channel the
    // catalog has never heard of; that would make UNSATISFIED_ASSERTION unreachable
    // and turn the publish check into theatre.
    assert.equal(
      nodeEffect({ id: 'd', type: 'deliver', config: { channel: 'teams_send', target: '#ops' } }),
      null,
    );
  });

  test('an empty channel is null, not a lookup of the empty string', () => {
    assert.equal(nodeEffect({ id: 'd', type: 'deliver', config: { channel: '   ' } }), null);
  });
});

describe('P13-0 — native behaviour is unchanged by the seam', () => {
  test('with NO catalog injected, native capabilities behave exactly as before', () => {
    setCapabilityCatalog(null);

    const slack = nodeEffect({ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } });
    assert.equal(slack.kind, 'message_sent');
    assert.deepEqual(slack.locators, ['#ops']);

    const airtable = nodeEffect({
      id: 'w', type: 'connector-action', config: { action: 'airtable_create_record', tableId: 'tbl1' },
    });
    assert.equal(airtable.kind, 'record_exists');

    assert.equal(
      nodeEffect({ id: 'r', type: 'connector-action', config: { action: 'airtable_list_records' } }),
      null,
    );
  });

  test('a registered native capability that declares nothing keeps its table-driven effect', () => {
    registry.register({ id: 'slack', connector: 'slack', positions: ['delivery'] });

    const eff = nodeEffect({ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } });
    assert.equal(eff.kind, 'message_sent', 'CHANNEL_EFFECTS still wins for the ids it knows');
  });

  test('a write inside a foreach is still a write when the capability is declared', () => {
    // The highest-risk shape: three separate P12 defects were "added to the top-level
    // executor, not the foreach sub-loop". The seam must reach inside a loop too.
    registry.register({
      id: SYNTHETIC, connector: 'x', positions: ['step'],
      effect: 'write', assertionKind: 'record_exists', locatorKeys: ['pageId'],
    });

    const eff = nodeEffect({
      id: 'loop', type: 'foreach',
      config: { steps: [{ id: 's', type: 'connector-action', config: { action: SYNTHETIC, pageId: 'Pages' } }] },
    });

    assert.ok(eff, 'a foreach carries the effects of the steps inside it');
    assert.equal(eff.kind, 'record_exists');
  });
});

describe('P13-0 — the registry refuses a malformed declaration', () => {
  test('an effect that is neither read nor write is rejected at registration', () => {
    // Fail at build time, not at run time. A typo'd effect must not silently become
    // "declared nothing" — that would put a real write back on the legacy guess path.
    assert.throws(
      () => registry.register({ id: 'x_bad', connector: 'x', positions: ['step'], effect: 'writes' }),
      /effect must be 'read' or 'write'/,
    );
  });
});

/* ── P13-0 (c) — destination resolution works for ANY declaring connector ─────
 *
 * The `destinations` node used to be Airtable by literal string in four places, so
 * every other connector fell back to "make the user paste an id" — violating the
 * converger's own rule, "never ask for what we can read".
 *
 * These exercise the registry side of the seam: a connector nobody hand-built
 * declares how its schema is read, and the catalog surfaces that declaration. The
 * node then drives entirely off the declaration (config-key names included, which
 * matters because writing a key the target node type does not declare fails
 * UNKNOWN_CONFIG_KEY at publish).
 */
describe('P13-0 (c) — schema discovery is declared, not hardcoded', () => {
  const DISCOVERY = {
    listCapability:    'x_list_spaces',
    listResultKey:     'spaces',
    describeArg:       'spaceId',
    describeResultKey: 'collections',
    tableColumnsKey:   'columns',
    containerKey:      'spaceId',
    tableKey:          'collectionId',
    containerLabel:    'X space',
    tableLabel:        'collection',
  };

  test('a synthetic connector that declares discovery is found by connector name', () => {
    registry.register({ id: 'x_list_spaces', connector: 'x', positions: ['step'], effect: 'read' });
    registry.register({
      id: 'x_describe_space', connector: 'x', positions: ['step'], effect: 'read',
      schemaDiscovery: DISCOVERY,
    });

    const found = registry.schemaDiscoveryFor('x');

    // MUTATION: restore the literal `usesConnector(n, 'airtable')` / hardcoded
    // 'airtable_list_bases' in elicitation-graph's destinations node — the synthetic
    // connector is then never resolved and the user is asked to paste an id.
    assert.ok(found, 'a declaring connector must be discoverable by name alone');
    assert.equal(found.describeCapability, 'x_describe_space',
      'the descriptor must carry WHICH capability declared it, so the node can call it');
    assert.equal(found.listCapability, 'x_list_spaces');
    assert.equal(found.containerKey, 'spaceId');
    assert.equal(found.tableKey, 'collectionId');
  });

  test('a connector that declares nothing returns null — we ASK rather than guess', () => {
    registry.register({ id: 'y_write_thing', connector: 'y', positions: ['step'], effect: 'write' });

    // Honest degradation is the whole point: no declaration means the ordinary
    // propose loop asks the user for the destination. Inventing one would write a
    // customer's record into somewhere that does not exist.
    assert.equal(registry.schemaDiscoveryFor('y'), null);
    assert.equal(registry.schemaDiscoveryFor('nope'), null);
    assert.equal(registry.schemaDiscoveryFor(''), null);
  });

  test('schemaDiscoveryConnectors lists only connectors that declared', () => {
    registry.register({ id: 'x_describe_space', connector: 'x', positions: ['step'], schemaDiscovery: DISCOVERY });
    registry.register({ id: 'y_write_thing',   connector: 'y', positions: ['step'], effect: 'write' });

    assert.deepEqual(registry.schemaDiscoveryConnectors(), ['x']);
  });

  test('the real Airtable connector declares it — the generalization did not drop the case it replaced', () => {
    // Guards the swap itself. It is entirely possible to generalize a mechanism and
    // silently lose the one connector that used to work; this is the check that the
    // literals were REPLACED rather than merely deleted.
    registry.register({
      id: 'airtable_describe_base', connector: 'airtable', positions: ['step'],
      schemaDiscovery: {
        listCapability: 'airtable_list_bases', listResultKey: 'bases',
        describeArg: 'baseId', describeResultKey: 'tables', tableColumnsKey: 'fields',
        containerKey: 'baseId', tableKey: 'tableId',
        containerLabel: 'Airtable base', tableLabel: 'table',
      },
    });

    const d = registry.schemaDiscoveryFor('airtable');
    assert.equal(d.describeCapability, 'airtable_describe_base');
    assert.equal(d.containerKey, 'baseId', 'Airtable still resolves through baseId');
    assert.equal(d.tableColumnsKey, 'fields', 'Airtable columns still come from table.fields');
  });
});

/* ── P13-0 (d) — the credential a node needs is DECLARED, not listed ──────────
 *
 * `server.js` decided which tenant token a node needed by testing its capability id
 * against three hand-typed Sets. The Google one carried its own warning: a capability
 * missing from the list gets no token at run time even though the tenant is properly
 * connected — the R22 defect, shipped once already.
 *
 * The failure is user-reachable and near-silent: the workflow publishes, the connector
 * shows connected, and the run dies with "no access token". Import a server exposing
 * forty tools and the old shape reproduces it forty times.
 *
 * These pin the RULE (resolve from the declared connector) at the registry level,
 * which is where `server.js`'s `ownsConnector` reads it from.
 */
describe('P13-0 (d) — credential resolution follows the declared connector', () => {
  // `ownsConnector` is imported from server.js and reads the catalog installed by
  // setInjectorCatalog — the same wiring buildEngine() does at boot.
  beforeEach(() => setInjectorCatalog(registry));
  afterEach(()  => setInjectorCatalog(null));
  const owns = (connectorId) => ownsConnector(connectorId);

  test('a NEW capability on a connected connector gets its credential without being listed anywhere', () => {
    // The whole point. `x_brand_new_thing` is in no Set, no regex, no list.
    registry.register({ id: 'x_brand_new_thing', connector: 'x', positions: ['step'], effect: 'write' });

    const ownsX = owns('x');

    // MUTATION: restore the hand-typed `X_ACTION_IDS` Set membership test in
    // server.js — the capability is absent from it, no token is injected, and the run
    // fails with "no access token" on a properly connected tenant. Red.
    assert.ok(ownsX({ type: 'connector-action', config: { action: 'x_brand_new_thing' } }),
      'a capability declaring connector "x" must resolve x credentials, unlisted');
  });

  test('the id prefix CANNOT stand in for the declaration — the Google case', () => {
    // This is why the hand-typed lists existed at all. Google capabilities are named
    // gmail_/sheets_/docs_/drive_ and share NO prefix with their connector, so any
    // prefix-based shortcut silently resolves nothing for the biggest connector we have.
    registry.register({ id: 'sheets_append', connector: 'google', positions: ['step', 'delivery'] });
    registry.register({ id: 'gmail_send',    connector: 'google', positions: ['step', 'delivery'] });

    const ownsG = owns('google');

    assert.ok(ownsG({ type: 'connector-action', config: { action: 'sheets_append' } }),
      'sheets_append declares connector google and must resolve google credentials');
    assert.ok(ownsG({ type: 'deliver', config: { channel: 'gmail_send' } }),
      'a deliver node resolves credentials the same way a step does');
  });

  test('a capability of ANOTHER connector never draws the wrong credential', () => {
    // The dangerous direction: handing one connector's token to another connector's
    // call. Cross-connector, and with a shared vault, a step from leaking a credential.
    registry.register({ id: 'sheets_append',  connector: 'google', positions: ['step'] });
    registry.register({ id: 'x_create_thing', connector: 'x',      positions: ['step'] });

    assert.equal(
      owns('google')({ type: 'connector-action', config: { action: 'x_create_thing' } }),
      false, 'connector x must never be handed google credentials');
    assert.equal(
      owns('x')({ type: 'connector-action', config: { action: 'sheets_append' } }),
      false, 'connector google must never be handed x credentials');
  });

  test('an unregistered id falls back to the prefix, so nothing regresses', () => {
    // Slack always worked by prefix; a catalog-less test harness must still behave.
    const ownsS = owns('slack');
    assert.ok(ownsS({ type: 'deliver', config: { channel: 'slack' } }));
    assert.ok(ownsS({ type: 'connector-action', config: { action: 'slack_post_message' } }));
    assert.equal(ownsS({ type: 'connector-action', config: { action: 'notion_create_page' } }), false);
  });

  test('a node that invokes no capability owns nothing', () => {
    const ownsN = owns('x');
    assert.equal(ownsN({ type: 'llm', config: { mode: 'summarize' } }), false);
    assert.equal(ownsN({ type: 'connector-action', config: {} }), false);
    assert.equal(ownsN(null), false);
  });
});

/* ── P13-0 (e) — a declared write really DOES get its guards ──────────────────
 *
 * This section exists because an independent verifier disproved the claim the rest
 * of this file was written around. Seams #1/#2 made the OUTCOME ORACLE read a
 * capability's declared effect — but the two guards that actually protect a customer,
 * the duplicate check (WRITE_WITHOUT_IDEMPOTENCY) and the approval-strength check
 * (WEAK_APPROVAL_FOR_WRITE), were driven by a SECOND, untouched name-matching rule
 * in workflow-validator.js. So the system knew a step wrote and guarded it anyway.
 *
 * `notion_create_page` and `notion_update_page` — the canonical shapes the next
 * increment imports — escaped both. These tests are the ones that were missing.
 */
describe('P13-0 (e) — the declaration reaches the guards, not just the oracle', () => {
  test('a declared write is a write to the validator, whatever it is called', () => {
    registry.register({
      id: 'notion_update_page', connector: 'notion', positions: ['step'], effect: 'write',
    });

    // MUTATION: drop the `declaresWrite(action)` line from isWritingAction in
    // workflow-validator.js. "update_page" matches none of create/append/send/post/
    // add/insert, so the step stops counting as a write, loses its duplicate
    // protection and its approval-strength check, and this goes red.
    assert.equal(isWritingAction('notion_update_page'), true,
      'a declared write must be a write to the guards, not only to the oracle');
    assert.equal(
      isWriteNode({ type: 'connector-action', config: { action: 'notion_update_page' } }), true,
      'isWriteNode feeds WEAK_APPROVAL_FOR_WRITE — it must see the declaration too');
  });

  test('the same id UNDECLARED is still not a write — the control', () => {
    registry.register({ id: 'notion_update_page', connector: 'notion', positions: ['step'] });
    // Step-only and silent ⇒ legacy regex ⇒ no verb match. Pins that the DECLARATION
    // is what did the work above, not something incidental.
    assert.equal(isWritingAction('notion_update_page'), false);
  });

  test('a declaration can only ADD a write, never remove a guard', () => {
    // The unrecoverable direction. `x_create_thing` matches the regex; declaring it a
    // read must NOT strip its duplicate protection. A spurious idempotency key costs
    // nothing; a missing one loses data.
    registry.register({ id: 'x_create_thing', connector: 'x', positions: ['step'], effect: 'read' });

    assert.equal(isWritingAction('x_create_thing'), true,
      'a declared read whose name says create must STAY guarded — fail closed');
  });

  test('with no catalog, the guards behave exactly as before P13-0', () => {
    setCapabilityCatalog(null);
    assert.equal(isWritingAction('airtable_create_record'), true);
    assert.equal(isWritingAction('gmail_send'), true);
    assert.equal(isWritingAction('airtable_list_records'), false);
    assert.equal(isWritingAction('notion_update_page'), false);   // the pre-P13 gap, unchanged
  });
});

/* ── P13-0 (f) — the seam-#3 PRODUCTION path, not just the registry lookup ────
 *
 * The §(c) tests below exercise `CapabilityRegistry.schemaDiscoveryFor`. An
 * independent verifier proved that was not enough: reverting the resolution used by
 * the live build loop to the literal `['airtable']` left the entire suite green —
 * 1119 tests, identical pass/fail with and without the mutant. The generalization
 * that actually runs when a user builds a workflow was pinned by nothing, while the
 * tests that claimed to cover it never touched it.
 *
 * This drives `resolveSchemaDiscovery`, the function the destinations node calls.
 */
describe('P13-0 (f) — destination resolution works for a connector nobody hand-built', () => {
  const ZETA = {
    listCapability: 'zeta_list_spaces', listResultKey: 'spaces',
    describeArg: 'spaceId', describeResultKey: 'collections', tableColumnsKey: 'columns',
    containerKey: 'spaceId', tableKey: 'collectionId',
    containerLabel: 'Zeta space', tableLabel: 'collection',
  };
  const zetaWrite = { type: 'connector-action', config: { action: 'zeta_create_page' } };

  test('a synthetic connector resolves through the live path', () => {
    registry.register({ id: 'zeta_describe_space', connector: 'zeta', positions: ['step'], schemaDiscovery: ZETA });
    registry.register({ id: 'zeta_create_page',    connector: 'zeta', positions: ['step'], effect: 'write' });

    const got = resolveSchemaDiscovery(registry, [zetaWrite]);

    // MUTATION: revert resolveSchemaDiscovery's loop to `for (const connector of
    // ['airtable'])` — zeta is never considered, the user is asked to paste an id,
    // and this goes red. Before this test existed that mutation killed NOTHING.
    assert.ok(got, 'a declaring connector must resolve through the production path');
    assert.equal(got.connector, 'zeta');
    assert.equal(got.descriptor.describeCapability, 'zeta_describe_space');
    assert.equal(got.descriptor.containerKey, 'spaceId', 'the node writes the DECLARED key');
    assert.deepEqual(got.targets, [zetaWrite]);
  });

  test('Airtable still resolves — the generalization did not drop what it replaced', () => {
    registry.register({
      id: 'airtable_describe_base', connector: 'airtable', positions: ['step'],
      schemaDiscovery: { listCapability: 'airtable_list_bases', listResultKey: 'bases',
        describeArg: 'baseId', describeResultKey: 'tables', tableColumnsKey: 'fields',
        containerKey: 'baseId', tableKey: 'tableId' },
    });
    const got = resolveSchemaDiscovery(registry, [
      { type: 'connector-action', config: { action: 'airtable_create_record' } },
    ]);
    assert.equal(got.connector, 'airtable');
    assert.equal(got.descriptor.containerKey, 'baseId');
  });

  test('a draft that writes to no declaring connector resolves to null — we ASK, never guess', () => {
    registry.register({ id: 'zeta_describe_space', connector: 'zeta', positions: ['step'], schemaDiscovery: ZETA });

    // Nothing in this draft touches zeta. Returning a descriptor anyway would send
    // the build hunting for a destination the workflow never writes to.
    assert.equal(resolveSchemaDiscovery(registry, [
      { type: 'connector-action', config: { action: 'slack_post_message' } },
    ]), null);
    assert.equal(resolveSchemaDiscovery(registry, []), null);
    assert.equal(resolveSchemaDiscovery(null, [zetaWrite]), null, 'no catalog ⇒ ask, do not throw');
  });
});
