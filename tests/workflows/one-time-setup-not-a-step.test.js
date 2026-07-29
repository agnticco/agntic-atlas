/**
 * SETTING A RESOURCE UP IS NOT WORK THE WORKFLOW REPEATS.
 *
 * WITNESSED ON PROD, 2026-07-29. Asked to write four fields into an Airtable table
 * that had four different ones, Atlas did the right thing conversationally — read
 * the real columns, proposed a mapping, offered to add the two that were missing —
 * and then put those two `airtable_create_field` calls INSIDE an email-triggered
 * workflow. Every incoming email would try to re-add the same two columns.
 *
 * WHY THAT IS NOT MERELY WASTEFUL. Airtable refuses a duplicate field name, the
 * connector's api helper throws on any non-2xx, so the step fails — and by the
 * workflow's own failure rule the run stops there, before the record is written and
 * before the Slack post. The workflow works EXACTLY ONCE.
 *
 * AND ITS OWN SAFETY NET COULD NOT SEE IT: the test panel's dry run stubs writes, so
 * the one step that would fail never ran. It passed, and would have gone live.
 *
 * Two fixes, and both are needed:
 *   · the capability is now IDEMPOTENT — "add this column" on a column that exists
 *     is a no-op, which has to be true wherever it is called from (a re-publish, an
 *     edit, a retry all call it again);
 *   · the placement is REFUSED at build time, from a DECLARED trait rather than a
 *     guess at the capability's name.
 *
 * `airtable_create_field` and `airtable_create_record` are indistinguishable to any
 * name test — one is setup, one is genuinely per-run work — which is why this is
 * declared. That is the third time a name-matching rule has been the defect here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { WorkflowValidator } from '../../src/workflows/workflow-validator.js';
import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { setCapabilityCatalog, declaresOneTimeSetup, declaresWrite } from '../../src/workflows/outcome-oracle.js';
import { airtableCreateField } from '../../src/connectors/airtable/index.js';

/** The two capabilities this is about, as the registry stores them. */
const CATALOG = new Map([
  ['airtable_create_field',  { id: 'airtable_create_field',  connector: 'airtable', positions: ['step'], effect: 'write', oneTimeSetup: true }],
  ['slack_create_channel',   { id: 'slack_create_channel',   connector: 'slack',    positions: ['step'], effect: 'write', oneTimeSetup: true }],
  ['airtable_create_record', { id: 'airtable_create_record', connector: 'airtable', positions: ['step', 'delivery'], effect: 'write' }],
]);

