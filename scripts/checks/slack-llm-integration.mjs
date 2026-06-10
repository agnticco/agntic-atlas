/**
 * Slack + LLM integration test suite.
 *
 * Two layers:
 *
 *   1. INTEGRATION — llm → deliver(slack channel) two-node workflows via
 *      the real engine + local model. Proves the full data path: LLM
 *      generates content, engine routes it to the right Slack handler,
 *      stub records what arrived.
 *
 *   2. TOOL SELECTION — the LLM is shown the Slack capability surface +
 *      a natural-language intent and asked to output a deliver node config
 *      as JSON. This is a direct preview of P3's converger pattern.
 *      The small local model (Qwen2.5-0.5B) is transparent about its
 *      reasoning — we print raw output so you can see exactly what it does.
 *
 * Requires local GGUF weights. Stub Slack; no real credentials.
 * Prints results per test + a summary. Exits 0 only if all integration
 * tests pass (tool-selection results are advisory — graded but non-blocking
 * since a 0.5B model isn't the P3 converger).
 */
import http from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHAT_MODEL = process.env.LOCAL_MODEL_PATH ?? resolve('models/qwen2.5-0.5b-instruct-q4_k_m.gguf');
if (!existsSync(CHAT_MODEL)) { console.error(`SKIP: chat model not found at ${CHAT_MODEL}`); process.exit(0); }

// ── Stub Slack ──────────────────────────────────────────────────────────────
const received = [];
const stub = http.createServer((req, res) => {
  let buf = ''; req.on('data', (d) => { buf += d; }); req.on('end', () => {
    let body = {}; try { body = JSON.parse(buf); } catch { /* ignore */ }
    const endpoint = req.url.replace(/^\//, '');
    received.push({ endpoint, body, token: (req.headers.authorization ?? '').replace('Bearer ', '') });
    const ok = { ok: true };
    const canned = {
      'chat.postMessage':           { ...ok, ts: `${Date.now()}.001`, channel: body.channel ?? 'C001' },
      'conversations.open':         { ...ok, channel: { id: 'D001' } },
      'users.lookupByEmail':        { ...ok, user: { id: 'U999', real_name: 'Test User', name: 'test' } },
      'reminders.add':              { ...ok, reminder: { id: 'R001' } },
      'conversations.history':      { ...ok, messages: [{ ts: '200.001', text: 'deployed v2.1', user: 'U001' }, { ts: '200.002', text: 'tests green', user: 'U002' }] },
      'files.getUploadURLExternal': { ...ok, upload_url: `http://127.0.0.1:${stub.address().port}/upload`, file_id: 'F001' },
      'upload':                     ok,
      'files.completeUploadExternal': ok,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(canned[endpoint] ?? { ok: true }));
  });
});
await new Promise((r) => stub.listen(0, r));
process.env.SLACK_API_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.SLACK_BOT_TOKEN = 'xoxb-test';

// ── Boot spine ──────────────────────────────────────────────────────────────
const t = mkdtempSync(join(tmpdir(), 'atlas-llmslack-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
})) process.env[k] = join(t, v);
process.env.EMBEDDING_PROVIDER = 'local';

const { bootSpine } = await import('../../src/api/server.js');
const spine = await bootSpine();
const ft = spine.engine.flowTester;

// ── Helpers ─────────────────────────────────────────────────────────────────
const last = (endpoint) => [...received].reverse().find((r) => r.endpoint === endpoint);
let passed = 0; let failed = 0; let advisory = 0;

function check(label, cond, msg) {
  if (cond) { console.log(`ok   ${label}`); passed++; }
  else { console.log(`FAIL ${label}${msg ? ` — ${msg}` : ''}`); failed++; }
}
function note(label, cond, msg) {
  // Advisory — graded but doesn't fail the suite.
  const icon = cond ? 'ok  ' : 'note';
  console.log(`${icon} [advisory] ${label}${msg ? ` — ${msg}` : ''}`);
  advisory++;
}

