/**
 * HAS SLACK EVER ACTUALLY DELIVERED AN EVENT TO THIS DEPLOYMENT?
 *
 * WITNESSED ON PROD 2026-07-30 and re-confirmed 2026-08-01. A Slack-triggered workflow was
 * built, tested ("Contract kept"), published, and shown as live. The Atlas bot was in the
 * channel. A human posted a message containing the keyword. **Nothing happened** — no run,
 * no delivery, no log line.
 *
 * Measured across the ENTIRE event-log history, the only Slack paths ever hit are
 * `/connectors/slack/status` (57), `/callback` (1) and `/authorize` (1), plus two requests
 * to `/events` 224ms apart on 2026-07-30 that were a deliberate probe of the verification
 * handshake. **Slack has never delivered a real event to this deployment.** The endpoint
 * itself is fine — probed from the public internet it answers `url_verification`
 * correctly — so the gap is in the Slack app's own configuration (Event Subscriptions not
 * enabled, or not pointed here, or `message.channels` not subscribed), which is a console
 * setting Atlas cannot read through any API.
 *
 * **THE PRODUCT DEFECT IS THAT IT PUBLISHED ANYWAY.** The fail-closed rule of 2026-07-24 —
 * *"a workflow that saves, shows as live, and can never fire is the lie the product exists
 * to prevent"* — checks that AIRTABLE triggers can be armed and has no equivalent for
 * Slack. This module is that equivalent.
 *
 * ── WHY IT ASKS ABOUT THE DEPLOYMENT AND NOT THE TENANT ──────────────────────
 *
 * The obvious rule — "refuse unless we have seen an event for THIS tenant" — traps every
 * correctly-configured workspace at its first Slack workflow, because no event can have
 * arrived before the first one is published. That is a false refusal with no way past it,
 * and this file's neighbours record repeatedly that trapping a user is worse than the
 * defect being fixed.
 *
 * So the question is scoped to the only thing that is unambiguous:
 *
 *   · this deployment has NEVER received a Slack event, from anyone, ever
 *     ⇒ Event Subscriptions is not delivering here. REFUSE, and say what to change.
 *   · it has received events, but none yet for this tenant
 *     ⇒ the plumbing works; this workspace may simply not have posted yet, or the bot may
 *       not be in the channel. ALLOW — "not yet" and "never" are different answers.
 *
 * The first case is the one that is TRUE today and the one that shipped a lie. The second is
 * indistinguishable from ordinary quiet and must not block a publish.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Where the record lives. A sibling of the Airtable webhook routing table. */
export const DEFAULT_RECORD_PATH = './memory/slack-events-seen.json';

function read(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Note that a real Slack event reached this deployment.
 *
 * Called from the events route on every `event_callback`. Cheap, best-effort and never
 * throws: a failure to record must not drop the event that is being delivered.
 */
export function recordSlackEventSeen(tenantId, { file = DEFAULT_RECORD_PATH, now } = {}) {
  const stamp = now ?? new Date().toISOString();
  try {
    const cur = read(file) ?? { firstSeenAt: null, tenants: {} };
    cur.firstSeenAt ??= stamp;
    if (tenantId) cur.tenants[tenantId] = stamp;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cur, null, 2));
    return cur;
  } catch {
    return null;                                  // never let bookkeeping cost an event
  }
}

/** What this deployment has ever seen. */
export function slackDeliveryRecord({ file = DEFAULT_RECORD_PATH } = {}) {
  const cur = read(file);
  return {
    everReceived: !!cur?.firstSeenAt,
    firstSeenAt: cur?.firstSeenAt ?? null,
    tenants: cur?.tenants ?? {},
  };
}

/** Does this trigger start a workflow from a Slack event? */
export function isSlackEventTrigger(trigger) {
  if (!trigger || trigger.type !== 'event') return false;
  return String(trigger.connector ?? '').trim().toLowerCase() === 'slack';
}

/**
 * May a spec carrying a Slack trigger be published?
 *
 * Mirrors `checkAirtableTriggersArmable` deliberately — same shape, same `{ok, code,
 * error}`, same plain-language sentence a person can act on — so the two do not drift into
 * two different ideas of what "armable" means.
 *
 * @param {object} spec
 * @param {{connected: boolean}} slack   live connection status for the tenant
 * @param {{everReceived: boolean}} record  what this deployment has ever received
 */
export function checkSlackTriggersArmable(spec, slack, record) {
  const triggers = (spec?.triggers ?? []).filter(isSlackEventTrigger);
  if (!triggers.length) return { ok: true };            // nothing to arm

  if (!slack?.connected) {
    return {
      ok: false, code: 'SLACK_TRIGGER_NOT_CONNECTED',
      error: 'This workflow starts when something happens in Slack, but Slack is not connected — Atlas cannot watch for those messages yet. Connect Slack, then publish.',
    };
  }

  // NEVER, not "not lately". A deployment that has received Slack events is wired; one
  // that has never received a single event from any workspace is not, and every workflow
  // published against it would show as live and sit silent.
  if (!record?.everReceived) {
    return {
      ok: false, code: 'SLACK_EVENTS_NOT_DELIVERING',
      error: 'This workflow starts when a message is posted in Slack, but Slack has never sent Atlas an event — so it would look live and never actually run. In your Slack app settings, turn on Event Subscriptions, point them at this Atlas address, and subscribe to messages. Then publish.',
    };
  }

  return { ok: true };
}
