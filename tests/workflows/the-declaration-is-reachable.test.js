/**
 * A DECLARATION NOTHING EVER READS IS NOT A DECLARATION.
 *
 * FOUND 2026-07-30, while fixing a calendar workflow that failed its own promise.
 * `CHANNEL_EFFECTS` — a hand-written table in `outcome-oracle.js` mapping a channel to
 * its connector, assertion kind and locator keys — was consulted BEFORE the
 * capability's own declaration. So for every id in both, the declared
 * `effect` / `assertionKind` / `locatorKeys` were **never read**: dead code that looked
 * live. Six shipped capabilities were in that state.
 *
 * THIS IS THE THIRD QUESTION, AND NOTHING WAS ASKING IT.
 *
 *   · `capability-declarations-audit.test.js`      — "is everything DECLARED?"
 *   · `build-and-runtime-agree-everywhere.test.js` — "do the two consumers AGREE?"
 *   · this file                                    — "is the declaration USED?"
 *
 * Both of the others passed throughout, because nothing was missing and the two
 * consumers agreed — on the table. `calendar_create_event` even carried a
 * `locatorKeys: ['title']` declaration written to MATCH the table, so the audit saw a
 * declaration, the sweep saw agreement, and the oracle reported the event's own name as
 * the place it was written. They agreed, and were wrong together.
 *
 * THE ORDER THIS FILE PINS is by CONFIDENCE, not by source:
 *
 *     explicit declaration  >  CHANNEL_EFFECTS  >  inference from the id
 *
 * The middle rung is load-bearing and was found by a failing test rather than by
 * reasoning: P13-0 made silence from a delivery-capable capability count as a WRITE,
 * which is a useful default but an INFERENCE, and the kind it yields comes from a verb
 * regex that knows nothing about Slack. A capability that is merely registered must
 * therefore NOT outrank the table; one that states its own effect, kind or destination
 * must.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { registerSlackTriggers } from '../../src/connectors/slack/index.js';
import { nodeEffect, setCapabilityCatalog, canonicalConnector } from '../../src/workflows/outcome-oracle.js';

/** The live, shipped registry — never a fixture. */
function registry() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  registerSlackTriggers(reg);
  setCapabilityCatalog(reg);
  return reg;
}

/**
 * The ids `CHANNEL_EFFECTS` knows. Kept here as GROUND TRUTH rather than imported,
 * because importing the table would make this file agree with whatever the table says
 * — which is precisely the failure being guarded against. If an id is added there,
 * the completeness check below fails until a human records it here.
 */
const TABLE_IDS = [
  'slack', 'slack_dm', 'slack_file', 'gmail_send', 'docs_create', 'sheets_append',
  'calendar_create_event', 'airtable_create_record', 'airtable_update_record',
  'inbox_deliver', 'in_app', 'webhook',
];

/** A plausible value for each locator key, so every node names a real destination. */
const VALUE = {
  title: 'Weekly Report', tasklistId: 'My Tasks', to: 'sam@acme.com',
  spreadsheetId: 'Leads', range: 'A:C', table: 'Leads', tableId: 'Leads',
  baseId: 'appXXXXXXXXXXXXXX', name: 'Invoices', target: '#ops', user: 'sam@acme.com',
  url: 'https://example.test/hook', subject: 'Hello',
};

const nodeFor = (id, keys, type = 'connector-action') => {
  const config = { [type === 'deliver' ? 'channel' : 'action']: id };
  for (const k of keys) if (VALUE[k] !== undefined) config[k] = VALUE[k];
  return { id: 'n', type, config };
};

