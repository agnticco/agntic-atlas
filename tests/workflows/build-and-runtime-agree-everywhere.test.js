/**
 * THE TWO HALVES AGREE — FOR EVERY CAPABILITY, EVERY SPELLING, EVERY PAIRING.
 *
 * Seven times across 2026-07-29/30, one rule living in two places drifted apart, or a
 * rule matched the SHAPE of a name instead of its meaning. The last of them —
 * `satisfiesAssertion` consulting the connector alias table while
 * `checkAssertionAtRuntime` compared two canonical scalars — meant a correct workflow
 * passed its promise at build time and failed it at run time, purely because the
 * contract said `google_drive:` where the delivery went via `docs_create`.
 *
 * `capability-declarations-audit.test.js` asks "is everything DECLARED?" and would
 * never have caught that: nothing was missing. This file asks the other question —
 * "do the two consumers of those declarations AGREE?" — and asks it exhaustively
 * rather than for a handful of hand-picked pairs, because hand-picked pairs are how
 * the first six instances were missed.
 *
 * Both sweeps are driven from the LIVE registry, so a capability added tomorrow is
 * swept tomorrow without anyone remembering to add it here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import {
  normalizeDelivery, satisfiesAssertion, checkAssertionAtRuntime,
  canonicalConnector, nodeEffect, setCapabilityCatalog,
} from '../../src/workflows/outcome-oracle.js';

function registry() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  setCapabilityCatalog(reg);
  return reg;
}

/** A plausible value for each locator key, so every node has a real destination. */
const VALUE = {
  title: 'The Thing', tasklistId: 'My Tasks', to: 'sam@acme.com',
  spreadsheetId: 'Leads', range: 'A:C', table: 'Leads', tableId: 'Leads',
  baseId: 'appXXXXXXXXXXXXXX', name: 'Invoices',
};

/** The node a caller would actually write for this capability. */
function nodeFor(cap, type = 'connector-action') {
  const config = { action: cap.id };
  for (const k of cap.locatorKeys ?? []) if (VALUE[k] !== undefined) config[k] = VALUE[k];
  return type === 'deliver'
    ? { id: 'n', type: 'deliver', config: { ...config, channel: cap.id } }
    : { id: 'n', type: 'connector-action', config };
}

const receipt = (node) => normalizeDelivery(node, { dryRun: true, wouldDeliver: true });
const canonOf = (cap) => canonicalConnector(cap.id.split('_')[0]);

/** Every spelling of a connector a model plausibly writes. */
const spellings = (canon) => [...new Set([canon, `g${canon}`, `google${canon}`, `google_${canon}`])];

/** Both answers to the one question. */
function bothHalves(assertion, node) {
  return {
    build: satisfiesAssertion(assertion, node),
    run: checkAssertionAtRuntime(assertion, [receipt(node)]).ok,
  };
}

