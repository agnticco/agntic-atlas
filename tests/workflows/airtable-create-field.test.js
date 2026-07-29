/**
 * ADDING A COLUMN — the write half of schema awareness.
 *
 * The builder could already READ a table's real columns, so it knew when a workflow
 * promised a field the table did not have. The only thing it could do about it was
 * rebuild the workflow and hope. Observed live: a spec promised a `Notes` column while
 * the model believed the table had `Message`, and it oscillated between the two
 * spellings across two whole-spec rebuilds (425s + 237s) — neither answer could satisfy
 * both. The cheap resolution was always one question, and that question was
 * unanswerable because nothing could add a column.
 *
 * The permission was never the obstacle: `schema.bases:write` shipped with the
 * connector and was used by nothing.
 *
 * WHAT THESE TESTS PIN, and why each one is here rather than being obvious:
 *  - the REQUEST SHAPE. The api helper takes an options object ({ body }), not a bare
 *    body. The first version of this passed the payload directly, which sends no body
 *    at all — a mistake that unit tests only catch if they assert on what was SENT,
 *    and that otherwise surfaces as a confusing 4xx from Airtable.
 *  - the DEFAULT TYPE. A typed guess (a number, a select with invented choices) is a
 *    decision the user did not make, and a wrong type silently rejects writes.
 *  - the REFUSALS. A column with no name, or no table to put it on, is not a request
 *    that should reach Airtable at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { airtableCreateField } from '../../src/connectors/airtable/index.js';

/**
 * Stand in for the connector's api helper, recording exactly how it was called.
 *
 * Answers the SCHEMA READ separately (2026-07-29). `airtableCreateField` now looks
 * the table up first, so that adding a column that already exists is a no-op rather
 * than a failure — see one-time-setup-not-a-step.test.js for why that matters. These
 * tests are about the WRITE, so the read reports an empty base and every assertion
 * below targets the POST rather than "the first call".
 */
function recorder(response = { id: 'fldNEW', name: 'Notes', type: 'singleLineText' }) {
  const calls = [];
  const api = async (method, path, opts) => {
    calls.push({ method, path, opts });
    if (method === 'GET' && path.includes('/tables')) return { tables: [] };
    return response;
  };
  return { api, calls };
}

/** The create call itself. */
const postOf = (calls) => calls.find(c => c.method === 'POST');

const BASE = { baseId: 'appABC', tableId: 'Sheet1', name: 'Notes' };

describe('adding an Airtable column', () => {
  test('sends the body in the options object the api helper expects', async () => {
    const { api, calls } = recorder();
    await airtableCreateField(api, BASE);

    const c = postOf(calls);
    assert.ok(c, 'the column must actually be created');
    assert.equal(c.path, '/meta/bases/appABC/tables/Sheet1/fields');
    assert.ok(c.opts && c.opts.body,
      'the payload must be under `body` — a bare third argument sends no body at all');
    assert.equal(c.opts.body.name, 'Notes');
  });

  test('defaults to a plain text column rather than guessing a type', async () => {
    const { api, calls } = recorder();
    await airtableCreateField(api, BASE);
    assert.equal(postOf(calls).opts.body.type, 'singleLineText',
      'a guessed type is a decision the user did not make, and a wrong one silently rejects writes');
  });

  test('an explicit type is honoured', async () => {
    const { api, calls } = recorder();
    await airtableCreateField(api, { ...BASE, type: 'number' });
    assert.equal(postOf(calls).opts.body.type, 'number');
  });

  test('returns what was created, so the caller can confirm it', async () => {
    const { api } = recorder();
    const r = await airtableCreateField(api, BASE);
    assert.equal(r.name, 'Notes');
    assert.equal(r.created, true);
    assert.equal(r.baseId, 'appABC');
  });

  test('refuses a column with no name — before touching Airtable', async () => {
    const { api, calls } = recorder();
    await assert.rejects(() => airtableCreateField(api, { ...BASE, name: '   ' }), /name is required/i);
    assert.equal(calls.length, 0, 'a nameless column must never reach the API');
  });

  test('refuses when there is no table to add it to', async () => {
    const { api, calls } = recorder();
    await assert.rejects(() => airtableCreateField(api, { baseId: 'appABC', name: 'Notes' }), /tableId is required/i);
    assert.equal(calls.length, 0);
  });

  test('a table NAME with spaces is encoded, not sent raw', async () => {
    const { api, calls } = recorder();
    await airtableCreateField(api, { ...BASE, tableId: 'Sales Enquiries' });
    assert.ok(postOf(calls).path.includes('Sales%20Enquiries'),
      'an unencoded table name breaks the URL for every table whose name has a space');
  });
});
