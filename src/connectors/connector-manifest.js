/**
 * Connector manifest — the declarative catalog of user-connectable services.
 *
 * This is the "templating" the product asked for: adding a connector is a
 * config edit here (plus, at most, a thin per-provider adapter in a later
 * slice) — NOT new plumbing. `GET /connectors` and the Frontend catalog are
 * both driven entirely off this array, so a new entry surfaces end-to-end
 * with zero code changes elsewhere (Slice 2 acceptance #5 / Slice 5).
 *
 * Boundaries (deliberate, reconciled against live Slice-1 code 2026-05-15):
 *   - NO OAuth secrets here. The Architect brief sketched `oauth.providerConfig`
 *     inline, but Slice-1's locked convention (Fork 2B) resolves client
 *     id/secret/redirect server-side from per-deployment env via
 *     `googleProviderConfig()` (src/auth/oauth-client.js). Embedding them in a
 *     manifest would contradict that and leak secrets into a catalog response.
 *     So `oauth.connectorId` is just the key passed to the Slice-1 mechanism
 *     (`auth.oauth.{start,status,revoke}`), and `oauth.scopes` is a
 *     human-readable summary for the UI — the authoritative scope list lives
 *     in `googleProviderConfig()`.
 *   - The `mcp` block is INERT data in Slice 2. Actually spawning a per-user
 *     Google MCP subprocess (Fork 1A) is Slice 4; the exact off-the-shelf
 *     server binary is deliberately NOT hard-picked here and stays fully
 *     overridable via env so Slice 4 can finalize it without touching code.
 *
 * @module src/connectors/connector-manifest.js
 */

/**
 * @typedef {object} ConnectorEntry
 * @property {string} id            stable connector id (also the URL segment)
 * @property {string} label         display name
 * @property {string} icon          icon identifier the frontend maps to a glyph
 * @property {string} description   one-line, user-facing (no jargon)
 * @property {{ connectorId: string, scopes: string[] }} oauth
 *           connectorId → key for the Slice-1 OAuth mechanism; scopes →
 *           display-only summary (authoritative scopes live in the provider
 *           config resolved by Slice 1).
 * @property {object} mcp           inert Slice-4 spawn template (Fork 1A stdio)
 */

/** @type {ConnectorEntry[]} */
export const CONNECTOR_MANIFEST = [
  {
    id: 'google',
    label: 'Google Workspace',
    icon: 'google',
    description:
      'Connect your Google account so the agent can answer questions about your Gmail, Calendar, and Drive — read-only.',
    oauth: {
      connectorId: 'google',
      scopes: [
        'Gmail — read-only',
        'Calendar — read-only',
        'Drive — read-only',
      ],
    },
    mcp: {
      // Slice 4 (Fork 1A): per-user stdio subprocess. The exact off-the-shelf
      // Google Workspace MCP binary is a PER-DEPLOYMENT choice (set in the
      // same Fork-2B sandbox setup that registers the Google OAuth app), so
      // command/args are env-overridable with a placeholder default. The
      // ${OAUTH_ACCESS_TOKEN} marker is substituted per-user at spawn by the
      // Slice-3 pool from that user's Slice-1 token.
      //
      // ⚠️ CONTRACT (Slice-4 finding — see reports/2026-05-16-slice4-*.md):
      // the chosen server MUST authenticate from a Bearer access token in the
      // GOOGLE_OAUTH_ACCESS_TOKEN env var. Servers that run their own OAuth
      // dance / want a client-secret or service-account JSON file are NOT
      // drop-in compatible without a thin token→server adapter.
      transport: 'stdio',
      commandEnv: 'GOOGLE_MCP_COMMAND',          // default: npx
      argsEnv:    'GOOGLE_MCP_ARGS',             // default: placeholder pkg (override per deployment)
      env:        { GOOGLE_OAUTH_ACCESS_TOKEN: '${OAUTH_ACCESS_TOKEN}' },
      // Read-only v1 is primarily guaranteed by the read-only OAuth scopes
      // (googleProviderConfig — Google enforces this regardless of the MCP
      // server). The allowlist is belt-and-suspenders; tool names are
      // server-specific so it is env-overridable, null ⇒ rely on scopes.
      toolsAllowlistEnv: 'GOOGLE_MCP_TOOLS_ALLOWLIST',
    },
  },

  // ── Connector #2 (Slice 5 templating proof) ───────────────────────────────
  // A genuinely different OAuth2 provider (not a Google-scope clone), with no
  // customer-IT dependency — consistent with the self-service LOI motion.
  // Added by THIS manifest entry only. It carries a full `oauth.provider`
  // spec (endpoints/scopes/env-var NAMES — never secrets, Fork-2B) to show
  // the manifest CAN express a second provider. See the Slice-5 finding doc
  // for what generalizes for free vs. the one seam that doesn't.
  {
    id: 'github',
    label: 'GitHub',
    icon: 'github',
    description:
      'Connect your GitHub account so the agent can answer questions about your repositories and activity — read-only.',
    oauth: {
      connectorId: 'github',
      scopes: ['Profile — read-only', 'Repositories — read-only'],
      // Manifest-expressed provider spec (the data the abstraction needs to
      // generalize). Consumed by providerConfigFromManifest() below.
      provider: {
        authorizationEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint:         'https://github.com/login/oauth/access_token',
        revocationEndpoint:    null,                 // GitHub has no RFC-7009 endpoint; revoke best-effort no-ops, row still deleted
        oauthScopes:           ['read:user', 'repo'],
        clientIdEnv:           'GITHUB_OAUTH_CLIENT_ID',
        clientSecretEnv:       'GITHUB_OAUTH_CLIENT_SECRET',
        callbackPath:          '/auth/oauth/github/callback',
        extraAuthParams:       {},
      },
    },
    mcp: {
      transport: 'stdio',
      commandEnv: 'GITHUB_MCP_COMMAND',
      argsEnv:    'GITHUB_MCP_ARGS',
      env:        { GITHUB_PERSONAL_ACCESS_TOKEN: '${OAUTH_ACCESS_TOKEN}' },
      toolsAllowlistEnv: 'GITHUB_MCP_TOOLS_ALLOWLIST',
    },
  },
];

