/**
 * Airtable webhook sync — the thing that makes a published "when a record changes"
 * trigger REAL.
 *
 * Before this module, `POST /connectors/airtable/webhooks` existed but was called
 * by nothing (not from `src/`, not from `public/`), and `refreshAirtableWebhook`
 * had exactly one reference in the repo: its own definition. So a user could build
 * a "when a record changes in Airtable" workflow, publish it, see it listed as
 * live — and it would never fire once, silently. That is the failure mode this
 * codebase treats as worst: it looks like success.
 *
 * Two jobs:
 *
 *   1. RECONCILE (`syncAirtableWebhooks`) — make the set of registered Airtable
 *      webhooks equal the set a tenant's live workflows actually need. Run it
 *      after publish, after edit, and after delete/deactivate. It is idempotent
 *      and authoritative in both directions: it creates what is missing and
 *      removes what nothing needs any more, so re-publishing cannot pile up
 *      duplicate webhooks and deleting a workflow does not leave one running.
 *
 *   2. RENEW (`refreshAirtableWebhooks`) — Airtable expires a webhook after 7 days
 *      unless it is refreshed. A webhook created once and never renewed dies
 *      quietly a week later, which is the same silent failure on a delay.
 *
 * Failure policy: this is best-effort and NEVER throws into a publish. A user
 * whose workflow saved but whose webhook could not be created must still get their
 * workflow — but the failure is returned to the caller and logged, never swallowed
 * into a shrug. The caller decides what to tell them.
 */

import {
  createAirtableWebhook, deleteAirtableWebhook, refreshAirtableWebhook,
  registerWebhookRoute, unregisterWebhookRoute, allWebhooks, makeAirtableApi,
} from './index.js';
import { getAirtableAccessToken } from './oauth.js';
import { oauthRedirectBase } from '../oauth-redirect.js';

/** The trigger id the catalog registers, and the bare event name the dispatcher matches. */
const RECORD_CHANGED = 'record_changed';
const RECORD_CHANGED_ID = 'airtable_record_changed';

/**
 * Does this trigger mean "when an Airtable record changes"?
 *
 * Accepts BOTH spellings on purpose. The capability id is `airtable_record_changed`
 * and the converger's generic trigger template emits that id as the event name,
 * while the dispatcher was written to match the bare `record_changed`. They never
 * agreed, so the trigger could not have matched a workflow even with a webhook in
 * place. Normalising here means neither spelling is silently dead.
 */
export function isAirtableRecordChangedTrigger(t) {
  if (!t || t.type !== 'event' || t.connector !== 'airtable') return false;
  return t.event === RECORD_CHANGED || t.event === RECORD_CHANGED_ID;
}

/** `{baseId, tableId}` for every Airtable record-changed trigger on a workflow. */
export function airtableWatchesOf(workflow) {
  const out = [];
  for (const t of (workflow?.triggers ?? [])) {
    if (!isAirtableRecordChangedTrigger(t)) continue;
    const src = t.filter ?? t.config ?? {};
    const baseId = src.baseId ?? src.base ?? null;
    if (!baseId) continue;                 // nothing to watch — see note in syncAirtableWebhooks
    out.push({ baseId: String(baseId), tableId: src.tableId ? String(src.tableId) : null });
  }
  return out;
}

/** Stable key for a watch. JSON.stringify, never concatenation — "ab"+"c" collides with "a"+"bc". */
export const watchKey = ({ baseId, tableId }) => JSON.stringify([baseId, tableId ?? null]);

/**
 * Make the registered webhooks for one tenant equal what its live workflows need.
 *
 * @param {object}   opts
 * @param {Function} opts.api             — an Airtable api helper bound to the tenant's token
 * @param {string}   opts.tenantId
 * @param {object[]} opts.workflows       — the tenant's ACTIVE flows
 * @param {string}   opts.notificationUrl — public URL Airtable should POST to
 * @param {boolean}  [opts.prune=true]    — delete webhooks nothing needs any more
 * @returns {Promise<{created:object[], removed:string[], kept:number, failed:object[], missingBase:number}>}
 */
export async function syncAirtableWebhooks({ api, tenantId, workflows, notificationUrl, prune = true }) {
  if (!tenantId) throw new Error('syncAirtableWebhooks: tenantId is required'); // fail closed, never guess a tenant

  // What SHOULD exist.
  const desired = new Map();  // key → { baseId, tableId }
  let missingBase = 0;
  for (const wf of (workflows ?? [])) {
    for (const t of (wf?.triggers ?? [])) {
      if (!isAirtableRecordChangedTrigger(t)) continue;
      const watches = airtableWatchesOf({ triggers: [t] });
      // A record-changed trigger with no base names nothing to watch. We cannot
      // guess one — watching "some base" is not a thing — so it is counted and
      // reported rather than quietly treated as satisfied.
      if (!watches.length) { missingBase++; continue; }
      for (const w of watches) desired.set(watchKey(w), w);
    }
  }

  // What DOES exist, for this tenant only.
  const existing = new Map(); // key → webhookId
  for (const [webhookId, entry] of allWebhooks()) {
    if (entry?.tenantId !== tenantId) continue;
    existing.set(watchKey({ baseId: entry.baseId, tableId: entry.tableId ?? null }), webhookId);
  }

  const created = [];
  const failed = [];
  for (const [key, watch] of desired) {
    if (existing.has(key)) continue;
    try {
      const { webhookId, macSecretBase64 } = await createAirtableWebhook(api, {
        baseId: watch.baseId, tableId: watch.tableId ?? undefined, notificationUrl,
      });
      registerWebhookRoute({ webhookId, tenantId, baseId: watch.baseId, tableId: watch.tableId ?? null, macSecretBase64 });
      created.push({ webhookId, ...watch });
    } catch (err) {
      failed.push({ ...watch, error: err?.message ?? String(err) });
    }
  }

  const removed = [];
  if (prune) {
    for (const [key, webhookId] of existing) {
      if (desired.has(key)) continue;
      try { await deleteAirtableWebhook(api, { baseId: JSON.parse(key)[0], webhookId }); }
      catch { /* already gone at Airtable's end — still drop our route */ }
      unregisterWebhookRoute(webhookId);
      removed.push(webhookId);
    }
  }

  return { created, removed, kept: desired.size - created.length, failed, missingBase };
}

