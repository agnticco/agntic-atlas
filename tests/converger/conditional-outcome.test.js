/**
 * Conditionally-routed outcomes — Part 1 (generation) + the gap-scorer reconciliation.
 *
 * A branching intent ("if urgent → #support, if billing → #sales, else → inbox") must
 * yield a contract of CONDITIONAL assertions (each with a `when` from the SAME closed
 * routing vocabulary the workflow classifies on), not N unconditional ones — otherwise
 * the workflow fails its own self-test on every input that took a different lane.
 *
 * And CONDITIONAL_UNPROVEN must fire ONLY when the condition is genuinely ungated: with
 * the runtime oracle now proving each conditional promise on the lane it names, a `when`
 * a classify → branch actually routes on is checked, so the stale "it fires on every run"
 * warning must not appear for it.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { buildOutcomePrompt, buildGeneratePrompt } from '../../src/converger/prompts.js';
import { scoreGap } from '../../src/converger/gap-scorer.js';

const CAPS = {
  channels: [
    { id: 'slack',         available: true, configSchema: [{ key: 'target' }] },
    { id: 'gmail_send',    available: true, configSchema: [{ key: 'to' }, { key: 'subject' }] },
    { id: 'inbox_deliver', available: true, configSchema: [{ key: 'subject' }] },
  ],
};
const codes = (r) => r.gaps.map(g => g.code);

// ── Part 1: generation ───────────────────────────────────────────────────────
describe('Part 1 — the outcome prompt teaches CONDITIONAL assertions', () => {
  const p = buildOutcomePrompt({ intent: 'if urgent send to #support, if billing send to #sales, else my inbox', capabilities: CAPS });

  test('it introduces an optional `when` and a CONDITIONAL DELIVERIES section', () => {
    assert.match(p, /"when"/);
    assert.match(p, /CONDITIONAL DELIVERIES/);
  });

  test('it demands the `when` values be a CLOSED set shared with the branch', () => {
    assert.match(p, /CLOSED set of routing categories/);
    assert.match(p, /classify/i);
  });

  test('it says an ALWAYS-happening delivery carries NO `when`', () => {
    assert.match(p, /NO "when"/);
  });
});

describe('Part 1 — the generate prompt turns `when` values into a classify + branch', () => {
  const outcome = {
    statement: 'Route each message.',
    assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:#support', when: 'urgent' },
      { id: 'a2', kind: 'message_sent', target: 'slack:#sales',   when: 'billing_question' },
      { id: 'a3', kind: 'message_sent', target: 'inbox:Triage',   when: 'general' },
    ],
  };
  const p = buildGeneratePrompt({ intent: 'triage inbound', outcome, capabilities: CAPS });

  test('the contract renders each [only when: X] and names the exact categories to classify on', () => {
    assert.match(p, /\[only when: urgent\]/);
    assert.match(p, /classify/i);
    // The categories the branch must use are spelled out from the `when` values.
    assert.match(p, /urgent, billing_question, general/);
  });

  test('an UNCONDITIONAL contract adds no conditional instruction', () => {
    const flat = buildGeneratePrompt({
      intent: 'summarize to slack',
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      capabilities: CAPS,
    });
    assert.doesNotMatch(flat, /only when/);
    assert.doesNotMatch(flat, /CONDITIONAL/);
  });
});

// ── Part 3: gap-scorer reconciliation ────────────────────────────────────────
function gatedBranchSpec() {
  return {
    version: 2,
    name: 'Inbound triage',
    outcome: {
      statement: 'Route each inbound message to the right place.',
      assertions: [
        { id: 'a1', kind: 'message_sent', target: 'slack:#support', when: 'urgent' },
        { id: 'a2', kind: 'message_sent', target: 'slack:#sales',   when: 'billing_question' },
        { id: 'a3', kind: 'message_sent', target: 'inbox:Triage',   when: 'general' },
      ],
    },
    triggers: [{ type: 'email', filter: 'is:unread' }],
    nodes: [
      { id: 'triage', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'urgent\nbilling_question\ngeneral', instructions: 'Sort the message.' } },
      { id: 'route', type: 'branch', label: 'Route',
        config: { on: 'triage.output', cases: [
          { when: 'urgent', to: 'send_support' },
          { when: 'billing_question', to: 'send_sales' },
          { when: '*', to: 'save_inbox' },
        ] } },
      { id: 'send_support', type: 'deliver', label: 'To #support', config: { channel: 'slack', target: '#support' } },
      { id: 'send_sales',   type: 'deliver', label: 'To #sales',   config: { channel: 'slack', target: '#sales' } },
      { id: 'save_inbox',   type: 'deliver', label: 'To inbox',    config: { channel: 'inbox_deliver', subject: 'Triage' } },
    ],
    edges: [
      { from: 'triage', to: 'route' },
      { from: 'route', to: 'send_support' },
      { from: 'route', to: 'send_sales' },
      { from: 'route', to: 'save_inbox' },
    ],
  };
}

describe('Part 3 — CONDITIONAL_UNPROVEN fires only when the condition is UNGATED', () => {
  test('a classify → branch that routes on the `when` value raises NO CONDITIONAL_UNPROVEN', () => {
    const r = scoreGap(gatedBranchSpec(), { capabilities: CAPS });
    assert.equal(codes(r).includes('CONDITIONAL_UNPROVEN'), false,
      'the runtime oracle now proves each conditional promise on its lane — no stale warning');
  });

  test('a conditional `when` NOTHING routes on still raises CONDITIONAL_UNPROVEN (protection kept)', () => {
    // Linear workflow: a `when` with no classify/branch to gate it — it would fire on
    // every run, and the scorer must still say so.
    const ungated = {
      version: 2,
      name: 'Log',
      outcome: {
        statement: 'Post the summary to #logistics.',
        assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#logistics', when: 'urgent' }],
      },
      triggers: [{ type: 'email', filter: 'from:ups.com' }],
      nodes: [
        { id: 'summarize', type: 'llm', label: 'Summarize', config: { mode: 'summarize', instructions: 'Summarize.' } },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#logistics' } },
      ],
      edges: [{ from: 'summarize', to: 'post' }],
    };
    const r = scoreGap(ungated, { capabilities: CAPS });
    assert.equal(codes(r).includes('CONDITIONAL_UNPROVEN'), true,
      'nothing routes on "urgent" — the promise is genuinely ungated');
  });
});
