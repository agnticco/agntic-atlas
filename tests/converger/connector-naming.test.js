/**
 * A COMPOUND CONNECTOR NAME MUST NOT READ AS "NOT CONNECTED".
 *
 * Driving a research workflow live, the converger REFUSED TO BUILD:
 *
 *   "I can't include google_docs — that connector is not connected, so I won't
 *    promise something the workflow can't actually do."
 *
 * Google Docs was connected. The live catalog, queried from the authenticated
 * app at that moment, reported `docs_create` with `available: true`.
 *
 * The model had written its outcome assertion as `google_docs:My Digest` — what a
 * person would say. That is neither a connector id (`google`) nor a capability id
 * (`docs_create`), so the candidate filter compared it raw against the alias set
 * built from the live catalog, matched nothing, and refused. The same request had
 * built fine minutes earlier with a different spelling, which is what made it look
 * like flakiness rather than a naming bug.
 *
 * Two things are pinned:
 *   1. compound vendor names resolve to their connector (google_docs -> docs),
 *   2. a genuinely unconnected connector is STILL refused — the fix must not
 *      simply make everything promisable, which would reintroduce the defect it
 *      exists to prevent (promising a destination the workflow cannot reach).
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { canonicalConnector, assertableConnectors } from '../../src/workflows/outcome-oracle.js';

/** The shape `builder.js` hands the converger: the live, per-tenant catalog. */
const catalog = () => ({
  channels: [
    { id: 'docs_create',    available: true },
    { id: 'sheets_append',  available: true },
    { id: 'gmail_send',     available: true },
    { id: 'slack',          available: true },
  ],
});

/** Exactly what the converger's candidate filter asks. */
const promisable = (target) => {
  const can = assertableConnectors(catalog());
  const connector = String(target).split(':')[0].toLowerCase();
  return can.has(connector) || can.has(canonicalConnector(connector));
};

describe('connector names a person would write', () => {
  test('google_docs resolves to the docs connector', () => {
    assert.equal(canonicalConnector('google_docs'), 'docs');
    assert.equal(promisable('google_docs:My Weekly Digest'), true,
      'this exact string caused a live refusal to build against an AVAILABLE connector');
  });

  test('the same holds for the other compound Google names', () => {
    assert.equal(canonicalConnector('google_sheets'), 'sheets');
    assert.equal(promisable('google_sheets:Leads'), true);
  });

  test('separators other than underscore resolve too', () => {
    assert.equal(canonicalConnector('google-docs'), 'docs');
    assert.equal(canonicalConnector('google.docs'), 'docs');
  });

  test('the plain forms still work — nothing regressed', () => {
    for (const t of ['docs:X', 'gdocs:X', 'slack:#ops', 'gmail:me@x.com']) {
      assert.equal(promisable(t), true, `${t} must remain promisable`);
    }
  });

  test('AN UNCONNECTED CONNECTOR IS STILL REFUSED', () => {
    // The whole point of the check: never promise a destination the workflow
    // cannot reach. A fix that made everything promisable would be worse than
    // the bug — it would put the silent-drop defect back.
    assert.equal(promisable('notion:Roadmap'), false);
    assert.equal(promisable('salesforce:Leads'), false);
    // …and a compound name for something unconnected must not sneak through by
    // matching its vendor half.
    assert.equal(promisable('notion_pages:Roadmap'), false,
      'resolving compound names must not become a way to promise anything');
  });

  test('an unresolvable name is returned unchanged, not silently mapped', () => {
    assert.equal(canonicalConnector('quickbooks'), 'quickbooks');
    assert.equal(canonicalConnector(''), '');
  });
});
