/**
 * A SERVICE NOBODY CAN CONNECT IS NOT CONNECTED.
 *
 * ── What was wrong (2026-08-03, found by the operator looking at the app) ───
 *
 * P13-A shipped six services a customer can connect by pressing one button —
 * Notion, Linear, Sentry, Asana, Stripe, Figma — and Atlas grew a full set of
 * routes to do it. Then nothing in the product ever called them.
 *
 * `public/index.html` contained the string `connectors/mcp` ZERO times. The
 * Connections panel built its list from a hardcoded four (Slack, Google,
 * Airtable, Web) and `connectProvider` refused everything else with a SILENT
 * early return, so even a rendered card would have done nothing and said
 * nothing. The only way to connect Notion was to type
 * `/connectors/mcp/notion/oauth/start` into the address bar — which is further
 * into developer territory than pasting a key, and is the exact errand this
 * whole phase exists to remove.
 *
 * P13's own sign-off names this as HALF the proof: "one button, the service's
 * own consent screen, back to Atlas connected".
 *
 * ── The shape, which is why it is worth a file ───────────────────────────────
 *
 * The server half was complete and correct the whole time. Every defect here is
 * a surface that had to be told about a thing the system already knew — the
 * sixth instance of that in this repo in two days, and the reason the fix is
 * DERIVED (the panel asks the server which services exist) rather than a seventh
 * hand-typed list. A service added to the directory tomorrow appears tomorrow,
 * and the last test asserts exactly that.
 *
 * ── What is proved here, and what is NOT ────────────────────────────────────
 *
 * PROVED, against the real app with a real tenant and a real token store: the
 * list, the disconnect, cross-tenant isolation, and the client rendering (the
 * page's own methods are lifted out and EXECUTED, never copied).
 *
 * NOT proved here: the happy path of `authorize`. It performs live discovery
 * against the third-party service, so exercising it would make this suite
 * depend on Notion being up. Only its refusals are covered. The live connect is
 * proved by driving a browser, and by the P13-A gate step.
 *
 * ── Mutations, run by hand and MEASURED (2026-08-03) ────────────────────────
 *   M1   the panel drops the mcp fetch (back to four connectors)  → 5 red
 *   M2   disconnect keeps the grant                               → 2 red
 *   M3   disconnect answers 200 for an unknown service            → 1 red
 *   M4   disconnect writes to a hardcoded tenant                  → 1 red
 *   M5   a not-connected card claims what the service can do      → 1 red
 *   M6a  connected-but-unreadable collapses into a tool count     → 1 red
 *   M6b  a service that cannot be used is reported healthy        → 1 red
 *   M7   the service id is pasted in whole, not as a path segment → 1 red
 *   M8   the panel NAVIGATES instead of asking (refusal → JSON)   → 3 red
 *   M9   the two connect doors stop sharing one decision          → 2 red
 *
 * M6 was first run as ONE edit that left the page unparseable — 14 tests never
 * ran at all, which reads as a kill and is not one. It was split into the two
 * above and each was re-run against a page that still parses. A mutation that
 * breaks the harness proves nothing.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MCP_DIRECTORY } from '../../src/connectors/mcp-directory.js';
import { mcpOwnerId, mcpConnectorId } from '../../src/connectors/connected-services.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/* ───────────────────────── the real app ───────────────────────────────────── */

let spine, server, base, tmp, tokenA, tokenB;

const api = async (method, p, { token, body } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, data };
};

/** Write a grant directly — the OAuth dance is not what is under test here. */
const grant = (tenantId, serverId) => spine.auth.oauthTokenStore.upsert({
  tenantId, userId: mcpOwnerId(tenantId), connectorId: mcpConnectorId(serverId),
  accessTokenEnc: spine.auth.tokenCipher.encrypt('tok-' + serverId), scope: '', expiry: Date.now() + 3600e3,
  account: 'https://example.test/mcp',
});
const hasGrant = (tenantId, serverId) => !!spine.auth.oauthTokenStore.get({
  tenantId, userId: mcpOwnerId(tenantId), connectorId: mcpConnectorId(serverId),
});

