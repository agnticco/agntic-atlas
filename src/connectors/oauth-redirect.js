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
