/**
 * ApprovalService — the ask goes out, the answer comes back, and the answer is
 * PROVEN. (P12 Increment D, converger-v2 §7.)
 *
 * Increment B built the durable pause: a `human` step stops the run, persists a
 * full-fidelity checkpoint, and holds no compute while it waits. It stopped
 * exactly there, deliberately — because a `human` node nobody can answer is a
 * hang, and an approval anybody can forge is not an approval. This file is the
 * other half.
 *
 * ── The two halves ──────────────────────────────────────────────────────────
 *
 *   deliverAsk()  the question, over every channel the node declares.
 *   resolve*()    the answer — one per channel, each of which must ESTABLISH WHO
 *                 IS ANSWERING before it goes anywhere near the engine.
 *
 * There is exactly one door from here into the engine: `resumeRun(run, answer)`
 * on the scheduler. It authenticates nothing, by design — everything that calls
 * it has already proven the answerer:
 *
 *   inbox  an authenticated session, whose tenant must match the run's.
 *   slack  a `block_actions` payload HMAC-verified against SLACK_SIGNING_SECRET,
 *          carrying the Slack user id that clicked.
 *   email  a signed, hashed, single-use magic link, bound to (run, node, decision).
 *   timeout the system's own answer, and never `approve`.
 *
 * If you add a fifth channel, it proves who is answering BEFORE it reaches
 * `resumeRun`, or it is not a channel.
 *
 * ── What must never appear in this file ─────────────────────────────────────
 *
 * A function that reads an email body. `From:` is spoofable, SPF/DKIM
 * authenticate a sending domain rather than a human intent, and a forwarded
 * thread is full of the word "yes" (§11.8, EMAIL_REPLY_APPROVAL).
 *
 * @module src/approvals/approval-service.js
 */

import { log } from '../utils/logger.js';
import { parseDuration } from '../workflows/duration.js';
import { DEFAULT_TTL_MS } from './approval-store.js';

/** How the answer reached us. Recorded on the run, and shown in the audit trail. */
export const CHANNEL_INBOX = 'inbox';
export const CHANNEL_SLACK = 'slack';
export const CHANNEL_EMAIL = 'email';

export class ApprovalService {
  /**
   * @param {object} deps
   * @param {import('./approval-store.js').ApprovalStore} deps.approvalStore
   * @param {import('../workflows/workflow-store.js').WorkflowStore} deps.workflowStore
   * @param {object} deps.inboxStore              — in-app items (the `inbox` channel)
   * @param {(run:object, answer:object)=>Promise} deps.resumeRun — the scheduler's one door
   * @param {(args:object)=>Promise} [deps.postSlack]  — chat.postMessage with blocks
   * @param {(args:object)=>Promise} [deps.sendMail]   — the platform mailer
   * @param {()=>string} [deps.baseUrl]           — where a magic link points
   */
  constructor({ approvalStore, workflowStore, inboxStore, resumeRun, postSlack = null, sendMail = null, baseUrl = () => '' }) {
    this.approvals    = approvalStore;
    this.workflowStore = workflowStore;
    this.inbox        = inboxStore;
    this.resumeRun    = resumeRun;
    this.postSlack    = postSlack;
    this.sendMail     = sendMail;
    this.baseUrl      = baseUrl;
  }

  // ── The ask ───────────────────────────────────────────────────────────────

