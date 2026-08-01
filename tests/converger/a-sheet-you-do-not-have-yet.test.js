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
  CREATE_CHOICE_ID, looksLikeAnIdentifier, nameToCreate, pickerChoices, readPick, headersFor,
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
  test('the sheet they named is offered, not silently swapped for one they have', () => {
    const name = nameToCreate(WROTE('Buyer Inquiries'), sheets(), TEN);
    assert.equal(name, 'Buyer Inquiries');

    const choices = pickerChoices({ containers: TEN, createName: name, containerLabel: 'Google Sheet' });
    assert.equal(choices.length, 4, 'the ten real spreadsheets must still be offered');
    assert.equal(choices[0].id, CREATE_CHOICE_ID);
    assert.equal(choices[0].label, 'Create a new Google Sheet called "Buyer Inquiries"');
    assert.equal(choices[0].selected, true,
      'the default was an unrelated spreadsheet the person never mentioned');
    assert.equal(choices.filter(c => c.selected).length, 1);
  });

  test('and pressing it means CREATE, not "the first one on the list"', () => {
    const pick = readPick({ id: CREATE_CHOICE_ID }, { containers: TEN, createName: 'Buyer Inquiries' });
    assert.deepEqual(pick, { create: 'Buyer Inquiries' });
  });

  test('typing the name means the same thing', () => {
    // A person answering in prose says the name they already said. Case and spacing are
    // not a different answer.
    const pick = readPick({ answer: '  buyer   inquiries ' }, { containers: TEN, createName: 'Buyer Inquiries' });
    assert.deepEqual(pick, { create: 'Buyer Inquiries' });
  });
});

describe('the guard that made the first attempt wrong is still standing', () => {
  test('an unlisted name is never quietly accepted as a destination', () => {
    // `nameToCreate` decides what to OFFER. It must never be readable as "so use it" —
    // the whole point is that the name becomes valid by being created, not by being
    // believed. Nothing here returns a container.
    const out = nameToCreate(WROTE('Buyer Inquiries'), sheets(), TEN);
    assert.equal(typeof out, 'string');
    assert.ok(!TEN.some(c => c.name === out || c.id === out));
  });

  test('a spreadsheet they DO have is picked, never re-created', () => {
    // The commonest case by far, and the one a needless "create" would damage: a second
    // "Agntic CRM" appears in their Drive and the workflow writes to the empty one.
    assert.equal(nameToCreate(WROTE('Agntic CRM'), sheets(), TEN), null);
    assert.equal(nameToCreate(WROTE('agntic crm'), sheets(), TEN), null, 'matched case-sensitively');
    assert.equal(nameToCreate(WROTE(TEN[0].id), sheets(), TEN), null, 'matched by name only');
  });
});

