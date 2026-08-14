/**
 * A PERSON PICKS THEIR SPREADSHEET. THEY DO NOT PASTE ITS ID.
 *
 * WITNESSED ON PROD, 2026-07-30, driving the Sheets shape:
 *
 *     "What is the spreadsheet ID for 'Pricing Enquiries'? (I need it to map the
 *      columns correctly — you can find it in the URL of the sheet, between /d/ and
 *      /edit.)"
 *
 * …asked AFTER offering "the spreadsheet ID **or name**" and being given a name. That is
 * the developer-settings errand P13 forbids, wearing a chat bubble.
 *
 * The discovery seam has existed since P13-0 and **only Airtable ever declared it**, so
 * every other connector fell back to asking. `sheets_describe` was built for exactly this
 * job and had been sitting unwired — the residual has been carried in ENGINEERING-LOG.md since.
 *
 * TWO THINGS HAD TO GENERALISE, and both were Airtable's shape being ASSUMED rather than
 * declared — the same mistake as the hardcoded connector strings the seam was built to
 * remove, one level down:
 *   · `listArgs` — Sheets has no "list spreadsheets" capability, so the container list
 *     comes from DRIVE filtered to spreadsheets. Airtable's list took no arguments, so
 *     the consumer passed none, and Drive would have returned every file in the account.
 *   · `tableIdKey` / `tableNameKey` — a tab returns `{sheet, headers}`, with no `id` and
 *     no `name`. The consumer read those two field names literally, so the first Google
 *     Sheet would have thrown on `x.name.toLowerCase()`.
 *
 * Every test here drives the REAL registry and the REAL return shapes of
 * `driveListFiles` and `sheetsDescribe`. A fixture shaped the way the author imagines is
 * what hid both mismatches.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { resolveSchemaDiscovery, fillDestination } from '../../src/converger/elicitation-graph.js';
import { shouldAsk } from '../../src/converger/asking.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function live() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  return reg;
}

/** A Sheets write, as the converger builds one. */
const SHEETS_WRITE = [
  { id: 'row', type: 'deliver', label: 'Append row',
    config: { channel: 'sheets_append', spreadsheetId: 'Pricing Enquiries', range: 'A:E' } },
];

describe('Google is discoverable at all', () => {
  test('the connector now declares how to find where a write lands', () => {
    const d = live().schemaDiscoveryFor('google');
    assert.ok(d, 'google declares no schemaDiscovery — this is the residual, still open');
    assert.equal(d.describeCapability, 'sheets_describe', 'the registry supplies the describe id');
  });

  test('…and it did not exist before, which is why the errand happened', () => {
    // Airtable was the ONLY declaring connector. Keeping this assertion documents why
    // the seam looked "built" while every other connector asked for an id.
    const connectors = live().schemaDiscoveryConnectors();
    assert.ok(connectors.includes('airtable'), 'airtable has always declared it');
    assert.ok(connectors.includes('google'), 'google must now too');
  });

  test('resolveSchemaDiscovery picks it up for a Sheets write', () => {
    const found = resolveSchemaDiscovery(live(), SHEETS_WRITE);
    assert.ok(found, 'a Sheets write resolves to no discovery — the person will be asked for an id');
    assert.equal(found.connector, 'google');
    assert.equal(found.descriptor.containerLabel, 'Google Sheet');
    assert.equal(found.descriptor.tableLabel, 'tab');
  });

  test('a workflow touching NO discoverable connector still resolves to nothing', () => {
    // `null` must keep meaning "ask", never "guess" — a guess writes a customer's row
    // into a spreadsheet that does not exist.
    const slackOnly = [{ id: 'p', type: 'deliver', config: { channel: 'slack', target: '#ops' } }];
    assert.equal(resolveSchemaDiscovery(live(), slackOnly), null);
  });
});

