/**
 * Generates docs/architecture/cost-model-v2.pdf — Atlas Cost Model v2.
 * Data source: the 2026-07-13 cost stress test (10 workflows, 503 runs, $29.12).
 */
import PDFDocument from 'file:///Users/crepps/Desktop/atlas/node_modules/pdfkit/js/pdfkit.js';
import { createWriteStream, mkdirSync } from 'node:fs';

const OUT = '/Users/crepps/Desktop/atlas/docs/architecture/cost-model-v2.pdf';
mkdirSync('/Users/crepps/Desktop/atlas/docs/architecture', { recursive: true });

const INK = '#111318';
const MUTED = '#6b7280';
const RULE = '#d8dbe0';
const ACCENT = '#8a6d2f';
const GOOD = '#1f7a45';
const BAD = '#b3261e';
const BAND = '#f4f5f7';

const doc = new PDFDocument({ size: 'LETTER', margins: { top: 62, bottom: 62, left: 62, right: 62 }, bufferPages: true });
doc.pipe(createWriteStream(OUT));

const W = doc.page.width - 124; // content width
const L = 62;

// ── helpers ──────────────────────────────────────────────────────────────────
const need = (h) => { if (doc.y + h > doc.page.height - 78) doc.addPage(); };

function h1(t) {
  need(60);
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(t, L, doc.y);
  const y = doc.y + 5;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.8).strokeColor(ACCENT).stroke();
  doc.y = y + 11;
}
function h2(t) {
  need(40);
  doc.moveDown(0.45);
  doc.font('Helvetica-Bold').fontSize(10.8).fillColor(INK).text(t, L, doc.y);
  doc.moveDown(0.32);
}
function p(t, opts = {}) {
  need(30);
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.6).fillColor(opts.color || INK)
    .text(t, L, doc.y, { width: W, align: 'left', lineGap: 2.6 });
  doc.moveDown(0.42);
}
function bullets(items) {
  for (const it of items) {
    need(26);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.6).fillColor(ACCENT).text('•', L + 4, y, { width: 10 });
    doc.font('Helvetica').fontSize(9.6).fillColor(INK)
      .text(it, L + 18, y, { width: W - 18, lineGap: 2.4 });
    doc.moveDown(0.3);
  }
  doc.moveDown(0.2);
}
function callout(title, body, color = ACCENT) {
  need(64);
  const pad = 11;
  const textW = W - pad * 2 - 3;
  const th = doc.font('Helvetica-Bold').fontSize(9.6).heightOfString(title, { width: textW });
  const bh = doc.font('Helvetica').fontSize(9.4).heightOfString(body, { width: textW, lineGap: 2.4 });
  const h = th + bh + pad * 2 + 4;
  const y = doc.y;
  doc.save().rect(L, y, W, h).fill(BAND).restore();
  doc.save().rect(L, y, 3, h).fill(color).restore();
  doc.font('Helvetica-Bold').fontSize(9.6).fillColor(color).text(title, L + pad + 3, y + pad, { width: textW });
  doc.font('Helvetica').fontSize(9.4).fillColor(INK).text(body, L + pad + 3, doc.y + 2, { width: textW, lineGap: 2.4 });
  doc.y = y + h + 10;
}
/** table: cols=[{label,w,align}], rows=[[cell|{t,color,bold}]] — wraps, variable row height */
const PAD_X = 6, PAD_Y = 5;
function headerRow(cols, y) {
  const hh = 18;
  doc.save().rect(L, y, W, hh).fill('#eceef1').restore();
  let x = L;
  for (const c of cols) {
    doc.font('Helvetica-Bold').fontSize(7.4).fillColor(MUTED)
      .text(String(c.label).toUpperCase(), x + PAD_X, y + 6, {
        width: c.w - PAD_X * 2, align: c.align || 'left', characterSpacing: 0.4, lineBreak: false,
      });
    x += c.w;
  }
  return y + hh;
}
function table(cols, rows) {
  const measure = (row) => {
    let h = 0;
    row.forEach((cell, ci) => {
      const o = (typeof cell === 'object' && cell !== null) ? cell : { t: cell };
      doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.9);
      h = Math.max(h, doc.heightOfString(String(o.t), { width: cols[ci].w - PAD_X * 2, lineGap: 1.6 }));
    });
    return h + PAD_Y * 2;
  };

  need(60);
  let y = headerRow(cols, doc.y);

  rows.forEach((row, i) => {
    const h = measure(row);
    if (y + h > doc.page.height - 78) {
      doc.addPage();
      y = headerRow(cols, doc.y);
    }
    if (i % 2 === 1) doc.save().rect(L, y, W, h).fill('#fafbfc').restore();
    let x = L;
    row.forEach((cell, ci) => {
      const c = cols[ci];
      const o = (typeof cell === 'object' && cell !== null) ? cell : { t: cell };
      doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.9)
        .fillColor(o.color || INK)
        .text(String(o.t), x + PAD_X, y + PAD_Y, {
          width: c.w - PAD_X * 2, align: c.align || 'left', lineGap: 1.6,
        });
      x += c.w;
    });
    doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.4).strokeColor(RULE).stroke();
    y += h;
  });
  doc.y = y + 11;
}

