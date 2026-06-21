/**
 * Airtable OAuth 2.0 + PKCE install flow check (offline, stubbed Airtable).
 *
 * Drives the real spine: platform setup → two tenants → each tenant's admin
 * runs the OAuth install (oauth/start → extract state → callback → token exchange)
 * → the workspace access token is stored in THAT tenant's vault. Proves:
 *   - per-tenant token storage + isolation (each tenant gets its own token),
 *   - an authenticated workflow run calls the Airtable API using the tenant's OWN token,
 *   - /connectors/airtable/status + /capabilities reflect the per-tenant grant,
 *   - disconnect removes it.
 *
 * No real Airtable. AIRTABLE_OAUTH_URL and AIRTABLE_API_URL redirect all HTTP
 * calls to a local stub server before server.js is imported.
 * Prints AIRTABLE-OAUTH-PASS / -FAIL and exits 0/1.
 */
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Stub server ───────────────────────────────────────────────────────────────
// Handles:
//   POST /oauth2/v1/token  — token exchange / refresh
//   GET  /v0/:base/:table  — list records (airtable_list_records capability)

const apiCalledWith = []; // tokens seen in Airtable API calls

const stub = http.createServer((req, res) => {
  let buf = ''; req.on('data', d => { buf += d; }); req.on('end', () => {
    if (req.url === '/oauth2/v1/token' && req.method === 'POST') {
      // Token exchange or refresh — return a token derived from the code/refresh token
      // so each tenant's install yields a distinct, traceable access token.
      const params = new URLSearchParams(buf);
      const seedValue = params.get('code') || params.get('refresh_token') || 'unknown';
      const scope = 'data.records:read data.records:write schema.bases:read webhook:manage';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token:  `at-${seedValue}`,
        refresh_token: `rt-${seedValue}`,
        scope,
        expires_in:    3600,
        token_type:    'Bearer',
      }));
    } else if (req.url.startsWith('/v0/') && req.method === 'GET') {
      // list-records call — record the bearer token so we can verify isolation
      apiCalledWith.push((req.headers.authorization || '').replace('Bearer ', ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        records: [{ id: 'recTEST001', fields: { Name: 'test' }, createdTime: '2026-06-20T00:00:00.000Z' }],
      }));
    } else {
      res.writeHead(404); res.end();
    }
  });
});
await new Promise(r => stub.listen(0, r));
const stubPort = stub.address().port;

// ── Env setup (BEFORE import so module-level constants pick up the overrides) ─
const t = mkdtempSync(join(tmpdir(), 'atlas-airtable-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
})) process.env[k] = join(t, v);

process.env.AIRTABLE_OAUTH_URL     = `http://127.0.0.1:${stubPort}/oauth2/v1/token`;
process.env.AIRTABLE_API_URL       = `http://127.0.0.1:${stubPort}/v0`;
process.env.AIRTABLE_CLIENT_ID     = 'test-client-id';
process.env.AIRTABLE_CLIENT_SECRET = 'test-client-secret';
process.env.OAUTH_REDIRECT_BASE    = `http://127.0.0.1:${stubPort}`;
// Remove Slack env so only the Airtable path is exercised.
delete process.env.SLACK_BOT_TOKEN;
delete process.env.SLACK_CLIENT_ID;
delete process.env.SLACK_CLIENT_SECRET;

const { bootSpine, createApp } = await import('../../src/api/server.js');
const spine = await bootSpine();
const app   = createApp(spine);
const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

// ── Test helpers ──────────────────────────────────────────────────────────────
let pass = true;
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) pass = false; };

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
};

/**
 * Drive the Airtable OAuth install for one tenant:
 *   1. GET /connectors/airtable/oauth/start  → extract state from 302 Location
 *   2. GET /connectors/airtable/callback?state=...&code=...  → stub exchanges code,
 *      token stored, server 302s to /?connected=airtable
 */
