/**
 * Purchase notifications — mirrors the support-ticket alert (src/api/tickets.js):
 * a Block Kit Slack message + a plaintext email, best-effort, never throws into the
 * webhook path. Fires when a Stripe checkout completes (a new paid subscription).
 *
 * Lands in the SAME place as feedback by default — reuses SUPPORT_SLACK_CHANNEL /
 * SUPPORT_EMAIL (and SLACK_BOT_TOKEN). Set BILLING_SLACK_CHANNEL / BILLING_EMAIL to
 * route purchases somewhere separate.
 */

import { sendMail } from '../utils/mailer.js';
import { logEvent, errFields } from '../utils/event-log.js';

// Neutralize Slack mrkdwn control chars (mirror of tickets.js) so nothing in a
// customer-controlled field can inject mentions/broadcast tokens into the alert.
const slackEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function money(cents, currency) {
  if (cents == null) return '—';
  try {
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: String(currency || 'usd').toUpperCase() });
  } catch { return `${(cents / 100).toFixed(2)} ${String(currency || 'usd').toUpperCase()}`; }
}

async function postSlack(token, payload) {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({ ok: false, error: 'bad_response' }));
}

/** Block Kit message for a new subscription — same visual grammar as the ticket alert. */
export function buildPurchaseSlackMessage(p, adminUrl) {
  const amount = money(p.amountCents, p.currency);
  const workspace = slackEscape(p.tenantName ?? p.tenantId);
  const who = slackEscape(p.email ?? '—');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `🎉 New subscription — ${p.planLabel}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${slackEscape(p.planLabel)}*  ·  *${amount}/mo*` } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Workspace*\n${workspace}` },
      { type: 'mrkdwn', text: `*Customer*\n${who}` },
      { type: 'mrkdwn', text: `*Plan*\n${slackEscape(p.plan)}` },
      { type: 'mrkdwn', text: `*MRR*\n${amount}` },
    ] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: [
      `tenant \`${slackEscape(p.tenantId)}\``,
      p.subscriptionId ? `sub \`${slackEscape(p.subscriptionId)}\`` : null,
    ].filter(Boolean).join('   ·   ') }] },
    ...(adminUrl ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in admin  →', emoji: true }, url: adminUrl, style: 'primary' }] }] : []),
  ];

  return {
    username: 'Atlas · New Subscription',
    icon_emoji: ':moneybag:',
    text: `🎉 New subscription — ${slackEscape(p.planLabel)} (${amount}/mo) · ${workspace}`, // notification-preview fallback
    blocks,
  };
}

/**
 * Best-effort team alert on a new paid subscription. Never throws.
 * @param {object} p { tenantName, tenantId, plan, planLabel, amountCents, currency, email, subscriptionId, adminBase }
 */
export async function notifyPurchase(p) {
  const adminUrl = p.adminBase ? `${String(p.adminBase).replace(/\/+$/, '')}/admin` : null;

  // Slack → the internal Agntic workspace (platform bot). Falls back to the support
  // channel so purchases and feedback land together unless BILLING_* is set.
  const channel = process.env.BILLING_SLACK_CHANNEL || process.env.SUPPORT_SLACK_CHANNEL;
  const token = process.env.SLACK_BOT_TOKEN;
  if (channel && token) {
    try {
      const msg = buildPurchaseSlackMessage(p, adminUrl);
      const payload = { channel, unfurl_links: false, text: msg.text, blocks: msg.blocks, username: msg.username, icon_emoji: msg.icon_emoji };
      let r = await postSlack(token, payload);
      // Custom username/icon needs chat:write.customize. If that's the only blocker,
      // re-post without them so the alert still lands.
      if (r && r.ok === false && /scope|customize|username|icon/i.test(r.error ?? '')) {
        const { username, icon_emoji, ...plain } = payload;
        r = await postSlack(token, plain);
      }
      if (r && r.ok === false) logEvent('billing.notify.slack_error', { error: r.error, channel });
    } catch (err) { logEvent('billing.notify.slack_error', errFields(err)); }
  }

  const to = process.env.BILLING_EMAIL || process.env.SUPPORT_EMAIL;
  if (to) {
    try {
      const amount = money(p.amountCents, p.currency);
      const body = [
        'New Atlas subscription',
        '',
        `Plan:      ${p.planLabel} (${p.plan})`,
        `Amount:    ${amount}/mo`,
        `Workspace: ${p.tenantName ?? p.tenantId} (${p.tenantId})`,
        `Customer:  ${p.email ?? '—'}`,
        p.subscriptionId ? `Sub:       ${p.subscriptionId}` : null,
        adminUrl ? '' : null,
        adminUrl ? `Admin: ${adminUrl}` : null,
      ].filter((x) => x != null).join('\n');
      await sendMail({ to, subject: `[Atlas] New subscription — ${p.planLabel} (${amount}/mo)`, text: body });
    } catch (err) { logEvent('billing.notify.email_error', errFields(err)); }
  }
}

