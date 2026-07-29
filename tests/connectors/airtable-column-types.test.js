/**
 * ATLAS COULD ONLY EVER MAKE ONE KIND OF COLUMN.
 *
 * WITNESSED ON PROD, 2026-07-29, building a lead-intro workflow against a real CRM.
 * Atlas read the Companies table, noticed there was nowhere to record that a lead
 * had been contacted, correctly proposed adding an "Intro Email Sent" CHECKBOX,
 * showed it on the confirm card, was confirmed — and then:
 *
 *     Add Airtable Column "Intro Email Sent" — airtable POST
 *     /meta/bases/app0agE5SbNEnINMY/tables/tblIVdMFZz9UIb71z/fields failed:
 *     Invalid options for Companies.Intro Email Sent:
 *     Failed schema validation: Intro Email Sent.options is missing
 *
 * `airtableCreateField` sent `{ name, type }` and nothing else. Most Airtable field
 * types carry REQUIRED `options`; the only type that does not is the
 * `singleLineText` default. So the capability worked for every column anyone had
 * happened to ask for — all text — and could not create any other kind. It offered
 * to do something it could not do, at the one moment the user had said yes.
 *
 * TWO THINGS ARE FIXED HERE, and the second matters as much as the first: what a
 * person is shown when it still cannot be done. The message above contains an HTTP
 * verb, two opaque provider ids and Airtable's internal validator, and it was
 * rendered verbatim on a chat card.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { airtableCreateField } from '../../src/connectors/airtable/index.js';

const TABLE = { id: 'tbl1', name: 'Companies', fields: [{ id: 'f1', name: 'Notes', type: 'singleLineText' }] };

/** An api double that records the POST body it was given. */
function recordingApi() {
  const seen = {};
  const api = async (method, path, opts) => {
    if (method === 'GET') return { tables: [TABLE] };
    seen.body = opts.body;
    return { id: 'fldNEW', name: opts.body.name, type: opts.body.type };
  };
  api.seen = seen;
  return api;
}

const create = (api, over = {}) =>
  airtableCreateField(api, { baseId: 'appX', tableId: 'Companies', name: 'Intro Email Sent', ...over });

describe('THE PROD CASE: a checkbox column', () => {
  test('it is sent with the options Airtable requires', async () => {
    const api = recordingApi();
    await create(api, { type: 'checkbox' });
    assert.deepEqual(api.seen.body.options, { icon: 'check', color: 'greenBright' });
  });

  test('and the column is actually created', async () => {
    const api = recordingApi();
    assert.equal((await create(api, { type: 'checkbox' })).created, true);
  });
});

describe('every type that needs options gets them', () => {
  const CASES = [
    ['checkbox', o => assert.ok(o.icon && o.color)],
    ['number',   o => assert.equal(typeof o.precision, 'number')],
    ['percent',  o => assert.equal(typeof o.precision, 'number')],
    ['currency', o => assert.ok(typeof o.precision === 'number' && o.symbol)],
    ['rating',   o => assert.ok(o.icon && o.max && o.color)],
    ['date',     o => assert.ok(o.dateFormat?.name)],
    ['dateTime', o => assert.ok(o.dateFormat?.name && o.timeFormat?.name && o.timeZone)],
    ['duration', o => assert.ok(o.durationFormat)],
  ];

  for (const [type, check] of CASES) {
    test(`${type} carries options`, async () => {
      const api = recordingApi();
      await create(api, { type });
      assert.ok(api.seen.body.options, `${type} sent no options — this is the defect`);
      check(api.seen.body.options);
    });
  }

  test('a type that needs NONE sends none', async () => {
    // An empty `options` object is itself a schema violation — absent is not the
    // same as blank.
    for (const type of ['singleLineText', 'multilineText', 'email', 'url', 'phoneNumber']) {
      const api = recordingApi();
      await create(api, { type });
      assert.ok(!('options' in api.seen.body), type);
    }
  });

  test('the default type still works and still sends no options', async () => {
    const api = recordingApi();
    await create(api, {});
    assert.equal(api.seen.body.type, 'singleLineText');
    assert.ok(!('options' in api.seen.body));
  });
});

