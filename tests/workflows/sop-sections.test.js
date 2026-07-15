/**
 * The SOP's G sections: outcome, escalation policy, provenance. (P12 Increment G.)
 *
 * The SOP is the consultant's deliverable and the auditor's document. E gave it the
 * decision tables; G gives it the three things an auditor actually asks for: what
 * this workflow must ACHIEVE (the contract), what happens WHEN THINGS GO WRONG
 * (derived from the spec's own on_error / human / catch-all structure, so it is true
 * even for a hand-edited workflow), and HOW IT WAS DECIDED (which promises were
 * agreed, which cases were left to a person).
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { generateSopMarkdown } from '../../src/workflows/sop-generator.js';

const base = () => ({
  name: 'Lead triage', status: 'active', version: 2, created_at: '2026-07-14',
  triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
  nodes: [
    { id: 'extract', type: 'llm', label: 'Extract', config: { mode: 'extract', fields: 'name: n' } },
    { id: 'save', type: 'connector-action', label: 'Save the lead', config: { action: 'airtable_create_record' } },
  ],
  edges: [{ from: 'extract', to: 'save' }],
});

describe('the Outcome section', () => {
  test('renders the statement and every assertion', () => {
    const wf = { ...base(), outcome: {
      statement: 'Every lead becomes a Leads record.',
      assertions: [
        { id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name', 'Budget'] },
        { id: 'a2', kind: 'message_sent', target: 'slack:#sales', when: "priority = 'P1'" },
      ],
    } };
    const md = generateSopMarkdown(wf);
    assert.match(md, /## Outcome/);
    assert.match(md, /Every lead becomes a Leads record/);
    assert.match(md, /record exists.*airtable:Leads.*carrying Name, Budget/);
    assert.match(md, /only when priority = 'P1'/, 'a conditional assertion says so');
  });

  test('accepts the outcome as a JSON STRING (the store shape)', () => {
    const wf = { ...base(), outcome: JSON.stringify({ statement: 'x', assertions: [{ kind: 'message_sent', target: 'slack:#ops' }] }) };
    assert.match(generateSopMarkdown(wf), /## Outcome[\s\S]*slack:#ops/);
  });

  test('a v1 workflow with no outcome simply omits the section', () => {
    const md = generateSopMarkdown(base());
    assert.equal(/## Outcome/.test(md), false);
  });
});

describe('the "When things go wrong" section — derived from the SPEC', () => {
  test('an on_error:escalate node is described', () => {
    const wf = base();
    wf.nodes.push({ id: 'score', type: 'decision', label: 'Score it',
      config: { inputs: [{ key: 'b', type: 'number' }], output: { key: 'p', type: 'enum', values: ['P1', 'P3'] }, hitPolicy: 'FIRST', rules: [{ when: { b: '-' }, then: 'P3' }] },
      on_error: { retry: 2, then: 'escalate' } });
    const md = generateSopMarkdown(wf);
    assert.match(md, /## When things go wrong/);
    assert.match(md, /Score it.*fails.*after 2 retries.*handed to a person/);
  });

  test('a branch catch-all is described — nothing falls through silently', () => {
    const wf = base();
    wf.nodes.push({ id: 'route', type: 'branch', label: 'Route',
      config: { on: '{{x.output}}', cases: [{ when: 'P1', to: 'save' }, { when: '*', to: 'save' }] } });
    assert.match(generateSopMarkdown(wf), /unanticipated value at .*Route.*nothing falls through silently/);
  });

  test('a human gate and its timeout are described', () => {
    const wf = base();
    wf.nodes.push({ id: 'ask', type: 'human', label: 'Approve send',
      config: { prompt: 'ok?', decisions: ['approve', 'reject'], timeout: { after: '48h', then: 'reject' } } });
    assert.match(generateSopMarkdown(wf), /Approve send.*pauses for a person.*nobody answers.*reject/);
  });

  test('a workflow with no failure handling omits the section rather than inventing one', () => {
    // base() has no on_error, no human, no branch. Silence is honest here: there IS
    // no policy, and the SOP must not manufacture reassurance.
    assert.equal(/## When things go wrong/.test(generateSopMarkdown(base())), false);
  });
});

describe('the "How this was decided" section — provenance', () => {
  test('renders agreed promises and escalated gaps', () => {
    const prov = [
      { kind: 'assertion', step: 2, detail: { message: 'post to #sales-urgent for P1 leads' } },
      { kind: 'gap_escalated', detail: { message: 'what to do when the budget is unknown' } },
    ];
    const md = generateSopMarkdown(base(), { provenance: prov });
    assert.match(md, /## How this was decided/);
    assert.match(md, /post to #sales-urgent for P1 leads.*step 2/);
    assert.match(md, /Left to a person, by default/);
    assert.match(md, /what to do when the budget is unknown/);
  });

  test('a JSON-STRING detail is parsed', () => {
    const prov = [{ kind: 'assertion', detail: JSON.stringify({ target: 'slack:#ops' }) }];
    assert.match(generateSopMarkdown(base(), { provenance: prov }), /slack:#ops/);
  });

  test('no provenance ⇒ no section (a hand-built or pre-C workflow)', () => {
    assert.equal(/## How this was decided/.test(generateSopMarkdown(base())), false);
    assert.equal(/## How this was decided/.test(generateSopMarkdown(base(), { provenance: [] })), false);
  });
});
