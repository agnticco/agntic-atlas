/**
 * A finished build must survive the browser that asked for it.
 *
 * ── The defect this pins (observed live, 2026-07-21) ────────────────────────
 *
 * A six-minute build completed server-side and logged `respond.ok` with the whole
 * workflow in hand — and the browser never received it ("TypeError: Failed to
 * fetch"). NOTHING was saved, because the only thing that ever wrote the spec was
 * the client acknowledging it. The user was told to start over from
 * "+ New workflow": minutes of model work and their place in a long conversation,
 * gone because one HTTP response did not land.
 *
 * The server now writes the spec to the draft row the moment it has it. These
 * tests pin the RULES that keep that safe, since the route itself needs a whole
 * spine to exercise:
 *
 *   • only ever a DRAFT row (never a live workflow),
 *   • only when there is a real spec to save,
 *   • and the CONTRACT rides along — the client-driven autosave omits `outcome`,
 *     which is the same omission that left it NULL on every stored workflow (F11).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The decision the /respond autosave makes, extracted verbatim in shape from
 * src/api/builder.js. If that changes, this must change with it.
 */
function autosavePatch(row, spec, { tenantId }) {
  if (!row || row.tenant_id !== tenantId || row.status !== 'draft') return null;
  if (!spec || !Array.isArray(spec.nodes) || !spec.nodes.length) return null;
  const patch = { nodes: spec.nodes };
  if (Array.isArray(spec.edges))    patch.edges = spec.edges;
  if (Array.isArray(spec.triggers)) patch.triggers = spec.triggers;
  if (typeof spec.name === 'string' && spec.name) patch.name = spec.name;
  if (spec.outcome !== undefined)   patch.outcome = spec.outcome;
  return patch;
}

const DRAFT = { id: 'w1', tenant_id: 't1', status: 'draft' };
const LIVE  = { id: 'w2', tenant_id: 't1', status: 'active' };
const SPEC  = {
  name: 'ATLASGATE Email Approval Gate',
  nodes: [{ id: 'a', type: 'llm' }, { id: 'b', type: 'deliver' }],
  edges: [{ from: 'a', to: 'b' }],
  triggers: [{ type: 'email', filter: 'subject:ATLASGATE is:unread' }],
  outcome: { statement: 'Ask before sending.', assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:me' }] },
};

describe('the finished build is saved', () => {
  test('a draft row gets the whole spec', () => {
    const p = autosavePatch(DRAFT, SPEC, { tenantId: 't1' });
    assert.equal(p.nodes.length, 2);
    assert.equal(p.edges.length, 1);
    assert.equal(p.triggers[0].type, 'email');
    assert.equal(p.name, 'ATLASGATE Email Approval Gate');
  });

  test('THE CONTRACT RIDES ALONG', () => {
    // A recovered draft with no promise cannot be certified against anything —
    // and omitting `outcome` here is exactly the bug that left it NULL on 148/148
    // stored workflows (F11).
    const p = autosavePatch(DRAFT, SPEC, { tenantId: 't1' });
    assert.ok(p.outcome, 'the contract was dropped on autosave');
    assert.equal(p.outcome.assertions.length, 1);
  });
});

describe('what it must never touch', () => {
  test('never a LIVE workflow', () => {
    assert.equal(autosavePatch(LIVE, SPEC, { tenantId: 't1' }), null);
  });

  test('never another tenant\'s row', () => {
    assert.equal(autosavePatch(DRAFT, SPEC, { tenantId: 'other' }), null);
  });

  test('never writes an empty or absent spec over saved work', () => {
    assert.equal(autosavePatch(DRAFT, { nodes: [] }, { tenantId: 't1' }), null);
    assert.equal(autosavePatch(DRAFT, null, { tenantId: 't1' }), null);
    assert.equal(autosavePatch(DRAFT, { name: 'x' }, { tenantId: 't1' }), null);
  });

  test('a spec with no outcome key leaves the stored contract alone', () => {
    // undefined means "inherit", not "retract" — the same distinction the PUT
    // publish path had to learn.
    const { outcome, ...noOutcome } = SPEC;
    const p = autosavePatch(DRAFT, noOutcome, { tenantId: 't1' });
    assert.ok(p);
    assert.equal('outcome' in p, false);
  });
});

describe('a stuck local slice must not shadow a finished build', () => {
  // Mirrors openConsole(): the server's copy is the authority on whether the
  // build FINISHED. A slice saved mid-build restores as awaiting-approval, and
  // testing only unlocks on phase 'proposed' — so without this a completed
  // 9-step workflow reopened permanently untestable, with no way forward.
  const resolve = (slice, wf) => {
    const serverFinished = wf.nodes && wf.nodes.length;
    const sliceStuck = slice.phase === 'building' || slice.awaitingGraphApproval;
    return (serverFinished && sliceStuck) ? 'proposed' : slice.phase;
  };

  test('a mid-build slice + a finished server spec resolves to testable', () => {
    assert.equal(resolve({ phase: 'building' }, { nodes: [{ id: 'a' }] }), 'proposed');
    assert.equal(resolve({ phase: 'chat', awaitingGraphApproval: true }, { nodes: [{ id: 'a' }] }), 'proposed');
  });

  test('with nothing on the server, the local slice is left alone', () => {
    assert.equal(resolve({ phase: 'building' }, { nodes: [] }), 'building');
  });

  test('a slice that is already past approval is untouched', () => {
    assert.equal(resolve({ phase: 'proposed' }, { nodes: [{ id: 'a' }] }), 'proposed');
    assert.equal(resolve({ phase: 'chat' }, { nodes: [{ id: 'a' }] }), 'chat');
  });
});