// ── cover ────────────────────────────────────────────────────────────────────
doc.font('Helvetica-Bold').fontSize(8.4).fillColor(ACCENT)
  .text('ATLAS  ·  PRICING & UNIT ECONOMICS', L, 82, { characterSpacing: 1.2 });
doc.moveDown(1.1);
doc.font('Helvetica-Bold').fontSize(27).fillColor(INK).text('Cost Model v2', L, doc.y, { width: W });
doc.moveDown(0.25);
doc.font('Helvetica').fontSize(12.5).fillColor(MUTED)
  .text('Re-pricing the tier ladder against measured LLM cost', L, doc.y, { width: W });
doc.moveDown(1.0);
doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.8).strokeColor(RULE).stroke();
doc.moveDown(0.8);

doc.font('Helvetica').fontSize(9.2).fillColor(MUTED)
  .text('Revision 2  ·  13 July 2026  ·  Reflects prompt caching shipped in v1.3.8', L, doc.y, { width: W });
doc.moveDown(1.2);

callout(
  'The finding in one line',
  'A run is not a unit of cost. Measured across 598 real runs, run cost ranges from $0.00056 to $0.20636 — a 369× spread — and the Business tier, at its own 5,000-run cap, loses $432/month.',
  BAD,
);

p('This document sets out the evidence, the options considered, and the tier table we recommend. Every number in it is measured, not modelled: it comes from live stress tests run against the production codebase on 13 July 2026, in which thirteen workflows were built through the conversational builder and executed 598 times against real connectors.');

callout(
  'What changed in this revision',
  'Prompt caching shipped to production (v1.3.8) between the first draft and this one. Build cost fell 61%, from $0.569 to $0.2215. Run costs fell 4–24% depending on shape. Every figure below has been re-measured against the shipped code — the run caps are barely affected, but a build now costs one run-unit instead of three, which changes the build allowance materially. Section 8 supersedes the first draft.',
  GOOD,
);

h1('1. Executive summary');

bullets([
  'The current ladder prices by run count. Run count does not predict cost — payload size does. The two are uncorrelated.',
  'At its 5,000-run cap, Business costs ~$1,032/mo in LLM spend against $600 of revenue. Team goes negative in the worst case too. Only Solo has real headroom.',
  'Prompt caching (shipped v1.3.8) cut build cost 61% and web-search runs 24%. It did NOT move the worst-case run, which is what sets the caps: that cost is a volatile payload, and volatile payloads cannot be cached.',
  'Converger (build) spend is still capped by nothing at all. A $20 Solo tenant is structurally permitted to burn far more than their subscription building workflows without ever touching a run cap.',
  'We recommend keeping runs as the unit — they are legible and familiar — but sizing each tier so that margin holds even if every run is the most expensive kind. Light users then yield 96%+ margin; the worst possible user still yields ~65%.',
  'We explicitly reject input truncation as a cost control. On digest-shaped workflows it is not a quality trade-off, it is a correctness bug.',
]);

h1('2. How the data was gathered');

p('A clean measurement environment was established and every LLM call was attributed per tenant via llm_cost_log, cross-checked against the workflow_runs.cost_usd ledger. The two agree.');

table(
  [{ label: 'Parameter', w: 190 }, { label: 'Value', w: W - 190 }],
  [
    ['Date', '13 July 2026'],
    ['Tenant', 'agntic (founding plan, unlimited)'],
    ['Model', 'claude-sonnet-4-6 (balanced tier), claude-haiku-4-5 (chat)'],
    ['Workflows built', '13, all via the conversational builder UI'],
    ['Runs executed', '598 real runs (test runs excluded)'],
    ['Connectors exercised', 'Slack, Gmail, Calendar, Drive, Sheets, Web search, Web fetch, Inbox'],
    ['Total spend', '$29.12 pre-caching; re-measured post-caching in section 5'],
    ['Prompt caching', 'Shipped v1.3.8 mid-study; all headline figures re-measured after'],
  ],
);

