/**
 * P2 engine check: inject a mock UPS email as initialContext, run the canonical
 * UPS→Slack spec through the engine, assert a Slack delivery ts is returned.
 * Requires SLACK_API_URL to point at the stub Slack server.
 * Prints P2-ENGINE-PASS:<ts> / P2-ENGINE-FAIL:<reason>.
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'atlas-p2-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
})) process.env[k] = join(tmp, v);
process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? 'xoxb-test';

const { bootSpine } = await import('../../src/api/server.js');
const spine = await bootSpine();

const spec = JSON.parse(readFileSync('./docs/specs/canonical-ups-slack.json', 'utf8'));

const mockEmail = `From: UPS Quantum View <pkginfo@ups.com>
Subject: UPS Package Update: Your package is out for delivery
Date: ${new Date().toUTCString()}

Your UPS package (1Z999AA10123456784) is out for delivery today.
Expected delivery: Today by 8:00 PM. No signature required.`;

let ts = null; let failed = null;
for await (const ev of spine.engine.flowTester.run(
  { nodes: spec.nodes, edges: spec.edges },
  { initialContext: mockEmail }
)) {
  if (ev.type === 'step_completed') {
    const o = typeof ev.output === 'string'
      ? (() => { try { return JSON.parse(ev.output); } catch { return null; } })()
      : ev.output;
    if (o?.ts) ts = o.ts;
  }
  if (ev.type === 'run_failed') { failed = ev.error; break; }
}

try { await spine.rag.embedder.dispose?.(); } catch { /* ignore */ }
try { await spine.engine.llm?.tiers?.balanced?.dispose?.(); } catch { /* ignore */ }
spine.close();

if (failed) { console.log(`P2-ENGINE-FAIL:${failed}`); process.exit(1); }
if (!ts)    { console.log('P2-ENGINE-FAIL:no delivery ts returned'); process.exit(1); }
console.log(`P2-ENGINE-PASS:ts=${ts}`);
process.exit(0);
