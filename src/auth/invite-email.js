/**
 * Workspace invite email — sent when a platform admin provisions a new tenant.
 * The invite link is a password-reset token issued with a longer TTL, so the new
 * admin sets their own password on first click (same /?reset= flow).
 *
 * Uses the email-client-safe branded template (table layout, inline styles,
 * Outlook VML button, light/dark variants) — the same design as the password
 * reset email. Reads the template once and substitutes the per-message values.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'invite-email.template.html');

let _tpl;
function template() { if (_tpl == null) _tpl = readFileSync(TEMPLATE_PATH, 'utf8'); return _tpl; }

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

/**
 * @param {object} p
 * @param {string} p.inviteLink     full set-password URL (already includes the token)
 * @param {string} p.userEmail      recipient (shown in the header)
 * @param {string} p.workspaceName  the tenant they've been added to
 * @param {string} p.base           public base URL, e.g. https://atlas.agntic.co
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderInviteEmail({ inviteLink, userEmail, workspaceName, base }) {
  const ws = workspaceName || 'your workspace';
  const assetsBase = `${String(base).replace(/\/+$/, '')}/assets`;

  const html = template()
    .split('{{assets_base}}').join(esc(assetsBase))
    .split('{{invite_link}}').join(esc(inviteLink))
    .split('{{user_email}}').join(esc(userEmail))
    .split('{{workspace_name}}').join(esc(ws));

  const text = [
    `You're invited to ${ws} on Atlas`,
    '',
    `You've been added to ${ws} on Atlas. Atlas builds your automations from`,
    'plain-language descriptions — you say what you want to happen, and it builds a',
    'workflow that runs it.',
    '',
    'Set your password to get started (this link is valid for 7 days):',
    inviteLink,
    '',
    "Not expecting this? You can safely ignore this email — no account is active",
    'until you set a password. Questions: hello@agntic.co',
    '',
    'Atlas · by Agntic',
  ].join('\n');

  return { subject: `You're invited to Atlas — set up ${ws}`, html, text };
}
