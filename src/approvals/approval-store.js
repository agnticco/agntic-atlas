/**
 * ApprovalStore — forgery-proof answers to a `human` node. (P12 Increment D.)
 *
 * converger-v2 §7.3 says to mirror `src/auth/password-reset-store.js` verbatim
 * in shape, because that module already solved this problem and is battle-tested.
 * This does, with one structural addition the reset flow does not need: a token
 * is bound to a **decision**, not merely to a subject.
 *
 * ── The security model ──────────────────────────────────────────────────────
 *
 *   • `newApprovalToken()` → 32 random bytes, base64url.
 *   • Only the **SHA-256 hash** is stored. The raw token exists solely in the
 *     email that was sent. A dump of this database yields no usable link.
 *   • **Single-use.** Consumed on the first valid click.
 *   • **TTL**, defaulting to the node's `timeout.after`. An approval link that
 *     works forever is a standing invitation.
 *   • **One token per (runId, nodeId, decision).** Approve and reject are
 *     DIFFERENT tokens. This is the point: if one token carried the decision as
 *     a query parameter, anyone holding an "approve" link could flip it to
 *     "reject" by editing the URL — the link would authenticate the ANSWERER but
 *     not the ANSWER.
 *   • **Consuming either invalidates BOTH.** One approval, one answer. Otherwise
 *     a forwarded thread lets a second reader reject what the first approved,
 *     and the run resumes twice.
 *
 * ── Fail-closed on tenant ───────────────────────────────────────────────────
 *
 * Every token carries the tenant it was issued in, and `consume()` will not
 * return a token whose tenant does not match the caller's. A `?? 'default'`
 * anywhere in this file would be a cross-tenant forgery primitive (ENGINEERING-LOG.md —
 * the `?? 'unscoped'` idempotency scope that handed one tenant another tenant's
 * output). Issuing without a tenant THROWS.
 *
 * @module src/approvals/approval-store.js
 */

import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function newApprovalToken() { return randomBytes(32).toString('base64url'); }
export function hashApprovalToken(token) { return createHash('sha256').update(String(token)).digest('hex'); }

/** 48h — the same default as a `human` node's `timeout.after`. */
export const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approval_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  decision   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  UNIQUE (run_id, node_id, decision)
);
CREATE INDEX IF NOT EXISTS idx_appr_run ON approval_tokens(run_id, node_id);
`;

export class ApprovalStore {
  constructor({ dbPath = './memory/approvals/approvals.sqlite', db = null } = {}) {
    this.dbPath = dbPath;
    this.db = db;
  }

  init() {
    if (!this.db) {
      if (this.dbPath !== ':memory:') {
        try { mkdirSync(dirname(this.dbPath), { recursive: true }); } catch { /* exists */ }
      }
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(SCHEMA);
    return this;
  }

  /**
   * Issue one token per decision for a paused step. Returns the PLAINTEXT tokens
   * — `{ approve: '…', reject: '…' }` — which the caller puts in the email and
   * then forgets. Only the hashes are persisted.
   *
   * Re-issuing for the same (run, node) replaces any outstanding tokens, so a
   * re-sent ask never leaves a live link behind from the previous send.
   */
  issue({ tenantId, runId, nodeId, decisions, ttlMs = DEFAULT_TTL_MS }) {
    // Fail closed. A token that cannot say which tenant it belongs to cannot be
    // checked against the run it claims to answer — which is the entire defence
    // against tenant A resolving tenant B's run.
    if (!tenantId) throw new Error('ApprovalStore.issue: tenantId is required — an unscoped approval token cannot be checked against the run it answers.');
    if (!runId || !nodeId) throw new Error('ApprovalStore.issue: runId and nodeId are required.');
    const list = (Array.isArray(decisions) ? decisions : [])
      .map(d => String(d).trim()).filter(Boolean);
    if (!list.length) throw new Error('ApprovalStore.issue: at least one decision is required.');

    this.db.prepare('DELETE FROM approval_tokens WHERE run_id = ? AND node_id = ?').run(runId, nodeId);

    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS)).toISOString();
    const insert = this.db.prepare(
      `INSERT INTO approval_tokens (token_hash, tenant_id, run_id, node_id, decision, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const out = {};
    for (const decision of list) {
      const token = newApprovalToken();
      insert.run(hashApprovalToken(token), tenantId, runId, nodeId, decision, createdAt, expiresAt);
      out[decision] = token;
    }
    return out;
  }

  /**
   * The row for a valid (unused, unexpired) token, else null. Does NOT consume —
   * this is what `GET /approvals/:token` renders its confirmation page from.
   *
   * A GET from a mail client must be safe to prefetch: scanning proxies and link
   * checkers fetch every URL in an email, and if the GET consumed the token they
   * would approve the customer's refund before the human ever saw it. The GET
   * looks; a POST decides.
   */
  peek(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM approval_tokens WHERE token_hash = ?').get(hashApprovalToken(token));
    if (!row || row.used_at) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    return row;
  }

  /**
   * Consume a token: mark it used and INVALIDATE EVERY OTHER TOKEN for the same
   * (run, node) — the sibling "reject" link dies with the "approve" one. One
   * approval, one answer.
   *
   * Returns the consumed row, or null if the token was unknown, already used,
   * expired, or belongs to a different tenant than the caller.
   *
   * @param {string} token
   * @param {{ tenantId?: string }} [opts] — when given, the token's tenant must
   *        match. The caller that knows the tenant (the inbox, the Slack
   *        workspace) MUST pass it.
   */
  consume(token, { tenantId = null } = {}) {
    const row = this.peek(token);
    if (!row) return null;
    if (tenantId && row.tenant_id !== tenantId) return null;

    const now = new Date().toISOString();
    // The whole (run, node) is answered in one transaction: mark this token
    // used, and burn its siblings. Not two statements the caller could interleave.
    const burn = this.db.transaction(() => {
      const info = this.db.prepare(
        'UPDATE approval_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
      ).run(now, row.token_hash);
      if (info.changes === 0) return false;   // lost a race — someone else consumed it
      this.db.prepare(
        'UPDATE approval_tokens SET used_at = ? WHERE run_id = ? AND node_id = ? AND used_at IS NULL',
      ).run(now, row.run_id, row.node_id);
      return true;
    });

    return burn() ? { ...row, used_at: now } : null;
  }

  /**
   * Burn every outstanding token for a (run, node) without consuming one — used
   * when the answer arrived over a channel that does not use tokens at all (the
   * in-app inbox, a Slack button), and when a timeout resolves the step. The
   * magic links in the email must die at that moment too: the question has been
   * answered, and a link that still works is a second answer waiting to happen.
   */
  invalidate(runId, nodeId) {
    return this.db.prepare(
      'UPDATE approval_tokens SET used_at = ? WHERE run_id = ? AND node_id = ? AND used_at IS NULL',
    ).run(new Date().toISOString(), runId, nodeId).changes;
  }

  /** Housekeeping: drop used/expired rows. */
  purgeExpired() {
    return this.db.prepare('DELETE FROM approval_tokens WHERE expires_at < ? OR used_at IS NOT NULL')
      .run(new Date().toISOString()).changes;
  }

  close() { this.db?.close(); this.db = null; }
}
