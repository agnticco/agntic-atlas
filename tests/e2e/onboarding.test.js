/**
 * Onboarding suite (#8) — admin-provisioned workspaces.
 *
 * Boots the real spine, creates the platform admin via /setup, then exercises
 * POST /admin/tenants: create a tenant with a plan + first admin, issue a 7-day
 * invite token. Offline (no mailer configured → invite link returned in the
 * response), deterministic.
 *
 *   node --test tests/e2e/onboarding.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let spine, server, base, tmp, platformToken;

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, data };
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'atlas-onb-'));
  for (const [k, v] of Object.entries({
    WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
    AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
    INTERACTIONS_DB: 'i.sqlite', INBOX_DB: 'inbox.sqlite',
  })) process.env[k] = join(tmp, v);
  process.env.DB_BACKUP_KEEP = '0';
  process.env.SCHEDULER_ENABLED = 'false';
  // This suite is ABOUT the hosted product's plan machinery — seat caps, PLAN_LIMIT
  // refusals, per-plan entitlements. Atlas defaults to SELF-HOSTED, where every one
  // of those limits is off by design, so without this line the seat-limit tests
  // would assert against a program nobody runs and pass vacuously.
  process.env.ATLAS_SELF_HOSTED = 'false';

  const { bootSpine, createApp } = await import('../../src/api/server.js');
  spine = await bootSpine();
  const app = createApp(spine);
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  const setup = await api('POST', '/setup', { body: { token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'ops-pw-12345' } });
  platformToken = setup.data.token;
  assert.ok(platformToken, 'platform admin token');
});

after(async () => {
  try { server?.close(); } catch { /* ignore */ }
  try { spine?.close(); } catch { /* ignore */ }
  try { await spine?.disposeModels?.(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('create workspace: requires platform admin', async () => {
  const r = await api('POST', '/admin/tenants', { body: { name: 'Nope', admin: { email: 'x@y.test' } } });
  assert.equal(r.status, 401, 'unauthenticated is rejected');
});

test('create workspace: provisions tenant + plan + invite token', async () => {
  const r = await api('POST', '/admin/tenants', { token: platformToken, body: { name: 'Acme Operations', plan: 'team', admin: { email: 'boss@acme.test' } } });
  assert.equal(r.status, 200, `200 (got ${r.status}: ${JSON.stringify(r.data)})`);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.tenant.plan, 'team', 'plan stored');
  assert.equal(r.data.tenant.slug, 'acme-operations', 'slug derived from name');
  assert.equal(r.data.tenant.status, 'active');
  assert.equal(r.data.admin.email, 'boss@acme.test');
  // No mailer in test → invite not delivered, link handed back instead.
  assert.equal(r.data.invited, false, 'mailer unconfigured → not delivered');
  assert.ok(typeof r.data.inviteLink === 'string' && r.data.inviteLink.includes('/?reset='), 'invite link returned');

  // The invite token is a real, valid reset token.
  const token = new URL(r.data.inviteLink).searchParams.get('reset');
  const verify = await api('POST', '/auth/reset/verify', { body: { token } });
  assert.equal(verify.status, 200);
  assert.equal(verify.data.valid, true, 'invite token validates via the reset flow');
});

test('create workspace: shows up in the tenant roster with its plan', async () => {
  const r = await api('GET', '/admin/tenants', { token: platformToken });
  assert.equal(r.status, 200);
  const acme = (r.data.tenants || []).find((t) => t.id === 'acme-operations');
  assert.ok(acme, 'new tenant listed');
  assert.equal(acme.plan, 'team', 'roster carries the plan');
});

test('create workspace: validates input + dedupes slugs', async () => {
  const noEmail = await api('POST', '/admin/tenants', { token: platformToken, body: { name: 'No Email Co' } });
  assert.equal(noEmail.status, 400, 'missing admin email → 400');

  const badPlan = await api('POST', '/admin/tenants', { token: platformToken, body: { name: 'Bad Plan Co', plan: 'wizard', admin: { email: 'a@bad.test' } } });
  assert.equal(badPlan.data.tenant.plan, 'solo', 'unknown plan falls back to the entry tier');

  // Same name again → slug is deduped, not a crash.
  const dupe = await api('POST', '/admin/tenants', { token: platformToken, body: { name: 'Acme Operations', plan: 'solo', admin: { email: 'boss2@acme.test' } } });
  assert.equal(dupe.status, 200);
  assert.equal(dupe.data.tenant.slug, 'acme-operations-2', 'duplicate name → -2 slug');
});

test('lifecycle: suspend / reactivate / archive / restore', async () => {
  const c = await api('POST', '/admin/tenants', { token: platformToken, body: { name: 'Lifecycle Co', plan: 'solo', admin: { email: 'lc@lifecycle.test' } } });
  const id = c.data.tenant.id;

  let r = await api('POST', `/admin/tenants/${id}/suspend`, { token: platformToken });
  assert.equal(r.status, 200); assert.equal(r.data.tenant.status, 'suspended', 'suspended');

  r = await api('POST', `/admin/tenants/${id}/activate`, { token: platformToken });
  assert.equal(r.data.tenant.status, 'active', 'reactivated');

  r = await api('POST', `/admin/tenants/${id}/archive`, { token: platformToken });
  assert.equal(r.status, 200); assert.ok(r.data.tenant.archived_at, 'archived_at set');

  r = await api('POST', `/admin/tenants/${id}/restore`, { token: platformToken });
  assert.equal(r.data.tenant.archived_at, null, 'restored'); assert.equal(r.data.tenant.status, 'active');
});

test('lifecycle: auth required + platform tenant protected', async () => {
  assert.equal((await api('POST', '/admin/tenants/x/suspend', {})).status, 401, 'unauth rejected');
  assert.equal((await api('POST', '/admin/tenants/platform/suspend', { token: platformToken })).status, 400, 'platform not suspendable');
  assert.equal((await api('POST', '/admin/tenants/platform/archive', { token: platformToken })).status, 400, 'platform not archivable');
});

test('pending status: true until the admin actually signs in', async () => {
  const c = await api('POST', '/admin/tenants', { token: platformToken, body: { name: 'Pending Co', plan: 'solo', admin: { email: 'newadmin@pending.test' } } });
  const id = c.data.tenant.id;
  const token = new URL(c.data.inviteLink).searchParams.get('reset');

  // Freshly created, nobody has signed in → pending.
  let roster = (await api('GET', '/admin/tenants', { token: platformToken })).data.tenants;
  assert.equal(roster.find((t) => t.id === id).pending, true, 'new workspace is pending');

  // Admin sets their password via the invite link, then signs in.
  const setPw = await api('POST', '/auth/reset', { body: { token, password: 'set-Pass-word-12345' } });
  assert.equal(setPw.status, 200, 'password set via invite token');
  const login = await api('POST', '/auth/login', { body: { email: 'newadmin@pending.test', password: 'set-Pass-word-12345' } });
  assert.ok(login.data.token, 'admin signs in');

  // No longer pending.
  roster = (await api('GET', '/admin/tenants', { token: platformToken })).data.tenants;
  assert.equal(roster.find((t) => t.id === id).pending, false, 'signed-in workspace is no longer pending');
});

// Helper: create a workspace on a plan and return a signed-in admin token.
async function makeAdmin(name, plan, email) {
  const c = await api('POST', '/admin/tenants', { token: platformToken, body: { name, plan, admin: { email } } });
  const token = new URL(c.data.inviteLink).searchParams.get('reset');
  await api('POST', '/auth/reset', { body: { token, password: 'a-Strong-Pass-12345' } });
  return (await api('POST', '/auth/login', { body: { email, password: 'a-Strong-Pass-12345' } })).data.token;
}

test('team: admin invites a teammate (same invite flow), within the team seat allowance', async () => {
  const adminToken = await makeAdmin('Teamco', 'team', 'lead@teamco.test');

  let team = (await api('GET', '/api/builder/team', { token: adminToken })).data;
  assert.equal(team.members.length, 1);
  assert.equal(team.isAdmin, true);
  assert.equal(team.plan, 'team');
  // Team is 5 seats, not unlimited. This asserted `null` (unlimited) from the
  // pre-2026-07-09 ladder and had been failing at baseline ever since.
  assert.equal(team.seats.limit, 5, 'team = 5 seats');

  const inv = await api('POST', '/api/builder/team/invite', { token: adminToken, body: { email: 'mate@teamco.test' } });
  assert.equal(inv.status, 200, `invite ok (got ${inv.status}: ${JSON.stringify(inv.data)})`);
  assert.equal(inv.data.member.pending, true);
  assert.ok(inv.data.inviteLink && inv.data.inviteLink.includes('/?reset='), 'invite link handed back (no mailer in test)');

  team = (await api('GET', '/api/builder/team', { token: adminToken })).data;
  assert.equal(team.members.length, 2);
  assert.equal(team.members.find((m) => m.email === 'mate@teamco.test').pending, true, 'teammate is pending until sign-in');
});

test('team: solo seat limit enforced; auth required', async () => {
  const adminToken = await makeAdmin('Solo', 'solo', 'solo@solo.test');
  const team = (await api('GET', '/api/builder/team', { token: adminToken })).data;
  assert.equal(team.seats.limit, 1, 'solo = 1 seat');

  const blocked = await api('POST', '/api/builder/team/invite', { token: adminToken, body: { email: 'extra@solo.test' } });
  assert.equal(blocked.status, 402, 'over seat limit → 402');
  assert.equal(blocked.data.code, 'PLAN_LIMIT');

  assert.equal((await api('GET', '/api/builder/team', {})).status, 401, 'team list requires auth');
});
