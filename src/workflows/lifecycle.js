/**
 * Pausing, resuming and deleting a workflow — the rules, in one place.
 *
 * These operations look trivial (`UPDATE workflows SET status = ?`) and are not. Both
 * carry a guard that was written after the behaviour it prevents had already shipped, and
 * both have a side effect outside the database that decides whether the workflow actually
 * stops or starts.
 *
 * ── WHY THIS IS A MODULE AND NOT A ROUTE ─────────────────────────────────────
 *
 * The console had the correct version and `workflow-service.js` had a second one that is
 * missing both guards: its `resume()` sets status to active from ANY state, and its
 * `delete()` is a hard delete. Two implementations of one operation, disagreeing about
 * safety, is how the console gets fixed and every other caller keeps the bug. Adding a
 * third for MCP would have made it three.
 *
 * ── ONLY A PAUSED WORKFLOW MAY RESUME ────────────────────────────────────────
 *
 * `active ? paused : active` promotes any non-active status to live, INCLUDING `draft`.
 * A workflow that had never been tested, never had its promise checked and never had a
 * trigger armed could be made live and scheduled with nothing shown to say so. Observed
 * during QA: a real draft went draft → active → paused and was live for 42 seconds.
 *
 * A draft becomes live exactly one way — by being published, which is the path that
 * verifies it. `draft` and `error` are the states that have not earned live, so this
 * fails closed and says which one it is.
 *
 * ── STATUS IS HALF THE CHANGE; THE TRIGGER IS THE OTHER HALF ─────────────────
 *
 * Resuming an Airtable-triggered workflow without arming its webhook marks it live while
 * no subscription exists — "shows as live, can never fire", a shape this codebase has
 * shipped once already. Pausing without reconciling leaves it subscribed, so a paused
 * workflow keeps receiving events.
 *
 * The sync is authoritative in both directions, so it is the same call either way. It is
 * AWAITED for status changes, because a resume that could not arm its trigger is
 * something the caller has to be told about — and only reported when it genuinely failed
 * (`not_connected` is the ordinary state of a tenant with no Airtable; reporting it as a
 * warning trains people to ignore the field that matters when arming really does fail).
 */

import { logEvent, errFields } from '../utils/event-log.js';
import { syncAirtableWebhooksForTenant } from '../connectors/airtable/webhook-sync.js';

/** Statuses a human may move a workflow between outside the builder. */
const TOGGLEABLE = new Set(['active', 'paused']);

/**
 * Reconcile trigger subscriptions for a tenant.
 *
 * @returns {Promise<string|null>} a warning worth showing the caller, or null
 */
async function reconcileTriggers(spine, tenantId) {
  try {
    const armed = await syncAirtableWebhooksForTenant(spine, tenantId);
    if (armed && armed.ok === false && armed.reason !== 'not_connected') {
      return armed.error ?? 'This workflow\'s trigger could not be armed — it may not fire.';
    }
    return null;
  } catch (err) {
    return err?.message ?? String(err);
  }
}

/**
 * Look a workflow up and confirm it belongs to this tenant.
 *
 * The two-step — fetch scoped to the user, then compare tenant_id — is the same one every
 * other handler uses. A single-step lookup is where a new surface re-implements tenant
 * scoping and gets it wrong.
 */
function ownedWorkflow(spine, { workflowId, userId, tenantId }) {
  const wf = spine.engine.workflowStore.get(workflowId, { userId });
  return wf && wf.tenant_id === tenantId ? wf : null;
}

/**
 * Move a workflow between active and paused.
 *
 * @param {'active'|'paused'} to
 * @returns {Promise<{ok: boolean, status?: string, previousStatus?: string,
 *                    unchanged?: boolean, triggerWarning?: string|null,
 *                    code?: string, error?: string}>}
 */
export async function setWorkflowStatus(spine, { workflowId, userId, tenantId, to }) {
  if (!TOGGLEABLE.has(to)) {
    return { ok: false, code: 'BAD_STATUS', error: 'status must be active or paused' };
  }
  const wf = ownedWorkflow(spine, { workflowId, userId, tenantId });
  if (!wf) return { ok: false, code: 'NOT_FOUND', error: 'Workflow not found' };

  if (!TOGGLEABLE.has(wf.status)) {
    // FAIL CLOSED. See the header: draft and error have not earned live.
    logEvent('workflow.status.refused', { workflowId, status: wf.status, tenant: tenantId });
    return {
      ok: false,
      code: 'NOT_RESUMABLE',
      status: wf.status,
      error: wf.status === 'draft'
        ? 'This workflow has never been published. Open it in the builder, test it, and use Go live.'
        : `A workflow in "${wf.status}" cannot be resumed here. Re-publish it from the builder.`,
    };
  }

  if (wf.status === to) {
    return { ok: true, status: to, previousStatus: to, unchanged: true, triggerWarning: null };
  }

  spine.engine.workflowStore.update(workflowId, { status: to }, { userId });
  const triggerWarning = await reconcileTriggers(spine, tenantId);
  if (triggerWarning) {
    logEvent('workflow.status.trigger_warning', {
      workflowId, newStatus: to, tenant: tenantId, detail: triggerWarning,
    });
  }
  logEvent('workflow.status', { workflowId, newStatus: to, tenant: tenantId });
  return { ok: true, status: to, previousStatus: wf.status, unchanged: false, triggerWarning };
}

/**
 * Soft-delete a workflow: recoverable for 30 days, then purged.
 *
 * Soft, never hard, because this is reachable from surfaces where a mistake cannot be
 * undone by the person who made it — and because `restore` already exists, so the
 * recoverable path costs nothing and the destructive one throws away a workflow somebody
 * built. Triggers are torn down: a deleted workflow that keeps receiving events is worse
 * than one that merely still exists.
 */
export async function deleteWorkflow(spine, { workflowId, userId, tenantId }) {
  const wf = ownedWorkflow(spine, { workflowId, userId, tenantId });
  if (!wf) return { ok: false, code: 'NOT_FOUND', error: 'Workflow not found' };

  const removed = spine.engine.workflowStore.softDelete(workflowId, { userId, tenantId });
  if (!removed) return { ok: false, code: 'DELETE_FAILED', error: 'Delete did not persist.' };

  const triggerWarning = await reconcileTriggers(spine, tenantId);
  logEvent('workflow.deleted', { workflowId, tenant: tenantId, name: wf.name ?? null });
  return {
    ok: true,
    deleted: { id: wf.id, name: wf.name ?? null, slug: wf.slug ?? null },
    recoverableForDays: 30,
    triggerWarning,
  };
}

export default { setWorkflowStatus, deleteWorkflow };