const DEFAULTS = {
  GOOGLE_MCP_COMMAND: 'npx',
  // Intentionally a clearly-overridable placeholder, NOT a hard-picked
  // package — selecting + live-validating the real binary needs a Fork-2B
  // environment (see the Slice-4 finding). Deployments set GOOGLE_MCP_ARGS.
  GOOGLE_MCP_ARGS: '-y @modelcontextprotocol/server-google-REPLACE-ME',
  GITHUB_MCP_COMMAND: 'npx',
  GITHUB_MCP_ARGS: '-y @modelcontextprotocol/server-github',
};

/**
 * Slice 5 thin adapter (the ≤1 allowed file-equivalent — colocated, adds no
 * wiring): turn a manifest `oauth.provider` spec into the exact shape the
 * Slice-1 OAuthClient `_provider()` consumes, reading client id/secret from
 * the per-deployment env-var NAMES the manifest declares (Fork-2B — secrets
 * never in source/manifest). This proves the manifest CAN fully express a
 * second OAuth2 provider.
 *
 * NOTE (Slice-5 finding): producing this object is sufficient *data*, but the
 * shipped OAuthClient resolves providers via a google-hardcoded
 * `_resolveProvider` constructed in `src/auth/index.js` with NO injected
 * resolver, and the Slice-2 connect route passes no `providerConfig`. So
 * wiring this in requires a one-time core generalization (inject a
 * manifest-driven resolver at `new OAuthClient(...)`). That core edit is
 * deliberately NOT made here — see reports/2026-05-16-slice5-templating-proof.md.
 *
 * @param {ConnectorEntry} entry
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object|null} `_provider`-shaped config, or null if no provider spec
 */
export function providerConfigFromManifest(entry, env = process.env) {
  const p = entry?.oauth?.provider;
  if (!p) return null; // e.g. 'google' resolves via Slice-1 googleProviderConfig()
  const clientId     = env[p.clientIdEnv]?.trim();
  const clientSecret = env[p.clientSecretEnv]?.trim();
  const redirectBase = (env.OAUTH_REDIRECT_BASE?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  return {
    name:                  entry.oauth.connectorId,
    configured:            !!(clientId && clientSecret),
    clientId,
    clientSecret,
    redirectUri:           `${redirectBase}${p.callbackPath}`,
    authorizationEndpoint: p.authorizationEndpoint,
    tokenEndpoint:         p.tokenEndpoint,
    revocationEndpoint:    p.revocationEndpoint ?? null,
    scopes:                p.oauthScopes ?? [],
    extraAuthParams:       p.extraAuthParams ?? {},
  };
}

/** Parse an env args string: JSON array if it looks like one, else whitespace-split. */
function parseArgs(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('[')) { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(String); } catch { /* fall through */ } }
  return s.split(/\s+/);
}

/**
 * Turn a connector's `mcp` template into an `McpRegistry.createServer` def
 * for a specific owner. `name` is deliberately the connectorId — the Slice-3
 * pool resolves the per-user token via `oauth.getAccessToken({ userId,
 * connectorId: row.name })`, so they MUST match. The `${OAUTH_ACCESS_TOKEN}`
 * env marker is left literal for the pool to substitute per-user.
 *
 * @param {ConnectorEntry} entry
 * @param {{ ownerUserId: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {object|null} createServer def, or null if the connector has no mcp block
 */
export function materializeMcpDef(entry, { ownerUserId, env = process.env } = {}) {
  if (!entry?.mcp || !ownerUserId) return null;
  const m = entry.mcp;
  const command = (env[m.commandEnv]?.trim()) || DEFAULTS[m.commandEnv] || 'npx';
  const args    = parseArgs(env[m.argsEnv]) ?? parseArgs(DEFAULTS[m.argsEnv]) ?? [];
  const allow   = parseArgs(env[m.toolsAllowlistEnv]); // comma/space list or JSON; null ⇒ scopes-only
  return {
    name:           entry.oauth.connectorId,   // MUST equal connectorId (Slice-3 token key)
    transport:      m.transport === 'sse' ? 'sse' : 'stdio',
    command,
    args,
    env:            { ...(m.env ?? {}) },       // ${OAUTH_ACCESS_TOKEN} stays literal
    source:         'user',
    owner_user_id:  ownerUserId,
    enabled:        true,
    tools_allowlist: allow && allow.length ? allow : null,
  };
}

/** Get one connector entry by id, or null. */
export function getConnector(id) {
  if (!id) return null;
  return CONNECTOR_MANIFEST.find((c) => c.id === id) ?? null;
}

/**
 * UI-safe projection of the catalog: metadata only, never the `mcp` spawn
 * template or anything secret. Per-caller connection status is merged in by
 * the route layer (it needs req.user.id), not here.
 * @returns {Array<{id:string,label:string,icon:string,description:string,oauth:{connectorId:string,scopes:string[]}}>}
 */
export function listConnectors() {
  return CONNECTOR_MANIFEST.map(({ id, label, icon, description, oauth }) => ({
    id, label, icon, description, oauth,
  }));
}

export default CONNECTOR_MANIFEST;
