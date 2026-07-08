/**
 * Support-ticket submission API (operator app).
 *
 *   POST /api/tickets   — authenticated + tenant-scoped; end users submit
 *                         bugs / ideas / requests with an optional screenshot
 *                         and a captured runtime-context bundle.
 *
 * Screenshots are written to disk under ./memory/tickets/<tenant>/ (gitignored)
 * — same base64-data-URL-in-JSON convention as /rag/ingest-files (no multipart).
 * Runtime context is enriched server-side (app version, workspace name, receive
 * time) so those can't be spoofed or forgotten by the client.
 *
 * Triage + coding-agent hand-off (list/detail/brief/GitHub) live in the admin
 * app — see src/admin/server.js.
 *
 * @module src/api/tickets.js
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { APP_VERSION } from '../version.js';
import { sendMail } from '../utils/mailer.js';
import { oauthRedirectBase } from '../connectors/oauth-redirect.js';
import { renderTicketBrief, ticketGithubTitle } from '../support/ticket-brief.js';
import { logEvent, errFields } from '../utils/event-log.js';

export const TICKETS_DIR = process.env.TICKETS_DIR ?? './memory/tickets';
const MAX_SHOT_BYTES = 5_000_000; // decoded screenshot cap (body itself is capped at 4mb)
const SHOT_RE = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/s;
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Decode a base64 image data URL and write it under TICKETS_DIR. Returns the
 *  relative path ("<tenant>/<uuid>.<ext>") or null if absent/invalid/oversize. */
function writeScreenshot(tenantId, dataUrl) {
  const m = SHOT_RE.exec(dataUrl);
  if (!m) return null;
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_SHOT_BYTES) return null;
  const ext = EXT_BY_MIME[mime] ?? 'png';
  const safeTenant = String(tenantId).replace(/[^a-z0-9_-]/gi, '_') || 'unknown';
  const dir = resolve(join(TICKETS_DIR, safeTenant));
  mkdirSync(dir, { recursive: true });
  const file = `${randomUUID()}.${ext}`;
  writeFileSync(join(dir, file), buf);
  return `${safeTenant}/${file}`;
}

/** Read a stored screenshot back as a data URL for inlining in an admin response.
 *  Traversal-safe: the resolved path must stay under TICKETS_DIR. Null if missing. */
export function screenshotToDataUrl(relPath) {
  if (!relPath || typeof relPath !== 'string') return null;
  const root = resolve(TICKETS_DIR);
  const abs = resolve(join(root, relPath));
  if (abs !== root && !abs.startsWith(root + '/')) return null; // reject traversal
  if (!existsSync(abs)) return null;
  const ext = (abs.split('.').pop() ?? '').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
  try {
    const buf = readFileSync(abs);
    if (buf.length > MAX_SHOT_BYTES) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

// Neutralize Slack mrkdwn control chars so user-submitted text can't inject
// broadcast tokens (<!channel>, <!here>) or user mentions (<@U…>) into the alert.
const slackEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Per-type Slack identity — the bot names + icons itself by what came in, so the
// channel is scannable at a glance.
const TYPE_SLACK_META = {
  bug:     { label: 'bug',     emoji: '🐞', username: 'Atlas · Bug Report',   icon: ':lady_beetle:' },
  idea:    { label: 'idea',    emoji: '💡', username: 'Atlas · Feature Idea', icon: ':bulb:' },
  request: { label: 'request', emoji: '✨', username: 'Atlas · Request',       icon: ':sparkles:' },
};

async function postSlack(token, payload) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({ ok: false, error: 'bad_response' }));
}

/** Build the Block Kit message for a new ticket: type-named bot, session metadata,
 *  and a button linking straight to the ticket in the admin app. */
export function buildTicketSlackMessage(ticket, ticketUrl) {
  const meta = TYPE_SLACK_META[ticket.type] ?? TYPE_SLACK_META.bug;
  const ctx = ticket.context ?? {};
  const sev = ticket.type === 'bug' && ticket.severity ? ` · ${ticket.severity}` : '';
  const workspace = slackEscape(ctx.tenantName ?? ticket.tenant_id);
  const who = slackEscape(ticket.user_name
    ? `${ticket.user_name} (${ticket.user_email ?? ticket.user_id})`
    : (ticket.user_email ?? ticket.user_id));
  const where = slackEscape([ctx.surface, ctx.phase].filter(Boolean).join(' · ') || '—');
  const errN = Array.isArray(ctx.consoleErrors) ? ctx.consoleErrors.length : 0;
  const netN = Array.isArray(ctx.networkErrors) ? ctx.networkErrors.length : 0;
  const safeUrl = (ctx.url && /^https?:\/\//.test(ctx.url)) ? ctx.url.replace(/[<>|]/g, '') : null;

  const contextBits = [
    safeUrl ? `<${safeUrl}|page>` : null,
    ctx.viewport ? slackEscape(ctx.viewport) : null,
    ctx.appVersion ? `v${slackEscape(ctx.appVersion)}` : null,
    `${errN} console err${errN === 1 ? '' : 's'}`,
    `${netN} failed req${netN === 1 ? '' : 's'}`,
    ctx.workflowId ? `wf \`${slackEscape(ctx.workflowId)}\`` : null,
    `\`${ticket.id}\``,
  ].filter(Boolean).join('   ·   ');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${meta.emoji} New ${meta.label}${sev}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${slackEscape(ticket.title)}*` } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Workspace*\n${workspace}` },
      { type: 'mrkdwn', text: `*From*\n${who}` },
      { type: 'mrkdwn', text: `*Where*\n${where}` },
      { type: 'mrkdwn', text: `*App version*\n${slackEscape(ctx.appVersion ?? '—')}` },
    ] },
    { type: 'section', text: { type: 'mrkdwn', text: slackEscape(ticket.description).slice(0, 600) || '_(no description)_' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: contextBits }] },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open ticket in admin  →', emoji: true }, url: ticketUrl, style: 'primary' }] },
  ];

  return {
    username: meta.username,
    icon_emoji: meta.icon,
    text: `${meta.emoji} New ${meta.label}${sev}: ${slackEscape(ticket.title)}`, // notification-preview fallback
    blocks,
  };
}