describe('the trait is declared, never inferred', () => {
  test('setup capabilities declare it', () => {
    setCapabilityCatalog(CATALOG);
    assert.equal(declaresOneTimeSetup('airtable_create_field'), true);
    assert.equal(declaresOneTimeSetup('slack_create_channel'), true);
  });

  test('per-run work that LOOKS identical by name does not', () => {
    // `airtable_create_record` also matches /create/. If this ever returns true the
    // workflow that writes a row every time would be refused, which is the opposite
    // of the point.
    setCapabilityCatalog(CATALOG);
    assert.equal(declaresOneTimeSetup('airtable_create_record'), false);
    assert.equal(declaresWrite('airtable_create_record'), true, 'it is still a write');
  });

  test('the DECLARATION decides, not the name — both directions', () => {
    // The three tests above pass just as well against a regex over capability ids,
    // because every fixture's name happens to agree with its declaration. These are
    // the two cases where they disagree, and they are the whole point of declaring
    // it: a name test would get both wrong.
    setCapabilityCatalog(new Map([
      // Named nothing like setup, but it IS setup.
      ['notion_provision_database', { id: 'notion_provision_database', positions: ['step'], oneTimeSetup: true }],
      // Named exactly like setup, but it is NOT — a hypothetical per-run variant.
      ['airtable_create_field',     { id: 'airtable_create_field',     positions: ['step'] }],
    ]));
    assert.equal(declaresOneTimeSetup('notion_provision_database'), true,
      'a capability that declares the trait must be caught whatever it is called');
    assert.equal(declaresOneTimeSetup('airtable_create_field'), false,
      'and one that does not declare it must NOT be, however it is named');
  });

  test('the real registry carries the trait through', () => {
    // Everything else here hands the oracle a hand-built Map. If `register()` drops
    // the field on the way in, every one of those tests still passes and the live
    // product has no trait at all.
    const reg = new CapabilityRegistry();
    reg.register({ id: 'x_setup', positions: ['step'], oneTimeSetup: true, handle: () => ({}) });
    reg.register({ id: 'x_work',  positions: ['step'], handle: () => ({}) });
    assert.equal(reg.get('x_setup').oneTimeSetup, true);
    assert.equal(reg.get('x_work').oneTimeSetup, false, 'absent means no, not undefined');
  });

  test('the two shipped capabilities really declare it', () => {
    // A trait nothing declares is a trait that does nothing. This reads the actual
    // connector source rather than a fixture.
    for (const [file, id] of [['src/connectors/airtable/index.js', 'airtable_create_field'],
                              ['src/connectors/slack/index.js',    'slack_create_channel']]) {
      const src = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
      const at = src.indexOf(`id: '${id}'`);
      assert.ok(at > 0, `${id} is gone from ${file}`);
      assert.match(src.slice(at, at + 600), /oneTimeSetup: true/,
        `${id} must declare the trait or the gate never fires for it`);
    }
  });

  test('an unknown capability does not block a build', () => {
    // This gate REFUSES a workflow, so silence must never be able to stop one. Only
    // an explicit declaration can.
    setCapabilityCatalog(CATALOG);
    assert.equal(declaresOneTimeSetup('something_nobody_registered'), false);
    assert.equal(declaresOneTimeSetup(''), false);
    assert.equal(declaresOneTimeSetup(null), false);
  });
});

describe('the placement is refused at build time', () => {
  const specWith = (action) => ({
    name: 'Log the email',
    triggers: [{ type: 'email', filter: 'is:unread' }],
    nodes: [
      { id: 'setup', type: 'connector-action', label: 'Add the Subject column',
        config: { action, baseId: 'appX', tableId: 'Table 1', name: 'Subject' } },
      { id: 'write', type: 'connector-action', label: 'Add the row',
        config: { action: 'airtable_create_record', baseId: 'appX', tableId: 'Table 1', fields: { Name: '{{prev}}' } } },
    ],
    edges: [{ from: 'setup', to: 'write' }],
  });

  const codesFor = (action) => {
    setCapabilityCatalog(CATALOG);
    const v = new WorkflowValidator({});
    return (v.validate(specWith(action))?.issues ?? []).map(i => i.code);
  };

  test('a setup capability inside the workflow is an error', () => {
    assert.ok(codesFor('airtable_create_field').includes('SETUP_ACTION_AS_STEP'),
      'this is the shape that worked exactly once and then failed forever');
  });

  test('the same workflow without it is not flagged', () => {
    // The refusal must be about the SETUP step, not about connector actions.
    assert.ok(!codesFor('airtable_create_record').includes('SETUP_ACTION_AS_STEP'),
      'writing a row every run is exactly what this workflow is for');
  });

  test('it says where the step belongs, not just that it is wrong', () => {
    setCapabilityCatalog(CATALOG);
    const v = new WorkflowValidator({});
    const issue = (v.validate(specWith('airtable_create_field'))?.issues ?? [])
      .find(i => i.code === 'SETUP_ACTION_AS_STEP');
    assert.ok(issue, 'expected the issue');
    assert.match(issue.message, /every single fire|once/i);
    assert.match(issue.hint, /once while the workflow is being built/i,
      'a refusal a person cannot act on is just a wall');
    assert.doesNotMatch(issue.message + issue.hint, /oneTimeSetup|capability|connector-action/,
      'the person reading this is not an engineer');
  });
});

