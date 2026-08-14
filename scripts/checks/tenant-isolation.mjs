/**
 * Adversarial cross-tenant isolation check — HTTP level, no model needed.
 *
 * Drives the real spine over HTTP: platform setup -> create two tenants ->
 * log in each tenant's admin -> attempt cross-tenant access. Proves a tenant
 * cannot see another tenant's users, cannot use platform-only endpoints, that a
 * token is bound to its tenant, and that suspending a tenant locks it out.
 *
 * Prints TENANT-ISOLATION-PASS / -FAIL and exits 0/1.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const t = mkdtempSync(join(tmpdir(), 'atlas-teniso-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
})) process.env[k] = join(t, v);

const { bootSpine, createApp } = await import('../../src/api/server.js');
const spine = await bootSpine();
const app = createApp(spine);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let pass = true;
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) pass = false; };
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
};

try {
  // Platform setup using the one-time bootstrap token.
  const setup = await api('POST', '/setup', { body: { token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'fixture-not-a-secret-platform' } });
  ok('platform setup issues a token', setup.status === 200 && !!setup.json?.token);
  const platformToken = setup.json.token;

  // Platform creates two tenants, each with a first admin.
  const c1 = await api('POST', '/tenants', { token: platformToken, body: { name: 'Acme', slug: 'acme', admin: { email: 'a@acme.test', password: 'fixture-not-a-secret-acme-b' } } });
  const c2 = await api('POST', '/tenants', { token: platformToken, body: { name: 'Globex', slug: 'globex', admin: { email: 'b@globex.test', password: 'fixture-not-a-secret-globex-b' } } });
  ok('platform created two tenants', c1.status === 200 && c2.status === 200);

  // Tenant admins log in.
  const la = await api('POST', '/auth/login', { body: { email: 'a@acme.test', password: 'fixture-not-a-secret-acme-b' } });
  const lb = await api('POST', '/auth/login', { body: { email: 'b@globex.test', password: 'fixture-not-a-secret-globex-b' } });
  ok('tenant admins log in', la.status === 200 && lb.status === 200);
  const tokenA = la.json.token, tokenB = lb.json.token;
  ok('login returns tenant-scoped user', la.json.user?.tenant_id === 'acme' && lb.json.user?.tenant_id === 'globex');

  // Attack 1: a tenant admin cannot use platform-only endpoints.
  const aTenants = await api('GET', '/tenants', { token: tokenA });
  ok('tenant admin BLOCKED from /tenants (platform-only)', aTenants.status === 403);

  // Attack 2: a tenant admin only ever sees their OWN tenant's users.
  const aUsers = await api('GET', '/users', { token: tokenA });
  const bUsers = await api('GET', '/users', { token: tokenB });
  const aEmails = (aUsers.json?.users ?? []).map((u) => u.email);
  ok('acme admin sees only acme users', aUsers.status === 200 && aEmails.includes('a@acme.test') && !aEmails.some((e) => e.includes('globex')));
  ok('globex admin sees only globex users', bUsers.status === 200 && (bUsers.json.users ?? []).every((u) => u.tenant_id === 'globex'));

  // Attack 3: a globex user cannot be authenticated into acme (email is global; user is single-tenant).
  const dup = await api('POST', '/tenants/acme/users', { token: platformToken, body: { email: 'b@globex.test', password: 'fixture-not-a-secret-x' } });
  ok('cannot re-create a globex user inside acme (no cross-tenant identity)', dup.status === 400);

  // Attack 4: suspend acme → its admin is locked out everywhere.
  const susp = await api('POST', '/tenants/acme/status', { token: platformToken, body: { status: 'suspended' } });
  ok('platform can suspend a tenant', susp.status === 200 && susp.json?.tenant?.status === 'suspended');
  const aAfter = await api('GET', '/users', { token: tokenA });
  ok('suspended-tenant token is locked out (403)', aAfter.status === 403);
  const reLogin = await api('POST', '/auth/login', { body: { email: 'a@acme.test', password: 'fixture-not-a-secret-acme-b' } });
  ok('suspended-tenant login is refused (403)', reLogin.status === 403);
  // globex unaffected.
  const bAfter = await api('GET', '/users', { token: tokenB });
  ok('other tenant unaffected by the suspension', bAfter.status === 200);
} finally {
  server.close();
  spine.close();
}

console.log(pass ? 'TENANT-ISOLATION-PASS' : 'TENANT-ISOLATION-FAIL');
process.exit(pass ? 0 : 1);
