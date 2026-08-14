/**
 * Slack OAuth install flow check (offline, stubbed Slack).
 *
 * Drives the real spine: platform setup -> two tenants -> each tenant's admin
 * runs the OAuth install (authorize -> callback -> oauth.v2.access exchange) ->
 * the workspace bot token is stored in THAT tenant's vault. Proves:
 *   - per-tenant token storage + isolation (each tenant gets its own token),
 *   - an authenticated workflow run posts using the tenant's OWN OAuth token,
 *   - /connectors/slack/status + /capabilities reflect the per-tenant grant,
 *   - disconnect removes it.
 *
 * No real Slack and no env SLACK_BOT_TOKEN (so only the OAuth path can post).
 * Prints SLACK-OAUTH-PASS / -FAIL and exits 0/1.
 */
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stub Slack: oauth.v2.access returns a token derived from the code (so each
// tenant's install yields a distinct token); chat.postMessage records the token used.
const postedWith = [];
const stub = http.createServer((req, res) => {
  let buf = ''; req.on('data', (d) => { buf += d; }); req.on('end', () => {
    if (req.url.endsWith('/oauth.v2.access')) {
      const code = new URLSearchParams(buf).get('code');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, access_token: `xoxb-${code}`, token_type: 'bot', scope: 'chat:write,chat:write.public', bot_user_id: 'U999', team: { id: `T-${code}`, name: `${code} Inc` } }));
    } else if (req.url.endsWith('/chat.postMessage')) {
      postedWith.push((req.headers.authorization || '').replace('Bearer ', ''));
      const body = JSON.parse(buf || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: '1700000000.000200', channel: body.channel }));
    } else { res.writeHead(404); res.end(); }
  });
});
await new Promise((r) => stub.listen(0, r));

const t = mkdtempSync(join(tmpdir(), 'atlas-slackoauth-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
})) process.env[k] = join(t, v);
process.env.SLACK_API_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.SLACK_CLIENT_ID = 'cid'; process.env.SLACK_CLIENT_SECRET = 'csecret';
process.env.SLACK_REDIRECT_URI = 'https://atlas.example/connectors/slack/callback';
process.env.SLACK_OAUTH_SCOPES = 'chat:write,chat:write.public';
delete process.env.SLACK_BOT_TOKEN; // force the OAuth path — no env fallback

const { bootSpine, createApp } = await import('../../src/api/server.js');
const spine = await bootSpine();
const app = createApp(spine);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let pass = true;
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) pass = false; };
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
};
const connect = async (token, code) => {
  const auth = await api('GET', '/connectors/slack/authorize', { token });
  const state = new URL(auth.json.authorizeUrl).searchParams.get('state');
  return api('GET', `/connectors/slack/callback?state=${state}&code=${code}`);
};
const slackSpec = { name: 'post', nodes: [{ id: 'p', type: 'deliver', label: 'post', config: { channel: 'slack', target: '#general', body: 'hello from the tenant install' } }], edges: [] };

try {
  const platform = (await api('POST', '/setup', { body: { token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'fixture-not-a-secret-platform' } })).json.token;
  await api('POST', '/tenants', { token: platform, body: { name: 'Acme', slug: 'acme', admin: { email: 'a@acme.test', password: 'fixture-not-a-secret-acme-b' } } });
  await api('POST', '/tenants', { token: platform, body: { name: 'Globex', slug: 'globex', admin: { email: 'b@globex.test', password: 'fixture-not-a-secret-globex-b' } } });
  const tokenA = (await api('POST', '/auth/login', { body: { email: 'a@acme.test', password: 'fixture-not-a-secret-acme-b' } })).json.token;
  const tokenB = (await api('POST', '/auth/login', { body: { email: 'b@globex.test', password: 'fixture-not-a-secret-globex-b' } })).json.token;

  // Before connecting: not connected.
  ok('acme starts disconnected', (await api('GET', '/connectors/slack/status', { token: tokenA })).json?.connected === false);

  // Acme installs (its own code => its own token).
  const cbA = await connect(tokenA, 'acmecode');
  ok('acme OAuth callback stores the install', cbA.status === 200 && cbA.json?.connected === true && cbA.json?.scopes?.includes('chat:write'));
  const stA = await api('GET', '/connectors/slack/status', { token: tokenA });
  ok('acme status now connected', stA.json?.connected === true && stA.json?.account === 'acmecode Inc');

  // Globex still NOT connected (isolation), then installs with its own token.
  ok('globex still disconnected (isolation)', (await api('GET', '/connectors/slack/status', { token: tokenB })).json?.connected === false);
  await connect(tokenB, 'globexcode');
  ok('globex connected independently', (await api('GET', '/connectors/slack/status', { token: tokenB })).json?.connected === true);

  // Authenticated run posts with the TENANT'S OWN OAuth token (not env, not the other tenant).
  postedWith.length = 0;
  const runA = await api('POST', '/workflows/run', { token: tokenA, body: { spec: slackSpec } });
  ok('acme run posts (ts returned)', !!runA.json?.deliveries?.[0]?.ts);
  ok('acme posted with ACME oauth token', postedWith.length === 1 && postedWith[0] === 'xoxb-acmecode');

  postedWith.length = 0;
  await api('POST', '/workflows/run', { token: tokenB, body: { spec: slackSpec } });
  ok('globex posted with GLOBEX oauth token (no cross-tenant token)', postedWith.length === 1 && postedWith[0] === 'xoxb-globexcode');

  // /capabilities reflects the granted scopes from acme's install.
  const caps = await api('GET', '/capabilities', { token: tokenA });
  const pm = caps.json?.connectors?.slack?.actions?.find((a) => a.id === 'post_message');
  ok('capabilities post_message available from grant', pm?.available === true && caps.json.connectors.slack.grantedScopes.includes('chat:write'));

  // Disconnect.
  await api('DELETE', '/connectors/slack', { token: tokenA });
  ok('acme disconnect removes the install', (await api('GET', '/connectors/slack/status', { token: tokenA })).json?.connected === false);
  ok('globex still connected after acme disconnect', (await api('GET', '/connectors/slack/status', { token: tokenB })).json?.connected === true);
} finally {
  server.close(); stub.close(); spine.close();
}

console.log(pass ? 'SLACK-OAUTH-PASS' : 'SLACK-OAUTH-FAIL');
process.exit(pass ? 0 : 1);