describe('adding a column that already exists is a no-op', () => {
  // The idempotency half. It has to hold wherever the capability is called from — a
  // re-publish, an edit, a retry — not only in the workflow.
  const TABLE = { id: 'tbl1', name: 'Table 1', fields: [{ id: 'fld1', name: 'Notes', type: 'singleLineText' }] };

  /** An api stub that records what it was asked to do. */
  function stubApi({ failCreate = false } = {}) {
    const calls = [];
    const api = async (method, path, opts) => {
      calls.push({ method, path, opts });
      if (method === 'GET' && path.includes('/tables')) return { tables: [TABLE] };
      if (method === 'POST') {
        if (failCreate) throw new Error('airtable POST failed: Duplicate or empty field name');
        return { id: 'fldNEW', name: opts.body.name, type: opts.body.type };
      }
      return {};
    };
    api.calls = calls;
    return api;
  }

  test('an existing column is returned, and nothing is written', async () => {
    const api = stubApi();
    const r = await airtableCreateField(api, { baseId: 'appX', tableId: 'Table 1', name: 'Notes' });
    assert.equal(r.created, false);
    assert.equal(r.id, 'fld1');
    assert.equal(api.calls.filter(c => c.method === 'POST').length, 0,
      'it must not attempt the write that would fail');
  });

  test('matching is case-insensitive, as Airtable is', async () => {
    const r = await airtableCreateField(stubApi(), { baseId: 'appX', tableId: 'Table 1', name: '  notes ' });
    assert.equal(r.created, false);
  });

  test('the table can be named or given by id', async () => {
    assert.equal((await airtableCreateField(stubApi(), { baseId: 'appX', tableId: 'tbl1', name: 'Notes' })).created, false);
  });

  test('a genuinely new column is still created', async () => {
    const api = stubApi();
    const r = await airtableCreateField(api, { baseId: 'appX', tableId: 'Table 1', name: 'Subject' });
    assert.equal(r.created, true);
    assert.equal(r.name, 'Subject');
    assert.equal(api.calls.filter(c => c.method === 'POST').length, 1);
  });

  test('a duplicate error from a race is absorbed too', async () => {
    // Check-then-act is never atomic. If the column appears between the two, the
    // POST fails with a duplicate error and that must still not break the run.
    const api = stubApi({ failCreate: true });
    let seen = 0;
    const racy = async (method, path, opts) => {
      if (method === 'GET') { seen += 1; return { tables: [seen === 1 ? { ...TABLE, fields: [] } : TABLE] }; }
      return api(method, path, opts);
    };
    const r = await airtableCreateField(racy, { baseId: 'appX', tableId: 'Table 1', name: 'Notes' });
    assert.equal(r.created, false, 'the column exists — that is what the caller wanted');
  });

  test('an unrelated failure is NOT swallowed', async () => {
    // Absorbing every error would turn a broken token into a silent success.
    const api = async (method) => {
      if (method === 'GET') return { tables: [{ ...TABLE, fields: [] }] };
      throw new Error('airtable POST failed: NOT_AUTHORIZED');
    };
    await assert.rejects(
      () => airtableCreateField(api, { baseId: 'appX', tableId: 'Table 1', name: 'Subject' }),
      /NOT_AUTHORIZED/);
  });

  test('…even when the column DOES turn up on the second look', async () => {
    // The sharp version, and the one the test above cannot see: the recovery path
    // only runs when the error says "duplicate". If it ran for ANY error, this
    // sequence — permission denied, then a schema that happens to contain the
    // column — would be reported as a success, and a workflow with no write
    // permission would look like it had set itself up correctly.
    let look = 0;
    const api = async (method) => {
      if (method === 'GET') { look += 1; return { tables: [look === 1 ? { ...TABLE, fields: [] } : TABLE] }; }
      throw new Error('airtable POST failed: NOT_AUTHORIZED');
    };
    await assert.rejects(
      () => airtableCreateField(api, { baseId: 'appX', tableId: 'Table 1', name: 'Notes' }),
      /NOT_AUTHORIZED/, 'only a duplicate error means "someone else already did it"');
  });

  test('an unreadable schema falls through to the write rather than guessing', async () => {
    const api = async (method, path, opts) => {
      if (method === 'GET') throw new Error('schema read failed');
      return { id: 'fldNEW', name: opts.body.name, type: opts.body.type };
    };
    assert.equal((await airtableCreateField(api, { baseId: 'appX', tableId: 'T', name: 'Subject' })).created, true);
  });
});
