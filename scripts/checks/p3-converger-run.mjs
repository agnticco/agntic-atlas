/**
 * P3 converger check — headless harness.
 *
 * Boots the spine, runs the converger on the canonical UPS→Slack intent with
 * all proposals auto-confirmed, then verifies two things:
 *
 *   1. Structural equivalence: emitted spec has the right trigger type, UPS
 *      filter, a summarize node, a delivery-to-Slack node, a connecting edge,
 *      and at least one confirmation per committed step.
 *
 *   2. Runnability: the emitted spec runs through the execution engine
 *      end-to-end (mock UPS email → summarize → stub Slack) and returns a
 *      delivery ts — the same bar Phase 2 proved for the hand-authored spec.
 *
 * "Exact" means structurally equivalent AND provably runnable. Byte-for-byte
 * identity is not required; the converger is non-deterministic by design.
 * (Decision recorded in CLAUDE.md § "The frozen canonical spec".)
 *
 * Prints P3-CONVERGER-PASS or P3-CONVERGER-FAIL:<reason>.
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync }  from 'node:fs';
import { tmpdir }       from 'node:os';
import { join }         from 'node:path';
import { liftV1Node }   from '../../src/workflows/node-types/compat-v1.js';

// ── Hermetic env ──────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'atlas-p3-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
})) process.env[k] = join(tmp, v);

const { bootSpine }    = await import('../../src/api/server.js');
const { runHeadless }  = await import('../../src/converger/index.js');

const spine = await bootSpine();

const frozen = JSON.parse(readFileSync('./docs/specs/canonical-ups-slack.json', 'utf8'));
const intent = 'When a UPS tracking email arrives, summarize it and post to Slack #social';

// ── Step 1: Run converger ─────────────────────────────────────────────────────
let result;
try {
  result = await runHeadless({
    intent,
    capabilities: {
      connectors: {
        slack:  { actions: [{ id: 'post_message', label: 'Post a message to a channel', available: true }] },
        google: { actions: [{ id: 'gmail_search',  label: 'Search Gmail messages',       available: true }] },
      },
    },
    llm:             spine.engine.llm,
    checkpointerDir: join(tmp, 'converger'),
  });
} catch (err) {
  console.log(`P3-CONVERGER-FAIL:${err.message}`);
  process.exit(1);
}

function fail(reason) {
  console.log(`P3-CONVERGER-FAIL:${reason}`);
  process.exit(1);
}

// ── Step 2: Structural equivalence ───────────────────────────────────────────
const { spec, confirmationLog } = result;

if (!spec)                     fail('no spec emitted');
if (!spec.triggers?.length)    fail('emitted spec has no triggers');
if (!spec.nodes?.length)       fail('emitted spec has no nodes');
if (!spec.edges?.length)       fail('emitted spec has no edges');
if (!spec.name?.trim())        fail('emitted spec has no name');

const trigger = spec.triggers[0];
if (trigger?.type !== 'email') fail(`trigger type is "${trigger?.type}", expected "email"`);
if (!/ups/i.test(trigger?.filter ?? '')) fail(`trigger filter "${trigger?.filter}" does not reference UPS`);

// This check used to ask `n.type === 'summarize'`. The P12 Increment A node
// re-cut collapsed the summarize/extract/rewrite node types into `llm` + `mode`,
// so that question became the wrong one: it asks about an ENCODING, and the
// encoding changed. What P3 actually asserts is a ROLE — "the spec summarizes
// the email before delivering it" — and that role now has two spellings: a v1
// `summarize` node (still valid; the compat shim lifts it) and a v2
// `llm` node with `mode: 'summarize'`.
//
// So the check is expressed in terms of the role, via the same lift the
// validator and the executor use. It is not weaker: a spec with NO summarizing
// step still fails, exactly as before. The frozen spec (a v1 spec) still
// satisfies it, and so does anything the v2 converger emits.
const isSummarizer = (n) => {
  const lifted = liftV1Node(n);
  return lifted.type === 'llm' && (lifted.config?.mode ?? 'freeform') === 'summarize';
};

// `tool` / `mcp-tool` were deleted in the re-cut — they were never runnable
// (there is no ToolRegistry in this build), so they could never have been a
// real delivery path. `deliver` is the delivery node.
const DELIVERY     = new Set(['deliver']);
const hasSummarize = spec.nodes.some(isSummarizer);
const hasDeliver   = spec.nodes.some(n => DELIVERY.has(n.type));
if (!hasSummarize) fail('no summarizing step in emitted spec (expected an llm node with mode:"summarize", or a v1 summarize node)');
if (!hasDeliver)   fail('no delivery node in emitted spec');

const deliverNode    = spec.nodes.find(n => n.type === 'deliver');
const deliverChannel = deliverNode?.config?.channel ?? deliverNode?.config?.connector;
if (deliverChannel !== 'slack') fail(`delivery channel is "${deliverChannel}", expected "slack"`);

const summarizeId = spec.nodes.find(isSummarizer)?.id;
const deliverId   = spec.nodes.find(n => DELIVERY.has(n.type))?.id;
const hasEdge     = spec.edges.some(e => e.from === summarizeId && e.to === deliverId);
if (!hasEdge) fail(`no edge from "${summarizeId}" to "${deliverId}"`);

if (!confirmationLog?.length)  fail('confirmation log is empty');
if (confirmationLog.length < 3) fail(`only ${confirmationLog.length} confirmations — expected at least 3`);

// Structural match vs frozen (same roles present)
if (frozen.triggers[0]?.type !== trigger.type)                     fail('trigger type mismatch vs frozen spec');
if (frozen.nodes.some(isSummarizer) && !hasSummarize)              fail('emitted spec missing summarizing step');
if (frozen.nodes.some(n => DELIVERY.has(n.type)) && !hasDeliver)   fail('emitted spec missing delivery node');

// ── Step 3: Runnability — run emitted spec through the engine ─────────────────
// Start an inline stub Slack server so we don't need a real token.
import http from 'node:http';

const STUB_PORT = Number(process.env.P3_STUB_PORT ?? 3994);
const stubServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ts: `${Date.now()}.000200`, channel: 'C001' }));
});
await new Promise(r => stubServer.listen(STUB_PORT, r));

let engineTs = null;
let engineFailed = null;

try {
  const mockEmail = `From: UPS Quantum View <pkginfo@ups.com>
Subject: UPS Package Update: Your package is out for delivery
Date: ${new Date().toUTCString()}

Your UPS package (1Z999AA10123456784) is out for delivery today.
Expected delivery: Today by 8:00 PM. No signature required.`;

  // Normalize tool-type Slack delivery nodes → deliver nodes so the
  // registered Slack channel handler fires correctly in the engine.
  const runnableNodes = spec.nodes.map(n => {
    if (n.type === 'tool' && (n.config?.connector === 'slack' || n.config?.connector === 'SLACK')) {
      return {
        ...n,
        type:   'deliver',
        config: { channel: 'slack', target: n.config?.params?.channel ?? '#social', title: 'UPS Update' },
      };
    }
    return n;
  });

  // Temporarily point Slack at the stub
  const origSlackUrl = process.env.SLACK_API_URL;
  process.env.SLACK_API_URL = `http://127.0.0.1:${STUB_PORT}`;

  for await (const ev of spine.engine.flowTester.run(
    { nodes: runnableNodes, edges: spec.edges },
    { initialContext: mockEmail },
  )) {
    if (ev.type === 'step_completed') {
      const o = typeof ev.output === 'string'
        ? (() => { try { return JSON.parse(ev.output); } catch { return null; } })()
        : ev.output;
      if (o?.ts) engineTs = o.ts;
    }
    if (ev.type === 'run_failed') { engineFailed = ev.error; break; }
  }

  if (origSlackUrl !== undefined) process.env.SLACK_API_URL = origSlackUrl;
  else delete process.env.SLACK_API_URL;
} catch (err) {
  engineFailed = err.message;
} finally {
  stubServer?.close?.();
  try { await spine.engine.llm?.tiers?.balanced?.dispose?.(); } catch { /* ignore */ }
  spine.close();
}

if (engineFailed) fail(`engine run failed: ${engineFailed}`);
if (!engineTs)    fail('engine run did not reach Slack delivery (no ts returned)');

console.log(`P3-CONVERGER-PASS: spec="${spec.name}" trigger=email nodes=[${spec.nodes.map(n=>n.type).join(',')}] confirmations=${confirmationLog.length} engine-ts=${engineTs}`);
process.exit(0);
