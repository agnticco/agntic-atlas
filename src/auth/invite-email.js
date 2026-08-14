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
import { PLAN_META } from '../entitlements/index.js';
import { supportLineText, supportLineHtml } from '../utils/support-contact.js';

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'invite-email.template.html');

let _tpl;
function template() { if (_tpl == null) _tpl = readFileSync(TEMPLATE_PATH, 'utf8'); return _tpl; }

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

/** Human-readable one-liner of what a plan includes, e.g. "1 live automation · 30 runs/month · 1 user". */
function planSummary(meta) {
  const wf = meta.workflows === Infinity ? 'Unlimited automations' : `${meta.workflows} live automation${meta.workflows === 1 ? '' : 's'}`;
  const runs = `${Number(meta.runs).toLocaleString('en-US')} runs/month`;
  const users = meta.users === Infinity ? 'Unlimited users' : `${meta.users} user${meta.users === 1 ? '' : 's'}`;
  return `${wf} · ${runs} · ${users}`;
}

/** ISO → "Aug 21, 2026" (null-safe). */
function fmtDate(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  catch { return null; }
}

/** The branded plan callout row for the onboarding email (empty string when no plan). */
function planBlockHtml(plan, nextChargeIso = null) {
  const meta = PLAN_META[plan];
  if (!meta) return '';
  const summary = planSummary(meta);
  const next = fmtDate(nextChargeIso);
  const billing = next
    ? `Billed $${meta.price}/mo — renews ${esc(next)}. Cancel anytime in Account → Manage billing.`
    : `Billed $${meta.price}/mo — cancel anytime in Account → Manage billing.`;
  return `<tr>
            <td class="px" style="padding:28px 48px 0 48px;">
              <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F6F6F6" style="background:#F6F6F6; border:1px solid #E6E6E6; border-radius:12px;">
                <tr>
                  <td style="padding:20px 22px;">
                    <p class="mono txt-3" style="margin:0 0 6px 0; font-size:10px; letter-spacing:2px; text-transform:uppercase; color:#767676;">Your plan</p>
                    <p class="sans txt-primary" style="margin:0 0 3px 0; font-size:17px; line-height:22px; font-weight:600; color:#0A0A0A;">${esc(meta.label)} <span class="txt-3" style="color:#767676; font-weight:400;">— $${meta.price}/mo</span></p>
                    <p class="sans txt-2" style="margin:0 0 8px 0; font-size:14px; line-height:21px; color:#444444;">${esc(summary)}</p>
                    <p class="sans txt-3" style="margin:0; font-size:12.5px; line-height:19px; color:#767676;">${billing}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`;
}

/**
 * @param {object} p
 * @param {string} p.inviteLink     full set-password URL (already includes the token)
 * @param {string} p.userEmail      recipient (shown in the header)
 * @param {string} p.workspaceName  the tenant they've been added to
 * @param {string} p.base           public base URL, e.g. https://atlas.agntic.co
 * @param {string} [p.plan]         plan id (solo/professional/team/business/…) — when
 *                                  set, the email names the plan they're onboarding into.
 *                                  Passed for new-workspace onboarding; omitted for
 *                                  teammate invites to an existing workspace.
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderInviteEmail({ inviteLink, userEmail, workspaceName, base, plan = null, nextChargeIso = null }) {
  const ws = workspaceName || 'your workspace';
  const assetsBase = `${String(base).replace(/\/+$/, '')}/assets`;
  const meta = plan ? PLAN_META[plan] : null;

  const html = template()
    .split('{{assets_base}}').join(esc(assetsBase))
    .split('{{invite_link}}').join(esc(inviteLink))
    .split('{{user_email}}').join(esc(userEmail))
    .split('{{workspace_name}}').join(esc(ws))
    .split('{{plan_block}}').join(planBlockHtml(plan, nextChargeIso))
    .split('{{support_line}}').join(supportLineHtml());

  const text = [
    `You're invited to ${ws} on Atlas`,
    '',
    `You've been added to ${ws} on Atlas. Atlas builds your automations from`,
    'plain-language descriptions — you say what you want to happen, and it builds a',
    'workflow that runs it.',
    ...(meta ? ['', `Your plan: ${meta.label} — $${meta.price}/mo (${planSummary(meta)}).`] : []),
    '',
    'Set your password to get started (this link is valid for 7 days):',
    inviteLink,
    '',
    "Not expecting this? You can safely ignore this email — no account is active",
    'until you set a password.',
    // Conditional SPREAD, not a filter over the whole array: filtering empty
    // strings would also strip the deliberate blank lines that paragraph this
    // email, so an unconfigured support address would silently reformat it.
    ...(supportLineText() ? [supportLineText()] : []),
    '',
    'Atlas · by Agntic',
  ].join('\n');

  return { subject: `You're invited to Atlas — set up ${ws}`, html, text };
}
