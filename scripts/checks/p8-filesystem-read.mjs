/**
 * P8 filesystem check: run a workflow with a filesystem_read node against a
 * temp file within an approved folder. Assert the file content appears in output.
 * Prints P8-FS-PASS / P8-FS-FAIL:<reason>.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir }                                 from 'node:os';
import { join }                                   from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'atlas-p8-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
  INBOX_DB: 'inbox.sqlite',
})) process.env[k] = join(tmp, v);

// Create an approved folder with a test file.
const approvedDir  = join(tmp, 'project-folder');
const testFilePath = join(approvedDir, 'README.md');
mkdirSync(approvedDir, { recursive: true });
writeFileSync(testFilePath, '# Test Project\nThis is the P8 filesystem gate fixture.\n', 'utf8');

// Seed sources.json so the filesystem connector approves this folder.
const tenantId   = 'test-tenant';
const vectorsDir = join(tmp, 'vectors', tenantId);
mkdirSync(vectorsDir, { recursive: true });
writeFileSync(
  join(vectorsDir, 'sources.json'),
  JSON.stringify([{ path: approvedDir, addedAt: Date.now(), files: 1, chunks: 1 }]),
);

const { bootSpine } = await import('../../src/api/server.js');
const spine = await bootSpine();

// Minimal workflow: trigger → filesystem_read → deliver (inline, no real delivery)
const spec = {
  slug: 'p8-fs-gate',
  name: 'P8 filesystem gate',
  triggers: [{ type: 'manual' }],
  nodes: [
    {
      id: 'read1',
      type: 'connector-action',
      config: { action: 'filesystem_read', path: testFilePath, _tenantId: tenantId },
    },
  ],
  edges: [],
};

try {
  let output = null;
  for await (const ev of spine.engine.flowTester.run(spec, {})) {
    if (ev.type === 'step_completed' && ev.nodeId === 'read1') {
      output = typeof ev.output === 'string' ? JSON.parse(ev.output) : ev.output;
    }
    if (ev.type === 'run_failed') { console.error('P8-FS-FAIL:', ev.error); process.exit(1); }
  }
  if (!output?.content?.includes('P8 filesystem gate fixture')) {
    console.error('P8-FS-FAIL: output did not contain expected file content');
    console.error('output:', JSON.stringify(output));
    process.exit(1);
  }
  console.log('P8-FS-PASS:', testFilePath);
  process.exit(0);
} catch (err) {
  console.error('P8-FS-FAIL:', err.message);
  process.exit(1);
} finally {
  spine.close?.();
}
