/**
 * Slack capability-map check.
 *   1. Resolver logic: availability = implemented AND requiredScopes ⊆ granted.
 *   2. Scope auto-detect: parses the x-oauth-scopes header from a stub auth.test.
 *   3. Endpoint: GET /capabilities exposes connectors.slack with per-client flags.
 *
 * Fully offline (local stub). Prints SLACK-CAP-PASS / -FAIL and exits 0/1.
 */
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSlackCapabilities, detectGrantedScopes } from '../../src/connectors/slack/index.js';

let pass = true;
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) pass = false; };

// 1. Pure resolver (no network).
{
  // With all bot-token scopes granted, implemented + scoped actions should be available.
  // set_reminder + search_messages are isReady:false (user token only) → always unavailable.
  const allScopes = ['chat:write','chat:write.public','im:write','reactions:write','reactions:read',
    'files:write','files:read','channels:manage','channels:join','channels:write.invites',
    'channels:write.topic','channels:read','channels:history','pins:write','pins:read',
    'reminders:write','users:read','users:read.email','users.profile:read',
    'search:read.public','mpim:write','usergroups:read','team:read','dnd:read','emoji:read',
    'groups:read','groups:history','im:history','mpim:history'];
  const r = resolveSlackCapabilities(allScopes);
  const botAvailable = r.actions.filter((a) => a.available);
  check('25 actions available with full bot scope grant', botAvailable.length === 25);
  check('set_reminder unavailable (user token only)', r.actions.find((a) => a.id === 'set_reminder')?.available === false);
  check('search_messages unavailable (user token only)', r.actions.find((a) => a.id === 'search_messages')?.available === false);
  check('action count is 34', r.actions.length === 34);
}
{
  const pm = resolveSlackCapabilities([]).actions.find((a) => a.id === 'post_message');
  check('post_message unavailable without scope', pm?.available === false && /missing scope/.test(pm.unavailableReason));
}
{
  // Scope-gating still works: post_dm needs im:write; without it, unavailable.
  const dm = resolveSlackCapabilities(['chat:write']).actions.find((a) => a.id === 'post_dm');
  check('post_dm unavailable without im:write scope', dm?.available === false && /missing scope/.test(dm.unavailableReason));
}

// 2. Scope auto-detect from the x-oauth-scopes header.
{
  const stub = http.createServer((req, res) => {
    if (req.url.endsWith('/auth.test')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': 'chat:write,chat:write.public,reactions:write' });
      res.end(JSON.stringify({ ok: true }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => stub.listen(0, r));
  const scopes = await detectGrantedScopes({ token: 'xoxb-stub', apiBase: `http://127.0.0.1:${stub.address().port}` });
  stub.close();
  check('detectGrantedScopes parses x-oauth-scopes', scopes.length === 3 && scopes.includes('chat:write') && scopes.includes('reactions:write'));
}

// 3. /capabilities end-to-end via the real spine (scopes auto-detected from stub).
{
  const stub = http.createServer((req, res) => {
    if (req.url.endsWith('/auth.test')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': 'chat:write,chat:write.public,im:write,reactions:write,reactions:read,files:write,files:read,channels:manage,channels:join,channels:write.invites,channels:write.topic,channels:read,channels:history,pins:write,pins:read,reminders:write,users:read,users:read.email,users.profile:read,search:read.public,mpim:write,usergroups:read,team:read,dnd:read,emoji:read,groups:read' });
      res.end(JSON.stringify({ ok: true }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => stub.listen(0, r));
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-slackcap-'));
  for (const [k, v] of Object.entries({
    WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
    AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
  })) process.env[k] = join(tmp, v);
  process.env.SLACK_API_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.SLACK_BOT_TOKEN = 'xoxb-stub';

  const { bootSpine, createApp } = await import('../../src/api/server.js');
  const spine = await bootSpine();
  const app = createApp(spine);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  // /capabilities is per-tenant + auth-gated. Bootstrap a platform admin and call
  // it with that token; the platform tenant has no Slack grant, so scopes fall
  // back to the dev env token's scopes (auth.test stub) — proving the env path.
  const setup = await (await fetch(`http://127.0.0.1:${port}/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'platform-pw-1' }) })).json();
  const caps = await (await fetch(`http://127.0.0.1:${port}/capabilities`, { headers: { authorization: `Bearer ${setup.token}` } })).json();
  server.close(); stub.close(); spine.close();

  const slack = caps.connectors?.slack;
  const pm = slack?.actions?.find((a) => a.id === 'post_message');
  const dm = slack?.actions?.find((a) => a.id === 'post_dm');
  check('/capabilities exposes connectors.slack', !!slack);
  check('grantedScopes auto-detected via endpoint', !!slack?.grantedScopes?.includes('chat:write'));
  check('post_message available over endpoint', pm?.available === true);
  const botAvail = (caps.connectors?.slack?.actions ?? []).filter((a) => a.available);
  check('25 actions available over endpoint (excl user-token-only)', botAvail.length === 25);
  console.log(`  menu: ${slack?.actions?.map((a) => `${a.id}${a.available ? '✓' : '✗'}`).join(' ')}`);
}

console.log(pass ? 'SLACK-CAP-PASS' : 'SLACK-CAP-FAIL');
process.exit(pass ? 0 : 1);
