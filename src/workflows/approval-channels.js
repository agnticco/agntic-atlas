/**
 * approval-channels — the trust table, and the ONE definition of it.
 *
 * P12 Increment D (converger-v2 §7.2). An approval that anyone can forge is not
 * an approval, so the channels a `human` node may be asked over are **not
 * interchangeable**:
 *
 *   inbox   strong   an in-app item, answered from an authenticated session.
 *                    Proves: THIS user, logged in.
 *   slack   strong   Block Kit buttons; the answer arrives as a `block_actions`
 *                    payload HMAC-signed with SLACK_SIGNING_SECRET and carrying
 *                    the Slack user id. Proves: WHICH Slack user clicked.
 *   email   medium   a signed, hashed, single-use magic link. Proves only
 *                    POSSESSION OF THE LINK — i.e. mailbox access. Forwardable.
 *   email_reply      FORBIDDEN. Proves NOTHING.
 *
 * ── Why `email_reply` is not a channel with a low score, but a hard error ─────
 *
 * Parsing "yes" out of a reply body authenticates nothing. `From:` is trivially
 * spoofable; SPF/DKIM authenticate a sending DOMAIN, not a human INTENT; and a
 * forwarded thread is full of the word "yes". There is no configuration of it
 * that is safe, so it is rejected at build time rather than scored (§11.8).
 *
 * ── Why this file exists at all ──────────────────────────────────────────────
 *
 * The trust level is read in three places — the validator (WEAK_APPROVAL_FOR_WRITE),
 * the gap scorer (which must reach the same verdict publish will, or `complete ⇒
 * publishable` is false), and the service that actually delivers the ask. Three
 * copies of a security rule drift, and the day they drift is the day the
 * converger ratifies a spec that publish rejects — or worse, the day a `medium`
 * channel gates a write because one copy forgot. Same discipline as
 * `closedDomainOf()`: a channel earns its trust level HERE, once.
 *
 * @module src/workflows/approval-channels.js
 */

/** The closed set of approval channel types, and what each one proves. */
export const CHANNEL_TRUST = Object.freeze({
  inbox: 'strong',
  slack: 'strong',
  email: 'medium',
});

/** Never a channel. Present only so the validator can name it and reject it. */
export const FORBIDDEN_CHANNELS = Object.freeze(['email_reply']);

/** A channel whose answer proves who gave it. */
export function isStrong(type) {
  return CHANNEL_TRUST[String(type)] === 'strong';
}

export function trustOf(type) {
  return CHANNEL_TRUST[String(type)] ?? null;
}

/**
 * Which approval channels this deployment can actually ask over, derived from
 * the SAME live catalog the engine runs on plus the platform mailer.
 *
 * `inbox` is unconditional: it is in-app, it needs no connector, and it is what
 * makes the escalation default honest — there is always somewhere to put a
 * question a person must answer.
 *
 * @param {{ get?: Function }} channelRegistry — the live ChannelRegistry (or the
 *        converger's channel view). Null when the caller has no catalog, in
 *        which case slack cannot be confirmed and is NOT offered — a channel we
 *        cannot verify is not a channel we may promise.
 * @param {{ mailer?: boolean }} [opts]
 * @returns {string[]} available channel types
 */
export function availableApprovalChannels(channelRegistry, { mailer = false } = {}) {
  const out = ['inbox'];
  const slack = channelRegistry?.get?.('slack');
  if (slack && slack.available !== false) out.push('slack');
  if (mailer) out.push('email');
  return out;
}

/**
 * A view the validator can consult. `null` means "this caller cannot see the
 * catalog" — the validator then skips the connectedness check, exactly as it
 * already does for `deliver` channels, and the GAP SCORER fails closed instead
 * (CHANNELS_UNVERIFIED). Refusing to certify is always available; certifying
 * without checking is not.
 */
export function approvalChannelView(types) {
  if (!Array.isArray(types)) return null;
  const set = new Set(types.map(String));
  return { has: (t) => set.has(String(t)), list: () => [...set] };
}
