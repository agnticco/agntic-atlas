/**
 * p11-converger-q29-repro — deterministic repro for Q29.
 *
 * BUG (Q29): the converger can never finalize a workflow that has NO processing
 * step — a valid, runnable trigger→delivery shape such as:
 *   - "every weekday at 8am post a fixed message to Slack #general"
 *   - "when an Airtable record changes, forward it to Slack"
 * These are trigger + delivery, no summarize/llm/extract/rewrite in between.
 *
 * ROOT CAUSE (no LLM needed to prove):
 *   src/converger/gap-scorer.js requires `hasProcessing` for `complete`
 *   (needsProcessing = hasTrigger && !hasProcessing; complete = !needs...).
 *   So a trigger+delivery draft has complete=false FOREVER.
 *
 * GRAPH CONSEQUENCE (src/converger/elicitation-graph.js):
 *   - `analyze` routes to `ratify` (→ publishable spec) ONLY when gap.complete.
 *   - `propose` asks the LLM for the next component; for a done trigger+deliver
 *     workflow the LLM has nothing to add, returns no `component`, and falls to
 *     the fallback interrupt "I need a bit more detail to build the next step."
 *   → analyze never ratifies + propose never completes = an unbreakable loop.
 *     The user can never test or publish the workflow. (Observed live 2026-07-03.)
 *
 * This also violates the constitution: the engine is workflow-AGNOSTIC — a
 * delivery-only workflow is a legitimate shape, not a missing processing step.
 *
 * Exit 0  = bug reproduced (Case A wrongly incomplete, Case B complete).
 * Exit 1  = bug NOT reproduced (Case A now completes) — i.e. a fix has landed;
 *           this script then doubles as a regression guard confirming the fix.
 */

import { scoreGap, gapLabel } from '../../src/converger/gap-scorer.js';

// Case A — a real, runnable workflow with NO processing step: schedule → Slack deliver.
const deliveryOnly = {
  name:     'Morning Greeting → #general',
  triggers: [{ type: 'schedule', cron: '0 8 * * 1-5' }],
  nodes: [
    { id: 'post_greeting', type: 'deliver', config: { channel: '#general', message: 'Good morning team!' } },
  ],
  edges: [],   // single node, no edges required
};

// Case B — the same intent WITH a processing step: schedule → summarize → deliver.
const withProcessing = {
  name:     'Daily Digest → #general',
  triggers: [{ type: 'schedule', cron: '0 9 * * 1-5' }],
  nodes: [
    { id: 'summarize', type: 'summarize', config: {} },
    { id: 'post',      type: 'deliver',   config: { channel: '#general' } },
  ],
  edges: [{ from: 'summarize', to: 'post' }],
};

const a = scoreGap(deliveryOnly);
const b = scoreGap(withProcessing);

const line = (s) => console.log(s);
line('── Q29 repro: converger cannot finalize a delivery-only workflow ──\n');

line('Case A — trigger → deliver (no processing step), a valid runnable shape:');
line(`  scoreGap.complete        = ${a.complete}`);
line(`  scoreGap.needsProcessing = ${a.needsProcessing}`);
line(`  gapLabel                 = "${gapLabel(a)}"`);
line(`  → analyze() will NOT route to ratify (needs gap.complete); propose() has`);
line(`    nothing to add → falls to the "need a bit more detail" interrupt. LOOP.\n`);

line('Case B — trigger → summarize → deliver (contrast, has a processing step):');
line(`  scoreGap.complete        = ${b.complete}`);
line(`  gapLabel                 = "${gapLabel(b)}"\n`);

const reproduced = a.complete === false && a.needsProcessing === true && b.complete === true;

if (reproduced) {
  line('RESULT: ✗ BUG REPRODUCED — a delivery-only workflow is scored incomplete');
  line('forever (needsProcessing=true), so the converger can never ratify/publish it.');
  line('Expected after fix: Case A scoreGap.complete === true (processing optional');
  line('when a trigger + delivery + edges + name are present).');
  process.exit(0);
} else {
  line('RESULT: ✓ Bug NOT reproduced — Case A now scores complete. Fix appears present;');
  line('this script now serves as a regression guard for Q29.');
  process.exit(1);
}