/**
 * Customer-facing purchase confirmation — sent to the buyer so they know what they
 * bought and how to cancel. Best-effort, never throws.
 * @param {object} c { to, name, plan, planLabel, amountCents, currency, appBase }
 */
export async function sendPurchaseConfirmation(c) {
  if (!c.to) return;
  const amount = money(c.amountCents, c.currency);
  const app = c.appBase ? String(c.appBase).replace(/\/+$/, '') : null;
  const hi = c.name ? `Hi ${c.name},` : 'Hi,';

  const text = [
    hi,
    '',
    'Thanks for subscribing to Atlas — your plan is active.',
    '',
    `  Plan:    ${c.planLabel}`,
    `  Price:   ${amount} / month`,
    '  Renews:  Monthly, until you cancel',
    '',
    'Manage or cancel anytime:',
    'Sign in to Atlas, open Account settings, and click "Manage billing" to update',
    'your payment method or cancel. If you cancel, you keep access through the end of',
    'the period you\'ve already paid for.',
    ...(app ? ['', `  ${app}`] : []),
    '',
    'Questions or need a hand? Just reply to this email, or reach us at hello@agntic.co.',
    '',
    '— The Atlas team',
  ].join('\n');

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;line-height:1.55">
  <p style="margin:0 0 14px">${esc(hi)}</p>
  <p style="margin:0 0 16px">Thanks for subscribing to Atlas — your plan is active.</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e6e6e6;border-radius:10px;background:#f7f7f8;margin:0 0 18px">
    <tr><td style="padding:16px 18px;font-size:14px">
      <div style="margin:0 0 6px"><strong>Plan</strong> &nbsp; ${esc(c.planLabel)}</div>
      <div style="margin:0 0 6px"><strong>Price</strong> &nbsp; ${esc(amount)} / month</div>
      <div><strong>Renews</strong> &nbsp; Monthly, until you cancel</div>
    </td></tr>
  </table>
  <p style="margin:0 0 6px;font-weight:600">Manage or cancel anytime</p>
  <p style="margin:0 0 16px;font-size:14px">Sign in to Atlas, open <strong>Account settings</strong>, and click <strong>Manage billing</strong> to update your payment method or cancel. If you cancel, you keep access through the end of the period you've already paid for.</p>
  ${app ? `<p style="margin:0 0 20px"><a href="${esc(app)}" style="display:inline-block;background:#0A0A0C;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:9px">Open Atlas</a></p>` : ''}
  <p style="margin:0;font-size:13px;color:#666">Questions? Reply to this email, or reach us at <a href="mailto:hello@agntic.co" style="color:#666">hello@agntic.co</a>.</p>
  <p style="margin:14px 0 0;font-size:13px;color:#666">— The Atlas team</p>
</div>`;

  try {
    await sendMail({ to: c.to, subject: `Your Atlas subscription — ${c.planLabel}`, text, html });
  } catch (err) { logEvent('billing.confirm.email_error', errFields(err)); }
}