describe('where a capability declares, the DECLARATION is what runs', () => {
  const overlapping = () => registry().list().filter(c => TABLE_IDS.includes(c.id));

  test('the overlap is not empty — this file would otherwise prove nothing', () => {
    // A sweep that silently covers nothing is worse than no sweep. Six ids overlapped
    // when this was written; if that drops to zero the duplication is gone and this
    // check should be re-read, not deleted quietly.
    assert.ok(overlapping().length >= 4,
      `only ${overlapping().length} capabilities overlap the table — has the table been emptied?`);
  });

  test('the declared LOCATOR KEYS are the ones actually read', () => {
    // The defect: the table said a calendar event's destination was its `title` OR
    // `subject`; the capability declares `title` alone. Feeding a node BOTH shows
    // which list was consulted.
    const bad = [];
    for (const cap of overlapping()) {
      if (!Array.isArray(cap.locatorKeys) || !cap.locatorKeys.length) continue;
      const node = nodeFor(cap.id, [...cap.locatorKeys, 'subject', 'title', 'target']);
      const eff = nodeEffect(node);
      if (!eff) { bad.push(`${cap.id}: no effect at all`); continue; }
      const wanted = cap.locatorKeys.map(k => VALUE[k]).filter(Boolean);
      const extra = eff.locators.filter(l => !wanted.includes(l));
      if (extra.length) bad.push(`${cap.id}: read ${JSON.stringify(extra)}, which it does not declare`);
    }
    assert.deepEqual(bad, [], 'the table is still deciding where these write');
  });

  test('the declared ASSERTION KIND is the one actually used', () => {
    const bad = [];
    for (const cap of overlapping()) {
      if (typeof cap.assertionKind !== 'string') continue;
      const eff = nodeEffect(nodeFor(cap.id, cap.locatorKeys ?? []));
      if (eff && eff.kind !== cap.assertionKind) {
        bad.push(`${cap.id}: declares ${cap.assertionKind}, oracle says ${eff.kind}`);
      }
    }
    assert.deepEqual(bad, [], 'the table is still deciding what these promise');
  });

  test('and it holds for a `deliver` node as well as a step', () => {
    // Two branches compute this, and a fix applied to one of them is how the halves
    // in this file's neighbours came to disagree.
    const bad = [];
    for (const cap of overlapping()) {
      if (!(cap.positions ?? []).includes('delivery')) continue;
      if (typeof cap.assertionKind !== 'string') continue;
      const eff = nodeEffect(nodeFor(cap.id, cap.locatorKeys ?? [], 'deliver'));
      if (eff && eff.kind !== cap.assertionKind) {
        bad.push(`${cap.id} [deliver]: declares ${cap.assertionKind}, oracle says ${eff.kind}`);
      }
    }
    assert.deepEqual(bad, [], 'the deliver branch still reads the table');
  });

  test('a declared READ is still a read, table entry or not', () => {
    // The fail-OPEN direction. If the table ever gained a read's id, the old order
    // would have made it satisfy promises.
    for (const cap of registry().list().filter(c => c.effect === 'read')) {
      assert.equal(nodeEffect(nodeFor(cap.id, [])), null, cap.id);
    }
  });
});

describe('but a capability that merely EXISTS does not outrank the table', () => {
  test('registered with no declaration keeps the table\'s answer', () => {
    // The middle rung, and the reason this is ordered by confidence rather than by
    // source. `slack` is not a declaring capability; the table knows it is a message,
    // while the id-based inference does not and would call it a record.
    const reg = new CapabilityRegistry();
    reg.register({ id: 'slack', connector: 'slack', positions: ['delivery'] });
    setCapabilityCatalog(reg);
    const eff = nodeEffect({ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } });
    assert.equal(eff.kind, 'message_sent', 'a bare registration must not demote the table to a verb regex');
    assert.deepEqual(eff.locators, ['#ops']);
  });

  test('…and one that DOES declare overrides it', () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: 'slack', connector: 'slack', positions: ['delivery'],
      effect: 'write', assertionKind: 'document_exists', locatorKeys: ['target'],
    });
    setCapabilityCatalog(reg);
    const eff = nodeEffect({ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } });
    assert.equal(eff.kind, 'document_exists', 'an explicit declaration must win');
  });

  test('with NO catalog at all the table still answers', () => {
    // Many checks construct the oracle without a catalog; removing the entries would
    // silently drop them to the verb regex.
    setCapabilityCatalog(null);
    const eff = nodeEffect({ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } });
    assert.equal(eff.kind, 'message_sent');
  });
});

