/**
 * A workflow may not be published with a trigger that nothing can run.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * QA found an Airtable-triggered workflow whose approval card read "A new email
 * arrives". The wrong caption was the visible half. The real defect was that its
 * stored trigger was `{"type":"connector_event"}` — no connector, no event, no
 * baseId, no tableId — and **it published anyway**.
 *
 * `checkAirtableTriggersArmable` filters with `isAirtableRecordChangedTrigger`,
 * which demands `type === 'event' && connector === 'airtable'`. A trigger shaped
 * like the above matches nothing, so the filter returned an empty list and the
 * check said `{ok:true}` — "nothing to arm". The fail-closed publishing rule
 * (2026-07-24, operator's call) was not weakened; it was **bypassed**, because
 * the trigger never looked like an Airtable trigger in the first place. Slack
 * dispatch has the same requirement and therefore the same blind spot.
 *
 * The result is the exact silent failure that rule exists to prevent: a workflow
 * that saves, shows as live, and can never fire.
 *
 * **The check that was missing is not Airtable-specific, so this one is not
 * either.** The constitution's rule is `a check scoped to the PRODUCER is wrong;
 * scope it to the VALUE` — so this asks one question of every trigger: *is there
 * anything in this system that could ever start a workflow from this?* Anything
 * unrecognised is refused. That is deliberate and it is the whole point: a
 * trigger type added to a prompt but never taught to a consumer now refuses to
 * publish LOUDLY, instead of publishing and silently never firing.
 *
 * ── Where `connector_event` came from ────────────────────────────────────────
 *
 * It was never a runnable type. At the time of writing it appeared in exactly
 * ONE place in all of `src/`: the elicitation prompt, which listed it among the
 * types the model may return. Nothing consumed it — not the scheduler, not the
 * Gmail poller, not the Slack or Airtable dispatchers. The interview was asking
 * the model for a value the runtime cannot honour. That prompt is fixed in the
 * same commit, but the prompt fix is a BELIEF about model behaviour and is
 * pinned by nothing; this guard is the mechanism, and it holds regardless of
 * what any model emits.
 *
 * ── The runnable set, and who honours each ───────────────────────────────────
 *
 *   email     → WorkflowScheduler polls it (`t.type === 'email'`) and
 *               gmail-source reads its filter.
 *   schedule  → WorkflowScheduler's cron path (`_isFlowDue`).
 *   manual    → nothing to arm; it starts when a person presses run.
 *   event     → a pushed connector. REQUIRES `connector`, because every
 *               dispatcher matches on it (Airtable: `type==='event' &&
 *               connector==='airtable'`). An `event` with no connector is
 *               un-routable and is refused for the same reason as the above.
 *
 * Keep this list in step with the consumers. If you add a trigger type, add it
 * here **and** teach something to run it — this file failing a publish is the
 * signal that only one of those two happened.
 */

/** Trigger types something in this system can actually start a workflow from. */
export const RUNNABLE_TRIGGER_TYPES = Object.freeze(['email', 'schedule', 'manual', 'event']);

/** A pushed-connector trigger is only routable if it says WHICH connector. */
const REQUIRES_CONNECTOR = 'event';

/**
 * Is there anything in this system that could ever start a workflow from `t`?
 * Deliberately structural — it asks what the value IS, never who produced it.
 */
export function isRunnableTrigger(t) {
  if (!t || typeof t !== 'object') return false;
  const type = typeof t.type === 'string' ? t.type.trim().toLowerCase() : '';
  if (!RUNNABLE_TRIGGER_TYPES.includes(type)) return false;
  if (type === REQUIRES_CONNECTOR) {
    if (typeof t.connector !== 'string' || t.connector.trim() === '') return false;
    // ── AND IT MUST SAY WHICH EVENT ────────────────────────────────────────
    //
    // WITNESSED 2026-08-03: a Slack workflow published, showed as live, and could
    // never fire. Its trigger named the connector — so it passed this check — but
    // carried NO event id, and every dispatcher matches on one
    // (`selectSlackFlows`: `t.event === wantEvent`). A real message arrived,
    // verified, and matched nothing.
    //
    // The same defect as `connector_event`, one field along, and the entry above
    // ends with the sentence this closes: *keep the runnable set in step with the
    // consumers*. Naming the connector was necessary and was never sufficient —
    // the dispatcher needs to know WHICH of that connector's events to match.
    return typeof t.event === 'string' && t.event.trim() !== '';
  }
  return true;
}

/**
 * Refuse a publish whose trigger could never fire.
 *
 * Fails CLOSED on anything it does not understand, and says so in words a
 * non-technical person can act on — the product's own standard for a refusal.
 *
 * A spec with NO triggers at all is passed through untouched: "this workflow has
 * no trigger" is a different question, owned by the validator, and answering it
 * here would refuse manual-run and draft shapes this check has no business
 * judging.
 *
 * @returns {{ok:true} | {ok:false, code:string, error:string}}
 */
export function checkTriggersRunnable(spec) {
  const triggers = Array.isArray(spec?.triggers) ? spec.triggers : [];
  if (!triggers.length) return { ok: true };

  for (const t of triggers) {
    if (isRunnableTrigger(t)) continue;

    const raw = (t && typeof t.type === 'string' && t.type.trim()) ? t.type.trim() : null;

    // An `event` missing its connector is a different mistake from an
    // unrecognised type, and deserves a different sentence.
    if (raw && raw.toLowerCase() === REQUIRES_CONNECTOR) {
      return {
        ok: false,
        code: 'TRIGGER_NO_CONNECTOR',
        error: 'This workflow is meant to start when something happens in another app, '
             + 'but it does not say which app to watch — so it could never start. '
             + 'Pick the app that should start it, then publish.',
      };
    }

    return {
      ok: false,
      code: 'TRIGGER_NOT_RUNNABLE',
      error: 'Atlas cannot start this workflow, because it does not have a way to watch '
           + `for ${raw ? 'that kind of event' : 'anything'} yet — so it would save, look `
           + 'live, and never run. Change what starts it to an email arriving, a schedule, '
           + 'a change in a connected app, or running it yourself.',
    };
  }

  return { ok: true };
}
