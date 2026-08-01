/**
 * "CREATE A FRESH SHEET CALLED BUYER INQUIRIES" — AND THE PICKER OFFERED TEN OTHERS.
 *
 * Witnessed on a fresh tenant, 2026-08-01. The Sheets picker shipped the day before did
 * its job: real spreadsheets, by name, no ids. Then, told *"don't touch that one — create
 * a fresh sheet called Buyer Inquiries for this instead"*, the build stopped and asked
 * *"Which Google Sheet should this write to?"*, listing the same ten spreadsheets, **none
 * of them Buyer Inquiries**. A question with no correct answer.
 *
 * THE FIX THAT WAS TRIED FIRST IS WHY THIS FILE EXISTS. Skipping the picker and carrying
 * the named sheet through turned eight destination-adversarial tests red — including *"a
 * base id the connector never listed cannot survive into the spec"*, whose own comment
 * reads *"a guess writes the customer's lead into a base that does not exist."* That is a
 * silent failure, and it is worse than the dead end it replaces. It was reverted.
 *
 * So the invariant is KEPT and the missing half is BUILT: the sheet reaches the spec by
 * being CREATED, after which it is a real container with a real id and every existing
 * check passes for the ordinary reason. Slack has worked this way since 2026-07-24;
 * Sheets got the pick half and never got the create half.
 *
 * The decision is pure and exported (`destination-create-or-pick.js`) precisely because
 * the destinations node closes over the LLM, the graph state and `interrupt` and cannot be
 * lifted — the trap this file's neighbour records as "a generalisation silently reverted
 * in a closure nobody can reach".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import {
  looksLikeAnIdentifier, resolveNamedContainer, headersFor,
} from '../../src/converger/destination-create-or-pick.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The live, shipped registry — never a fixture. */
function live() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  return reg;
}
const sheets   = () => live().schemaDiscoveryFor('google');
const airtable = () => live().schemaDiscoveryFor('airtable');