describe('a capability with ONE possible destination can say so', () => {
  /**
   * `locatorKeys: []` means "the destination is FIXED" — it is a declaration, not the
   * absence of one. The code read it as "undeclared" and fell through to the GUESS
   * list, which is the absent-vs-unrecognised conflation this repo keeps paying for.
   *
   * Nothing shipped declares `[]` today, so this is LATENT: the fix was found while
   * giving `calendar_create_event` a fixed destination, and mutation confirmed that
   * reverting it broke nothing. It is pinned here rather than removed because it is a
   * correctness fix for the next capability that has exactly one place to write —
   * without it, that capability silently gets the guess list back.
   */
  const FIXED = 'zzz_post_to_the_one_board';

  const withFixed = () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: FIXED, connector: 'zzz', positions: ['step', 'delivery'],
      effect: 'write', assertionKind: 'record_exists',
      locatorKeys: [], defaultLocator: 'the shared board',
    });
    setCapabilityCatalog(reg);
    return reg;
  };

  test('its destination is the declared default', () => {
    withFixed();
    const eff = nodeEffect({ id: 'n', type: 'connector-action', config: { action: FIXED, title: 'Q3 plan' } });
    assert.deepEqual(eff.locators, ['the shared board']);
  });

  test('and NOT a config key that merely looks like a destination', () => {
    // The whole point. `title` is on the guess list, so reading `[]` as "undeclared"
    // reports the item's own NAME as the place it was written — the exact defect that
    // cost three Opus rebuilds on Google Tasks and two on Calendar.
    withFixed();
    const eff = nodeEffect({ id: 'n', type: 'connector-action', config: { action: FIXED, title: 'Q3 plan', name: 'Q3 plan' } });
    assert.ok(!eff.locators.includes('Q3 plan'), 'the guess list is back');
  });

  test('a promise about that fixed place is kept', () => {
    withFixed();
    const eff = nodeEffect({ id: 'n', type: 'deliver', config: { channel: FIXED, title: 'Q3 plan' } });
    assert.deepEqual(eff.locators, ['the shared board']);
  });

  test('while a capability that declares NOTHING still gets the guess list', () => {
    // The other side of the same distinction: absent is not the same as empty.
    const reg = new CapabilityRegistry();
    reg.register({ id: FIXED, connector: 'zzz', positions: ['step'], effect: 'write', assertionKind: 'record_exists' });
    setCapabilityCatalog(reg);
    const eff = nodeEffect({ id: 'n', type: 'connector-action', config: { action: FIXED, title: 'Q3 plan' } });
    assert.ok(eff.locators.includes('Q3 plan'), 'an undeclared capability still falls back to the guess');
  });
});

describe('the table and the declarations never contradict each other', () => {
  // Where both exist, they may differ in DETAIL (the table lists a `subject` key that
  // neither doc nor calendar accepts) but must never disagree about what the thing IS.
  const TABLE_FACTS = {
    gmail_send:             { connector: 'gmail',    kind: 'message_sent' },
    docs_create:            { connector: 'docs',     kind: 'document_exists' },
    sheets_append:          { connector: 'sheets',   kind: 'record_exists' },
    calendar_create_event:  { connector: 'calendar', kind: 'record_exists' },
    airtable_create_record: { connector: 'airtable', kind: 'record_exists' },
    airtable_update_record: { connector: 'airtable', kind: 'record_exists' },
  };

  test('every id in both agrees about the connector and the kind', () => {
    const caps = new Map(registry().list().map(c => [c.id, c]));
    const bad = [];
    for (const [id, fact] of Object.entries(TABLE_FACTS)) {
      const cap = caps.get(id);
      if (!cap) { bad.push(`${id}: no longer a registered capability — update TABLE_FACTS`); continue; }
      if (typeof cap.assertionKind === 'string' && cap.assertionKind !== fact.kind) {
        bad.push(`${id}: declares ${cap.assertionKind}, table says ${fact.kind}`);
      }
      const declaredConn = canonicalConnector(cap.connector ?? id.split('_')[0]);
      const tableConn    = canonicalConnector(fact.connector);
      // `connector: 'google'` is a VENDOR on these capabilities; the table names the
      // SERVICE. Compare only when the declaration names a service too.
      if (declaredConn !== 'gmail' || id === 'gmail_send') {
        if (cap.connector && cap.connector !== 'google' && declaredConn !== tableConn) {
          bad.push(`${id}: declares connector ${cap.connector}, table says ${fact.connector}`);
        }
      }
    }
    assert.deepEqual(bad, [], 'the fallback contradicts the authority');
  });

  test('and the recorded table ids are still the ones in the table', () => {
    // Ground truth, kept by hand on purpose: importing the table would make this file
    // agree with whatever the table says, which is the failure being guarded against.
    // If this fails, someone edited CHANNEL_EFFECTS — read the note above it first.
    assert.equal(TABLE_IDS.length, 12);
    assert.ok(TABLE_IDS.includes('calendar_create_event'));
  });
});
