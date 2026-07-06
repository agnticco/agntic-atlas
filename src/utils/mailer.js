/**
 * mailer — minimal transactional email sender for system messages (password
 * reset, etc.). Provider-agnostic SMTP via nodemailer, configured entirely
 * through env so the operator can point it at Google Workspace (app password),
 * SendGrid/SES/Mailgun SMTP, or any host:
 *
 *   SMTP_HOST      smtp.gmail.com
 *   SMTP_PORT      587            (465 ⇒ implicit TLS)
 *   SMTP_SECURE    true|false     (defaults true when port is 465)
 *   SMTP_USER      login          (optional; omit for unauthenticated relays)
 *   SMTP_PASS      password / app-password
 *   MAIL_FROM      "Atlas <no-reply@your.co>"  (defaults to SMTP_USER)
 *
 * When SMTP_HOST is unset the sender is a no-op that logs server-side only —
 * the calling flow still succeeds, and it NEVER returns message contents to the
 * client (so e.g. a reset link is never leaked in an HTTP response).
 */

import nodemailer from 'nodemailer';
import { logEvent } from './event-log.js';

let _transport;

function transport() {
  if (_transport !== undefined) return _transport;
  const host = process.env.SMTP_HOST?.trim();
  if (!host) { _transport = null; return null; }
  const port = Number(process.env.SMTP_PORT) || 587;
  _transport = nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE != null ? String(process.env.SMTP_SECURE).toLowerCase() === 'true' : port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return _transport;
}

/** True when an SMTP host is configured (real email can be sent). */
export function mailerConfigured() { return !!process.env.SMTP_HOST?.trim(); }

/**
 * Send an email. Resolves { delivered } — false when SMTP is unconfigured
 * (dev fallback: logged server-side, nothing returned to callers).
 */
export async function sendMail({ to, subject, text, html }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || 'Atlas <no-reply@atlas.local>';
  const t = transport();
  if (!t) {
    logEvent('mail.unconfigured', { to, subject });
    console.log(`[mailer] SMTP not configured — email to ${to} not sent.\n  subject: ${subject}\n  ${text?.replace(/\n/g, '\n  ')}`);
    return { delivered: false };
  }
  try {
    await t.sendMail({ from, to, subject, text, html });
    logEvent('mail.sent', { to, subject });
    return { delivered: true };
  } catch (err) {
    logEvent('mail.error', { to, subject, error: err.message ?? String(err) });
    throw err;
  }
}