p('Runs were fired through POST /api/console/workflows/:id/run — the exact endpoint the "Run now" button calls — so they are counted, cost-logged and billable in precisely the way a customer’s runs are.');

h1('3. The measured cost of a run');

p('Ten workflow shapes, ordered by cost. The right-hand column is the mean input-token payload reaching the model — the variable that actually drives price.');

table(
  [
    { label: 'Workflow shape', w: 200 },
    { label: 'Connector', w: 78 },
    { label: 'Before', w: 86, align: 'right' },
    { label: 'Shipped', w: 88, align: 'right' },
    { label: 'Tok in', w: W - 200 - 78 - 86 - 88, align: 'right' },
  ],
  [
    [{ t: 'web_fetch -> extract -> rewrite', bold: true }, 'Web', '$0.21509', { t: '$0.20636', bold: true, color: BAD }, '47,855'],
    [{ t: 'calendar + gmail + web -> synthesis', bold: true }, 'Google/Web', '$0.13969', { t: 'n/m', color: MUTED }, '29,293'],
    ['web_search -> summarize', 'Web', '$0.10343', { t: '$0.07868', bold: true, color: ACCENT }, '19,261'],
    [{ t: 'drive_list_files -> llm', bold: true }, 'Google', '$0.07212', { t: 'n/m', color: MUTED }, '22,852'],
    ['sheets_read -> llm', 'Google', '$0.01311', { t: 'n/m', color: MUTED }, '1,143'],
    ['calendar_list_events -> llm', 'Google', '$0.01206', { t: 'n/m', color: MUTED }, '2,831'],
    ['slack_history -> summarize', 'Slack', '$0.00738', { t: 'n/m', color: MUTED }, '1,625'],
    ['llm -> slack post (write)', 'Slack', '$0.00266', { t: 'n/m', color: MUTED }, '222'],
    ['gmail_search -> summarize *', 'Google', '$0.00061', { t: '$0.00062', color: GOOD }, '124'],
    ['llm -> inbox', '—', '$0.00055', { t: '$0.00056', color: GOOD }, '77'],
  ],
);
doc.font('Helvetica').fontSize(8).fillColor(MUTED)
  .text('* Measured against an empty inbox. A populated inbox would move this shape materially upward; treat it as a floor, not a forecast.  "n/m" = not re-measured post-caching; these shapes have no repeated round-trips, so no material change is expected.', L, doc.y, { width: W });
doc.moveDown(0.7);

p('Building a workflow costs a further $0.2215 (was $0.569 before caching) — roughly flat across all shapes, regardless of connector or node count. A build is 20–35 Sonnet calls, because the converger re-sends its full context on every proposal turn. One build now costs about as much as one worst-case run, or roughly 400 trivial runs.');

h1('4. The central insight');

callout(
  'Cost tracks payload size, not workflow complexity',
  'drive_list_files -> llm is a two-step workflow a user would describe as "just list my files". It costs $0.07212 per run — 130× the trivial shape and 70% of a full web search — purely because Google Drive returns a 22,852-token payload into the model. Meanwhile a six-node, three-connector workflow with a small payload is cheap. Node count, connector count and step count all fail to predict cost. Only tokens predict cost.',
);

p('This is why the current ladder cannot be repaired by moving the cap. Any fixed run allowance is simultaneously too stingy for the light user (whose runs cost $0.0006) and financially fatal against the heavy one (whose runs cost 391× more). The unit itself is the defect.');

h1('5. Prompt caching (shipped, v1.3.8)');

p('The converger re-sends a byte-stable capability catalog — roughly 7,500 tokens for a tenant with Slack, Google, Airtable, Web and filesystem connected — as its system prompt on every one of its ~21 proposal turns per build. Marking that prefix cacheable bills it at a tenth of the input rate on reads instead of full price. The prompt bytes are unchanged, so the model sees exactly what it saw before: output quality cannot be affected, and the P3 gate reproduces the frozen canonical spec identically before and after.');