describe('the declaration matches what the capabilities REALLY return', () => {
  // The two mismatches, asserted against the actual shapes rather than a fixture.

  /** `driveListFiles` returns this. */
  const DRIVE_RESULT = { files: [
    { id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', name: 'Pricing Enquiries', mimeType: 'application/vnd.google-apps.spreadsheet' },
    { id: '1ZZZ', name: 'Renewals Log', mimeType: 'application/vnd.google-apps.spreadsheet' },
  ] };
  /** `sheetsDescribe` returns this — note: no `id`, no `name`. */
  const DESCRIBE_RESULT = { spreadsheetId: '1Bxi', title: 'Pricing Enquiries',
    sheets: [{ sheet: 'Sheet1', headers: ['Date', 'Sender', 'Subject'] }, { sheet: 'Archive', headers: [] }] };

  const d = () => live().schemaDiscoveryFor('google');

  test('the container list is read from the key Drive actually uses', () => {
    assert.ok(Array.isArray(DRIVE_RESULT[d().listResultKey]), 'listResultKey does not match driveListFiles');
  });

  test('the container id and name are read from keys a Drive file HAS', () => {
    const file = DRIVE_RESULT.files[0];
    assert.ok(file[d().listIdKey ?? 'id'], 'listIdKey does not match a Drive file');
    assert.ok(file[d().listNameKey ?? 'name'], 'listNameKey does not match a Drive file');
  });

  test('THE TAB SHAPE — no `id` and no `name`, so both keys are declared', () => {
    // Reading `.name` literally is what would have thrown on the first Google Sheet.
    const tab = DESCRIBE_RESULT.sheets[0];
    assert.equal(tab.name, undefined, 'a tab genuinely has no `name` — that is the point');
    assert.equal(tab.id, undefined);
    assert.equal(tab[d().tableIdKey], 'Sheet1');
    assert.equal(tab[d().tableNameKey], 'Sheet1');
  });

  test('the columns are read from the key sheets_describe uses', () => {
    assert.deepEqual(DESCRIBE_RESULT.sheets[0][d().tableColumnsKey], ['Date', 'Sender', 'Subject']);
  });

  test('the describe argument is the one sheets_describe requires', () => {
    // `sheets_describe` throws "spreadsheetId is required" under any other name.
    assert.equal(d().describeArg, 'spreadsheetId');
  });

  test('the resolved container is written to the key sheets_append reads', () => {
    const cap = live().list().find(c => c.id === 'sheets_append');
    const keys = (cap.configSchema ?? []).map(f => f.key);
    assert.ok(keys.includes(d().containerKey), `sheets_append has no "${d().containerKey}" config key`);
    assert.ok(keys.includes(d().tableKey), `sheets_append has no "${d().tableKey}" config key`);
  });
});

describe('the container list is filtered to spreadsheets', () => {
  test('Drive is asked only for spreadsheets, not for every file', () => {
    // Without `listArgs` the picker would offer every document, PDF and image in the
    // account — and the consumer invoked the list capability with NO arguments, because
    // Airtable never needed any.
    const d = live().schemaDiscoveryFor('google');
    assert.ok(d.listArgs, 'no listArgs — Drive will return every file in the account');
    assert.match(String(d.listArgs.query), /application\/vnd\.google-apps\.spreadsheet/);
  });

  test('and the consumer actually passes them', () => {
    /**
     * SOURCE-level, and weaker than the rest of this file — said plainly.
     *
     * The first version of this test was WORTHLESS and mutation caught it: it built its
     * own `invokeCapability` double and then called it itself with
     * `descriptor.listArgs`, so it passed whatever the real consumer did. A test that
     * re-implements the code under test proves only that the test can call a function.
     *
     * The destinations node closes over the LLM, the interrupt channel and graph state,
     * so it cannot be lifted and executed here. Replace this with a behavioural check if
     * that node is ever made extractable.
     */
    const SRC = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');
    assert.match(SRC, /invokeCapability\(descriptor\.listCapability, descriptor\.listArgs \?\? undefined\)/,
      'the list capability is invoked with no arguments — Drive will return every file');
  });
});

describe('THE PICKER MUST ONLY FIRE FOR A SPREADSHEET WRITE', () => {
  /**
   * REGRESSION, witnessed on prod 2026-08-01 on a fresh tenant, and it BLOCKED A BUILD.
   * A Gmail→filter→Slack workflow with no spreadsheet anywhere in it stopped and asked
   * *"Which Google Sheet should this write to?"*, listing ten of the customer's real
   * spreadsheets, and sat waiting for an answer to a question about a resource it does
   * not use.
   *
   * Caused by the fix EARLIER THE SAME DAY. Making the connector match read the
   * capability's DECLARED connector was right — `sheets_append` belongs to `google`, not
   * to `google_*` — but `schemaDiscovery` is declared per CONNECTOR while describing ONE
   * resource shape, so `gmail_search`, `calendar_*` and `docs_*` all started matching.
   *
   * The test is now the descriptor's own declaration: a node must ACCEPT the container
   * key the descriptor fills. Scoped to what the capability can hold rather than to who
   * it belongs to — the same lesson as the original fix, one level further in.
   */
  test('a Gmail read with a Slack post offers NO spreadsheet picker', () => {
    const nodes = [
      { id: 's', type: 'connector-action', config: { action: 'gmail_search', query: 'newer_than:1d' } },
      { id: 'p', type: 'deliver', config: { channel: 'slack', target: '#atlas-test-temp' } },
    ];
    assert.equal(resolveSchemaDiscovery(live(), nodes), null,
      'a workflow with no spreadsheet in it was asked which spreadsheet to write to');
  });

  test('nor does a calendar event, or a Google Doc', () => {
    for (const nodes of [
      [{ id: 'c', type: 'connector-action', config: { action: 'calendar_create_event' } }],
      [{ id: 'd', type: 'deliver', config: { channel: 'docs_create' } }],
      [{ id: 'g', type: 'connector-action', config: { action: 'gmail_send' } }],
    ]) assert.equal(resolveSchemaDiscovery(live(), nodes), null, JSON.stringify(nodes[0].config));
  });

  test('…but a Sheets write still does — the feature must survive its own fix', () => {
    assert.ok(resolveSchemaDiscovery(live(), SHEETS_WRITE), 'the picker stopped working entirely');
  });

  test('and nothing is stamped onto a node that cannot hold it', () => {
    // The write half has to narrow identically, or a spreadsheet id is written into a
    // Gmail search node's config — an undeclared key, which is a hard publish failure.
    const reg = live();
    const nodes = [
      { id: 's', type: 'connector-action', config: { action: 'gmail_search', query: 'x' } },
      ...SHEETS_WRITE,
    ];
    const out = fillDestination(nodes, {
      connector: 'google', descriptor: reg.schemaDiscoveryFor('google'), catalog: reg,
      containerId: '1Bxi', tableId: 'Sheet1',
    });
    assert.equal(out[0].config.spreadsheetId, undefined, 'a spreadsheet id was written onto a Gmail search');
    assert.equal(out[1].config.spreadsheetId, '1Bxi', 'the real Sheets write was skipped');
  });
});

describe('Airtable is untouched', () => {
  // The generalisation must not change the connector that already worked. Its
  // descriptor declares no id/name keys, so the defaults must still apply.
  test('its descriptor still resolves for an Airtable write', () => {
    const nodes = [{ id: 'r', type: 'connector-action',
      config: { action: 'airtable_create_record', baseId: 'appXXXXXXXXXXXXXX', tableId: 'Leads' } }];
    const found = resolveSchemaDiscovery(live(), nodes);
    assert.equal(found?.connector, 'airtable');
  });

  test('and it declares no id/name keys, so the defaults are what it gets', () => {
    const d = live().schemaDiscoveryFor('airtable');
    assert.equal(d.tableIdKey, undefined);
    assert.equal(d.tableNameKey, undefined);
    assert.equal(d.listArgs, undefined, 'airtable listed bases with no arguments and still must');
  });
});

describe('the errand this replaces', () => {
  test('the question that was asked is still refused outright', () => {
    // Belt and braces with the asking rules: even if discovery fails entirely, a person
    // is never sent to a URL for an id.
    const v = shouldAsk({ text: "What is the spreadsheet ID for 'Pricing Enquiries'? You can find it in the URL of the sheet, between /d/ and /edit." });
    assert.equal(v.ask, false);
    assert.equal(v.code, 'IDENTIFIER');
  });

  test('and the question it becomes is one a person can answer', () => {
    const { descriptor } = resolveSchemaDiscovery(live(), SHEETS_WRITE);
    const question = `Which ${descriptor.containerLabel} should this write to?`;
    assert.equal(question, 'Which Google Sheet should this write to?');
    assert.equal(shouldAsk({ text: question, discoverable: true, discoveryAttempted: true }).ask, true);
  });
});

describe('THE WRITER HALF — what the person picked is written onto the step', () => {
  /**
   * Discovery resolving is only half of it. `fillDestination` is what puts the chosen
   * spreadsheet ONTO the node, and it used the same id-prefix match — so the picker
   * would have appeared, the person would have chosen "Pricing Enquiries", and the
   * spreadsheet id would have been written onto NOTHING. The build then ends in the
   * very question the discovery exists to replace.
   */
  const reg = () => live();

  test('the picked spreadsheet lands in the key sheets_append reads', () => {
    const d = reg().schemaDiscoveryFor('google');
    const out = fillDestination(SHEETS_WRITE, {
      connector: 'google', descriptor: d, catalog: reg(),
      containerId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms', tableId: 'Sheet1',
    });
    assert.equal(out[0].config.spreadsheetId, '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
      'the id was written onto no node — the person picks and nothing happens');
    assert.equal(out[0].config.range, 'Sheet1');
  });

  test('a node belonging to ANOTHER connector is left alone', () => {
    const mixed = [...SHEETS_WRITE,
      { id: 'p', type: 'deliver', config: { channel: 'slack', target: '#ops' } }];
    const out = fillDestination(mixed, {
      connector: 'google', descriptor: reg().schemaDiscoveryFor('google'), catalog: reg(),
      containerId: '1Bxi', tableId: 'Sheet1',
    });
    assert.deepEqual(out[1].config, { channel: 'slack', target: '#ops' });
  });

  test('with no catalog it still works for Airtable, whose ids DO carry the prefix', () => {
    // The fallback must survive: several call paths build the oracle with no catalog.
    const nodes = [{ id: 'r', type: 'connector-action',
      config: { action: 'airtable_create_record', baseId: '', tableId: '' } }];
    const out = fillDestination(nodes, {
      connector: 'airtable', descriptor: reg().schemaDiscoveryFor('airtable'),
      containerId: 'appXXXXXXXXXXXXXX', tableId: 'Leads',
    });
    assert.equal(out[0].config.baseId, 'appXXXXXXXXXXXXXX');
  });
});

describe('the two connectors do not agree on what a COLUMN is', () => {
  test('Airtable returns objects, a Google Sheet returns bare strings', () => {
    // Everything downstream reads `.name`, so a string column would arrive as
    // `undefined` at the mapper, the assertion rewrite and the log line alike.
    const sheetTab = { sheet: 'Sheet1', headers: ['Date', 'Sender', 'Subject'] };
    const d = live().schemaDiscoveryFor('google');
    const raw = sheetTab[d.tableColumnsKey];
    assert.equal(typeof raw[0], 'string', 'a Sheets header is a bare string — that is the point');
    const normalised = raw.map(c => (typeof c === 'string' ? { name: c } : c)).filter(c => c?.name);
    assert.deepEqual(normalised.map(c => c.name), ['Date', 'Sender', 'Subject']);
  });

  test('and the graph normalises them before anything reads .name', () => {
    // SOURCE-level for the same reason as above: the destinations node cannot be lifted.
    const SRC = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');
    assert.match(SRC, /typeof c === 'string' \? \{ name: c \} : c/,
      'a Sheets header would reach the column mapper as undefined');
  });
});
