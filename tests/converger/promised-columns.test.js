/**
 * A promised column the table does not have must be settled BEFORE the plan.
 *
 * OPERATOR'S CALL (2026-07-28): "the converger needs to sort the column details out
 * with the user before generating the workflow plan, because that information being
 * correct is integral to the success of the workflow" — and "this needs to apply for
 * every table style data source regardless of connector."
 *
 * Today it is found in `destinations`, after the whole workflow has been generated.
 * Measured on prod (build-platform-1785255582744): two whole-spec passes, 112s +
 * 152s, spent on a column that never existed — and the user was asked anyway.
 *
 * The contract already carries everything the question needs: `airtable:Table 1`
 * names the connector and the table, and the assertion names the fields. No node has
 * to exist for this to be answerable, which is exactly why it can run before the plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  promisedColumnGaps, columnMismatchQuestion, tableSchemasFromCapabilities,
} from '../../src/converger/elicitation-graph.js';

// The real prod shape: the user asked for sender name / subject / summary; the real
// "Table 1" has Name, Notes and Date.
const ASSERTIONS = [
  { id: 'a1', kind: 'message_sent',  target: 'slack:#atlas-test-temp' },
  { id: 'a2', kind: 'record_exists', target: 'airtable:Table 1',
    fields: ['Sender Name', 'Subject', 'Summary'] },
];
const REAL = new Map([['table 1', ['Name', 'Notes', 'Date']]]);
const declares = (c) => c === 'airtable';

test('the prod mismatch is caught from the contract alone, before any node exists', () => {
  const gaps = promisedColumnGaps(ASSERTIONS, declares, REAL);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].table, 'Table 1');
  assert.deepEqual(gaps[0].missing, ['Sender Name', 'Subject', 'Summary']);
});

test('a column the table DOES have is not reported missing', () => {
  const gaps = promisedColumnGaps(
    [{ target: 'airtable:Table 1', fields: ['Name', 'Summary'] }], declares, REAL);
  assert.deepEqual(gaps[0].missing, ['Summary'], 'Name exists; only Summary is missing');
});

test('matching is case- and space-insensitive, as a person would expect', () => {
  const gaps = promisedColumnGaps(
    [{ target: 'airtable:Table 1', fields: ['  name ', 'NOTES'] }], declares, REAL);
  assert.equal(gaps.length, 0);
});

test('the question names the real columns, so it can actually be answered', () => {
  const q = columnMismatchQuestion(promisedColumnGaps(ASSERTIONS, declares, REAL)[0]);
  assert.match(q, /Name, Notes, Date/, 'a person needs to see what the table HAS');
  assert.match(q, /Table 1/);
  assert.doesNotMatch(q, /assertion|config\.fields|UNSATISFIED/i, 'no identifiers in a question');
});

// ── GENERIC BY DECLARATION, NEVER BY CONNECTOR NAME ──────────────────────────

test('any connector that declares schema discovery is covered', () => {
  const gaps = promisedColumnGaps(
    [{ target: 'sheets:Leads', fields: ['Company'] }],
    (c) => c === 'sheets',
    new Map([['leads', ['Name', 'Email']]]),
  );
  assert.equal(gaps.length, 1, 'Sheets must be covered by the same mechanism, with no code naming it');
});

test('a connector that does NOT describe itself is left alone', () => {
  const gaps = promisedColumnGaps(
    [{ target: 'notion:Tasks', fields: ['Owner'] }],
    (c) => c === 'airtable',
    new Map([['tasks', ['Title']]]),
  );
  assert.equal(gaps.length, 0, 'we cannot check a schema the connector never offered');
});

// ── THE ANTI-FALSE-PASS CASES ────────────────────────────────────────────────
// Asking about a schema we never read would send the user to fix something fine.

test('columns we could not read are not treated as a mismatch', () => {
  assert.equal(promisedColumnGaps(ASSERTIONS, declares, new Map()).length, 0);
  assert.equal(promisedColumnGaps(ASSERTIONS, declares, new Map([['table 1', []]])).length, 0);
  assert.equal(promisedColumnGaps(ASSERTIONS, declares, null).length, 0);
});

test('an assertion promising no fields asks nothing', () => {
  assert.equal(promisedColumnGaps(
    [{ target: 'airtable:Table 1' }], declares, REAL).length, 0);
  assert.equal(promisedColumnGaps(
    [{ target: 'airtable:Table 1', fields: [] }], declares, REAL).length, 0);
});

test('a message promise is never mistaken for a table promise', () => {
  assert.equal(promisedColumnGaps(
    [{ target: 'slack:#ops', fields: ['Name'] }], (c) => c === 'airtable', REAL).length, 0);
});

test('junk in, nothing out', () => {
  assert.deepEqual(promisedColumnGaps(null, declares, REAL), []);
  assert.deepEqual(promisedColumnGaps([{ target: 'no-colon', fields: ['X'] }], declares, REAL), []);
  assert.deepEqual(promisedColumnGaps([{ target: 'airtable:', fields: ['X'] }], declares, REAL), []);
});

// ── THE SCHEMA COMES FROM WHAT IS ALREADY IN HAND ────────────────────────────
// `buildCapabilities` already fetches the tenant's real bases/tables/columns once
// per build for the chat context. An earlier cut of this asked the connector AGAIN
// and broke the "the connector is asked ONCE" latch two tests pin — a second
// round-trip, on the check whose entire purpose is to make builds cheaper.

test('the real columns are read from the capabilities already fetched', () => {
  const caps = { airtableSchema: [
    { id: 'appX', name: 'Priority Items', tables: [
      { id: 'tblY', name: 'Table 1', fields: [{ name: 'Name' }, { name: 'Notes' }, { name: 'Date' }] },
    ] },
  ] };
  const m = tableSchemasFromCapabilities(caps);
  assert.deepEqual(m.get('table 1'), ['Name', 'Notes', 'Date']);
  assert.deepEqual(m.get('tbly'), ['Name', 'Notes', 'Date'], 'findable by id as well as name');
});

test('a connector added later needs no code here — the generic slot works', () => {
  const m = tableSchemasFromCapabilities({
    schemas: { sheets: [{ id: 's1', name: 'Book', tables: [{ name: 'Leads', columns: ['Company', 'Email'] }] }] },
  });
  assert.deepEqual(m.get('leads'), ['Company', 'Email']);
});

test('an empty or malformed capabilities payload yields nothing, not a crash', () => {
  assert.equal(tableSchemasFromCapabilities(null).size, 0);
  assert.equal(tableSchemasFromCapabilities({}).size, 0);
  assert.equal(tableSchemasFromCapabilities({ airtableSchema: 'nope' }).size, 0);
  assert.equal(tableSchemasFromCapabilities({ airtableSchema: [{ tables: [{ name: 'T' }] }] }).size, 0,
    'a table with no columns contributes nothing, so nothing is reported missing against it');
});

test('end to end: capabilities in, the prod question out', () => {
  const caps = { airtableSchema: [
    { id: 'appX', name: 'Priority Items', tables: [
      { id: 'tblY', name: 'Table 1', fields: [{ name: 'Name' }, { name: 'Notes' }, { name: 'Date' }] },
    ] },
  ] };
  const gaps = promisedColumnGaps(ASSERTIONS, declares, tableSchemasFromCapabilities(caps));
  assert.equal(gaps.length, 1);
  assert.match(columnMismatchQuestion(gaps[0]), /Name, Notes, Date/);
});
