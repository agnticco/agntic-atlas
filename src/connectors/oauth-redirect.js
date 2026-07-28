/**
 * oauth-redirect — single source of truth for the public base URL that OAuth
 * providers (Slack, Google, …) redirect the browser back to after consent.
 *
 * Set ONE env var, `OAUTH_REDIRECT_BASE`, to switch the whole deployment between
 * local and hosted:
 *   - local testing:   OAUTH_REDIRECT_BASE=http://localhost:3000
 *   - hosted (P11):    OAUTH_REDIRECT_BASE=https://atlas.agntic.co
 * Defaults to http://localhost:<PORT> when unset.
 *
 * Per-connector overrides (SLACK_REDIRECT_URI, GOOGLE_REDIRECT_URI) still win when
 * present, but they are no longer required — leave them unset and both connectors
 * follow OAUTH_REDIRECT_BASE.
 *
 * Whatever base you pick must be registered as an allowed redirect URL in each
 * provider's console (Slack: OAuth & Permissions → Redirect URLs; Google Cloud:
 * Credentials → Authorized redirect URIs), as `<base>/connectors/<id>/callback`.
 *
 * @module src/connectors/oauth-redirect.js
 */

/** The trimmed, slash-normalised redirect base (no trailing slash). */
export function oauthRedirectBase() {
  const base = process.env.OAUTH_REDIRECT_BASE?.trim() || `http://localhost:${process.env.PORT ?? 3000}`;
  return base.replace(/\/+$/, '');
}

/** Full callback URL for a connector, e.g. connectorRedirectUri('slack'). */
export function connectorRedirectUri(connectorId) {
  return `${oauthRedirectBase()}/connectors/${connectorId}/callback`;
}

/**
 * CAN AN OAUTH ROUND-TRIP STARTED FROM `origin` EVER COME BACK?
 *
 * It cannot if the redirect base points somewhere else: the provider sends the
 * browser to `<base>/connectors/<id>/callback`, and a base on a different host is
 * a different Atlas — or nothing at all.
 *
 * WHY THIS IS FAIL-CLOSED RATHER THAN A WARNING (2026-07-28). Observed: a local
 * run carried `OAUTH_REDIRECT_BASE=https://dev.agntic.co`. Pressing Connect on
 * `http://localhost:3000` sent the user to Airtable, which answered *"invalid
 * client_id or mismatched redirect_uri"* — a provider's error page, in the
 * provider's words, for a misconfiguration on OUR side that we could have detected
 * before the first redirect. Atlas said nothing at any point. The user then could
 * not connect Airtable at all, and every table-shaped workflow was untestable
 * locally, which took a while to attribute to config rather than to the product.
 *
 * Same-origin is the only safe answer, so anything else is refused with both values
 * named. Deliberately compares ORIGIN (scheme + host + port): a tunnel that fronts
 * localhost under a public name is a legitimate setup, and there the browser really
 * is on the public origin, so it matches and is allowed.
 *
 * @returns {{ok: true} | {ok: false, base: string, origin: string, message: string}}
 */
export function redirectReachableFrom(origin) {
  const base = oauthRedirectBase();
  let baseOrigin = null, fromOrigin = null;
  try { baseOrigin = new URL(base).origin; } catch { baseOrigin = null; }
  try { fromOrigin = new URL(String(origin ?? '')).origin; } catch { fromOrigin = null; }
  // Unparseable on either side ⇒ we cannot prove a mismatch, and refusing on a
  // guess would block a working deployment. Proof of absence, not absence of proof.
  if (!baseOrigin || !fromOrigin) return { ok: true };
  if (baseOrigin === fromOrigin) return { ok: true };
  return {
    ok: false, base: baseOrigin, origin: fromOrigin,
    message: `Connecting from ${fromOrigin} cannot work: this Atlas is configured to `
      + `receive the provider's callback at ${baseOrigin}. Set OAUTH_REDIRECT_BASE to `
      + `${fromOrigin} (and register ${fromOrigin}/connectors/<id>/callback with the `
      + `provider), or open Atlas at ${baseOrigin} instead.`,
  };
}