  /**
   * Put the question in front of a person, over every channel the node declares.
   * Called by the scheduler the instant the run parks.
   *
   * Channels are asked over in PARALLEL and the first valid answer wins (§7.1).
   * One channel failing does not silence the others: a Slack outage must not mean
   * the approval never arrives, when the same question is also sitting in the
   * in-app inbox.
   */
  async deliverAsk({ workflow, run, ask, expiresAt = null }) {
    const tenantId = workflow.tenant_id ?? run.tenant_id;
    if (!tenantId) throw new Error('deliverAsk: no tenant on the workflow or the run — an unscoped approval cannot be delivered or checked.');

    const channels = Array.isArray(ask?.channels) ? ask.channels : [];
    const decisions = Array.isArray(ask?.decisions) && ask.decisions.length ? ask.decisions : ['approve', 'reject'];

    // Tokens exist ONLY for the email channel — the other two prove the answerer
    // by other means (a session, a signed Slack payload), and minting a link for
    // them would be creating a forgeable credential nobody needs. `issue()` also
    // replaces any outstanding tokens for this (run, node), so a re-sent ask never
    // leaves a live link behind.
    const wantsEmail = channels.some(c => c?.type === CHANNEL_EMAIL);
    let tokens = {};
    if (wantsEmail) {
      const ttlMs = parseDuration(ask?.timeout?.after) ?? DEFAULT_TTL_MS;
      tokens = this.approvals.issue({ tenantId, runId: run.id, nodeId: ask.nodeId, decisions, ttlMs });
    }

    const results = await Promise.allSettled(channels.map(async (ch) => {
      switch (ch?.type) {
        case CHANNEL_INBOX: return this._askInbox({ workflow, run, ask, ch, expiresAt });
        case CHANNEL_SLACK: return this._askSlack({ workflow, run, ask, ch, decisions, tenantId });
        case CHANNEL_EMAIL: return this._askEmail({ workflow, run, ask, ch, tokens, expiresAt });
        default:
          // Includes `email_reply`, which the validator rejects at build time. If
          // a spec that predates the rule reaches here, it is IGNORED — never
          // "handled" by falling back to something weaker.
          throw new Error(`unsupported approval channel "${ch?.type}"`);
      }
    }));

    const failed = results.filter(r => r.status === 'rejected');
    for (const f of failed) log.warn(`[approvals] channel failed: ${f.reason?.message ?? f.reason}`);

    // NOT ONE CHANNEL WORKED. The run is parked with a question nobody has been
    // asked. The pause still has a deadline, so it cannot hang forever — but the
    // person is going to find out at the timeout instead of now, and that is worth
    // saying loudly rather than logging quietly.
    if (channels.length && failed.length === channels.length) {
      throw new Error(`the approval for "${ask.nodeId}" could not be delivered over any of its ${channels.length} channel(s)`);
    }
    return { delivered: results.length - failed.length, of: channels.length };
  }

  /**
   * The in-app Approvals list. Strong: answered from an authenticated session.
   *
   * The QUESTION itself is not stored here — it already lives on the run
   * (`workflow_runs.pending_ask`), which is what `GET /api/approvals` reads and
   * what the Approve/Reject buttons answer. Duplicating it into the message body
   * would make two records of one question, and the day they disagree is the day
   * somebody approves the wrong thing.
   *
   * What this writes is a NOTIFICATION — a plain-English note in the person's
   * inbox so they find out a question is waiting without having to go looking.
   */
  async _askInbox({ workflow, run, ask, ch, expiresAt }) {
    const userId = ch?.assignee?.replace(/^user:/, '') || workflow.user_id;
    if (!userId) throw new Error('inbox approval has no assignee and the workflow has no owner');
    const by = expiresAt ? `\n\nIf nobody answers by ${new Date(expiresAt).toUTCString()}, the workflow takes its declared timeout path.` : '';
    this.inbox.create({
      tenantId: workflow.tenant_id ?? run.tenant_id,
      userId,
      sourceWorkflowId: workflow.id,
      sourceRunId:      run.id,
      subject: `Approval needed — ${workflow.name ?? workflow.slug}`,
      content: `${ask.prompt || 'Approve this step?'}\n\n${ask.preview ? `${ask.preview}\n\n` : ''}Open Approvals to answer.${by}`,
    });
    return { channel: CHANNEL_INBOX };
  }