describe('three rules, each a way this could have been made dangerous', () => {
  test('1. a connector that cannot create one is never offered the option', () => {
    // Airtable declares no create capability — a base needs a workspace id nobody has
    // been asked for. Declared, never inferred: its picker is untouched.
    const nodes = [{ id: 'r', type: 'connector-action',
      config: { action: 'airtable_create_record', baseId: 'Buyer Inquiries', tableId: 'Leads' } }];
    assert.equal(airtable().createCapability, undefined);
    assert.equal(nameToCreate(nodes, airtable(), TEN), null);
  });

  test('2. and neither is a connector we never actually listed', () => {
    // "They do not have it" is a claim. With no list capability there is one implicit
    // container and nothing was compared — so nothing can be concluded.
    const d = { ...sheets(), listCapability: null };
    assert.equal(nameToCreate(WROTE('Buyer Inquiries'), d, []), null);
  });

  test('3. a machine identifier is a guess at an id, not a name for a thing', () => {
    // Offering "Create a new Google Sheet called 1DG5qZ9mHvTl…" is nonsense, and it is
    // what a model produces when it invents an id it cannot know.
    for (const junk of [
      '1DG5qZ9mHvTlTU34iGRKWf9-vPyegVufENVmoJLcdnSA',   // a real-shaped Drive file id
      'appXXXXXXXXXXXXXX',                                // an Airtable base id
      'tblbQ0PmkA2o1P17Q',                                // …and a table id
    ]) assert.equal(nameToCreate(WROTE(junk), sheets(), TEN), null, junk);
  });

  test('a template is not a name either — it does not exist until the run', () => {
    for (const v of ['{{extract.sheet}}', '<the spreadsheet>', '   ', ''])
      assert.equal(nameToCreate(WROTE(v), sheets(), TEN), null, JSON.stringify(v));
  });

  test('but a real name with digits or punctuation still reads as a name', () => {
    // The identifier test must not be so eager that it silences a legitimate offer —
    // a false positive here puts the dead end back.
    for (const v of ['2026 Buyer Inquiries', 'Leads (Q3)', 'CRM-2026', 'Inquiries'])
      assert.equal(nameToCreate(WROTE(v), sheets(), TEN), v, v);
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
    // With an empty list the node used to pass straight through to the ordinary ask
    // loop — the errand. There is nothing to pick, and one real thing to do.
    assert.equal(nameToCreate(WROTE('Buyer Inquiries'), sheets(), []), 'Buyer Inquiries');
    const choices = pickerChoices({ containers: [], createName: 'Buyer Inquiries', containerLabel: 'Google Sheet' });
    assert.deepEqual(choices.map(c => c.id), [CREATE_CHOICE_ID]);
  });

  test('and with nothing listed and nothing named, nothing changes', () => {
    assert.equal(nameToCreate(WROTE(''), sheets(), []), null);
  });
});

describe('reading an answer can never leave the build with no destination', () => {
  test('an unreadable answer resolves to what was on screen as the default', () => {
    // The caller has to write SOMETHING onto the node. With a create option offered as
    // the default, falling back to an unrelated existing spreadsheet would be the
    // wrong-file write this whole design avoids.
    assert.deepEqual(readPick({ answer: 'yes please' }, { containers: TEN, createName: 'Buyer Inquiries' }),
      { create: 'Buyer Inquiries' });
    assert.deepEqual(readPick(undefined, { containers: TEN, createName: 'Buyer Inquiries' }),
      { create: 'Buyer Inquiries' });
  });

  test('with no name to create, the old behaviour is byte-for-byte what it was', () => {
    assert.deepEqual(readPick({ id: TEN[1].id }, { containers: TEN, createName: null }), { container: TEN[1] });
    assert.deepEqual(readPick({ answer: 'Q3 Planning' }, { containers: TEN, createName: null }), { container: TEN[2] });
    assert.deepEqual(readPick({ answer: 'nonsense' },  { containers: TEN, createName: null }), { container: TEN[0] });
    assert.deepEqual(pickerChoices({ containers: TEN, createName: null }).map(c => c.selected),
      [true, false, false], 'the first existing option must still be the default');
  });

  test('picking a real spreadsheet still wins over the create option', () => {
    // Offering to create must never make picking harder. They said Buyer Inquiries in
    // chat and then chose Agntic CRM in the picker: the picker is the later word.
    assert.deepEqual(readPick({ id: TEN[0].id }, { containers: TEN, createName: 'Buyer Inquiries' }),
      { container: TEN[0] });
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

  test('it asks whether there is something to create', () => {
    assert.match(SRC, /const createName = nameToCreate\(writeNodes, descriptor, listed\)/);
  });

  test('the question fires for a named-but-absent sheet even with one option or none', () => {
    // The gate was `bases.length > 1`, which is a COUNT. With one spreadsheet in the
    // account and a different one named, no question was asked at all.
    assert.match(SRC, /if \(\(bases\.length > 1 \|\| createName\) && !already\)/);
  });

  test('and the empty-list pass-through no longer swallows a creatable name', () => {
    assert.match(SRC, /if \(!bases\.length && !createName\) return \{ phase: 'gapping' \}/);
  });

  test('a creation that fails degrades to ASKING, never to a made-up id', () => {
    assert.match(SRC, /destination_create_failed/);
    assert.match(SRC, /if \(!newId\) \{/,
      'a connector returning no id would have written `undefined` as the destination');
  });
});
