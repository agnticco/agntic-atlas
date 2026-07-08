/**
 * ticket-brief.js — render a support ticket as a coding-agent-ready Markdown brief.
 *
 * The same brief is used two ways:
 *   1. "Copy / download brief" in the admin triage view (paste into a coding agent).
 *   2. The body of a filed GitHub issue.
 *
 * The goal is a self-contained hand-off: what/where/repro + the captured runtime
 * context (surface, versions, console + network logs) so a coding agent can act
 * without re-interviewing the user.
 *
 * @module src/support/ticket-brief.js
 */

const TYPE_LABEL = { bug: 'Bug', idea: 'Idea', request: 'Request' };

function fence(lang, body) {
  return '```' + lang + '\n' + body + '\n```';
}

function section(title, body) {
  if (body === null || body === undefined || String(body).trim() === '') return '';
  return `## ${title}\n\n${String(body).trim()}\n\n`;
}

/** One-line issue title, e.g. "[Bug · high] Save button does nothing on the console". */
export function ticketGithubTitle(t) {
  const type = TYPE_LABEL[t.type] ?? 'Ticket';
  const sev = t.type === 'bug' && t.severity ? ` · ${t.severity}` : '';
  return `[${type}${sev}] ${t.title}`.slice(0, 250);
}

/** GitHub labels derived from the ticket (caller filters to labels the repo actually has). */
export function ticketGithubLabels(t) {
  const labels = ['atlas-feedback', t.type];
  if (t.type === 'bug' && t.severity) labels.push(`sev:${t.severity}`);
  return labels;
}

/**
 * Render the full Markdown brief.
 * @param {object} t - a hydrated ticket (context parsed) from TicketStore
 * @param {object} [opts]
 * @param {string} [opts.screenshotUrl] - absolute/relative URL to the screenshot, if hosted
 * @param {string} [opts.adminUrl]      - link back to the ticket in the admin app
 */
export function renderTicketBrief(t, { screenshotUrl = null, adminUrl = null } = {}) {
  const ctx = t.context ?? {};
  let md = '';

  md += `# ${ticketGithubTitle(t)}\n\n`;

  // Metadata table.
  const meta = [
    ['Ticket', t.id],
    ['Type', TYPE_LABEL[t.type] ?? t.type],
    t.type === 'bug' ? ['Severity', t.severity ?? '—'] : null,
    ['Status', t.status],
    ['Submitted by', [t.user_name, t.user_email].filter(Boolean).join(' · ') || t.user_id],
    ['Workspace (tenant)', ctx.tenantName ? `${ctx.tenantName} (${t.tenant_id})` : t.tenant_id],
    ['Submitted at', t.created_at],
  ].filter(Boolean);
  md += '| Field | Value |\n|---|---|\n';
  for (const [k, v] of meta) md += `| ${k} | ${String(v ?? '—').replace(/\|/g, '\\|')} |\n`;
  md += '\n';

  md += section('Description', t.description);

  if (t.type === 'bug') {
    md += section('Steps to reproduce', t.steps);
    md += section('Expected', t.expected);
    md += section('Actual', t.actual);
  }

  // Environment / where it happened.
  const env = [
    ['App version', ctx.appVersion],
    ['Surface', ctx.surface ?? ctx.view],
    ['Builder phase', ctx.phase],
    ['Workflow id', ctx.workflowId],
    ['Console workflow id', ctx.consoleWfId],
    ['URL', ctx.url],
    ['Viewport', ctx.viewport],
    ['User agent', ctx.userAgent],
    ['Captured at', ctx.capturedAt],
  ].filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
  if (env.length) {
    md += '## Environment\n\n';
    for (const [k, v] of env) md += `- **${k}:** ${String(v).replace(/\n/g, ' ')}\n`;
    md += '\n';
  }

  // Console errors captured before submission.
  const errs = Array.isArray(ctx.consoleErrors) ? ctx.consoleErrors : [];
  if (errs.length) {
    const body = errs.map((e) => {
      const when = e.at ? `[${e.at}] ` : '';
      const where = e.source ? ` (${e.source}${e.line ? ':' + e.line : ''})` : '';
      return `${when}${e.message ?? e}${where}`;
    }).join('\n');
    md += section('Console errors', fence('text', body));
  }

  // Failed network requests.
  const net = Array.isArray(ctx.networkErrors) ? ctx.networkErrors : [];
  if (net.length) {
    const body = net.map((n) => {
      const when = n.at ? `[${n.at}] ` : '';
      return `${when}${n.method ?? 'GET'} ${n.url} → ${n.status ?? n.error ?? 'failed'}`;
    }).join('\n');
    md += section('Failed network requests', fence('text', body));
  }

  if (screenshotUrl) {
    md += `## Screenshot\n\n![screenshot](${screenshotUrl})\n\n`;
  } else if (t.hasScreenshot) {
    md += `## Screenshot\n\nA screenshot was attached — view it on the ticket in the Atlas admin app.\n\n`;
  }

  if (t.admin_notes && t.admin_notes.trim()) {
    md += section('Triage notes', t.admin_notes);
  }

  if (adminUrl) {
    md += `---\n\n[Open this ticket in Atlas admin](${adminUrl})\n`;
  }

  return md.trim() + '\n';
}
