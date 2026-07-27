/**
 * mailer — transactional email for system messages (password reset, etc.).
 *
 * Modes, chosen automatically in priority order:
 *
 *  0. Resend HTTP API (RESEND_API_KEY) — a dedicated transactional provider.
 *     Verify the sending domain on Resend (SPF/DKIM DNS records) and send from
 *     an address on it (MAIL_FROM). No Google credential; best deliverability.
 *
 *  1. Gmail API via a Google service account (GMAIL_SA_KEY_FILE + GMAIL_SEND_AS).
 *     A service account with domain-wide delegation impersonates a Workspace
 *     user and sends with the least-privilege `gmail.send` scope. Configure:
 *       GMAIL_SA_KEY_FILE   path to the service-account JSON key
 *                           (or GMAIL_SA_CLIENT_EMAIL + GMAIL_SA_PRIVATE_KEY)
 *       GMAIL_SEND_AS       the Workspace user to send as, e.g. hello@agntic.co
 *       MAIL_FROM           From header (defaults to GMAIL_SEND_AS)
 *     Admin console → API controls → Domain-wide delegation must authorise the
 *     service account's client ID for scope
 *     https://www.googleapis.com/auth/gmail.send.
 *
 *  2. Generic SMTP (SMTP_HOST/PORT/USER/PASS) via nodemailer — any provider.
 *
 *  3. Unconfigured: a no-op that logs server-side only. The calling flow still
 *     succeeds and nothing (e.g. a reset link) is returned to the client.
 */

import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import jwt from 'jsonwebtoken';
import { logEvent } from './event-log.js';

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL  = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_SCOPE     = 'https://www.googleapis.com/auth/gmail.send';

function gmailSendAs() { return process.env.GMAIL_SEND_AS?.trim(); }

/** Load the service-account { client_email, private_key } from env, or null. */
let _sa; // cache (undefined = not yet loaded)
function serviceAccount() {
  if (_sa !== undefined) return _sa;
  try {
    const file = process.env.GMAIL_SA_KEY_FILE?.trim();
    if (file) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (!j.client_email || !j.private_key) throw new Error('key file missing client_email/private_key');
      _sa = { client_email: j.client_email, private_key: j.private_key };
    } else if (process.env.GMAIL_SA_CLIENT_EMAIL && process.env.GMAIL_SA_PRIVATE_KEY) {
      _sa = { client_email: process.env.GMAIL_SA_CLIENT_EMAIL, private_key: process.env.GMAIL_SA_PRIVATE_KEY.replace(/\\n/g, '\n') };
    } else {
      _sa = null;
    }
  } catch (err) {
    // Configured but unreadable (e.g. key not provisioned yet) → fall back, don't crash.
    logEvent('mail.sa.load_error', { error: err.message ?? String(err) });
    _sa = null;
  }
  return _sa;
}

function mode() {
  if (process.env.RESEND_API_KEY?.trim()) return 'resend';
  if (serviceAccount() && gmailSendAs()) return 'gmail-sa';
  if (process.env.SMTP_HOST?.trim()) return 'smtp';
  return 'none';
}

// ── Resend (HTTP API) ────────────────────────────────────────────────────────
async function sendViaResend({ from, to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  if (!res.ok) throw new Error(`resend send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/**
 * True when real email can be sent — i.e. ANY sender is configured: Resend
 * (the currently active mode), Gmail service-account, or SMTP. The old comment
 * here listed only Gmail-SA and SMTP and so read as "Resend is not covered",
 * which is the opposite of the truth (2026-07-27).
 *
 * This is also a SAFETY ASSERTION, not only a capability flag: the test gate
 * requires it to be false in every process it starts (scripts/gates/_no-mail.sh,
 * tests/gates/gate-cannot-send-mail.test.js). Any new sending mode must be added
 * to `mode()` above AND to that script's blanked variable list, or the gate can
 * silently email real people again.
 */
export function mailerConfigured() { return mode() !== 'none'; }

// ── Gmail API (service account, domain-wide delegation) ──────────────────────
let _token = { value: null, exp: 0 };
async function gmailAccessToken() {
  if (_token.value && Date.now() < _token.exp - 60_000) return _token.value;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, sub: gmailSendAs(), scope: GMAIL_SCOPE, aud: GMAIL_TOKEN_URL, iat: now, exp: now + 3600 },
    sa.private_key, { algorithm: 'RS256' },
  );
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error(`gmail token exchange failed: ${data.error_description || data.error || res.status}`);
  _token = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return _token.value;
}

function buildMime(opts) {
  return new Promise((resolve, reject) => {
    new MailComposer(opts).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
}

async function sendViaGmailApi({ from, to, subject, text, html }) {
  const mime = await buildMime({ from, to, subject, text, html });
  const raw = mime.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = await gmailAccessToken();
  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`gmail send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

// ── SMTP (nodemailer) ────────────────────────────────────────────────────────
let _smtp;
function smtpTransport() {
  if (_smtp !== undefined) return _smtp;
  const host = process.env.SMTP_HOST?.trim();
  if (!host) { _smtp = null; return null; }
  const port = Number(process.env.SMTP_PORT) || 587;
  _smtp = nodemailer.createTransport({
    host, port,
    secure: process.env.SMTP_SECURE != null ? String(process.env.SMTP_SECURE).toLowerCase() === 'true' : port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return _smtp;
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function sendMail({ to, subject, text, html }) {
  const from = process.env.MAIL_FROM || gmailSendAs() || process.env.SMTP_USER || 'Atlas <no-reply@atlas.local>';
  const m = mode();
  try {
    if (m === 'resend') {
      await sendViaResend({ from, to, subject, text, html });
      logEvent('mail.sent', { to, subject, via: 'resend' });
      return { delivered: true };
    }
    if (m === 'gmail-sa') {
      await sendViaGmailApi({ from, to, subject, text, html });
      logEvent('mail.sent', { to, subject, via: 'gmail-api' });
      return { delivered: true };
    }
    if (m === 'smtp') {
      await smtpTransport().sendMail({ from, to, subject, text, html });
      logEvent('mail.sent', { to, subject, via: 'smtp' });
      return { delivered: true };
    }
    // Unconfigured — dev fallback (server-side log only).
    logEvent('mail.unconfigured', { to, subject });
    console.log(`[mailer] email not sent (no sender configured). to=${to} subject="${subject}"\n  ${text?.replace(/\n/g, '\n  ')}`);
    return { delivered: false };
  } catch (err) {
    logEvent('mail.error', { to, subject, via: m, error: err.message ?? String(err) });
    throw err;
  }
}
