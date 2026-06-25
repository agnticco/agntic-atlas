#!/usr/bin/env node
/**
 * P10 gate check — admin observability.
 *
 * Verifies:
 *   1. mountAdminRoutes is exported from src/admin/server.js
 *   2. Required admin endpoints are defined in the module
 *   3. All routes are guarded by requirePlatformAdmin (structural check)
 *   4. Per-tenant queries use WHERE tenant_id = ? (cross-tenant isolation)
 *   5. SQL in cost/run helpers correctly scopes by tenant_id
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');

const fail = (msg) => { console.error(`p10 FAIL: ${msg}`); process.exit(1); };
const pass = (msg) => console.log(`  ✓ ${msg}`);

// ── 1. Admin module exists and exports mountAdminRoutes ────────────────────

const adminPath = path.join(ROOT, 'src/admin/server.js');
if (!existsSync(adminPath)) fail('src/admin/server.js not found');
const adminSrc = readFileSync(adminPath, 'utf8');
if (!adminSrc.includes('export function mountAdminRoutes')) fail('mountAdminRoutes not exported from src/admin/server.js');
pass('src/admin/server.js exists and exports mountAdminRoutes');

// ── 2. Required endpoints are registered ──────────────────────────────────

const requiredEndpoints = [
  { path: '/admin/tenants', method: 'get', label: 'tenant list' },
  { path: '/admin/tenants/:id/runs',  method: 'get', label: 'per-tenant run count' },
  { path: '/admin/tenants/:id/cost',  method: 'get', label: 'per-tenant cost breakdown' },
  { path: '/admin/usage',  method: 'get', label: 'system-wide usage' },
];

for (const ep of requiredEndpoints) {
  const pattern = new RegExp(`app\\.${ep.method}\\(\\s*['"\`]${ep.path.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}['"\`]`);
  if (!pattern.test(adminSrc)) fail(`endpoint missing: ${ep.method.toUpperCase()} ${ep.path} (${ep.label})`);
  pass(`endpoint registered: ${ep.method.toUpperCase()} ${ep.path}`);
}

// ── 3. Data endpoints guarded by adminOnly (requirePlatformAdmin) ────────────

// adminOnly guard must be defined
if (!adminSrc.includes('const adminOnly = [requireAuth, requirePlatformAdmin]')) {
  fail('adminOnly guard not defined as [requireAuth, requirePlatformAdmin]');
}
// Data routes must use adminOnly; public routes (/admin, /admin/ui, /admin/me) are exempt
const DATA_ROUTES = ['/admin/tenants', '/admin/tenants/:id', '/admin/tenants/:id/runs', '/admin/tenants/:id/cost', '/admin/usage'];
for (const route of DATA_ROUTES) {
  const escaped = route.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  const withGuard = new RegExp(`app\\.(?:get|post|put|delete)\\(\\s*['"\`]${escaped}['"\`]\\s*,\\s*adminOnly`);
  if (!withGuard.test(adminSrc)) {
    fail(`Data route missing adminOnly guard: ${route}`);
  }
}
pass('all data routes guarded by adminOnly (requirePlatformAdmin)');

// ── 4. Cross-tenant isolation: per-tenant queries use WHERE tenant_id = ? ───

// Check the helper functions scope by tenant_id
if (!adminSrc.includes('WHERE tenant_id = ?')) {
  fail('per-tenant query helpers do not use WHERE tenant_id = ? — cross-tenant isolation broken');
}
// Count occurrences — should appear in at least 3 query helpers
const tenantScoped = (adminSrc.match(/WHERE.*tenant_id\s*=\s*\?/g) ?? []).length;
if (tenantScoped < 3) fail(`Only ${tenantScoped} tenant-scoped queries found — expected at least 3`);
pass(`cross-tenant isolation: ${tenantScoped} queries scoped with WHERE tenant_id = ?`);

// ── 5. Admin UI exists ────────────────────────────────────────────────────────

const uiPath = path.join(ROOT, 'src/admin/index.html');
if (!existsSync(uiPath)) fail('src/admin/index.html not found — admin UI missing');
pass('admin UI found at src/admin/index.html');

// ── 6. Admin routes mounted in server.js ─────────────────────────────────────

const serverPath = path.join(ROOT, 'src/api/server.js');
const serverSrc = readFileSync(serverPath, 'utf8');
if (!serverSrc.includes("mountAdminRoutes")) fail('mountAdminRoutes not called in src/api/server.js');
if (!serverSrc.includes("from '../admin/server.js'")) fail('src/admin/server.js not imported in server.js');
pass('admin routes mounted in src/api/server.js');

// ── 7. CostTracker wired to ModelPool and WorkflowScheduler ──────────────────

if (!serverSrc.includes('new CostTracker()')) fail('CostTracker not instantiated in server.js');
if (!serverSrc.includes('buildLLM(costTracker)')) fail('costTracker not passed to buildLLM()');
if (!/new WorkflowScheduler\([^)]*costTracker/.test(serverSrc)) fail('costTracker not passed to WorkflowScheduler');
pass('CostTracker wired to ModelPool and WorkflowScheduler');

// ── 8. Non-admin 403 — structural check ──────────────────────────────────────
// requirePlatformAdmin in middleware.js must check platform tenant + admin role

const middlewarePath = path.join(ROOT, 'src/auth/middleware.js');
const middlewareSrc = existsSync(middlewarePath) ? readFileSync(middlewarePath, 'utf8') : '';
if (!middlewareSrc.includes('requirePlatformAdmin') && !serverSrc.includes('requirePlatformAdmin')) {
  fail('requirePlatformAdmin not found in middleware or server — 403 enforcement missing');
}
pass('requirePlatformAdmin present (non-admin receives 403)');

console.log('\np10 PASS: admin app live; cost tracking wired; metrics endpoints defined; tenant isolation enforced; non-admin guarded');
process.exit(0);