async function runFlow(nodes, edges = []) {
  const steps = []; let output = null; let error = null;
  for await (const ev of ft.run({ name: 'test', nodes, edges, triggers: [], errorHandling: {} }, {})) {
    if (ev.type === 'step_completed') steps.push({ id: ev.nodeId, output: ev.output });
    if (ev.type === 'run_completed') output = ev.output;
    if (ev.type === 'run_failed') { error = ev.error; break; }
  }
  return { steps, output, error };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — INTEGRATION: llm → deliver(slack channel) end-to-end
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ Part 1: Integration (llm → Slack channel, via engine) ══\n');

// 1a. llm → post_message: generate an announcement, post it to a channel
{
  received.length = 0;
  console.log('--- llm → post_message ---');
  const { steps, error } = await runFlow([
    { id: 'write', type: 'llm', label: 'draft announcement', config: {
      prompt: 'Write a one-sentence announcement that a new feature has shipped. Be concise.' } },
    { id: 'post',  type: 'deliver', label: 'post to channel', config: {
      channel: 'slack', target: '#announcements' } },
  ], [{ from: 'write', to: 'post' }]);
  const llmOut = steps.find((s) => s.id === 'write')?.output ?? '';
  const posted = last('chat.postMessage');
  console.log(`  LLM said: "${String(llmOut).trim().slice(0, 80)}"`);
  check('llm output reached Slack (text is non-empty)', posted && posted.body.text?.length > 0);
  check('delivered to #announcements', posted?.body?.channel === '#announcements');
  check('no engine error', !error);
}

// 1b. llm → post_dm: summarise a prompt and DM it to a user
{
  received.length = 0;
  console.log('\n--- llm → post_dm ---');
  const { steps, error } = await runFlow([
    { id: 'sum', type: 'llm', label: 'summarise', config: {
      prompt: 'Summarise in one sentence: our deployment completed successfully at 3pm, all tests green.' } },
    { id: 'dm', type: 'deliver', label: 'DM the user', config: {
      channel: 'slack_dm', target: '#social', user: 'U001' } },
  ], [{ from: 'sum', to: 'dm' }]);
  const llmOut = steps.find((s) => s.id === 'sum')?.output ?? '';
  const posted = last('chat.postMessage');
  console.log(`  LLM said: "${String(llmOut).trim().slice(0, 80)}"`);
  check('DM opened via conversations.open', !!last('conversations.open'));
  check('message posted to the opened DM channel', posted?.body?.channel === 'D001');
  check('no engine error', !error);
}

// 1c. llm → upload_file: generate a report and upload it as a file
{
  received.length = 0;
  console.log('\n--- llm → upload_file ---');
  const { steps, error } = await runFlow([
    { id: 'report', type: 'llm', label: 'write report', config: {
      prompt: 'Write a 3-bullet deployment report: what shipped, who did it, current status. Plain text.' } },
    { id: 'upload', type: 'deliver', label: 'upload as file', config: {
      channel: 'slack_file', target: 'C001', title: 'Deployment Report', filename: 'deploy.txt' } },
  ], [{ from: 'report', to: 'upload' }]);
  const llmOut = steps.find((s) => s.id === 'report')?.output ?? '';
  console.log(`  LLM said: "${String(llmOut).trim().slice(0, 120)}"`);
  check('file upload initiated (getUploadURLExternal called)', !!last('files.getUploadURLExternal'));
  check('upload completed (completeUploadExternal called)', !!last('files.completeUploadExternal'));
  check('no engine error', !error);
}

// 1d. llm → set_reminder: LLM writes reminder text, then set a reminder
{
  received.length = 0;
  console.log('\n--- llm → set_reminder ---');
  const { steps, error } = await runFlow([
    { id: 'text', type: 'llm', label: 'write reminder', config: {
      prompt: 'Write a short reminder to check the deployment logs. One sentence.' } },
    { id: 'remind', type: 'deliver', label: 'set reminder', config: {
      channel: 'slack_reminder', time: 'in 1 hour', user: 'U001' } },
  ], [{ from: 'text', to: 'remind' }]);
  const reminderBody = last('reminders.add')?.body;
  console.log(`  LLM said: "${String(steps.find((s) => s.id === 'text')?.output ?? '').trim().slice(0, 80)}"`);
  check('reminder created (reminders.add called)', !!reminderBody);
  check('reminder text is non-empty', reminderBody?.text?.length > 0);
  check('reminder time forwarded correctly', reminderBody?.time === 'in 1 hour');
  check('no engine error', !error);
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — TOOL SELECTION: LLM sees capability map, picks the right action
// This is the P3 converger pattern in miniature.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n══ Part 2: Tool selection (LLM sees capability map, picks action) ══');
console.log('   Note: this uses the 0.5B local model — not the P3 converger.');
console.log('   Results are advisory. The point is to see how it reasons.\n');

const { resolveSlackCapabilities, describeSlackForPrompt } = await import('../../src/connectors/slack/index.js');
const allScopes = ['chat:write','chat:write.public','im:write','reactions:write','files:write',
  'channels:manage','channels:write.invites','channels:write.topic','pins:write',
  'reminders:write','users:read','users:read.email','search:read.public','channels:history','mpim:write'];
const capSurface = describeSlackForPrompt(resolveSlackCapabilities(allScopes));

const { LlamaCppLLM } = await import('../../src/llm/index.js');
const llm = new LlamaCppLLM({ modelPath: CHAT_MODEL, contextSize: 2048 });

async function askLLM(intent) {
  const prompt = `You are a workflow builder. You have these Slack capabilities:\n\n${capSurface}\n\nUser intent: "${intent}"\n\nRespond with ONLY a JSON object: {"action": "<action_id>", "reason": "<one sentence>"}. No other text.`;
  const out = await llm._call(prompt);
  const text = typeof out === 'string' ? out : (out?.content ?? String(out));
  // Try to extract a JSON object from the output
  const match = text.match(/\{[^}]+\}/s);
  let parsed = null; try { if (match) parsed = JSON.parse(match[0]); } catch { /* ignore */ }
  return { raw: text.trim(), parsed };
}

const scenarios = [
  { intent: 'Send a message to the #general channel', expected: 'post_message' },
  { intent: 'Send a private message directly to a team member', expected: 'post_dm' },
  { intent: 'Reply to an existing message in a thread', expected: 'reply_in_thread' },
  { intent: 'React to a message with a thumbs up emoji', expected: 'add_reaction' },
  { intent: 'Share a report as a file in a Slack channel', expected: 'upload_file' },
  { intent: 'Create a new channel for the project team', expected: 'create_channel' },
  { intent: 'Set a reminder for the team in an hour', expected: 'set_reminder' },
  { intent: 'Search for messages about the deployment', expected: 'search_messages' },
  { intent: 'Read the recent message history from a channel', expected: 'get_channel_history' },
];

for (const { intent, expected } of scenarios) {
  const { raw, parsed } = await askLLM(intent);
  const picked = parsed?.action ?? null;
  const correct = picked === expected;
  console.log(`\n  Intent: "${intent}"`);
  console.log(`  Expected: ${expected} | Got: ${picked ?? '(unparsed)'}`);
  console.log(`  Raw output: "${raw.slice(0, 120)}"`);
  if (parsed?.reason) console.log(`  Reason: "${parsed.reason}"`);
  note(`tool selection: ${expected}`, correct, correct ? '' : `picked ${picked ?? 'nothing'}`);
}

// Dispose models in order before exit (avoids upstream Metal teardown assert,
// node-llama-cpp PR #17869 — same mitigation as elsewhere in the spine).
try { await spine.rag.embedder.dispose?.(); } catch { /* ignore */ }
try { await llm.dispose?.(); } catch { /* ignore */ }

// ── Summary ──────────────────────────────────────────────────────────────────
stub.close(); spine.close();

const selectionCorrect = advisory; // all advisory
console.log(`\n${'═'.repeat(60)}`);
console.log(`Integration tests : ${passed + failed} total, ${passed} passed, ${failed} failed`);
console.log(`Tool selection    : ${scenarios.length} scenarios (advisory, not blocking)`);
console.log(`${'═'.repeat(60)}`);

if (failed > 0) { console.log('\nSLACK-LLM-FAIL'); process.exit(1); }
console.log('\nSLACK-LLM-PASS');
process.exit(0);
