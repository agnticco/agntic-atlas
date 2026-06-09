/**
 * P1 check — clicking "run" posts to Slack.
 *
 * Boots the real spine, mounts the HTTP app, and POSTs the hand-authored
 * one-step spec to /workflows/run. The deliver node routes to the Slack channel,
 * which calls chat.postMessage. By default this points at a LOCAL STUB Slack
 * server (reproducible, no secrets) and asserts the request payload + returned ts.
 *
 * For a REAL post: set SLACK_BOT_TOKEN to a real bot token (chat:write), unset
 * SLACK_API_URL (so it hits api.slack.com), and set SLACK_TARGET to a channel the
 * bot is in. The same assertions then validate a genuine workspace post.
 *
 * Prints SLACK-POST-PASS / -FAIL and exits 0/1.
 */
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REAL = !!process.env.SLACK_BOT_TOKEN && !process.env.SLACK_API_URL;
let captured = null;
let stub = null;

if (!REAL) {
  // Local stub Slack: records the payload, returns the Slack-shaped {ok, ts}.
  stub = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.endsWith('/chat.postMessage')) {
      let buf = '';
      req.on('data', (d) => { buf += d; });
      req.on('end', () => {
        try { captured = JSON.parse(buf || '{}'); } catch { captured = { _parseError: buf }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: '1718000000.000100', channel: captured.channel }));
      });
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => stub.listen(0, r));
  process.env.SLACK_API_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? 'xoxb-stub-token';
}

// Hermetic DBs (set before importing the server so its const defaults pick them up).
const tmp = mkdtempSync(join(tmpdir(), 'atlas-p1-'));
process.env.WORKFLOWS_DB = join(tmp, 'workflows.sqlite');
process.env.SOURCES_DB   = join(tmp, 'sources.sqlite');
process.env.VECTOR_DB    = join(tmp, 'vectors.sqlite');

const spec = JSON.parse(readFileSync(resolve('docs/specs/p1-slack-hello.json'), 'utf8'));
if (REAL && process.env.SLACK_TARGET) spec.nodes[0].config.target = process.env.SLACK_TARGET;

const { bootSpine, createApp } = await import('../../src/api/server.js');
const spine = await bootSpine();
const app = createApp(spine);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;

let ok = false;
try {
  // Sanity: the Slack channel is wired and advertises its capability schema.
  const caps = await (await fetch(`http://127.0.0.1:${port}/capabilities`)).json();
  const slack = (caps.channels ?? []).find((c) => c.id === 'slack');
  if (!slack) throw new Error('slack channel not present in /capabilities');
  console.log(`capability: slack [${slack.available ? 'available' : 'not ready'}] config=${slack.configSchema.map((f) => f.key).join(',')}`);

  // Click "run".
  const resp = await fetch(`http://127.0.0.1:${port}/workflows/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec }),
  });
  const out = await resp.json();
  if (!resp.ok) throw new Error(`/workflows/run HTTP ${resp.status}: ${JSON.stringify(out)}`);

  const delivery = (out.deliveries ?? [])[0];
  if (!delivery?.ts) throw new Error(`no Slack delivery ts in response: ${JSON.stringify(out)}`);
  console.log(`run ${out.runId} -> posted to ${delivery.target}, ts=${delivery.ts} (${REAL ? 'REAL Slack' : 'stub'})`);

  if (!REAL) {
    if (captured?.channel !== spec.nodes[0].config.target) throw new Error(`stub got channel="${captured?.channel}", expected "${spec.nodes[0].config.target}"`);
    if (!String(captured?.text ?? '').includes('P1 spine proof')) throw new Error(`stub text mismatch: ${captured?.text}`);
    console.log(`stub received: channel=${captured.channel} text="${String(captured.text).slice(0, 48)}…"`);
  }
  ok = true;
} finally {
  server.close();
  if (stub) stub.close();
  spine.close();
}

console.log(ok ? 'SLACK-POST-PASS' : 'SLACK-POST-FAIL');
process.exit(ok ? 0 : 1);