before(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'atlas-mcpconn-'));
  for (const [k, v] of Object.entries({
    WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
    AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
    INTERACTIONS_DB: 'i.sqlite', INBOX_DB: 'inbox.sqlite',
  })) process.env[k] = path.join(tmp, v);
  process.env.DB_BACKUP_KEEP = '0';
  process.env.SCHEDULER_ENABLED = 'false';
  process.env.CONNECTOR_DEMAND_FILE = path.join(tmp, 'connector-demand.json');

  const { bootSpine, createApp } = await import('../../src/api/server.js');
  spine = await bootSpine();
  server = await new Promise((r) => { const s = createApp(spine).listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  const setup = await api('POST', '/setup', { body: { token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'ops-pw-12345' } });
  const admin = setup.data.token;
  await api('POST', '/tenants', { token: admin, body: { name: 'Acme', slug: 'acme', admin: { email: 'a@acme.test', password: 'acme-pw-12345' } } });
  await api('POST', '/tenants', { token: admin, body: { name: 'Beta', slug: 'beta', admin: { email: 'b@beta.test', password: 'beta-pw-12345' } } });
  tokenA = (await api('POST', '/auth/login', { body: { email: 'a@acme.test', password: 'acme-pw-12345' } })).data.token;
  tokenB = (await api('POST', '/auth/login', { body: { email: 'b@beta.test', password: 'beta-pw-12345' } })).data.token;
  assert.ok(tokenA && tokenB, 'both tenant tokens');
});

