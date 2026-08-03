/**
 * WHO ATLAS IS, TO A SERVICE IT HAS NEVER MET. (P13-A, first half.)
 *
 * ── The constraint that produced this ───────────────────────────────────────
 *
 * Atlas is a no-code product for non-technical people, so a customer must NEVER
 * be sent into a developer settings screen to create an integration, pick
 * permissions and paste a secret. That leaves exactly two ways to connect a
 * service, and this file is the first:
 *
 *   1. SELF-IDENTIFYING — no setup by anyone. Atlas publishes one identity
 *      document at a fixed address it already owns, and that ADDRESS IS ITS
 *      IDENTITY with every service supporting the standard. Verified 2026-07-24
 *      against Notion, Linear, Stripe, Asana, Sentry and Figma.
 *   2. Agntic registers once, by hand, per service. (Route 2, out of P13.)
 *
 * ── The one non-obvious rule ────────────────────────────────────────────────
 *
 * `client_id` IS THE DOCUMENT'S OWN URL. That is the whole mechanism: a server
 * receives an authorization request carrying a URL as the client id, fetches it,
 * and reads this document to learn who is asking. There is no registration step
 * and no shared secret, which is exactly why it needs none of the customer's
 * time. If the id and the URL ever disagree the identity is unresolvable, so that
 * is asserted rather than assumed.
 *
 * ── The hard stop, which must not be softened ───────────────────────────────
 *
 * The standard's identity order is:
 *
 *   pre-registered credentials → CIMD → dynamic registration → PROMPT THE USER
 *
 * IMPLEMENT THE FIRST THREE AND STOP. That fourth step *is* the banned developer
 * settings screen, and a naive implementation of the spec falls through to it by
 * default. A service that exhausts the first three is "not supported yet" and
 * goes on the route-2 list — it never degrades into asking a customer for a
 * token. `identityChain()` exists to make that refusal explicit and testable
 * rather than an absence someone can quietly fill in later.
 *
 * ── Public client, deliberately ─────────────────────────────────────────────
 *
 * `token_endpoint_auth_method: 'none'`. There is no client secret because there
 * was no registration to issue one — that is the point of the mechanism, not an
 * omission. Security rests on the redirect URI and PKCE, both declared here.
 */

import { oauthRedirectBase } from './oauth-redirect.js';

/** Where the identity document lives. Stable — it is the identity. */
export const CIMD_PATH = '/.well-known/oauth-client';

/** The document's own URL, which IS the client id. */
export function clientIdUrl() {
  return `${oauthRedirectBase()}${CIMD_PATH}`;
}

/**
 * Every callback a remote server may send an authorization code back to.
 *
 * MCP-sourced connectors share ONE callback rather than minting a path each —
 * the server is identified by state, not by the URL it returns to. A per-server
 * path would mean a document that changes whenever a connector is added, and the
 * document is the identity: it must be stable.
 */
export function redirectUris() {
  return [`${oauthRedirectBase()}/connectors/mcp/callback`];
}

/**
 * The Client ID Metadata Document.
 *
 * Deliberately minimal. Every field here is one a server may act on; anything
 * else would be decoration on a document whose whole job is to be unambiguous.
 */
export function clientIdMetadata() {
  return {
    client_id: clientIdUrl(),
    client_name: 'Atlas by Agntic',
    client_uri: oauthRedirectBase(),
    redirect_uris: redirectUris(),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // No secret to present, because nothing registered us. PKCE and the declared
    // redirect carry the security.
    token_endpoint_auth_method: 'none',
    // S256 only. `plain` is in the spec and is not a protection.
    code_challenge_methods_supported: ['S256'],
  };
}

/**
 * THE IDENTITY CHAIN, AND WHERE IT STOPS.
 *
 * Returns the steps to try, in order, for a server we have just met. The fourth
 * step of the standard — prompting the customer for credentials — is ABSENT by
 * construction, not filtered out at the end, so nothing downstream can reach it
 * by iterating one element further.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.hasPreRegistered]  do we already hold credentials for this server
 * @param {boolean} [opts.supportsCimd]      does its metadata advertise CIMD
 * @param {boolean} [opts.supportsDcr]       does it offer dynamic registration
 */
export function identityChain({ hasPreRegistered = false, supportsCimd = false, supportsDcr = false } = {}) {
  const steps = [];
  if (hasPreRegistered) steps.push('pre_registered');
  if (supportsCimd) steps.push('cimd');
  if (supportsDcr) steps.push('dcr');
  return steps;
}

/**
 * What to do when the chain runs out.
 *
 * NOT a credential prompt. A service we cannot identify ourselves to is one we do
 * not support yet, and saying so plainly is the honest answer — the customer can
 * act on "not supported yet" and cannot act on a form asking for a token they
 * would have to go and create.
 */
export function unsupportedService(name = 'That service') {
  return {
    supported: false,
    reason: 'no_identity_mechanism',
    message: `${name} doesn't yet work with Atlas. It needs a kind of connection we set up by hand, ` +
      `and it isn't on the list yet — tell us and we'll look at adding it. ` +
      `You won't ever need to create an app or paste a key to connect something here.`,
  };
}