describe('every write, every spelling, both node forms', () => {
  /** [capability, node, assertion] for the whole matrix. */
  const matrix = (() => {
    const out = [];
    for (const cap of registry().list().filter(c => c.effect === 'write')) {
      const base = nodeFor(cap);
      const eff = nodeEffect(base);
      if (!eff) continue;              // audited elsewhere; nothing to compare here
      const locator = eff.locators[0] ?? '';
      const forms = [base];
      if ((cap.positions ?? []).includes('delivery')) forms.push(nodeFor(cap, 'deliver'));
      for (const node of forms) {
        for (const spell of spellings(canonOf(cap))) {
          out.push([cap, node, { id: 'a1', kind: eff.kind, target: `${spell}:${locator}` }]);
        }
      }
    }
    return out;
  })();

  test('the matrix is not empty, and covers every shipped write', () => {
    // A sweep that silently covers nothing is worse than no sweep.
    const swept = new Set(matrix.map(([cap]) => cap.id));
    const writes = registry().list().filter(c => c.effect === 'write').map(c => c.id);
    assert.deepEqual(writes.filter(id => !swept.has(id)), [], 'these writes were not swept');
    assert.ok(matrix.length >= 40, `only ${matrix.length} combinations — the sweep has shrunk`);
  });

  test('build-time and runtime never disagree', () => {
    const bad = [];
    for (const [cap, node, a] of matrix) {
      const v = bothHalves(a, node);
      if (v.build !== v.run) bad.push(`${cap.id} [${node.type}] "${a.target}" build=${v.build} run=${v.run}`);
    }
    assert.deepEqual(bad, [], 'one rule, two answers');
  });

  test('and both SATISFY, since each promise names its own destination', () => {
    // Agreement alone is not enough: agreeing on "no" for a correct workflow is the
    // prod bug. Every row here is a capability promised against the place it writes.
    const bad = [];
    for (const [cap, node, a] of matrix) {
      const v = bothHalves(a, node);
      if (!v.build || !v.run) bad.push(`${cap.id} [${node.type}] "${a.target}" build=${v.build} run=${v.run}`);
    }
    assert.deepEqual(bad, [], 'a correct workflow judged as breaking its promise');
  });
});

describe('every promise against every other delivery', () => {
  // Where a fail-open would hide: A's promise checked against B's delivery.
  const pairs = (() => {
    const reg = registry();
    const writes = reg.list().filter(c => c.effect === 'write');
    const reads = reg.list().filter(c => c.effect === 'read' && (c.positions ?? []).includes('step'));
    const out = [];
    for (const A of writes) {
      const eff = nodeEffect(nodeFor(A));
      if (!eff) continue;
      const a = { id: 'a1', kind: eff.kind, target: `${canonOf(A)}:${eff.locators[0] ?? ''}` };
      for (const B of [...writes, ...reads]) out.push([A, B, a, nodeFor(B)]);
    }
    return out;
  })();

  test('the pairing sweep is substantial', () => {
    assert.ok(pairs.length >= 150, `only ${pairs.length} pairings`);
  });

  test('the two halves agree on every pairing', () => {
    const bad = [];
    for (const [A, B, a, nb] of pairs) {
      const v = bothHalves(a, nb);
      if (v.build !== v.run) bad.push(`promise ${A.id} vs delivery ${B.id}: build=${v.build} run=${v.run}`);
    }
    assert.deepEqual(bad, [], 'the halves disagree about a cross pairing');
  });

  test('a READ never keeps a promise, in either half', () => {
    // The fail-open direction. `gmail_get_message` once counted as a send because
    // `…_message` matched the message_sent verb.
    const bad = [];
    for (const [A, B, a, nb] of pairs) {
      if (B.effect !== 'read') continue;
      const v = bothHalves(a, nb);
      if (v.build || v.run) bad.push(`"${a.target}" satisfied by the READ ${B.id} (build=${v.build} run=${v.run})`);
    }
    assert.deepEqual(bad, [], 'a read satisfied a promise');
  });

  test('a DIFFERENT connector never keeps the promise either', () => {
    const bad = [];
    for (const [A, B, a, nb] of pairs) {
      if (canonOf(B) === canonOf(A)) continue;
      const v = bothHalves(a, nb);
      if (v.build || v.run) bad.push(`"${a.target}" satisfied by ${B.id} (build=${v.build} run=${v.run})`);
    }
    assert.deepEqual(bad, [], 'the wrong connector satisfied a promise');
  });
});

describe('the pairing that started this', () => {
  test('a Doc promised as google_drive: passes both halves', () => {
    // The exact prod shape, kept as a named case so a reader can see it without
    // decoding the sweep.
    const doc = { id: 'd', type: 'deliver', config: { channel: 'docs_create', title: 'New Companies This Week' } };
    registry();
    const v = bothHalves({ id: 'a1', kind: 'document_exists', target: 'google_drive:New Companies This Week' }, doc);
    assert.deepEqual(v, { build: true, run: true });
  });
});