describe('the caller can always overrule the defaults', () => {
  test('supplied options win', async () => {
    const api = recordingApi();
    await create(api, { type: 'checkbox', options: { icon: 'star', color: 'redBright' } });
    assert.deepEqual(api.seen.body.options, { icon: 'star', color: 'redBright' });
  });

  test('an empty options object falls back to the default, not to nothing', async () => {
    const api = recordingApi();
    await create(api, { type: 'checkbox', options: {} });
    assert.deepEqual(api.seen.body.options, { icon: 'check', color: 'greenBright' });
  });
});

describe('a select column is never guessed at', () => {
  // Its choices ARE its content. Inventing them would be guessing at someone's data,
  // and an empty list is both rejected and meaningless.
  for (const type of ['singleSelect', 'multipleSelects']) {
    test(`${type} without choices is refused, in words`, async () => {
      await assert.rejects(() => create(recordingApi(), { type, name: 'Stage' }), (e) => {
        assert.match(e.message, /tell me the choices/i);
        assert.doesNotMatch(e.message, /schema validation|POST|\/meta\/bases/i);
        return true;
      });
    });

    test(`${type} WITH choices goes through`, async () => {
      const api = recordingApi();
      await create(api, { type, name: 'Stage', options: { choices: [{ name: 'Lead' }] } });
      assert.deepEqual(api.seen.body.options.choices, [{ name: 'Lead' }]);
    });
  }
});

describe('what a person reads when it still cannot be done', () => {
  const rejecting = (msg) => async (method) => {
    if (method === 'GET') return { tables: [TABLE] };
    throw new Error(msg);
  };
  const SCHEMA_ERR = 'airtable POST /meta/bases/app0agE5SbNEnINMY/tables/tblIVdMFZz9UIb71z/fields failed: '
                   + 'Invalid options for Companies.Intro Email Sent: Failed schema validation: Intro Email Sent.options is missing';

  test('the raw API sentence never reaches the card', async () => {
    await assert.rejects(() => create(rejecting(SCHEMA_ERR), { type: 'checkbox' }), (e) => {
      for (const junk of [/POST/, /\/meta\/bases/, /app0agE5SbNEnINMY/, /tbl[A-Za-z0-9]{10}/, /schema validation/i]) {
        assert.doesNotMatch(e.message, junk, String(junk));
      }
      return true;
    });
  });

  test('and it names the column and the type, so it can be acted on', async () => {
    await assert.rejects(() => create(rejecting(SCHEMA_ERR), { type: 'checkbox' }), (e) => {
      assert.match(e.message, /Intro Email Sent/);
      assert.match(e.message, /checkbox/);
      return true;
    });
  });

  test('the original is kept as the cause, for the log', async () => {
    // Softening what the USER sees must not destroy what an engineer needs.
    await assert.rejects(() => create(rejecting(SCHEMA_ERR), { type: 'checkbox' }), (e) => {
      assert.match(String(e.cause?.message ?? ''), /Failed schema validation/);
      return true;
    });
  });

  test('an UNRELATED failure is passed through untouched', async () => {
    // Rewriting an auth error sends people to the wrong place entirely.
    await assert.rejects(
      () => create(rejecting('airtable POST failed: NOT_AUTHORIZED'), { type: 'checkbox' }),
      /NOT_AUTHORIZED/);
  });
});

describe('none of this disturbed the idempotency guard', () => {
  test('a column that already exists is still a no-op', async () => {
    const api = recordingApi();
    const r = await create(api, { name: 'Notes', type: 'checkbox' });
    assert.equal(r.created, false);
    assert.equal(api.seen.body, undefined, 'it must not attempt the write');
  });
});