/** Best-effort team alert on a new ticket. Never throws into the request path. */
async function notifyTeam(spine, ticket) {
  const base = oauthRedirectBase();
  const adminUrl = `${base}/admin`;
  const ticketUrl = `${adminUrl}?ticket=${encodeURIComponent(ticket.id)}`;

  // Slack → the internal Agntic workspace (platform bot), not the customer's.
  const channel = process.env.SUPPORT_SLACK_CHANNEL;
  const token = process.env.SLACK_BOT_TOKEN;
  if (channel && token) {
    try {
      const msg = buildTicketSlackMessage(ticket, ticketUrl);
      const payload = { channel, unfurl_links: false, text: msg.text, blocks: msg.blocks, username: msg.username, icon_emoji: msg.icon_emoji };
      let r = await postSlack(token, payload);
      // Custom username/icon needs the chat:write.customize scope. If that's the
      // only blocker, re-post without them so the alert still lands.
      if (r && r.ok === false && /scope|customize|username|icon/i.test(r.error ?? '')) {
        const { username, icon_emoji, ...plain } = payload;
        r = await postSlack(token, plain);
      }
      if (r && r.ok === false) logEvent('tickets.notify.slack_error', { error: r.error, channel });
    } catch (err) { logEvent('tickets.notify.slack_error', errFields(err)); }
  }

  // Email → the support inbox, carrying the full brief (deep-linked to the ticket).
  const to = process.env.SUPPORT_EMAIL;
  if (to) {
    try {
      const brief = renderTicketBrief(ticket, { adminUrl: ticketUrl });
      await sendMail({ to, subject: `[Atlas] ${ticketGithubTitle(ticket)}`, text: brief });
    } catch (err) { logEvent('tickets.notify.email_error', errFields(err)); }
  }
}

export function mountTicketRoutes(app, { spine, requireActiveTenant }) {
  app.post('/api/tickets', requireActiveTenant, async (req, res) => {
    try {
      if (!spine.tickets) return res.status(503).json({ error: 'ticketing unavailable' });
      const b = req.body ?? {};
      const type = ['bug', 'idea', 'request'].includes(b.type) ? b.type : 'bug';

      // Validate BEFORE writing the screenshot so a bad request can't leave an
      // orphaned blob on disk (the store re-validates as the source of truth).
      const title = String(b.title ?? '').trim();
      const description = String(b.description ?? '').trim();
      if (!title) return res.status(400).json({ error: 'title is required' });
      if (!description) return res.status(400).json({ error: 'description is required' });

      let screenshotPath = null;
      if (typeof b.screenshot === 'string' && b.screenshot.startsWith('data:image/')) {
        try { screenshotPath = writeScreenshot(req.tenant.id, b.screenshot); }
        catch (err) { logEvent('tickets.screenshot.error', errFields(err)); }
      }

      let tenantName = null;
      try { tenantName = spine.auth.tenantStore.get(req.tenant.id)?.name ?? null; } catch { /* ignore */ }

      const clientCtx = (b.context && typeof b.context === 'object') ? b.context : {};
      const context = {
        ...clientCtx,
        appVersion: APP_VERSION,
        tenantName,
        userAgent: clientCtx.userAgent || req.headers['user-agent'] || null,
        receivedAt: new Date().toISOString(),
      };

      let ticket;
      try {
        ticket = spine.tickets.create({
          tenantId: req.tenant.id,
          userId: req.user.id,
          userEmail: req.user.email ?? null,
          userName: req.user.display_name ?? req.user.name ?? null,
          type,
          severity: b.severity ?? null,
          title,
          description,
          steps: b.steps ?? null,
          expected: b.expected ?? null,
          actual: b.actual ?? null,
          context,
          screenshotPath,
        });
      } catch (err) {
        // Don't leave the screenshot orphaned if the insert fails.
        if (screenshotPath) {
          try { unlinkSync(resolve(join(TICKETS_DIR, screenshotPath))); } catch { /* ignore */ }
        }
        throw err;
      }

      logEvent('tickets.created', {
        ticket: ticket.id, tenant: req.tenant.id, user: req.user.id,
        type: ticket.type, severity: ticket.severity, hasShot: !!screenshotPath,
      });

      // Fire-and-forget team alert — never blocks the user's confirmation.
      notifyTeam(spine, ticket).catch((err) => logEvent('tickets.notify.error', errFields(err)));

      res.json({ ok: true, id: ticket.id });
    } catch (err) {
      logEvent('tickets.create.error', errFields(err));
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });
}