const connectAirtable = async (token, code) => {
  const startRes = await fetch(base + '/connectors/airtable/oauth/start', {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
  if (startRes.status !== 302) throw new Error(`oauth/start returned ${startRes.status}`);
  const location = startRes.headers.get('location') ?? '';
  const state = new URL(location).searchParams.get('state');
  if (!state) throw new Error(`no state param in authorize URL: ${location}`);

  const cbUrl = new URL(base + '/connectors/airtable/callback');
  cbUrl.searchParams.set('state', state);
  cbUrl.searchParams.set('code', code);
  const cbRes = await fetch(cbUrl.toString(), {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
  return { status: cbRes.status };
};

// Spec: single deliver node using airtable_list_records (step-only → actionOnly=true,
// calls handler directly without needing upstream content).
const airtableSpec = {
  name: 'list',
  nodes: [{ id: 'r', type: 'deliver', label: 'list records', config: { channel: 'airtable_list_records', baseId: 'appTEST', tableId: 'tblTEST' } }],
  edges: [],
};

// ── Test run ──────────────────────────────────────────────────────────────────
try {
  // Platform + two tenants
  const platform = (await api('POST', '/setup', { body: { token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'platform-pw-1' } })).json?.token;
  await api('POST', '/tenants', { token: platform, body: { name: 'Acme',   slug: 'acme',   admin: { email: 'a@acme.test',   password: 'acme-pw-12'  } } });
  await api('POST', '/tenants', { token: platform, body: { name: 'Globex', slug: 'globex', admin: { email: 'b@globex.test', password: 'globex-pw-1' } } });
  const tokenA = (await api('POST', '/auth/login', { body: { email: 'a@acme.test',   password: 'acme-pw-12'  } })).json?.token;
  const tokenB = (await api('POST', '/auth/login', { body: { email: 'b@globex.test', password: 'globex-pw-1' } })).json?.token;

  // Before connecting: not connected.
  ok('acme starts disconnected',
    (await api('GET', '/connectors/airtable/status', { token: tokenA })).json?.connected === false);

  // Acme installs.
  const cbA = await connectAirtable(tokenA, 'acmecode');
  ok('acme OAuth callback succeeds (302 redirect to app)',  cbA.status === 302);
  ok('acme status now connected',
    (await api('GET', '/connectors/airtable/status', { token: tokenA })).json?.connected === true);

  // Globex still NOT connected (isolation), then installs with its own code.
  ok('globex still disconnected (isolation)',
    (await api('GET', '/connectors/airtable/status', { token: tokenB })).json?.connected === false);
  await connectAirtable(tokenB, 'globexcode');
  ok('globex connected independently',
    (await api('GET', '/connectors/airtable/status', { token: tokenB })).json?.connected === true);

  // Acme run: verify the Airtable API is called with Acme's OWN OAuth token.
  apiCalledWith.length = 0;
  const runA = await api('POST', '/workflows/run', { token: tokenA, body: { spec: airtableSpec } });
  ok('acme run completes without error',     runA.json?.completed === true && !runA.json?.error);
  ok('acme run used acme OAuth token only',  apiCalledWith.length === 1 && apiCalledWith[0] === 'at-acmecode');

  // Globex run: must use Globex's token, never Acme's.
  apiCalledWith.length = 0;
  const runB = await api('POST', '/workflows/run', { token: tokenB, body: { spec: airtableSpec } });
  ok('globex run completes without error',              runB.json?.completed === true && !runB.json?.error);
  ok('globex run used globex token (cross-tenant isolation)',
    apiCalledWith.length === 1 && apiCalledWith[0] === 'at-globexcode');

  // /capabilities reflects granted scopes from Acme's install.
  const caps = await api('GET', '/capabilities', { token: tokenA });
  const lr = caps.json?.connectors?.airtable?.actions?.find(a => a.id === 'airtable_list_records');
  ok('capabilities airtable_list_records available',          lr?.available === true);
  ok('capabilities grantedScopes includes data.records:read',
    caps.json?.connectors?.airtable?.grantedScopes?.includes('data.records:read') === true);
  ok('capabilities connector shape has connected=true',
    caps.json?.connectors?.airtable?.connected === true);

  // Disconnect Acme — Globex must remain connected.
  await api('DELETE', '/connectors/airtable', { token: tokenA });
  ok('acme disconnect removes the install',
    (await api('GET', '/connectors/airtable/status', { token: tokenA })).json?.connected === false);
  ok('globex still connected after acme disconnect',
    (await api('GET', '/connectors/airtable/status', { token: tokenB })).json?.connected === true);

} finally {
  server.close(); stub.close(); spine.close();
}

console.log(pass ? 'AIRTABLE-OAUTH-PASS' : 'AIRTABLE-OAUTH-FAIL');
process.exit(pass ? 0 : 1);