/** The ten real spreadsheets the picker listed, shortened. */
const TEN = [
  { id: '1DG5qZ9mHvTlTU34iGRKWf9-vPyegVufENVmoJLcdnSA', name: 'Agntic CRM' },
  { id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', name: 'Pricing Enquiries' },
  { id: '1ZZqZ9mHvTlTU34iGRKWf9-vPyegVufENVmoJLcdnSAx', name: 'Q3 Planning' },
];
/** The write step, as the build recorded it: the NAME the person gave. */
const WROTE = (v) => [{ id: 'row', type: 'connector-action',
  config: { action: 'sheets_append', spreadsheetId: v, range: 'Sheet1' } }];

describe('THE WITNESSED CASE', () => {
  test('the sheet they named is created — it is not swapped for one they have', () => {
    assert.deepEqual(resolveNamedContainer(WROTE('Buyer Inquiries'), sheets(), TEN),
      { create: 'Buyer Inquiries' });
  });

  test('AND NOBODY IS ASKED ABOUT IT', () => {
    // Charles, watching the first fix work: "It did it again. All questions and details
    // should be worked out before the build commences." The answer being right is not
    // enough when the question should not have been asked.
    const out = resolveNamedContainer(WROTE('Buyer Inquiries'), sheets(), TEN);
    assert.ok(out, 'a null here is the code saying "I do not know" — which is the question');
  });
});

describe('THE QUESTION THAT SHOULD NEVER HAVE BEEN ASKED AT ALL', () => {
  /**
   * The older half, and the reason the picker appeared on EVERY Sheets build: the
   * already-answered test compared IDS ONLY. Airtable's model writes a real base id it
   * learned from `airtable_describe_base`; a Sheets user says "Agntic CRM". So a person
   * who named a spreadsheet they own, and saw the plan card quote it back, was still
   * asked which spreadsheet to use.
   */
  test('a spreadsheet they own, named the way a PERSON names it, is just used', () => {
    assert.deepEqual(resolveNamedContainer(WROTE('Agntic CRM'), sheets(), TEN),
      { container: TEN[0] });
  });

  test('case and spacing are not a different spreadsheet', () => {
    for (const v of ['agntic crm', '  Agntic   CRM  ', 'AGNTIC CRM'])
      assert.deepEqual(resolveNamedContainer(WROTE(v), sheets(), TEN), { container: TEN[0] }, v);
  });

  test('and an id still resolves, so Airtable is exactly as it was', () => {
    assert.deepEqual(resolveNamedContainer(WROTE(TEN[1].id), sheets(), TEN),
      { container: TEN[1] });
  });

  test('nothing recorded is the ONE remaining ambiguity, and it still asks', () => {
    // The build wrote down no destination. Nobody but a person can settle that, and
    // this is the only case left that reaches the picker.
    assert.equal(resolveNamedContainer(WROTE(''), sheets(), TEN), null);
    assert.equal(resolveNamedContainer([], sheets(), TEN), null);
  });
});

describe('the guard that made the first attempt wrong is still standing', () => {
  test('an unlisted name never becomes a destination by being believed', () => {
    // The whole point: the name becomes valid by being CREATED, not by being trusted.
    // `{create}` is an instruction to the connector, never a container.
    const out = resolveNamedContainer(WROTE('Buyer Inquiries'), sheets(), TEN);
    assert.equal(out.container, undefined);
    assert.ok(!TEN.some(c => c.name === out.create || c.id === out.create));
  });

  test('an id the tenant does not have is NOT created — it falls through to asking', () => {
    // A model's invented id is a guess at an identifier, not a name for a thing.
    // Creating a spreadsheet called `appABCDEFGHIJKLMN` would be nonsense, and this is
    // the case the destination-adversarial suite exists to hold.
    for (const junk of [
      '1DG5qZ9mHvTlTU34iGRKWf9-vPyegVufENVmoJLcdnSAxx',
      'appABCDEFGHIJKLMN',
      'tblbQ0PmkA2o1P17Q',
    ]) assert.equal(resolveNamedContainer(WROTE(junk), sheets(), TEN), null, junk);
  });
});

describe('three rules, each a way this could have been made dangerous', () => {
  test('1. a connector that cannot create one never tries', () => {
    // Airtable declares no create capability — a base needs a workspace id nobody has
    // been asked for. Declared, never inferred: its behaviour is untouched.
    const nodes = [{ id: 'r', type: 'connector-action',
      config: { action: 'airtable_create_record', baseId: 'Buyer Inquiries', tableId: 'Leads' } }];
    assert.equal(airtable().createCapability, undefined);
    assert.equal(resolveNamedContainer(nodes, airtable(), TEN), null);
  });

  test('2. and neither does a connector we never actually listed', () => {
    // "They do not have it" is a claim. With no list capability there is one implicit
    // container and nothing was compared — so nothing can be concluded.
    const d = { ...sheets(), listCapability: null };
    assert.equal(resolveNamedContainer(WROTE('Buyer Inquiries'), d, []), null);
  });

  test('3. a template is not a name — it does not exist until the run', () => {
    for (const v of ['{{extract.sheet}}', '<the spreadsheet>', '   '])
      assert.equal(resolveNamedContainer(WROTE(v), sheets(), TEN), null, JSON.stringify(v));
  });

  test('but a real name with digits or punctuation still reads as a name', () => {
    // A false positive on the identifier test puts the dead end back.
    for (const v of ['2026 Buyer Inquiries', 'Leads (Q3)', 'CRM-2026', 'Inquiries'])
      assert.deepEqual(resolveNamedContainer(WROTE(v), sheets(), TEN), { create: v }, v);
  });

  test('the identifier test, directly', () => {
    assert.equal(looksLikeAnIdentifier('1DG5qZ9mHvTlTU34iGRKWf9-vPyegVufENVmoJLcdnSA'), true);
    assert.equal(looksLikeAnIdentifier('appXXXXXXXXXXXXXX'), true);
    // Whitespace settles it: no Google file id has a space, and most names do.
    assert.equal(looksLikeAnIdentifier('A Spreadsheet With A Very Long Name Indeed'), false);
    assert.equal(looksLikeAnIdentifier('Buyer Inquiries'), false);
    assert.equal(looksLikeAnIdentifier(''), false);
  });
});

describe('a brand-new workspace has NO spreadsheets at all', () => {
  test('which is exactly when someone names one that does not exist', () => {
    assert.deepEqual(resolveNamedContainer(WROTE('Buyer Inquiries'), sheets(), []),
      { create: 'Buyer Inquiries' });
  });

  test('and with nothing listed and nothing named, nothing changes', () => {
    assert.equal(resolveNamedContainer(WROTE(''), sheets(), []), null);
  });
});

describe('a step that says nothing does not silence the step that does', () => {
  test('a blank and a template are SKIPPED, not read as "no destination"', () => {
    // The loop must keep looking. Treating the first unusable value as the answer would
    // send a build that knows exactly where it writes into the question — which is the
    // interruption this whole round removes.
    const nodes = [
      { id: 'a', type: 'connector-action', config: { action: 'sheets_append', spreadsheetId: '' } },
      { id: 'b', type: 'connector-action', config: { action: 'sheets_append', spreadsheetId: '{{pick.sheet}}' } },
      { id: 'c', type: 'connector-action', config: { action: 'sheets_append', spreadsheetId: 'Agntic CRM' } },
    ];
    assert.deepEqual(resolveNamedContainer(nodes, sheets(), TEN), { container: TEN[0] });
  });

  test('and the same holds for one it has to create', () => {
    const nodes = [
      { id: 'a', type: 'connector-action', config: { action: 'sheets_append', spreadsheetId: '{{x}}' } },
      { id: 'b', type: 'connector-action', config: { action: 'sheets_append', spreadsheetId: 'Buyer Inquiries' } },
    ];
    assert.deepEqual(resolveNamedContainer(nodes, sheets(), TEN), { create: 'Buyer Inquiries' });
  });
});

describe('a created sheet starts with the columns the build already promised', () => {
  const readFields = (config) => (config?.fields && typeof config.fields === 'object' ? config.fields : null);

  test('taken from the promise and the step, never invented', () => {
    const nodes = [{ id: 'row', type: 'connector-action',
      config: { action: 'sheets_append', fields: { Sender: '{{a}}', Subject: '{{b}}' } } }];
    const outcome = { assertions: [{ kind: 'record_exists', target: 'sheets:Buyer Inquiries', fields: ['Subject', 'Summary'] }] };
    assert.deepEqual(headersFor(nodes, outcome, readFields), ['Sender', 'Subject', 'Summary']);
  });

  test('and knowing none writes no header row rather than guessing one', () => {
    // `sheets_append` is positional and carries `values`, not `fields`, so this is the
    // ORDINARY case today. A guessed header lives in someone's spreadsheet forever.
    assert.deepEqual(headersFor(WROTE('Buyer Inquiries'), null, readFields), []);
  });
});

describe('the connector really can make one', () => {
  test('sheets_create is registered, and is SETUP — never a step in the run path', () => {
    const cap = live().get('sheets_create');
    assert.ok(cap, 'nothing can be created — the picker would offer an option that fails');
    assert.equal(cap.connector, 'google');
    assert.equal(cap.oneTimeSetup, true,
      'a spreadsheet created on every run is the airtable_create_field defect again');
    assert.equal(cap.effect, 'write');
  });

  test('the descriptor points at it by name, and at the id it returns', () => {
    const d = sheets();
    assert.equal(d.createCapability, 'sheets_create');
    assert.equal(d.createNameArg, 'title');
    assert.equal(d.createIdKey, 'spreadsheetId');
    // The declared argument names must be ones the capability actually takes, or the
    // create call silently makes an untitled sheet.
    const keys = live().get('sheets_create').configSchema.map(f => f.key);
    assert.ok(keys.includes(d.createNameArg), `sheets_create takes no "${d.createNameArg}"`);
    assert.ok(keys.includes(d.createColumnsArg), `sheets_create takes no "${d.createColumnsArg}"`);
  });
});

describe('the node consults all of this — SOURCE level, and weaker than the rest', () => {
  /**
   * Said plainly: the `destinations` node closes over the LLM, the graph state and
   * `interrupt`, so it cannot be lifted and executed the way the page renderers can. A
   * behavioural harness for it would have to drive the whole graph.
   *
   * These pins exist because the decision being RIGHT and never being CONSULTED is a
   * failure this repo has shipped before — the destination fix of P13-0 was pinned by
   * nothing and reverting it left the whole suite green.
   */
  const SRC = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');

  test('it asks the shared decision what the conversation already settled', () => {
    assert.match(SRC, /const settled = resolveNamedContainer\(writeNodes, descriptor, listed\)/);
  });

  test('THE INTERRUPT IS REACHED ONLY WHEN NOTHING WAS SETTLED', () => {
    // The whole point of this round. `interrupt` must sit in the LAST branch — the one
    // taken when the build recorded no usable destination — never on the path where it
    // has a container or a name to create.
    const at = SRC.indexOf('const settled = resolveNamedContainer');
    const block = SRC.slice(at, at + 4000);
    const ask = block.indexOf('await interrupt(');
    assert.ok(ask > 0, 're-point this test');
    const branch = block.lastIndexOf('} else if (bases.length > 1) {', ask);
    assert.ok(branch > 0 && branch < ask,
      'the question is no longer guarded by "nothing was settled" — it can interrupt a build that knows the answer');
  });

  test('and neither the container nor the create branch can reach it', () => {
    const at = SRC.indexOf('const settled = resolveNamedContainer');
    const block = SRC.slice(at, at + 4000);
    const container = block.indexOf('if (settled?.container)');
    const create    = block.indexOf('} else if (settled?.create) {');
    const ask       = block.indexOf('await interrupt(');
    assert.ok(container > 0 && create > container && ask > create,
      'the branches were reordered — a settled destination may now fall into the question');
  });

  test('the empty-list pass-through does not swallow a creatable name', () => {
    assert.match(SRC, /if \(!bases\.length && !settled\?\.create\) return \{ phase: 'gapping' \}/);
  });

  test('a creation that fails degrades to ASKING, never to a made-up id', () => {
    assert.match(SRC, /destination_create_failed/);
    assert.match(SRC, /if \(!newId\) \{/,
      'a connector returning no id would have written `undefined` as the destination');
  });
});