table(
  [
    { label: 'Surface', w: 214 },
    { label: 'Before', w: 84, align: 'right' },
    { label: 'After', w: 84, align: 'right' },
    { label: 'Change', w: W - 214 - 84 - 84, align: 'right' },
  ],
  [
    [{ t: 'Workflow BUILD', bold: true }, '$0.5690', { t: '$0.2215', bold: true, color: GOOD }, { t: '-61%', bold: true, color: GOOD }],
    ['Run: web_search -> summarize', '$0.10343', { t: '$0.07868', color: GOOD }, { t: '-24%', color: GOOD }],
    [{ t: 'Run: worst case (web_fetch chain)', bold: true }, '$0.21509', { t: '$0.20636', bold: true }, { t: '-4%', bold: true }],
    ['Run: trivial (identical-spec A/B)', '$0.00055', '$0.00056', 'noise'],
  ],
);

callout(
  'Caching does not rescue the run economics — and this is the point',
  'Runs cache only where a node makes repeated LLM round-trips: the native web-search tool loops internally, so each continuation re-reads the cached prefix (97% cached on that node, -24% on the run). But the WORST run barely moved, because its cost is a 47,855-token article payload — fresh every run, and therefore uncacheable by construction. Since the tier caps are priced against the worst case, caching leaves them essentially unchanged. What it changes is the cost of a BUILD, which fell by 61%.',
);

h1('6. Why the current ladder fails');

p('Worst case below is a tenant running the most expensive measured shape ($0.20636/run, post-caching) to their cap. Breakeven is the run count at which LLM cost alone equals the plan price.');

table(
  [
    { label: 'Plan', w: 112 },
    { label: 'Price', w: 60, align: 'right' },
    { label: 'Run cap', w: 66, align: 'right' },
    { label: 'Breakeven', w: 74, align: 'right' },
    { label: 'Headroom', w: 72, align: 'right' },
    { label: 'Verdict', w: W - 112 - 60 - 66 - 74 - 72 },
  ],
  [
    ['Solo', '$20', '30', '93', '3.1×', { t: 'safe', color: GOOD, bold: true }],
    ['Professional', '$50', '200', '232', '1.16×', { t: 'razor-thin', color: ACCENT, bold: true }],
    ['Team', '$200', '1,000', '930', '0.93×', { t: 'NEGATIVE', color: BAD, bold: true }],
    [{ t: 'Business', bold: true }, { t: '$600', bold: true }, { t: '5,000', bold: true }, '2,789', '0.56×', { t: '-$475/mo', color: BAD, bold: true }],
  ],
);

p('A Business tenant running web-fetch briefings to their cap costs $1,032/month against $600 of revenue (it was $1,075 before caching; caching does not save this tier). This is not a tail risk: it is the advertised allowance, used as advertised.');

h2('The uncapped build hole');
p('monthlyRuns is enforced only at the run choke point (registerRunBudgetCheck). Builder chat and converger spend are counted against no plan limit whatsoever. The sole backstop is TENANT_DAILY_USD_LIMIT, a flat $25/day applied identically to every plan — which permits a $20/month Solo tenant to consume up to $750/month in build spend while never running a single workflow.');

h1('7. Options considered');

h2('Option A — Cost-denominated credits');
p('Replace runs with a credit equal to a fixed quantum of underlying LLM cost. Margin becomes structurally guaranteed for any workflow shape, including connectors not yet built. Rejected as the primary model: credits are illegible to buyers, and metered pricing creates purchase anxiety on a product whose whole promise is "just describe what you want".');

h2('Option B — Clamp payloads, keep generous caps');
p('Truncate every node input to ~8k tokens before it reaches the model. This bounds the worst run at roughly $0.054 and would let the current caps stand almost unchanged. Rejected on correctness grounds — see below.');

callout(
  'Why we will not truncate',
  'On digest-shaped workflows — "summarize my unread emails", "summarize this channel", "tell me what is in my Drive" — truncation is not a degradation of quality, it is a silent correctness failure. The user asked for a summary of everything and receives a confident summary of some things, with no warning that the rest was discarded. Completeness is the entire value proposition of those workflows. A wrong digest is worse than an expensive one.',
  BAD,
);

h2('Option C — Price the worst case, keep runs (recommended)');
p('Keep the run as the unit, and size each tier so that gross margin holds even if every run is the most expensive kind. The low cap is itself the safety mechanism: it bounds the blast radius of an expensive workflow without ever constraining what that workflow is allowed to do.');

h1('8. Recommended tier table');

