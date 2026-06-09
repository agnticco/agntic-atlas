/**
 * Workflow-store tenant scoping check (no HTTP, no model).
 * Two-tenant create/list/get isolation + run/version tenant inheritance.
 * Prints WF-TENANT-PASS / -FAIL.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowStore } from '../../src/workflows/workflow-store.js';

const store = new WorkflowStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'atlas-wf-')), 'wf.sqlite') });
await store.init();

let pass = true;
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) pass = false; };

const a = store.create({ tenantId: 'acme', userId: 'u-a', name: 'Acme flow', slug: 'flow-a', nodes: [{ id: 'x', type: 'deliver', config: {} }] });
const b = store.create({ tenantId: 'globex', userId: 'u-b', name: 'Globex flow', slug: 'flow-b', nodes: [{ id: 'y', type: 'deliver', config: {} }] });

ok('workflow carries tenant_id', a.tenant_id === 'acme' && b.tenant_id === 'globex');
ok('list(tenant=acme) returns only acme', store.list({ tenantId: 'acme' }).length === 1 && store.list({ tenantId: 'acme' })[0].tenant_id === 'acme');
ok('get cross-tenant returns null', store.get(b.id, { tenantId: 'acme' }) === null);
ok('get in-tenant resolves', store.get(a.id, { tenantId: 'acme' })?.id === a.id);

const run = store.startRun(a.id, { isTest: true });
ok('run inherits workflow tenant_id', store.db.prepare('SELECT tenant_id FROM workflow_runs WHERE id = ?').get(run.id)?.tenant_id === 'acme');
ok('version inherits workflow tenant_id', store.db.prepare('SELECT tenant_id FROM workflow_versions WHERE workflow_id = ?').get(a.id)?.tenant_id === 'acme');

console.log(pass ? 'WF-TENANT-PASS' : 'WF-TENANT-FAIL');
process.exit(pass ? 0 : 1);