after(async () => {
  try { server?.close(); } catch { /* ignore */ }
  try { spine?.close(); } catch { /* ignore */ }
  try { await spine?.disposeModels?.(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('the app can be ASKED which services exist', () => {
  test('every directory service is offered, by name, with no address to paste', async () => {
    const r = await api('GET', '/connectors/mcp/servers', { token: tokenA });
    assert.equal(r.status, 200);
    const ids = r.data.servers.map((s) => s.id);
    for (const s of MCP_DIRECTORY) assert.ok(ids.includes(s.id), `${s.id} is not offered`);
    // A URL on this payload is the developer errand coming back in through the
    // list itself — the customer picks a NAME.
    assert.ok(r.data.servers.every((s) => !('url' in s)), 'an address reached the customer');
    assert.ok(r.data.servers.every((s) => typeof s.name === 'string' && s.name));
  });

  test('a service nobody connected is reported as not connected', async () => {
    const r = await api('GET', '/connectors/mcp/servers', { token: tokenB });
    assert.ok(r.data.servers.every((s) => s.connected === false));
  });
});

describe('disconnecting actually disconnects', () => {
  test('the grant is gone, and the service leaves that workspace view', async () => {
    grant('acme', 'notion');
    assert.equal(hasGrant('acme', 'notion'), true, 'fixture did not take');

    const before = await api('GET', '/connectors/mcp/servers', { token: tokenA });
    assert.equal(before.data.servers.find((s) => s.id === 'notion').connected, true);

    const del = await api('DELETE', '/connectors/mcp/notion', { token: tokenA });
    assert.equal(del.status, 200);
    assert.equal(del.data.ok, true);

    assert.equal(hasGrant('acme', 'notion'), false, 'the grant survived a disconnect');
    const after = await api('GET', '/connectors/mcp/servers', { token: tokenA });
    assert.equal(after.data.servers.find((s) => s.id === 'notion').connected, false);
  });

  test('an unknown service is a 404, never a cheerful 200', async () => {
    // "We deleted your connection to a service that does not exist" is the
    // silent-success shape this product exists to prevent.
    const r = await api('DELETE', '/connectors/mcp/definitely-not-a-service', { token: tokenA });
    assert.equal(r.status, 404);
  });

  test('ONE WORKSPACE CANNOT DISCONNECT ANOTHER', async () => {
    grant('acme', 'linear');
    grant('beta', 'linear');

    await api('DELETE', '/connectors/mcp/linear', { token: tokenB });

    assert.equal(hasGrant('beta', 'linear'), false, 'beta kept its own grant');
    assert.equal(hasGrant('acme', 'linear'), true,
      'ONE TENANT DISCONNECTED ANOTHER TENANT — a cross-tenant write');
  });

  test("and cannot SEE another's connection", async () => {
    grant('acme', 'sentry');
    const b = await api('GET', '/connectors/mcp/servers', { token: tokenB });
    assert.equal(b.data.servers.find((s) => s.id === 'sentry').connected, false);
  });
});

describe('the refusals are refusals', () => {
  test('connecting an unknown service is a 404, not a blank screen', async () => {
    const r = await api('GET', '/connectors/mcp/nope/authorize', { token: tokenA });
    assert.equal(r.status, 404);
  });

  test('neither route is reachable without a session', async () => {
    for (const [m, p] of [['GET', '/connectors/mcp/servers'], ['GET', '/connectors/mcp/notion/authorize'], ['DELETE', '/connectors/mcp/notion']]) {
      const r = await api(m, p);
      assert.ok(r.status === 401 || r.status === 403, `${m} ${p} answered ${r.status} with no token`);
    }
  });
});

/* ───────────────────── the panel a person actually sees ───────────────────── */

/** Lift methods out of the page and make them callable, so a copy cannot drift. */
function methods(...names) {
  const grab = (n) => {
    const i = HTML.indexOf(`  ${n}(`);
    assert.ok(i > 0, `${n} is gone from public/index.html — re-point this test`);
    const j = HTML.indexOf('\n  }', i);
    return HTML.slice(i, j + 4);
  };
  // eslint-disable-next-line no-new-func
  return new Function(`return {${names.map(grab).join(',')}}`)();
}

const ui = methods('_loadConnections', 'connectProvider', 'disconnectProvider');

/**
 * Run the page's own loader against a stubbed server and return what it set.
 * `servers` is the payload `/connectors/mcp/servers` answers with.
 */
async function panel(servers) {
  let state = null;
  const self = {
    state: { authToken: 't' },
    setState: (s) => { state = { ...(state || {}), ...s }; },
    _loadRequestable() {},
  };
  const routes = {
    '/connectors/slack/status': { connected: false },
    '/connectors/google/status': { connected: false },
    '/connectors/airtable/status': { connected: false },
    '/connectors/web/status': { connected: false },
    '/connectors/mcp/servers': { servers },
  };
  global.fetch = async (u) => ({ ok: u in routes, json: async () => routes[u] });
  await ui._loadConnections.call(self);
  await new Promise((r) => setImmediate(r));
  return state;
}

const find = (list, name) => (list || []).find((c) => c.name === name);

describe('the six show up where a person looks for them', () => {
  test('A CONNECTED SERVICE IS IN THE CONNECTED LIST, with its real tool count', async () => {
    const s = await panel([{ id: 'notion', name: 'Notion', connected: true, tools: 20 }]);
    const card = find(s.connected, 'Notion');
    assert.ok(card, 'THE DEFECT: a connected service was nowhere in the panel');
    assert.equal(card.provider, 'mcp:notion');
    assert.match(card.meta, /20 tools available/);
  });

  test('one tool is not "1 tools"', async () => {
    const s = await panel([{ id: 'figma', name: 'Figma', connected: true, tools: 1 }]);
    assert.match(find(s.connected, 'Figma').meta, /1 tool available/);
  });

  test('AN UNCONNECTED SERVICE CLAIMS NOTHING ABOUT WHAT IT CAN DO', async () => {
    // The directory is a list of NAMES; the tools are read from the service
    // after connecting. Describing capabilities here would be the product
    // confirming something it has not asked anyone about — the exact family of
    // defect recorded against "I can pull from your Knowledge docs".
    const s = await panel([{ id: 'stripe', name: 'Stripe', connected: false, tools: 0 }]);
    const card = find(s.available, 'Stripe');
    assert.ok(card, 'an unconnected service was not offered at all');
    assert.doesNotMatch(card.meta, /payment|invoice|charge|refund|customer/i,
      'the panel described what Stripe can do without having asked Stripe');
  });

  test('CONNECTED BUT UNREADABLE says so, and says what to do about it', async () => {
    // The state production hit first: token stored, catalog unreadable, zero
    // tools. The interview refuses to build on a service in this state, so a
    // bare green "Connected" here would contradict it one screen away.
    const s = await panel([{ id: 'linear', name: 'Linear', connected: true, tools: 0 }]);
    const card = find(s.connected, 'Linear');
    assert.match(card.meta, /couldn't read its tools/i);
    assert.match(card.meta, /reconnect/i, 'the remedy was not offered');

    const dash = (s.dashConnectors || []).find((d) => d.name === 'Linear');
    assert.equal(dash.connected, false, 'a service that cannot be used was reported healthy');
    assert.ok(dash.warn, 'the health panel said nothing was wrong');
  });

  test('the four hand-built connectors are untouched', async () => {
    const s = await panel([]);
    for (const n of ['Slack', 'Google Workspace', 'Airtable', 'Web']) {
      assert.ok(find(s.connected, n) || find(s.available, n), `${n} vanished`);
    }
  });

  test('THE LIST IS DERIVED — a service added tomorrow appears tomorrow', async () => {
    // The property that makes this a fix and not a seventh hand-typed list.
    const s = await panel([{ id: 'brandnew', name: 'Brand New Service', connected: true, tools: 3 }]);
    assert.ok(find(s.connected, 'Brand New Service'), 'the panel only knows names it was told at build time');
  });

  test('a server that cannot answer costs nothing else on the panel', async () => {
    let state = null;
    const self = { state: { authToken: 't' }, setState: (s) => { state = { ...(state || {}), ...s }; }, _loadRequestable() {} };
    global.fetch = async (u) => ({ ok: !u.includes('/mcp/'), json: async () => ({ connected: false }) });
    await ui._loadConnections.call(self);
    await new Promise((r) => setImmediate(r));
    assert.ok(state, 'the whole panel failed because one service list did');
    assert.ok(find(state.available, 'Slack'), 'the hand-built connectors went with it');
  });
});

describe('pressing Connect', () => {
  /** Drive connectProvider against a stubbed server; report where it went. */
  async function press(provider, name, reply) {
    const calls = [];
    let nav = null, flash = null;
    const self = {
      state: { authToken: 't' },
      setState: (s) => { if (s.connectFlash) flash = s.connectFlash; },
      _readJson: async (r) => ({ ok: r.ok, data: r.data }),
      _loadConnections() { calls.push('reload'); },
      _loadMentions() {},
    };
    global.fetch = async (u) => { calls.push(u); return { ok: reply.ok !== false, data: reply.data }; };
    const origin = { get href() { return nav; }, set href(v) { nav = v; } };
    Object.defineProperty(global, 'window', { value: { get location() { return nav; }, set location(v) { nav = v; } }, configurable: true });
    await ui.connectProvider.call(self, provider, name);
    await new Promise((r) => setImmediate(r));
    void origin;
    return { calls, nav, flash };
  }

  test('it asks the right address — the service id is a PATH SEGMENT', async () => {
    const r = await press('mcp:notion', 'Notion', { data: { authorizeUrl: 'https://mcp.notion.com/authorize?x=1' } });
    assert.ok(r.calls.includes('/connectors/mcp/notion/authorize'),
      `asked ${JSON.stringify(r.calls)} — "mcp:notion" was pasted in whole`);
    assert.equal(r.nav, 'https://mcp.notion.com/authorize?x=1', 'the browser never reached the consent screen');
  });

  test("THE END OF THE IDENTITY CHAIN IS A SENTENCE, and the browser stays put", async () => {
    // A service Atlas cannot identify itself to is refused in words — never
    // degraded into asking this person for a credential, and never rendered as
    // raw JSON on a blank page, which is what a navigation would have done.
    const r = await press('mcp:figma', 'Figma', { ok: false, data: { error: 'Figma cannot be connected yet.', code: 'no_identity_route' } });
    assert.equal(r.nav, null, 'it navigated to a refusal');
    assert.equal(r.flash.ok, false);
    assert.equal(r.flash.text, 'Figma cannot be connected yet.', 'the service own sentence was thrown away');
  });

  test('a refusal with no message still names the service, never the code', async () => {
    const r = await press('mcp:asana', 'Asana', { ok: false, data: {} });
    assert.match(r.flash.text, /Asana/);
    assert.doesNotMatch(r.flash.text, /mcp:|authorize|401|50\d/, 'engineer words reached the panel');
  });

  test('nothing to approve → it refreshes rather than navigating nowhere', async () => {
    const r = await press('mcp:sentry', 'Sentry', { data: { connected: true } });
    assert.equal(r.nav, null);
    assert.equal(r.flash.ok, true);
    assert.ok(r.calls.includes('reload'), 'the panel never re-read its own state');
  });
});

describe('pressing Disconnect', () => {
  test('it deletes the right address', async () => {
    const calls = [];
    const self = {
      state: { authToken: 't' }, setState() {},
      _readJson: async () => ({ ok: true, data: { ok: true } }),
      _loadConnections() {}, _loadMentions() {},
    };
    global.fetch = async (u, o) => { calls.push(o.method + ' ' + u); return { ok: true }; };
    await ui.disconnectProvider.call(self, 'mcp:notion', 'Notion');
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.includes('DELETE /connectors/mcp/notion'), `sent ${JSON.stringify(calls)}`);
  });

  test('the hand-built connectors still use their own address', async () => {
    const calls = [];
    const self = {
      state: { authToken: 't' }, setState() {},
      _readJson: async () => ({ ok: true, data: { ok: true } }),
      _loadConnections() {}, _loadMentions() {},
    };
    global.fetch = async (u, o) => { calls.push(o.method + ' ' + u); return { ok: true }; };
    await ui.disconnectProvider.call(self, 'slack', 'Slack');
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.includes('DELETE /connectors/slack'), `sent ${JSON.stringify(calls)}`);
  });
});

describe('the two doors into connecting share ONE decision (SOURCE-level)', () => {
  // The browser can NAVIGATE to oauth/start or the panel can ASK authorize.
  // They must render the same decision, never re-derive it — a rule written
  // twice is the shape this repo records paying for more than any other. The
  // routes close over `spine`, `mcpFlow` and the registry and cannot be lifted,
  // so this is anchored to the CALL, never to a comment near it.
  const SERVER = readFileSync(path.join(ROOT, 'src/api/server.js'), 'utf8');

  test('both routes call the one decision function', () => {
    const calls = SERVER.match(/await beginMcpConnect\(/g) || [];
    assert.equal(calls.length, 2, 'a connect door stopped sharing the decision');
    assert.match(SERVER, /app\.get\('\/connectors\/mcp\/:server\/authorize'/);
    assert.match(SERVER, /app\.delete\('\/connectors\/mcp\/:server'/);
  });

  test('beginConnect is consulted in exactly one place', () => {
    const direct = SERVER.match(/mcpFlow\.beginConnect\(/g) || [];
    assert.equal(direct.length, 1, 'the identity chain is being started from more than one place');
  });
});
