/**
 * Workspace invite email — sent when a platform admin provisions a new tenant.
 * The invite link is a password-reset token issued with a longer TTL, so the new
 * admin sets their own password on first click (same /?reset= flow). Mirrors
 * reset-email.js's escaping + envelope shape; self-contained HTML (no template).
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

/**
 * @param {object} p
 * @param {string} p.inviteLink     full set-password URL (already includes the token)
 * @param {string} p.userEmail      recipient
 * @param {string} p.workspaceName  the tenant they've been added to
 * @param {string} p.base           public base URL, e.g. https://atlas.agntic.co
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderInviteEmail({ inviteLink, userEmail, workspaceName, base }) {
  const ws   = workspaceName || 'your workspace';
  const link = esc(inviteLink);

  const subject = `You're invited to Atlas — set up ${ws}`;

  const text = [
    `You've been added to ${ws} on Atlas.`,
    '',
    'Atlas builds your automations by conversation — you describe what you want,',
    'and it builds a runnable workflow.',
    '',
    'Set your password to get started (this link is valid for 7 days):',
    inviteLink,
    '',
    'Questions? Just reply, or reach us at hello@agntic.co',
    '',
    'Atlas · by Agntic',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%;background:#ffffff;border-radius:16px;border:1px solid #e6e8ec;overflow:hidden;">
        <tr><td style="padding:32px 34px 8px;">
          <div style="font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#6b7bff;">Atlas</div>
        </td></tr>
        <tr><td style="padding:8px 34px 0;">
          <h1 style="margin:0;font-size:22px;line-height:1.25;color:#14161c;font-weight:700;">You're invited to ${esc(ws)}</h1>
          <p style="margin:14px 0 0;font-size:15px;line-height:1.6;color:#4a4f5e;">
            You've been added to a workspace on Atlas. Atlas builds your automations
            by conversation — just describe what you want, and it builds a runnable workflow.
          </p>
          <p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#4a4f5e;">
            Set your password to get started:
          </p>
        </td></tr>
        <tr><td style="padding:22px 34px 6px;">
          <a href="${link}" style="display:inline-block;background:#6b7bff;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 26px;border-radius:10px;">Set your password</a>
        </td></tr>
        <tr><td style="padding:14px 34px 0;">
          <p style="margin:0;font-size:12.5px;line-height:1.6;color:#8b90a3;">
            This link is valid for 7 days and can be used once. If the button doesn't work, copy this URL:<br>
            <span style="color:#6b7bff;word-break:break-all;">${link}</span>
          </p>
        </td></tr>
        <tr><td style="padding:24px 34px 32px;">
          <div style="border-top:1px solid #eceef1;padding-top:16px;font-size:12.5px;line-height:1.6;color:#8b90a3;">
            Questions? Just reply, or reach us at <a href="mailto:hello@agntic.co" style="color:#6b7bff;text-decoration:none;">hello@agntic.co</a>.<br>
            Atlas · by Agntic
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}