  /**
   * Slack Block Kit buttons. Strong: the answer arrives as a `block_actions`
   * payload, HMAC-signed by Slack and carrying the id of the user who clicked.
   *
   * The `value` on each button carries `runId:nodeId:decision` — and that is NOT
   * a credential. It is a routing hint, and it is worth being explicit about why
   * that is safe: the payload's SIGNATURE is the trust anchor, so a forged value
   * in an unsigned request is rejected before anything reads it, and a signed
   * request can only come from Slack. What the value cannot do is prove WHICH
   * WORKSPACE — so the interactive handler resolves the tenant from the Slack
   * team id, never from this string.
   */
  async _askSlack({ workflow, run, ask, ch, decisions, tenantId }) {
    if (!this.postSlack) throw new Error('slack approval requested but Slack is not wired in this deployment');
    const target = ch?.target;
    if (!target) throw new Error('slack approval has no target channel');

    const preview = ask.preview ? String(ask.preview) : '';
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `*${ask.prompt || 'Approve this step?'}*` } },
    ];
    if (preview) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '```' + preview.slice(0, 2800) + '```' },
      });
    }
    blocks.push({
      type: 'actions',
      block_id: `approval:${run.id}:${ask.nodeId}`,
      elements: decisions.map(d => ({
        type: 'button',
        text: { type: 'plain_text', text: titleCase(d) },
        style: d === 'approve' ? 'primary' : (d === 'reject' ? 'danger' : undefined),
        action_id: `approval_${d}`,
        value: `${run.id}:${ask.nodeId}:${d}`,
      })),
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${workflow.name ?? workflow.slug} · run \`${run.id.slice(0, 8)}\`` }],
    });

    await this.postSlack({
      tenantId, channel: target,
      text: ask.prompt || 'Approve this step?',   // notification fallback
      blocks,
    });
    return { channel: CHANNEL_SLACK };
  }

  /**
   * A signed, hashed, single-use magic link — one per decision (§7.3).
   *
   * MEDIUM trust, and the code says so: the link proves possession of the mail,
   * not the identity of the reader, and it is forwardable. That is why
   * WEAK_APPROVAL_FOR_WRITE refuses to let it stand alone in front of a write.
   *
   * The link is a GET a mail client will happily PREFETCH, so it must not decide
   * anything. It lands on a confirmation page; a POST from that page consumes the
   * token. Without that split, a scanning proxy approves the customer's refund
   * before the human has read the sentence.
   */
  async _askEmail({ workflow, run, ask, ch, tokens, expiresAt }) {
    if (!this.sendMail) throw new Error('email approval requested but no mailer is configured');
    const to = ch?.to;
    if (!to) throw new Error('email approval has no recipient');

    const base = String(this.baseUrl() ?? '').replace(/\/$/, '');
    const lines = Object.entries(tokens)
      .map(([decision, token]) => `${titleCase(decision)}: ${base}/approvals/${token}`);

    const when = expiresAt ? `\n\nThis link expires ${new Date(expiresAt).toUTCString()}.` : '';
    const body = [
      ask.prompt || 'Approve this step?',
      ask.preview ? `\n---\n${ask.preview}\n---\n` : '',
      lines.join('\n'),
      `\nEach link can be used once, and using either one answers the question.${when}`,
      `\n${workflow.name ?? workflow.slug} · run ${run.id.slice(0, 8)}`,
    ].join('\n');

    await this.sendMail({
      to,
      subject: `Approval needed — ${workflow.name ?? workflow.slug}`,
      text: body,
    });
    return { channel: CHANNEL_EMAIL };
  }

  // ── The answer ────────────────────────────────────────────────────────────

  /**
   * The in-app inbox: an authenticated session said yes.
   *
   * The tenant comes from the SESSION, and the run is loaded WITH that tenant in
   * the WHERE clause — so a user of tenant B naming a run id belonging to tenant A
   * gets "no such pending approval", not tenant A's run. Never load the run first
   * and compare tenants afterwards: that is the same shape as every cross-tenant
   * leak in this codebase's history, and it only takes one forgotten `if`.
   */
  async resolveFromInbox({ tenantId, userId, runId, nodeId, decision }) {
    if (!tenantId || !userId) return { ok: false, reason: 'not signed in' };
    const run = this.workflowStore.getAwaitingHuman(runId, { tenantId });
    if (!run) return { ok: false, reason: 'that approval is no longer pending' };
    if (run.paused_node !== nodeId) return { ok: false, reason: 'that approval is no longer pending' };

    const check = this._checkDecision(run, decision);
    if (!check.ok) return check;

    this.approvals.invalidate(run.id, nodeId);   // the emailed links die with it
    return this._resume(run, { decision, by: `user:${userId}`, channel: CHANNEL_INBOX });
  }

  /**
   * Slack. The caller (the `/connectors/slack/interactive` route) has ALREADY
   * verified the request signature — an unsigned payload never reaches this
   * method — and resolved the tenant from the Slack team id.
   */
  async resolveFromSlack({ tenantId, slackUserId, runId, nodeId, decision }) {
    if (!tenantId) return { ok: false, reason: 'unknown Slack workspace' };
    const run = this.workflowStore.getAwaitingHuman(runId, { tenantId });
    if (!run) return { ok: false, reason: 'that approval is no longer pending' };
    if (run.paused_node !== nodeId) return { ok: false, reason: 'that approval is no longer pending' };

    const check = this._checkDecision(run, decision);
    if (!check.ok) return check;

    this.approvals.invalidate(run.id, nodeId);
    return this._resume(run, { decision, by: `slack:${slackUserId}`, channel: CHANNEL_SLACK });
  }

  /**
   * The emailed magic link. `peek` looks (safe for a mail client to prefetch);
   * `consume` decides, and is reachable only from a POST.
   */
  peekToken(token) {
    const row = this.approvals.peek(token);
    if (!row) return null;
    const run = this.workflowStore.getAwaitingHuman(row.run_id, { tenantId: row.tenant_id });
    if (!run || run.paused_node !== row.node_id) return null;
    return {
      decision: row.decision,
      nodeId:   row.node_id,
      prompt:   run.pending_ask?.prompt ?? 'Approve this step?',
      preview:  run.pending_ask?.preview ?? null,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Consume the link. Single-use: the token is burned, AND SO IS ITS SIBLING —
   * so the "reject" link in the same email dies the moment "approve" is clicked.
   * A replay of either is rejected, which is what makes a forwarded thread safe:
   * the second reader is too late, not a second vote.
   */
  async resolveFromToken(token) {
    const row = this.approvals.consume(token);
    if (!row) return { ok: false, reason: 'this link has already been used, or it has expired' };

    // The token names its own tenant, and the run is loaded scoped to it. A token
    // minted in tenant A therefore cannot resolve a run in tenant B even if the
    // run ids were guessed — the WHERE clause has both.
    const run = this.workflowStore.getAwaitingHuman(row.run_id, { tenantId: row.tenant_id });
    if (!run || run.paused_node !== row.node_id) {
      return { ok: false, reason: 'that approval is no longer pending' };
    }
    return this._resume(run, { decision: row.decision, by: 'email:link', channel: CHANNEL_EMAIL });
  }

  /** Burn the outstanding links for a pause the sweeper is about to time out. */
  onTimeout({ run }) {
    if (run?.id && run?.paused_node) this.approvals.invalidate(run.id, run.paused_node);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * The answer must be one this node actually offers. A channel handing in
   * "approve" to a node whose decisions are ["ship", "hold"] is not a decision it
   * can act on — the executor would throw mid-resume, after the run had already
   * been flipped out of `awaiting_human` and could never be answered again.
   */
  _checkDecision(run, decision) {
    const allowed = run.pending_ask?.decisions;
    const d = String(decision ?? '');
    if (!d) return { ok: false, reason: 'no answer given' };
    if (Array.isArray(allowed) && allowed.length && !allowed.includes(d)) {
      return { ok: false, reason: `"${d}" is not one of the answers this step offers` };
    }
    return { ok: true };
  }

  async _resume(run, answer) {
    const res = await this.resumeRun(run, answer);
    if (!res?.resumed) return { ok: false, reason: res?.reason ?? 'that question has already been answered' };
    return { ok: true, decision: answer.decision, error: res.error ?? null };
  }
}

function titleCase(s) {
  const t = String(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
