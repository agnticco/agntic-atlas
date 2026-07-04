/**
 * ROI report generator (P11-QA Q08) — a customer-facing all-up ROI summary
 * derived from the /api/console/roi payload. Markdown out; the PDF path reuses
 * the SOP PDF pipeline (sop-pdf.js).
 *
 * generateRoiMarkdown(roi, { tenantName }) → string (Markdown)
 *   roi = { totalTimeSavedMinutes, totalRuns, byWorkflow[], generatedAt }
 */

function fmtDuration(minutes) {
  const m = Math.round(minutes || 0);
  if (m < 60) return `${m} min`;
  const hrs = m / 60;
  return (hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)) + ' hrs';
}

export function generateRoiMarkdown(roi, { tenantName = 'Your workspace' } = {}) {
  const r = roi ?? {};
  const rows = [...(r.byWorkflow ?? [])].sort((a, b) => (b.timeSavedMinutes ?? 0) - (a.timeSavedMinutes ?? 0));
  const generated = (r.generatedAt ?? '').slice(0, 10) || 'today';
  const lines = [];

  lines.push('# ROI Report');
  lines.push(`## ${tenantName}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| **Total time saved** | ${fmtDuration(r.totalTimeSavedMinutes)} |`);
  lines.push(`| **Automated runs** | ${r.totalRuns ?? 0} |`);
  lines.push(`| **Workflows tracked** | ${rows.length} |`);
  lines.push(`| **Generated** | ${generated} |`);
  lines.push('');
  lines.push('> Time saved is measured against a recorded baseline where one exists,');
  lines.push('> otherwise estimated per successful run. Test runs are excluded.');
  lines.push('');

  if (rows.length === 0) {
    lines.push('---');
    lines.push('');
    lines.push('_No completed runs yet — this report populates as your automations run._');
    return lines.join('\n');
  }

  lines.push('---');
  lines.push('');
  lines.push('## By workflow');
  lines.push('');
  lines.push('| Workflow | Runs | Time saved | Basis |');
  lines.push('|---|---:|---:|---|');
  for (const w of rows) {
    const basis = (w.baselineDurationS ?? 0) > 0 ? 'Measured' : 'Estimated';
    lines.push(`| ${w.name} | ${w.runs ?? 0} | ${fmtDuration(w.timeSavedMinutes)} | ${basis} |`);
  }
  lines.push('');
  return lines.join('\n');
}
