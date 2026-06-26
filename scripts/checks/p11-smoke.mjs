/**
 * p11-smoke — production smoke test against a LIVE Atlas instance.
 *
 * Target resolution:
 *   SMOKE_URL=https://atlas.agntic.co   (explicit base URL), or
 *   PROD_HOST=atlas.agntic.co           (→ https://<host>), or
 *   (neither) → http://127.0.0.1:${PORT|3000}   (local dev server)
 *
 * When PROD_HOST is set it also asserts DNS resolves (and, if EXPECTED_IP is set,
 * that it points at that IP — i.e. the VPS). Probes the real public endpoints:
 *   GET /health        → 200 (JSON, status ok)
 *   GET /setup/status  → 200 (JSON; auth/setup subsystem reachable)
 *   GET /              → 200 (HTML; builder UI root)
 *
 * Prints SMOKE-PASS / SMOKE-FAIL. Exits 0 pass, 1 fail, 2 if no target/unreachable.
 *   node scripts/checks/p11-smoke.mjs
 */
import { resolve as dnsResolve } from 'node:dns/promises';

const host    = (process.env.PROD_HOST || '').trim();
const baseUrl = (process.env.SMOKE_URL || (host ? `https://${host}` : `http://127.0.0.1:${process.env.PORT || 3000}`)).replace(/\/$/, '');

let pass = true;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) pass = false; };

// ── DNS (only meaningful when a real host is given) ───────────────────────────
if (host) {
  try {
    const ips = await dnsResolve(host);
    ok(`DNS ${host} resolves`, ips.length > 0, ips.join(', '));
    if (process.env.EXPECTED_IP) ok(`DNS ${host} → expected VPS IP`, ips.includes(process.env.EXPECTED_IP), `expected ${process.env.EXPECTED_IP}`);
  } catch (err) {
    ok(`DNS ${host} resolves`, false, err.message);
  }
}

// ── HTTP probes ───────────────────────────────────────────────────────────────
const probes = [
  { path: '/health',       check: async (r) => r.status === 200 && (await r.json().catch(() => ({})))?.status === 'ok' },
  { path: '/setup/status', check: async (r) => r.status === 200 },
  { path: '/',             check: async (r) => r.status === 200 },
];

for (const p of probes) {
  try {
    const r = await fetch(baseUrl + p.path, { redirect: 'manual' });
    ok(`GET ${p.path} → 200`, await p.check(r), `status ${r.status}`);
  } catch (err) {
    ok(`GET ${p.path}`, false, err.message);
    if (err.code === 'ECONNREFUSED') { console.error(`SMOKE: ${baseUrl} unreachable`); console.log('SMOKE-FAIL'); process.exit(2); }
  }
}

console.log(`target: ${baseUrl}`);
console.log(pass ? 'SMOKE-PASS' : 'SMOKE-FAIL');
process.exit(pass ? 0 : 1);
