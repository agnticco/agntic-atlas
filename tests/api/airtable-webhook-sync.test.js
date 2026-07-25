/**
 * Airtable "when a record changes" — the trigger that published, looked live, and
 * could never fire (2026-07-24).
 *
 * Three independent silent failures stacked on one feature:
 *   1. Nothing ever created the webhook. `POST /connectors/airtable/webhooks`
 *      existed but was called from nowhere in `src/` or `public/`.
 *   2. Nothing ever renewed it. `refreshAirtableWebhook` had exactly one reference
 *      in the repo — its own definition — so even a hand-made webhook died after
 *      Airtable's 7-day expiry.
 *   3. The event names never agreed. The converger's trigger template emits the
 *      capability id (`airtable_record_changed`); the dispatcher matched only the
 *      bare `record_changed`. So a correct trigger matched no workflow even with a
 *      webhook in place.
 *
 * These assert the RECONCILE — that the set of live webhooks equals the set the
 * tenant's live workflows need, in both directions, and that nothing is created
 * twice or pruned across a tenant boundary.
 *
 *   node --test tests/api/airtable-webhook-sync.test.js
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncAirtableWebhooks, refreshAirtableWebhooks, checkAirtableTriggersArmable,
  isAirtableRecordChangedTrigger, airtableWatchesOf,
} from '../../src/connectors/airtable/webhook-sync.js';
import { allWebhooks, unregisterWebhookRoute, registerWebhookRoute } from '../../src/connectors/airtable/index.js';

const NOTIFY = 'https://atlas.example/connectors/airtable/events';

// A fake Airtable that records every call, so we assert what was SENT, not that
// "a sync happened".
function fakeAirtable({ failCreate = false } = {}) {
  const calls = [];
  let n = 0;
  const api = async (method, path, opts) => {
    calls.push({ method, path, body: opts?.body });
    if (method === 'POST' && /\/webhooks$/.test(path)) {
      if (failCreate) throw new Error('Airtable said no');
      return { id: `ach${++n}`, macSecretBase64: Buffer.from(`secret${n}`).toString('base64') };
    }
    return {};
  };
  return { api, calls };
}

const trigger = (baseId, tableId, event = 'record_changed') => ({
  type: 'event', connector: 'airtable', event,
  ...(baseId ? { filter: { baseId, ...(tableId ? { tableId } : {}) } } : {}),
});
const wf = (slug, ...triggers) => ({ slug, triggers });

const routesFor = (tenantId) =>
  [...allWebhooks()].filter(([, e]) => e.tenantId === tenantId).map(([id, e]) => ({ id, ...e }));

beforeEach(() => { for (const [id] of [...allWebhooks()]) unregisterWebhookRoute(id); });

// ── Creating the watch ───────────────────────────────────────────────────────

test('publishing a workflow with an Airtable trigger actually creates the webhook', async () => {
  const { api, calls } = fakeAirtable();
  const r = await syncAirtableWebhooks({
    api, tenantId: 't1', workflows: [wf('orders', trigger('appA', 'tblX'))], notificationUrl: NOTIFY,
  });

  assert.equal(r.created.length, 1, 'a live trigger must produce a real subscription');
  assert.equal(r.failed.length, 0);

  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.path, '/bases/appA/webhooks', 'subscribed to the base the trigger names');
  assert.equal(post.body.notificationUrl, NOTIFY, 'Airtable must be told where to send events');
  assert.equal(post.body.specification.options.filters.recordChangeScope, 'tblX', 'scoped to the named table');

  const routes = routesFor('t1');
  assert.equal(routes.length, 1);
  assert.equal(routes[0].baseId, 'appA');
  assert.equal(routes[0].tableId, 'tblX');
  assert.ok(routes[0].macSecretBase64, 'the signing secret must be kept — events are rejected without it');
});

test('a base-wide trigger (no table) subscribes to the whole base', async () => {
  const { api, calls } = fakeAirtable();
  await syncAirtableWebhooks({ api, tenantId: 't1', workflows: [wf('all', trigger('appA'))], notificationUrl: NOTIFY });
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.specification.options.filters.recordChangeScope, undefined);
  assert.equal(routesFor('t1')[0].tableId, null);
});

test('both spellings of the event name are accepted', () => {
  assert.ok(isAirtableRecordChangedTrigger(trigger('appA', null, 'record_changed')));
  assert.ok(isAirtableRecordChangedTrigger(trigger('appA', null, 'airtable_record_changed')),
    'the converger emits the capability id — it must not be silently dead');
  assert.equal(isAirtableRecordChangedTrigger({ type: 'event', connector: 'slack', event: 'message' }), false);
  assert.equal(isAirtableRecordChangedTrigger({ type: 'schedule', cron: '0 9 * * *' }), false);
});

test('a workflow written with the capability-id spelling still gets a webhook', async () => {
  const { api } = fakeAirtable();
  const r = await syncAirtableWebhooks({
    api, tenantId: 't1',
    workflows: [wf('orders', trigger('appA', null, 'airtable_record_changed'))], notificationUrl: NOTIFY,
  });
  assert.equal(r.created.length, 1);
});

// ── Not creating it twice ────────────────────────────────────────────────────

test('re-publishing does not stack up duplicate webhooks', async () => {
  const { api } = fakeAirtable();
  const workflows = [wf('orders', trigger('appA', 'tblX'))];
  const first = await syncAirtableWebhooks({ api, tenantId: 't1', workflows, notificationUrl: NOTIFY });
  const again = await syncAirtableWebhooks({ api, tenantId: 't1', workflows, notificationUrl: NOTIFY });

  assert.equal(first.created.length, 1);
  assert.equal(again.created.length, 0, 'the second publish must reuse the existing subscription');
  assert.equal(again.kept, 1);
  assert.equal(routesFor('t1').length, 1);
});

test('base-only and base+table are different watches, not duplicates of each other', async () => {
  const { api } = fakeAirtable();
  const r = await syncAirtableWebhooks({
    api, tenantId: 't1',
    workflows: [wf('a', trigger('appA')), wf('b', trigger('appA', 'tblX'))], notificationUrl: NOTIFY,
  });
  assert.equal(r.created.length, 2, 'watching one table is not the same subscription as watching the base');
});

// ── Tearing it down ──────────────────────────────────────────────────────────

test('deleting the last workflow that needed a watch removes it', async () => {
  const { api, calls } = fakeAirtable();
  await syncAirtableWebhooks({ api, tenantId: 't1', workflows: [wf('orders', trigger('appA'))], notificationUrl: NOTIFY });
  const r = await syncAirtableWebhooks({ api, tenantId: 't1', workflows: [], notificationUrl: NOTIFY });

  assert.equal(r.removed.length, 1, 'a watch nothing needs must not keep firing');
  assert.equal(routesFor('t1').length, 0);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === '/bases/appA/webhooks/ach1'),
    'Airtable must be told to stop, not just our routing table');
});

test('a watch still needed by ANOTHER live workflow is not removed', async () => {
  const { api } = fakeAirtable();
  await syncAirtableWebhooks({
    api, tenantId: 't1', workflows: [wf('a', trigger('appA')), wf('b', trigger('appA'))], notificationUrl: NOTIFY,
  });
  const r = await syncAirtableWebhooks({ api, tenantId: 't1', workflows: [wf('b', trigger('appA'))], notificationUrl: NOTIFY });
  assert.equal(r.removed.length, 0, 'deleting one of two workflows on the same base must not disarm the other');
  assert.equal(routesFor('t1').length, 1);
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

test('one tenant\'s reconcile never touches another tenant\'s webhooks', async () => {
  const { api } = fakeAirtable();
  await syncAirtableWebhooks({ api, tenantId: 't1', workflows: [wf('a', trigger('appA'))], notificationUrl: NOTIFY });
  await syncAirtableWebhooks({ api, tenantId: 't2', workflows: [wf('b', trigger('appB'))], notificationUrl: NOTIFY });

  // t1 deletes everything it has.
  const r = await syncAirtableWebhooks({ api, tenantId: 't1', workflows: [], notificationUrl: NOTIFY });

  assert.equal(r.removed.length, 1);
  assert.equal(routesFor('t1').length, 0);
  assert.equal(routesFor('t2').length, 1, 'a neighbouring tenant must be untouched');
});

test('reconcile refuses to run without a tenant rather than guessing one', async () => {
  const { api } = fakeAirtable();
  await assert.rejects(
    () => syncAirtableWebhooks({ api, tenantId: null, workflows: [], notificationUrl: NOTIFY }),
    /tenantId is required/,
  );
});

// ── Refusing to pretend ──────────────────────────────────────────────────────

test('a trigger with no base is reported, not silently treated as armed', async () => {
  const { api, calls } = fakeAirtable();
  const r = await syncAirtableWebhooks({
    api, tenantId: 't1', workflows: [wf('vague', trigger(null))], notificationUrl: NOTIFY,
  });
  assert.equal(r.created.length, 0);
  assert.equal(r.missingBase, 1, 'we cannot guess which base to watch — say so');
  assert.equal(calls.length, 0);
  assert.deepEqual(airtableWatchesOf(wf('vague', trigger(null))), []);
});

test('a failure to create is reported, never swallowed', async () => {
  const { api } = fakeAirtable({ failCreate: true });
  const r = await syncAirtableWebhooks({
    api, tenantId: 't1', workflows: [wf('orders', trigger('appA'))], notificationUrl: NOTIFY,
  });
  assert.equal(r.created.length, 0);
  assert.equal(r.failed.length, 1, 'the user must be tellable that their trigger is not armed');
  assert.match(r.failed[0].error, /Airtable said no/);
  assert.equal(routesFor('t1').length, 0, 'no route may be registered for a webhook that does not exist');
});

// ── Renewal ──────────────────────────────────────────────────────────────────

test('every live webhook is renewed, so none dies at the 7-day expiry', async () => {
  const { api, calls } = fakeAirtable();
  await syncAirtableWebhooks({ api, tenantId: 't1', workflows: [wf('a', trigger('appA'))], notificationUrl: NOTIFY });
  await syncAirtableWebhooks({ api, tenantId: 't2', workflows: [wf('b', trigger('appB'))], notificationUrl: NOTIFY });
  calls.length = 0;

  const r = await refreshAirtableWebhooks({ apiFor: async () => api });

  assert.equal(r.refreshed, 2);
  assert.equal(r.failed, 0);
  const refreshes = calls.filter((c) => /\/refresh$/.test(c.path)).map((c) => c.path);
  assert.deepEqual(refreshes.sort(), ['/bases/appA/webhooks/ach1/refresh', '/bases/appB/webhooks/ach2/refresh']);
});

test('a tenant whose Airtable connection is gone is skipped, not crashed on', async () => {
  const { api } = fakeAirtable();
  await syncAirtableWebhooks({ api, tenantId: 't1', workflows: [wf('a', trigger('appA'))], notificationUrl: NOTIFY });
  const r = await refreshAirtableWebhooks({ apiFor: async () => null });
  assert.equal(r.refreshed, 0);
  assert.equal(r.dropped, 1);
});

test('a route with no tenant is dropped — it could never be routed anyway', async () => {
  registerWebhookRoute({ webhookId: 'orphan', tenantId: null, baseId: 'appA' });
  const r = await refreshAirtableWebhooks({ apiFor: async () => fakeAirtable().api });
  assert.equal(r.dropped, 1);
  assert.equal([...allWebhooks()].length, 0);
});

// ── Refusing to publish what cannot fire (operator, 2026-07-24) ──────────────
//
// The rule: if the watch cannot be set up, the workflow must not publish at all.
// A saved workflow that shows as live and cannot run is the lie the product exists
// to prevent, and a warning next to a green tick is not good enough.

const spineWith = (token) => ({
  auth: {
    oauthTokenStore: { get: () => (token ? { access_token_enc: 'enc', expiry: null } : null) },
    tokenCipher: { decrypt: () => token },
  },
});

test('a workflow with no Airtable trigger publishes freely', async () => {
  const r = await checkAirtableTriggersArmable(spineWith(null), 't1', { triggers: [{ type: 'email' }] });
  assert.equal(r.ok, true, 'the rule must only bite workflows that actually watch Airtable');
});

test('an Airtable trigger that names no base is REFUSED before anything is saved', async () => {
  const r = await checkAirtableTriggersArmable(spineWith('tok'), 't1', { triggers: [trigger(null)] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRIGGER_NO_BASE');
  assert.match(r.error, /which base/i, 'the message must tell the user what to fix');
  assert.ok(!/webhook|baseId|null/.test(r.error), 'and must not read like a stack trace');
});

test('an Airtable trigger is REFUSED when Airtable is not connected', async () => {
  const r = await checkAirtableTriggersArmable(spineWith(null), 't1', { triggers: [trigger('appA')] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRIGGER_NOT_CONNECTED');
  assert.match(r.error, /connect/i);
});

test('a fully specified Airtable trigger on a connected tenant is allowed', async () => {
  const r = await checkAirtableTriggersArmable(spineWith('tok'), 't1', { triggers: [trigger('appA', 'tblX')] });
  assert.equal(r.ok, true);
});

test('one bad trigger among several still blocks the publish', async () => {
  const r = await checkAirtableTriggersArmable(spineWith('tok'), 't1', {
    triggers: [trigger('appA'), trigger(null)],
  });
  assert.equal(r.ok, false, 'a workflow is not publishable because SOME of it works');
  assert.equal(r.code, 'TRIGGER_NO_BASE');
});
