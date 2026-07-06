/**
 * Password-reset email content. Reads the email-client-safe HTML template
 * (table layout, inline styles, Outlook VML button, dark-mode variants) once
 * and substitutes the per-message values. Images are hosted on the app (same
 * public base as the reset link) so the email stays lightweight.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'reset-email.template.html');

let _tpl;
function template() { if (_tpl == null) _tpl = readFileSync(TEMPLATE_PATH, 'utf8'); return _tpl; }

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

/**
 * @param {object} p
 * @param {string} p.resetLink  full reset URL (already includes the token)
 * @param {string} p.userEmail  recipient (shown in the header)
 * @param {string} p.base       public base URL, e.g. https://dev.agntic.co
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderResetEmail({ resetLink, userEmail, base }) {
  const assetsBase = `${String(base).replace(/\/+$/, '')}/assets`;
  const html = template()
    .split('{{assets_base}}').join(esc(assetsBase))
    .split('{{reset_link}}').join(esc(resetLink))
    .split('{{user_email}}').join(esc(userEmail));

  const text = [
    'Reset your Atlas password',
    '',
    'We got a request to reset the password on your Atlas account. Open this',
    'link to choose a new one (valid for 30 minutes):',
    resetLink,
    '',
    'For your security this link works once and expires shortly. If it lapses,',
    'request a new reset from the sign-in screen.',
    '',
    "Didn't request this? You can safely ignore this email — your password",
    'stays exactly as it is. Questions: hello@agntic.co',
    '',
    'Atlas · by Agntic',
  ].join('\n');

  return { subject: 'Reset your Atlas password', html, text };
}