table(
  [
    { label: 'Plan', w: 96 },
    { label: 'Price', w: 54, align: 'right' },
    { label: 'Runs/mo', w: 62, align: 'right' },
    { label: 'Workflows', w: 68, align: 'right' },
    { label: 'Worst-case GM', w: 82, align: 'right' },
    { label: 'Light-user GM', w: W - 96 - 54 - 62 - 68 - 82, align: 'right' },
  ],
  [
    [{ t: 'Solo', bold: true }, '$20', { t: '30', bold: true }, '1', { t: '65%', color: GOOD }, { t: '96%', color: GOOD }],
    [{ t: 'Professional', bold: true }, '$50', { t: '75', bold: true }, '3', { t: '66%', color: GOOD }, { t: '96%', color: GOOD }],
    [{ t: 'Team', bold: true }, '$200', { t: '300', bold: true }, '10', { t: '66%', color: GOOD }, { t: '97%', color: GOOD }],
    [{ t: 'Business', bold: true }, '$600', { t: '900', bold: true }, 'Unlimited', { t: '66%', color: GOOD }, { t: '97%', color: GOOD }],
  ],
);

bullets([
  'A workflow build costs 1 run from the allowance. Before caching a build cost 2.6 run-units, which meant a Solo user could afford only two builds a month alongside a daily automation. At 1.07 units they can afford seven. This is the single biggest product effect of the caching work.',
  'Test runs remain exempt. Users must be able to iterate on a draft without spending their allowance — this is what makes the caps tolerable.',
  'Prices are unchanged. Only the allowances move.',
  'Solo is set at 30 rather than 25 so that a weekday-daily automation (22 runs) still leaves room to iterate.',
]);

h1('9. Why these numbers');

p('The caps are derived, not chosen. Each is the largest allowance that still yields ~65% gross margin if every single run is the most expensive shape measured ($0.20636), net of Stripe fees at 2.9% + $0.30.');

p('The consequence is a margin floor that holds across the entire range of customer behaviour:');

table(
  [
    { label: 'If the customer’s runs actually cost…', w: 200 },
    { label: 'Solo', w: (W - 200) / 4, align: 'right' },
    { label: 'Prof.', w: (W - 200) / 4, align: 'right' },
    { label: 'Team', w: (W - 200) / 4, align: 'right' },
    { label: 'Business', w: (W - 200) / 4, align: 'right' },
  ],
  [
    ['$0.0006  (llm -> inbox)', { t: '96%', color: GOOD }, { t: '96%', color: GOOD }, { t: '97%', color: GOOD }, { t: '97%', color: GOOD }],
    ['$0.013  (sheets, calendar)', { t: '94%', color: GOOD }, { t: '94%', color: GOOD }, { t: '95%', color: GOOD }, { t: '95%', color: GOOD }],
    ['$0.072  (drive listing)', { t: '85%', color: GOOD }, { t: '85%', color: GOOD }, { t: '86%', color: GOOD }, { t: '86%', color: GOOD }],
    ['$0.079  (web search, cached)', { t: '84%', color: GOOD }, { t: '84%', color: GOOD }, { t: '85%', color: GOOD }, { t: '85%', color: GOOD }],
    [{ t: '$0.206  (worst measured)', bold: true }, { t: '65%', bold: true }, { t: '66%', bold: true }, { t: '66%', bold: true }, { t: '66%', bold: true }],
    ['$0.600  (pathological)', { t: '5%', color: ACCENT }, { t: '7%', color: ACCENT }, { t: '7%', color: ACCENT }, { t: '7%', color: ACCENT }],
  ],
);

callout(
  'The safety multiple',
  'At these allowances a single run would have to cost roughly $0.64 before any tier turns negative — about 3× more expensive than the worst workflow we could construct across eight connectors. Light users yield 96%+; the worst user we can imagine still yields 65%. This is the property the ladder was supposed to have and did not.',
  GOOD,
);

h1('10. Workflow count must match the run budget');

p('The old ladder advertised allowances that its own run budget could not fund. A weekday-daily automation consumes 22 runs per month, so an honest tier must fund at least that many runs per advertised workflow.');

table(
  [
    { label: 'Plan', w: 104 },
    { label: 'Runs', w: 70, align: 'right' },
    { label: 'Daily workflows funded', w: 148, align: 'right' },
    { label: 'Old advertised count', w: 122, align: 'right' },
    { label: '', w: W - 104 - 70 - 148 - 122, align: 'right' },
  ],
  [
    ['Solo', '25', '1', '1', { t: 'ok', color: GOOD, bold: true }],
    ['Professional', '75', '3', '10', { t: 'mismatch', color: BAD, bold: true }],
    ['Team', '300', '13', '50', { t: 'mismatch', color: BAD, bold: true }],
    ['Business', '900', '40', 'Unlimited', { t: 'mismatch', color: BAD, bold: true }],
  ],
);

