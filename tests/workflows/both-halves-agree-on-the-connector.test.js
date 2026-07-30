/**
 * BUILD-TIME AND RUNTIME DISAGREED ABOUT WHERE A GOOGLE DOC LIVES.
 *
 * WITNESSED ON PROD, 2026-07-30 (`build-platform-1785413586868`), driving a weekly CRM
 * digest written into a Google Doc. The contract said:
 *
 *     document_exists → google_drive:New Companies This Week
 *
 * and the delivery went via `docs_create`. `satisfiesAssertion` said satisfied;
 * `checkAssertionAtRuntime` said *"nothing reached "New Companies This Week" in google
 * drive — this run delivered to New Companies This Week — {{today}} (Google Docs)"*.
 * The build then spent two more whole-spec Opus passes trying to fix a spec that was
 * already correct, and the gate refused the third. Writing the identical promise as
 * `docs:` passed both halves — so the WORDING decided the verdict on a correct
 * workflow.
 *
 * THE CAUSE. The build-time half asks whether the wanted connector is among the
 * ALIASES of what the node writes to — `docs` carries `['docs','google','drive',
 * 'gdocs']`, because a Google Doc genuinely does live in Drive. The runtime half
 * compared two canonical SCALARS: `docs` vs `drive`, not equal, promise broken. One
 * rule, two places, drifted — the seventh instance of that shape in two days.
 *
 * WHY THE FIX IS DIRECTED AND NOT SYMMETRIC. `gmail` and `docs` BOTH list `google`
 * among their aliases. Intersecting the two alias sets would make an email satisfy a
 * promise about a document — a fail-open far worse than the false negative being
 * fixed. The question asked is exactly the build-time one: is the WANTED connector
 * among the aliases of what was actually written to.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import {
  normalizeDelivery, satisfiesAssertion, checkAssertionAtRuntime, setCapabilityCatalog,
} from '../../src/workflows/outcome-oracle.js';

function catalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  setCapabilityCatalog(reg);
}

const DOC   = { id: 'd', type: 'deliver', config: { channel: 'docs_create', title: 'New Companies This Week — {{today}}' } };
const MAIL  = { id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: 'sam@acme.com', subject: 'x', body: 'y' } };
const SHEET = { id: 's', type: 'deliver', config: { channel: 'sheets_append', spreadsheetId: 'Leads', range: 'A:C' } };
const SLACK = { id: 'k', type: 'deliver', config: { channel: 'slack', target: '#ops', body: 'hi' } };

const receipt = (node) => normalizeDelivery(node, { dryRun: true, wouldDeliver: true });

/** Both halves of the same question, so a disagreement cannot hide. */
function verdicts(target, kind, node) {
  catalog();
  const a = { id: 'a1', kind, target };
  return {
    build: satisfiesAssertion(a, node),
    run:   checkAssertionAtRuntime(a, [receipt(node)]).ok,
  };
}

describe('THE PROD CASE', () => {
  test('a Doc keeps a promise written as google_drive:', () => {
    const v = verdicts('google_drive:New Companies This Week', 'document_exists', DOC);
    assert.deepEqual(v, { build: true, run: true });
  });

  test('the failure sentence a person was shown is gone', () => {
    catalog();
    const a = { id: 'a1', kind: 'document_exists', target: 'google_drive:New Companies This Week' };
    const r = checkAssertionAtRuntime(a, [receipt(DOC)]);
    assert.equal(r.ok, true, r.reason ?? '');
  });
});

describe('the wording of the promise no longer decides the verdict', () => {
  // Every one of these is the same workflow and the same delivery. Before the fix,
  // `docs:` passed and `google_drive:` failed.
  for (const target of ['docs:New Companies This Week', 'drive:New Companies This Week',
                        'gdrive:New Companies This Week', 'google_drive:New Companies This Week',
                        'google_docs:New Companies This Week', 'gdocs:New Companies This Week']) {
    test(`"${target}"`, () => {
      const v = verdicts(target, 'document_exists', DOC);
      assert.equal(v.build, true, 'build-time');
      assert.equal(v.run, true, 'runtime');
    });
  }
});

describe('the two halves agree, whatever the answer is', () => {
  const CASES = [
    ['google_drive:New Companies This Week', 'document_exists', DOC,   'a doc, asked as drive'],
    ['docs:New Companies This Week',         'document_exists', DOC,   'a doc, asked as docs'],
    ['gmail:sam@acme.com',                   'message_sent',    MAIL,  'an email, asked as gmail'],
    ['sheets:Leads',                         'record_exists',   SHEET, 'a sheet row'],
    ['slack:#ops',                           'message_sent',    SLACK, 'a slack post'],
    ['gmail:New Companies This Week',        'message_sent',    DOC,   'a doc, asked as MAIL'],
    ['docs:sam@acme.com',                    'document_exists', MAIL,  'an email, asked as DOCS'],
    ['airtable:Leads',                       'record_exists',   DOC,   'a doc, asked as AIRTABLE'],
    ['slack:#ops',                           'message_sent',    MAIL,  'an email, asked as SLACK'],
  ];
  for (const [target, kind, node, label] of CASES) {
    test(label, () => {
      const v = verdicts(target, kind, node);
      assert.equal(v.build, v.run,
        `build says ${v.build} and runtime says ${v.run} about the same delivery`);
    });
  }
});

describe('it did not become a fail-open', () => {
  test('an EMAIL does not keep a promise about a document', () => {
    // gmail and docs both carry `google` in their alias lists, so a symmetric
    // intersection would have passed this. It must not.
    assert.equal(verdicts('docs:My Report', 'document_exists', MAIL).run, false);
  });

  test('a DOCUMENT does not keep a promise about email', () => {
    assert.equal(verdicts('gmail:sam@acme.com', 'message_sent', DOC).run, false);
  });

  test('an unrelated connector never matches', () => {
    for (const [target, kind] of [['airtable:Leads', 'record_exists'],
                                  ['slack:#ops', 'message_sent'],
                                  ['inbox:Digest', 'message_sent']]) {
      assert.equal(verdicts(target, kind, DOC).run, false, target);
    }
  });

  test('and the LOCATOR is still checked', () => {
    // Getting the connector right must not excuse the wrong destination. Note the
    // asymmetry, which I got wrong first time and the test caught: a template in the
    // ASSERTION is undecidable and excused, but a template in the DELIVERY's own
    // locator is compared literally — so a doc titled "New Companies This Week — …"
    // does not satisfy a promise about "Some Other Document", and should not.
    assert.equal(verdicts('docs:Some Other Document', 'document_exists', DOC).run, false,
      'right connector, wrong document — still a broken promise');
    assert.equal(verdicts('sheets:SomeOtherSheet', 'record_exists', SHEET).run, false,
      'a literal locator that differs must still fail');
  });

  test('a delivery that did not go through is still not a match', () => {
    catalog();
    const a = { id: 'a1', kind: 'document_exists', target: 'google_drive:New Companies This Week' };
    const refused = normalizeDelivery(DOC, { dryRun: true, wouldDeliver: false });
    assert.equal(checkAssertionAtRuntime(a, [refused]).ok, false);
  });
});
