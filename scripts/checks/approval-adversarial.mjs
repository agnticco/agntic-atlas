/**
 * approval-adversarial — try to FORGE an approval. (P12 Increment D.)
 *
 * An approval anyone can forge is not an approval, so this check does not ask
 * whether the happy path works (the test suite does that). It attacks:
 *
 *   1. an UNSIGNED Slack `block_actions` payload is rejected
 *   2. a WRONGLY-signed one is rejected (and an expired-timestamp replay of a
 *      genuinely-signed one is too)
 *   3. a token from tenant A cannot resolve a run in tenant B
 *   4. a REPLAYED magic link is rejected
 *   5. the GET on a magic link does not DECIDE anything (a mail scanner that
 *      prefetches every URL must not approve the customer's refund)
 *   6. `email_reply` is rejected by the validator
 *   7. an approval a user of ANOTHER tenant tries to click is refused
 *
 * ── Why it boots the real server ────────────────────────────────────────────
 *
 * ENGINEERING-LOG.md, architectural flaw #2: *a check that exercises a configuration
 * production never uses cannot see the bug production has.* A forgery check that
 * constructed its own validator with no signing secret, or hand-passed a tenantId
 * no real caller passes, would prove the signature check works in a program nobody
 * runs — while production sat wide open. That is verbatim how Increment B leaked
 * one tenant's output into another's.
 *
 * So: the real `bootSpine()`, the real `createApp()`, the real routes, over real
 * HTTP, with SLACK_SIGNING_SECRET set exactly as the deployment sets it. The only
 * things stubbed are the databases (throwaway temp files).
 *
 * Prints APPROVAL-ADVERSARIAL-PASS / -FAIL and exits 0/1. Used by the P12 gate.
 *
 *   node scripts/checks/approval-adversarial.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

// Hermetic env: isolated temp DBs so this never touches real data.
const tmp = mkdtempSync(join(tmpdir(), 'atlas-approval-adv-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
  INTERACTIONS_DB: 'i.sqlite', INBOX_DB: 'inbox.sqlite', APPROVALS_DB: 'approvals.sqlite',
  IDEMPOTENCY_DB: 'idem.sqlite',
})) process.env[k] = join(tmp, v);
process.env.DB_BACKUP_KEEP = '0';
process.env.SCHEDULER_ENABLED = 'false';   // we drive the sweeper by hand

// The secret the deployment signs with. Set BEFORE bootSpine so every route sees
// exactly what production sees — a check that ran without one would be testing a
// server whose signature check is switched off (it 501s), and would "pass" while
// proving nothing.
const SIGNING_SECRET = 'test-signing-secret-do-not-use-in-prod';
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;

const { bootSpine, createApp } = await import('../../src/api/server.js');
const { WorkflowValidator } = await import('../../src/workflows/workflow-validator.js');
const { NodeTypeRegistry } = await import('../../src/workflows/node-type-registry.js');
const { registerBuiltInNodeTypes } = await import('../../src/workflows/node-types/index.js');
const { approvalChannelView } = await import('../../src/workflows/approval-channels.js');

let pass = true;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) pass = false; };

const spine = await bootSpine();
const app = createApp(spine);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
};

/** Post a Slack interactive payload, signed however the caller asks. */
const slackPost = async (payload, { secret = SIGNING_SECRET, ts = Math.floor(Date.now() / 1000), sign = true } = {}) => {
  const form = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) {
    headers['x-slack-request-timestamp'] = String(ts);
    headers['x-slack-signature'] = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${form}`).digest('hex');
  }
  const res = await fetch(base + '/connectors/slack/interactive', { method: 'POST', headers, body: form });
  let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
};

/** A workflow that drafts something and then asks a person before sending it. */
const approvalFlow = (name) => ({
  name, kind: 'flow', status: 'active',
  triggers: [{ type: 'manual' }],
  nodes: [
    { id: 'draft', type: 'llm', config: { mode: 'freeform', prompt: 'draft a reply' } },
    { id: 'ask', type: 'human', config: {
      prompt: 'Send this reply to the customer?', preview: '{{draft.output}}',
      decisions: ['approve', 'reject'],
      channels: [{ type: 'inbox' }, { type: 'email', to: 'ops@acme.test' }],
      timeout: { after: '48h', then: 'reject' },
    } },
    { id: 'gate', type: 'branch', config: {
      on: '{{ask.decision}}',
      cases: [{ when: 'approve', to: 'send' }, { when: '*', to: 'dropped' }],
    } },
    { id: 'send',    type: 'deliver',  config: { channel: 'in_app', target: 'ops' } },
    { id: 'dropped', type: 'assemble', config: { title: 'Not approved.', sections: '[]' } },
  ],
  edges: [
    { from: 'draft', to: 'ask' }, { from: 'ask', to: 'gate' },
    { from: 'gate', to: 'send' }, { from: 'gate', to: 'dropped' },
  ],
});

try {
  // ── Setup: two tenants, each with a run parked on a `human` step ───────────
  const setup = await api('POST', '/setup', { body: { token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'ops-pw-12345' } });
  const platformToken = setup.json?.token;

  const tA = await api('POST', '/tenants', { token: platformToken, body: { name: 'Acme', slug: 'acme', admin: { email: 'a@acme.test', password: 'acme-pw-12345' } } });
  const tB = await api('POST', '/tenants', { token: platformToken, body: { name: 'Globex', slug: 'globex', admin: { email: 'b@globex.test', password: 'globex-pw-12345' } } });
  const userA = tA.json?.admin, userB = tB.json?.admin;
  const tokenA = (await api('POST', '/auth/login', { body: { email: 'a@acme.test', password: 'acme-pw-12345' } })).json?.token;
  const tokenB = (await api('POST', '/auth/login', { body: { email: 'b@globex.test', password: 'globex-pw-12345' } })).json?.token;
  ok('two tenants, both logged in', !!tokenA && !!tokenB);

  // The LLM is not called in this check — stub the draft so no key is needed and
  // the run is deterministic. (The ENGINE and every approval path stay real.)
  spine.engine.flowTester.llm = { invoke: async () => ({ content: 'DRAFTED REPLY — do not send without approval' }) };

  const wfA = spine.engine.workflowStore.create({ tenantId: 'acme',   userId: userA.id, ...approvalFlow('Acme approval') });
  const wfB = spine.engine.workflowStore.create({ tenantId: 'globex', userId: userB.id, ...approvalFlow('Globex approval') });

  // Park both runs on the human step, through the REAL scheduler path.
  await spine.engine.workflowScheduler._executeFlow(spine.engine.workflowStore.get(wfA.id), { trigger: 'manual' });
  await spine.engine.workflowScheduler._executeFlow(spine.engine.workflowStore.get(wfB.id), { trigger: 'manual' });

  const [pausedA] = spine.engine.workflowStore.listAwaitingHuman({ tenantId: 'acme' });
  const [pausedB] = spine.engine.workflowStore.listAwaitingHuman({ tenantId: 'globex' });
  ok('a run in each tenant is parked awaiting a person', !!pausedA && !!pausedB && pausedA.paused_node === 'ask');

  const stillPending = (tenantId) => spine.engine.workflowStore.listAwaitingHuman({ tenantId }).length === 1;

  // ── 1. An UNSIGNED Slack block_actions is rejected ─────────────────────────
  const unsigned = await slackPost({
    type: 'block_actions', team: { id: 'T-ACME' }, user: { id: 'U-ATTACKER' },
    actions: [{ value: `${pausedA.id}:ask:approve` }],
  }, { sign: false });
  ok('UNSIGNED Slack block_actions → 401', unsigned.status === 401);
  ok('  …and the approval is still pending', stillPending('acme'));

  // ── 2. A WRONGLY-signed one is rejected ───────────────────────────────────
  const badSig = await slackPost({
    type: 'block_actions', team: { id: 'T-ACME' }, user: { id: 'U-ATTACKER' },
    actions: [{ value: `${pausedA.id}:ask:approve` }],
  }, { secret: 'the-attackers-guess' });
  ok('WRONGLY-signed Slack block_actions → 401', badSig.status === 401);
  ok('  …and the approval is still pending', stillPending('acme'));

  // A correctly-signed payload with an OLD timestamp — a captured request being
  // replayed. The signature is genuine; the clock is what refuses it.
  const stale = await slackPost({
    type: 'block_actions', team: { id: 'T-ACME' }, user: { id: 'U-REAL' },
    actions: [{ value: `${pausedA.id}:ask:approve` }],
  }, { ts: Math.floor(Date.now() / 1000) - 3600 });
  ok('REPLAYED (stale-timestamp) Slack payload → 401', stale.status === 401);
  ok('  …and the approval is still pending', stillPending('acme'));

  // A perfectly-signed payload from a Slack workspace that belongs to NO tenant.
  // The signature proves Slack sent it; it does not prove whose run it may answer.
  const noTenant = await slackPost({
    type: 'block_actions', team: { id: 'T-NOBODY' }, user: { id: 'U-REAL' },
    actions: [{ value: `${pausedA.id}:ask:approve` }],
  });
  ok('signed payload from an UNCONNECTED workspace does not resolve', noTenant.status === 200 && stillPending('acme'));

  // ── 3. A token from tenant A cannot resolve a run in tenant B ─────────────
  // Mint a REAL token in tenant A (the email channel does this on every pause),
  // then aim it at tenant B's run id. The token is genuine; the binding is what
  // must stop it.
  const forged = spine.approvals.approvals.issue({
    tenantId: 'acme', runId: pausedB.id, nodeId: 'ask', decisions: ['approve'],
  });
  const crossTenant = await fetch(`${base}/approvals/${forged.approve}`, { method: 'POST' });
  const crossBody = await crossTenant.text();
  ok('a tenant-A token aimed at a tenant-B RUN does not resolve it',
    stillPending('globex') && /no longer|not|nothing/i.test(crossBody));

  // ── 4 + 5. The magic link: GET looks, POST decides, and a replay is dead ───
  const tokens = spine.approvals.approvals.issue({
    tenantId: 'acme', runId: pausedA.id, nodeId: 'ask', decisions: ['approve', 'reject'],
  });

  // THE PREFETCH. A mail scanner GETs every link in the message. If the GET
  // decided, the customer's refund would be approved by a security appliance.
  const prefetch = await fetch(`${base}/approvals/${tokens.approve}`);
  ok('GET on a magic link renders a page (200)', prefetch.status === 200);
  ok('  …and DECIDES NOTHING — the run is still awaiting a person', stillPending('acme'));

  // The person actually clicks.
  const consumed = await fetch(`${base}/approvals/${tokens.approve}`, { method: 'POST' });
  ok('POST on the magic link resolves the approval', consumed.status === 200 && !stillPending('acme'));

  // The forwarded thread. A second reader clicks the same link.
  const replay = await fetch(`${base}/approvals/${tokens.approve}`, { method: 'POST' });
  const replayBody = await replay.text();
  ok('a REPLAYED magic link is rejected', /already been used|no longer/i.test(replayBody));

  // And the sibling "reject" link died with it — one approval, one answer.
  const sibling = await fetch(`${base}/approvals/${tokens.reject}`, { method: 'POST' });
  const siblingBody = await sibling.text();
  ok('the SIBLING (reject) link is dead too — one question, one answer', /already been used|no longer/i.test(siblingBody));

  // ── 6. `email_reply` is rejected by the validator ─────────────────────────
  // Constructed the way PRODUCTION constructs it (server.js:buildEngine): with the
  // channel catalog AND the approval-channel view. A validator built blind here
  // would agree with itself about nothing.
  const prodValidator = new WorkflowValidator({
    nodeTypes: registerBuiltInNodeTypes(new NodeTypeRegistry()),
    channelRegistry: spine.engine.channelRegistry,
    approvalChannels: approvalChannelView(['inbox', 'slack', 'email']),
  });
  const replySpec = approvalFlow('Reply approval');
  replySpec.nodes.find(n => n.id === 'ask').config.channels = [{ type: 'email_reply', to: 'ops@acme.test' }];
  const verdict = prodValidator.validate(replySpec);
  ok('§11.8 — `email_reply` is REJECTED by the validator',
    !verdict.ok && verdict.issues.some(i => i.code === 'EMAIL_REPLY_APPROVAL' && i.severity === 'error'));

  // And it cannot be smuggled in through the real publish endpoint either.
  const published = await api('POST', '/api/builder/workflows', { token: tokenA, body: { spec: replySpec } });
  ok('  …and publish refuses it too', published.status >= 400 || published.json?.error);

  // ── 7. A user of another tenant cannot click tenant A's approval ──────────
  const [pausedB2] = spine.engine.workflowStore.listAwaitingHuman({ tenantId: 'globex' });
  const stranger = await api('POST', `/api/approvals/${pausedB2.id}/ask`, { token: tokenA, body: { decision: 'approve' } });
  ok('a signed-in user of tenant A cannot approve tenant B\'s run',
    stranger.json?.ok === false && stillPending('globex'));

  // The owner still can — the check above must not be passing because the whole
  // endpoint is broken.
  const owner = await api('POST', `/api/approvals/${pausedB2.id}/ask`, { token: tokenB, body: { decision: 'reject' } });
  ok('  …but its OWNER can (so the refusal above is a check, not an outage)',
    owner.json?.ok === true && !stillPending('globex'));

} catch (err) {
  ok(`unexpected error: ${err?.stack ?? err}`, false);
} finally {
  try { server.close(); } catch { /* ignore */ }
  try { spine.close(); } catch { /* ignore */ }
  try { await spine.disposeModels?.(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(pass ? 'APPROVAL-ADVERSARIAL-PASS' : 'APPROVAL-ADVERSARIAL-FAIL');
process.exit(pass ? 0 : 1);
