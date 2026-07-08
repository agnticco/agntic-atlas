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

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

/** Best-effort team alert on a new ticket. Never throws into the request path. */
async function notifyTeam(spine, ticket) {
  const base = oauthRedirectBase();
  const adminUrl = `${base}/admin`;
  const who = ticket.user_email ?? ticket.user_id;
  const workspace = ticket.context?.tenantName ?? ticket.tenant_id;
  const sev = ticket.type === 'bug' && ticket.severity ? ` (${ticket.severity})` : '';

  // Slack → the internal Agntic workspace (platform bot), not the customer's.
  const channel = process.env.SUPPORT_SLACK_CHANNEL;
  const token = process.env.SLACK_BOT_TOKEN;
  if (channel && token) {
    const text = [
      `🆕 New ${ticket.type}${sev}: *${ticket.title}*`,
      `${workspace} · ${who}`,
      ticket.description.slice(0, 400),
      `<${adminUrl}|Open in Atlas admin>`,
    ].join('\n');
    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel, text, unfurl_links: false }),
      });
    } catch (err) { logEvent('tickets.notify.slack_error', errFields(err)); }
  }

  // Email → the support inbox, carrying the full brief.
  const to = process.env.SUPPORT_EMAIL;
  if (to) {
    try {
      const brief = renderTicketBrief(ticket, { adminUrl });
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

      const ticket = spine.tickets.create({
        tenantId: req.tenant.id,
        userId: req.user.id,
        userEmail: req.user.email ?? null,
        userName: req.user.display_name ?? req.user.name ?? null,
        type,
        severity: b.severity ?? null,
        title: b.title,
        description: b.description,
        steps: b.steps ?? null,
        expected: b.expected ?? null,
        actual: b.actual ?? null,
        context,
        screenshotPath,
      });

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
