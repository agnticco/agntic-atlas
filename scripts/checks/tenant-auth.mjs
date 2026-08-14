/**
 * Tenant-aware auth/vault check (store level, no HTTP, no model).
 * Platform bootstrap, JWT tid claim, fail-closed list, vault isolation,
 * middleware tenant resolution. Prints TENANT-AUTH-PASS / -FAIL.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthSubsystem } from '../../src/auth/index.js';

const t = mkdtempSync(join(tmpdir(), 'atlas-tenauth-'));
const auth = await createAuthSubsystem({
  dbPath: join(t, 'auth.sqlite'), secretPath: join(t, '.jwt'),
  oauthDbPath: join(t, 'oauth.sqlite'), oauthKeyPath: join(t, '.okey'),
});

let pass = true;
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) pass = false; };

const platformAdmin = await auth.completeBootstrap({ token: auth.bootstrap.token, email: 'ops@atlas.dev', password: 'fixture-not-a-secret-platform-b' });
ok('platform admin in platform tenant', platformAdmin.tenant_id === 'platform' && platformAdmin.role === 'admin');

const { token } = auth.issueSession({ user: platformAdmin });
ok('token carries tid=platform', auth.tokenService.verify(token)?.tid === 'platform');

const t1 = auth.tenantStore.create({ name: 'Acme', slug: 'acme' });
const t2 = auth.tenantStore.create({ name: 'Globex', slug: 'globex' });
const u1 = await auth.authProvider.register({ tenantId: t1.id, email: 'a@acme.test', password: 'fixture-not-a-secret-acme-c' });
await auth.authProvider.register({ tenantId: t2.id, email: 'b@globex.test', password: 'fixture-not-a-secret-globex-b' });
ok('user created under tenant', u1.tenant_id === 'acme');

const acmeUsers = auth.userStore.list('acme');
ok('list(acme) only acme', acmeUsers.length === 1 && acmeUsers[0].email === 'a@acme.test');
let threw = false; try { auth.userStore.list(); } catch { threw = true; }
ok('unscoped list() THROWS (fail-closed)', threw);

auth.oauthTokenStore.upsert({ tenantId: 'acme', userId: u1.id, connectorId: 'slack', accessTokenEnc: 'ct' });
ok('vault get in-tenant resolves', !!auth.oauthTokenStore.get({ tenantId: 'acme', userId: u1.id, connectorId: 'slack' }));
ok('vault get cross-tenant returns null', auth.oauthTokenStore.get({ tenantId: 'globex', userId: u1.id, connectorId: 'slack' }) === null);
let vThrew = false; try { auth.oauthTokenStore.get({ userId: u1.id, connectorId: 'slack' }); } catch { vThrew = true; }
ok('vault get without tenant THROWS', vThrew);

const { token: u1Token } = auth.issueSession({ user: u1 });
const ctx = await auth.middleware.authenticate({ headers: { authorization: `Bearer ${u1Token}` }, cookies: {} });
ok('middleware resolves req.tenant', ctx?.tenant?.id === 'acme' && ctx?.user?.id === u1.id);

auth.close();
console.log(pass ? 'TENANT-AUTH-PASS' : 'TENANT-AUTH-FAIL');
process.exit(pass ? 0 : 1);