/** Where Airtable should POST. One lever (`OAUTH_REDIRECT_BASE`) drives every callback URL. */
export const airtableNotificationUrl = () => `${oauthRedirectBase()}/connectors/airtable/events`;

/**
 * Can this spec's Airtable triggers actually be armed?
 *
 * Asked BEFORE anything is persisted, so a workflow that could never fire is never
 * created in the first place (operator's call, 2026-07-24: publishing must fail
 * rather than produce a workflow that says "live" and cannot run). The checks are
 * the cheap, deterministic ones — is a base named, is Airtable connected — not a
 * round trip, so a publish is not held hostage to Airtable's latency.
 *
 * The remaining failure (Airtable refuses the subscription) can only be found by
 * trying, and the publish path rolls back when it happens.
 *
 * @returns {Promise<{ok:true} | {ok:false, code:string, error:string}>}
 */
export async function checkAirtableTriggersArmable(spine, tenantId, spec) {
  const triggers = (spec?.triggers ?? []).filter(isAirtableRecordChangedTrigger);
  if (!triggers.length) return { ok: true };            // nothing to arm

  for (const t of triggers) {
    if (!airtableWatchesOf({ triggers: [t] }).length) {
      return {
        ok: false, code: 'TRIGGER_NO_BASE',
        error: 'This workflow is meant to run when an Airtable record changes, but it does not say which base to watch — so it could never start. Pick the base and try again.',
      };
    }
  }

  const token = await getAirtableAccessToken({
    oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId,
  }).catch(() => null);
  if (!token) {
    return {
      ok: false, code: 'TRIGGER_NOT_CONNECTED',
      error: 'This workflow starts when an Airtable record changes, but Airtable is not connected — Atlas cannot watch for those changes yet. Connect Airtable, then publish.',
    };
  }
  return { ok: true };
}

/**
 * Reconcile one tenant's Airtable webhooks against its live workflows.
 *
 * The single entry point for publish / edit / delete / reconnect. Never throws —
 * a publish must not fail because Airtable was briefly unreachable — but always
 * REPORTS, so the caller can tell the user their trigger isn't armed yet instead
 * of showing them a live workflow that cannot fire.
 */
export async function syncAirtableWebhooksForTenant(spine, tenantId) {
  if (!tenantId) throw new Error('syncAirtableWebhooksForTenant: tenantId is required');
  try {
    const token = await getAirtableAccessToken({
      oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId,
    });
    if (!token) return { ok: false, reason: 'not_connected', created: [], removed: [], failed: [] };

    const workflows = spine.engine.workflowStore.list({ tenantId, kind: 'flow', status: 'active' });
    const result = await syncAirtableWebhooks({
      api: makeAirtableApi(token), tenantId, workflows, notificationUrl: airtableNotificationUrl(),
    });
    return { ok: result.failed.length === 0, ...result };
  } catch (err) {
    return { ok: false, reason: 'error', error: err?.message ?? String(err), created: [], removed: [], failed: [] };
  }
}

/** Renew every tenant's webhooks. Bound to the spine so a caller needs no Airtable knowledge. */
export async function refreshAllAirtableWebhooks(spine) {
  return refreshAirtableWebhooks({
    apiFor: async (tenantId) => {
      const token = await getAirtableAccessToken({
        oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId,
      });
      return token ? makeAirtableApi(token) : null;
    },
  });
}

/**
 * Renew every registered webhook so Airtable's 7-day expiry never silently ends a
 * live trigger. `apiFor(tenantId)` returns an api helper (or null if that tenant's
 * connection is gone — those routes are dropped, since they can never fire again).
 *
 * @returns {Promise<{refreshed:number, failed:number, dropped:number}>}
 */
export async function refreshAirtableWebhooks({ apiFor }) {
  let refreshed = 0, failed = 0, dropped = 0;
  const apis = new Map();

  for (const [webhookId, entry] of [...allWebhooks()]) {
    const tenantId = entry?.tenantId;
    if (!tenantId || !entry?.baseId) { unregisterWebhookRoute(webhookId); dropped++; continue; }

    if (!apis.has(tenantId)) apis.set(tenantId, await apiFor(tenantId).catch(() => null));
    const api = apis.get(tenantId);
    if (!api) { dropped++; continue; }   // connection gone; leave the route for a reconnect to reconcile

    try { await refreshAirtableWebhook(api, { baseId: entry.baseId, webhookId }); refreshed++; }
    catch { failed++; }
  }
  return { refreshed, failed, dropped };
}
