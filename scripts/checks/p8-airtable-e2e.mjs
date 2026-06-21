/**
 * P8 Airtable E2E check: boot the real spine, resolve the stored tenant token,
 * list bases, create a test record in the first available table, read it back,
 * then delete it. Prints AT-PASS / AT-FAIL:<reason>.
 *
 * Requires Airtable to be OAuth-connected for the 'agntic' tenant.
 * Run: node scripts/checks/p8-airtable-e2e.mjs
 */
import { readFileSync } from 'node:fs';

// Use the real databases so the stored Airtable token is accessible.
const envPath = new URL('../../.env', import.meta.url).pathname;
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — rely on already-set env */ }

const TENANT_ID = process.env.TEST_TENANT_ID ?? 'agntic';
const MARKER    = `atlas-p8-e2e-${Date.now()}`;
const API_BASE  = 'https://api.airtable.com/v0';

async function fail(reason, ...extra) {
  if (extra.length) console.error(...extra);
  console.error('AT-FAIL:', reason);
  process.exit(1);
}

const { bootSpine } = await import('../../src/api/server.js');
const spine = await bootSpine();

// ── 1. Resolve the tenant's Airtable token ───────────────────────────────────
const { getAirtableAccessToken } = await import('../../src/connectors/airtable/oauth.js');
const token = await getAirtableAccessToken({
  oauthTokenStore: spine.auth.oauthTokenStore,
  cipher:          spine.auth.tokenCipher,
  tenantId:        TENANT_ID,
}).catch(() => null);

if (!token) fail(`No Airtable token for tenant '${TENANT_ID}' — connect Airtable first`);

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`${method} ${path}: ${err?.error?.message ?? err?.error ?? `HTTP ${res.status}`}`);
  }
  return res.status === 204 ? {} : res.json();
}

// ── 2. List bases ─────────────────────────────────────────────────────────────
let bases;
try {
  const r = await api('GET', '/meta/bases');
  bases = r.bases ?? [];
} catch (err) { await fail('could not list bases', err.message); }

if (!bases.length) await fail('No Airtable bases found — create at least one base to run this check');

const base = bases[0];
console.log(`  using base: ${base.name} (${base.id})`);

// ── 3. List tables in the base ────────────────────────────────────────────────
let tables;
try {
  const r = await api('GET', `/meta/bases/${base.id}/tables`);
  tables = r.tables ?? [];
} catch (err) { await fail('could not list tables', err.message); }

if (!tables.length) await fail(`Base '${base.name}' has no tables`);

const table = tables[0];
console.log(`  using table: ${table.name}`);

// ── 4. Create a test record ───────────────────────────────────────────────────
// Use the first text-ish field available; fall back to Notes if present.
const fields = table.fields ?? [];
const textField = fields.find(f => ['singleLineText', 'multilineText', 'email', 'url', 'richText'].includes(f.type))
               ?? fields[0];

if (!textField) await fail(`Table '${table.name}' has no usable fields`);
console.log(`  writing field: "${textField.name}" (${textField.type})`);

// Use table ID in the URL — table name is not reliably accepted by all bases.
const tableRef = table.id;

// Record API paths are relative to API_BASE (which already includes /v0).
let createdId;
try {
  const r = await api('POST', `/${base.id}/${tableRef}`, {
    fields: { [textField.name]: MARKER },
  });
  createdId = r.id;
  if (!createdId) await fail('create returned no record id', JSON.stringify(r));
} catch (err) { await fail('create_record failed', err.message); }

console.log(`  created record: ${createdId}`);

// ── 5. Read it back ───────────────────────────────────────────────────────────
try {
  const r = await api('GET', `/${base.id}/${tableRef}/${createdId}`);
  const val = r.fields?.[textField.name];
  if (val !== MARKER) await fail(`read-back mismatch: expected "${MARKER}", got "${val}"`);
} catch (err) { await fail('read-back failed', err.message); }

// ── 6. Delete the test record (cleanup) ──────────────────────────────────────
try {
  await api('DELETE', `/${base.id}/${tableRef}/${createdId}`);
  console.log('  deleted test record (cleanup ok)');
} catch (err) {
  console.warn('  cleanup warning: could not delete test record:', err.message);
}

console.log(`AT-PASS: base=${base.name}, table=${table.name}, field="${textField.name}"`);
spine.close?.();
process.exit(0);
