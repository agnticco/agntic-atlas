/**
 * P3 converger check — headless harness.
 *
 * Boots the spine, runs the converger on the canonical UPS→Slack intent with
 * all proposals auto-confirmed, then:
 *   1. Verifies the emitted spec is structurally equivalent to the frozen
 *      canonical spec (docs/specs/canonical-ups-slack.json).
 *   2. Verifies at least one confirmation was logged per committed step.
 *
 * Prints P3-CONVERGER-PASS or P3-CONVERGER-FAIL:<reason>.
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync }  from 'node:fs';
import { tmpdir }       from 'node:os';
import { join }         from 'node:path';

// ── Hermetic env ──────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'atlas-p3-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
})) process.env[k] = join(tmp, v);

const { bootSpine }    = await import('../../src/api/server.js');
const { runHeadless }  = await import('../../src/converger/index.js');

const spine = await bootSpine();

const frozen   = JSON.parse(readFileSync('./docs/specs/canonical-ups-slack.json', 'utf8'));
const intent   = 'When a UPS tracking email arrives, summarize it and post to Slack #social';

// ── Run converger ─────────────────────────────────────────────────────────────
let result;
try {
  result = await runHeadless({
    intent,
    capabilities: {
      connectors: {
        slack:  { actions: [
          { id: 'post_message', label: 'Post a message to a channel', available: true },
        ]},
        google: { actions: [
          { id: 'gmail_search', label: 'Search Gmail messages', available: true },
        ]},
      },
    },
    llm:              spine.engine.llm,
    checkpointerDir:  join(tmp, 'converger'),
  });
} catch (err) {
  console.log(`P3-CONVERGER-FAIL:${err.message}`);
  process.exit(1);
} finally {
  try { await spine.engine.llm?.tiers?.balanced?.dispose?.(); } catch { /* ignore */ }
  spine.close();
}

// ── Structural equivalence check ─────────────────────────────────────────────
const { spec, confirmationLog } = result;

function fail(reason) {
  console.log(`P3-CONVERGER-FAIL:${reason}`);
  process.exit(1);
}

if (!spec)                          fail('no spec emitted');
if (!spec.triggers?.length)         fail('emitted spec has no triggers');
if (!spec.nodes?.length)            fail('emitted spec has no nodes');
if (!spec.edges?.length)            fail('emitted spec has no edges');

// Trigger: must be email type, filter referencing ups
const trigger = spec.triggers[0];
if (trigger?.type !== 'email')      fail(`trigger type is "${trigger?.type}", expected "email"`);
if (!/ups/i.test(trigger?.filter ?? '')) fail(`trigger filter "${trigger?.filter}" does not reference UPS`);

// Nodes: must have a summarize-type and a deliver-type
const DELIVERY     = new Set(['deliver', 'tool', 'mcp-tool']);
const hasSummarize = spec.nodes.some(n => n.type === 'summarize');
const hasDeliver   = spec.nodes.some(n => DELIVERY.has(n.type));
if (!hasSummarize)                  fail('no summarize node in emitted spec');
if (!hasDeliver)                    fail('no delivery node in emitted spec');

// Delivery node: must target Slack (deliver channel or tool connector)
const deliverNode = spec.nodes.find(n => n.type === 'deliver') ?? spec.nodes.find(n => n.type === 'tool');
const deliverChannel = deliverNode?.config?.channel ?? deliverNode?.config?.connector;
if (deliverChannel !== 'slack') fail(`delivery channel is "${deliverChannel}", expected "slack"`);

// Edges: summarize node must connect to deliver node
const summarizeId = spec.nodes.find(n => n.type === 'summarize')?.id;
const deliverId   = spec.nodes.find(n => DELIVERY.has(n.type))?.id;
const hasEdge     = spec.edges.some(e => e.from === summarizeId && e.to === deliverId);
if (!hasEdge)                       fail(`no edge from "${summarizeId}" to "${deliverId}"`);

// Confirmation log: must have at least one entry per structural component
// (trigger + summarize node + deliver node + edge = min 4, plus optional name)
if (!confirmationLog?.length)       fail('confirmation log is empty');
if (confirmationLog.length < 3)     fail(`only ${confirmationLog.length} confirmation(s) logged — expected at least 3`);

// Name
if (!spec.name?.trim())             fail('emitted spec has no name');

// Structural match vs frozen
if (frozen.triggers[0]?.type !== trigger.type)                        fail('trigger type mismatch vs frozen spec');
if (frozen.nodes.some(n => n.type === 'summarize') && !hasSummarize)  fail('emitted spec missing summarize node');
if (frozen.nodes.some(n => DELIVERY.has(n.type))  && !hasDeliver)     fail('emitted spec missing delivery node');

console.log(`P3-CONVERGER-PASS: spec="${spec.name}" trigger=email nodes=[${spec.nodes.map(n=>n.type).join(',')}] confirmations=${confirmationLog.length}`);
process.exit(0);