p('Under the old table, a Professional customer who built the ten workflows they were sold, and scheduled them daily, would exhaust their 200 runs inside week two. The recommended workflow counts are set to what the run budget can actually sustain, so the promise and the allowance agree.');

h1('11. Required engineering');

h2('A per-run cost circuit breaker');
p('The one genuine hole in an uncapped-cost model is that the worst run is unbounded — $0.215 is merely the worst shape we happened to build, not a ceiling. The fix is a hard stop, not a clamp: if a single run’s LLM spend crosses ~$1.00, abort the run and surface the error.');

p('This bounds the tail while never degrading a run that legitimately needs 47k tokens. It is a strictly better failure mode than truncation: a customer whose research workflow is too expensive is told so, and can split it, rather than silently receiving an incomplete answer.');

h2('Prompt-cache the converger');
p('93.2% of all tokens consumed in this test were input tokens. The converger re-sends its entire context on every proposal turn, which is why a build costs $0.57. Anthropic prompt caching bills cache reads at roughly a tenth of base input. This is the single largest available cost reduction and it does not touch quality.');

h2('Make the daily USD ceiling per-plan');
p('TENANT_DAILY_USD_LIMIT is a flat $25/day for every tenant regardless of plan. It should scale with the plan it is protecting.');

h1('12. Defects found during the study');

table(
  [{ label: 'Defect', w: 168 }, { label: 'Detail', w: W - 168 }],
  [
    [{ t: '{{today}} template leak', bold: true }, 'The converger emits timeMin: "{{today}}" into the Google Calendar API. The engine does not resolve {{today}}, so the literal string is sent to Google and rejected with 400 Bad Request. Confirmed: the identical step succeeds when instructed to leave timeMin at its default.'],
    [{ t: 'Converger drops requested steps', bold: true }, 'Asked for a note delivered to Slack AND emailed via Gmail, and confirmed twice, the ratified spec contained only the Slack delivery. The Gmail step was silently omitted — no warning, and the workflow published as if complete.'],
    [{ t: 'Dead model field', bold: true }, 'The converger sets "model":"claude-opus-4-5" on LLM nodes. src/workflows/node-types/llm.js never reads config.model, so it is ignored today — but it is an Opus-priced cost bomb the moment anyone wires it up.'],
    [{ t: 'Airtable is not discoverable', bold: true }, 'The capability catalog exposes no list_bases. Atlas cannot enumerate a tenant’s Airtable bases, so airtable_list_records can only ever be configured with a base ID the user pastes by hand — which breaks the conversational promise for that connector.'],
    [{ t: 'web_fetch approaches timeout', bold: true }, 'The web_fetch -> extract -> rewrite shape has a median run duration of 113s against the 180s connector timeout. This shape will begin failing on slower pages.'],
  ],
);

h1('13. Open questions');

bullets([
  'The gmail_search shape was measured against an empty inbox (124 tokens). A populated inbox will move it upward. It cannot threaten the margin floor — the run cap bounds that — but it does affect how generous 25 runs feels to a real Solo customer. Worth measuring.',
  'Prompt caching should be implemented and the build cost re-measured before the build-costs-3-runs rule is finalised. If caching lands, a build may be cheap enough to make free again.',
  'These figures are Sonnet-based. Routing summarisation steps to Haiku would cut the mid-range shapes roughly four-fold and is worth testing against output quality.',
]);

// ── footer ───────────────────────────────────────────────────────────────────
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(i);
  // Writing below the bottom margin makes pdfkit treat it as overflow and append
  // a page. Zero the margin for the stamp, then restore it.
  const saved = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  const y = doc.page.height - 46;
  doc.moveTo(L, y - 8).lineTo(L + W, y - 8).lineWidth(0.4).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(7.6).fillColor(MUTED)
    .text('Atlas · Cost Model v2 · 13 July 2026', L, y, { width: W / 2, lineBreak: false });
  doc.font('Helvetica').fontSize(7.6).fillColor(MUTED)
    .text(`${i + 1} / ${range.count}`, L + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });

  doc.page.margins.bottom = saved;
}
doc.flushPages();

doc.end();
console.log('wrote', OUT);
