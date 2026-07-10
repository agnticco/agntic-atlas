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
