/**
 * P12 Increment A — UNKNOWN_CONFIG_KEY + the v1 compat shim.
 *
 * The defect this pins (converger-v2 §1, defect #3): a real converger output
 * carried `"model": "claude-opus-4-5"` on an llm node. That model does not
 * exist, the key is in no schema, and NOTHING rejected it — the executor
 * silently ignored the key and ran on the default model. A hallucinated config
 * field must be a build-time error, not a shrug.
 *
 * The counterweight: the shipped corpus must keep validating. A blanket
 * "config keys ⊆ configSchema" check would reject the FROZEN canonical spec
 * (its summarize node carries instructions/format, which the v1 summarize
 * schema never declared) and every connector workflow (whose params are
 * per-capability by design). So the check is scoped by `configPolicy`:
 * closed types enforce the subset; open types (connector-action) pass params
 * through.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { WorkflowValidator } from '../../src/workflows/workflow-validator.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const validator = new WorkflowValidator({ nodeTypes });

/** Wrap nodes in the minimum shape validate() accepts (trigger + deliver present). */
const spec = (nodes, edges = []) => ({
  name: 'test workflow',
  triggers: [{ type: 'email', filter: 'from:ups.com' }],
  nodes,
  edges,
});

const codes = (res) => res.issues.map(i => i.code);
const errorCodes = (res) => res.errors.map(i => i.code);

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE HEADLINE. The hallucinated key is rejected.
// ─────────────────────────────────────────────────────────────────────────────
test('UNKNOWN_CONFIG_KEY: llm node with a hallucinated `model` key is REJECTED', () => {
  const res = validator.validate(spec(
    [
      { id: 'think', type: 'llm', config: { prompt: 'Summarize this.', model: 'claude-opus-4-5' } },
      { id: 'post',  type: 'deliver', config: { channel: 'slack', target: '#social' } },
    ],
    [{ from: 'think', to: 'post' }],
  ));

  assert.ok(!res.ok, 'a spec with a hallucinated config key must not validate');
  assert.ok(
    errorCodes(res).includes('UNKNOWN_CONFIG_KEY'),
    `expected UNKNOWN_CONFIG_KEY among errors, got: ${errorCodes(res).join(', ') || '(none)'}`,
  );

  const issue = res.errors.find(i => i.code === 'UNKNOWN_CONFIG_KEY');
  assert.equal(issue.nodeId, 'think');
  assert.equal(issue.field, 'config.model', 'the issue must point at the offending key so the UI can highlight it');
});

test('UNKNOWN_CONFIG_KEY: a legitimate llm node still validates', () => {
  const res = validator.validate(spec(
    [
      { id: 'think', type: 'llm', config: { prompt: 'Summarize this.' } },
      { id: 'post',  type: 'deliver', config: { channel: 'slack', target: '#social' } },
    ],
    [{ from: 'think', to: 'post' }],
  ));
  assert.ok(res.ok, `a valid llm node must validate, got: ${errorCodes(res).join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. §11.1 — the FROZEN canonical spec must still validate.
//    It is a v1 spec: type `summarize` with instructions/format.
// ─────────────────────────────────────────────────────────────────────────────
test('v1 compat: the FROZEN canonical spec still validates', () => {
  const frozen = JSON.parse(readFileSync('docs/specs/canonical-ups-slack.json', 'utf8'));
  const res = validator.validate(frozen);
  assert.ok(res.ok, `the frozen canonical spec must never fail validation, got: ${errorCodes(res).join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. §11.2 — the shipped corpus. Every deliver routing key below is READ BY A
//    HANDLER; they were simply never declared. If any of these regress, the
//    workflows running in production stop validating.
// ─────────────────────────────────────────────────────────────────────────────
test('v1 compat: every deliver routing key a handler actually reads is declared', () => {
  // Each key here has a real consumer, verified with a word-boundary grep:
  //   target      src/connectors/slack/index.js:256
  //   user        src/connectors/slack/index.js:278
  //   username    src/connectors/slack/index.js:259
  //   icon_emoji  src/connectors/slack/index.js:260
  //   to/subject  src/connectors/google/index.js:591
  //   title/body  src/workflows/node-types/deliver.js (run())
  const res = validator.validate(spec(
    [
      { id: 'l1', type: 'llm', config: { prompt: 'x' } },
      { id: 'd',  type: 'deliver', config: {
        channel: 'gmail_send', to: 'a@b.com', subject: 'S',
        title: 'T', body: 'B', user: '@me', username: 'bot', icon_emoji: ':x:',
      } },
    ],
    [{ from: 'l1', to: 'd' }],
  ));
  assert.ok(res.ok, `declared deliver routing keys must validate, got: ${errorCodes(res).join(', ')}`);
});

test('deliver `message` is REJECTED — nothing reads it, so it is silently dropped', () => {
  // `message` was briefly declared on this schema during Increment A, on a
  // misread: a grep for `config.message` prefix-matched `config.messageId` (a
  // gmail_get_message param). NOTHING in src/ reads `config.message`:
  //
  //   grep -rnE "(config|cfg)\.message\b" src/   →  no matches
  //
  // A deliver node carrying `message` therefore has its content SILENTLY
  // DISCARDED at run time — the user writes "post exactly this greeting" and
  // gets the upstream LLM's output instead, and is never told. That is defect
  // #3 exactly, and it is what this check exists to kill. Declaring the key to
  // make such a spec pass would have turned UNKNOWN_CONFIG_KEY into theatre.
  //
  // The body comes from the previous step, or from `body`. Never from `message`.
  const res = validator.validate(spec(
    [
      { id: 'l1',   type: 'llm', config: { prompt: 'Write a greeting.' } },
      { id: 'send', type: 'deliver', config: { channel: 'slack', target: '#general', message: 'Good morning team' } },
    ],
    [{ from: 'l1', to: 'send' }],
  ));
  assert.ok(!res.ok, 'a deliver node whose content would be silently dropped must not validate');
  const issue = res.errors.find(i => i.code === 'UNKNOWN_CONFIG_KEY');
  assert.ok(issue, `expected UNKNOWN_CONFIG_KEY, got: ${errorCodes(res).join(', ') || '(none)'}`);
  assert.equal(issue.field, 'config.message');
});

test('v1 compat: a deliver node using only real routing keys validates', () => {
  const res = validator.validate(spec(
    [
      { id: 'l1',   type: 'llm', config: { prompt: 'Write a greeting.' } },
      { id: 'send', type: 'deliver', config: { channel: 'slack', target: '#general' } },
    ],
    [{ from: 'l1', to: 'send' }],
  ));
  assert.ok(res.ok, `the common Slack delivery shape must validate, got: ${errorCodes(res).join(', ')}`);
});

test('v1 compat: the old LLM primitives (summarize/extract/rewrite) still validate', () => {
  const res = validator.validate(spec(
    [
      { id: 's', type: 'summarize', config: { instructions: 'be brief', format: 'plain', length: 'short', style: 'neutral' } },
      { id: 'r', type: 'rewrite',   config: { instructions: 'punch it up', format: 'email', tone: 'warm' } },
      { id: 'x', type: 'extract',   config: { fields: 'name: the name' } },
      { id: 'd', type: 'deliver',   config: { channel: 'slack', target: '#c' } },
    ],
    [{ from: 's', to: 'r' }, { from: 'r', to: 'x' }, { from: 'x', to: 'd' }],
  ));
  assert.ok(res.ok, `v1 primitives must lift cleanly, got: ${errorCodes(res).join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. connector-action is an OPEN schema — its params are per-capability.
//    A closed check here would reject every Airtable/Sheets/Drive workflow.
//    (Increment F makes these schema-aware per capability.)
// ─────────────────────────────────────────────────────────────────────────────
test('connector-action: per-capability params pass through (open schema)', () => {
  const res = validator.validate(spec(
    [
      { id: 'a', type: 'connector-action', config: {
        action: 'airtable_search_records',
        baseId: 'appX', tableId: 'tblY', filterByFormula: '{Status}="New"', maxRecords: 10,
      } },
      { id: 'd', type: 'deliver', config: { channel: 'slack', target: '#c' } },
    ],
    [{ from: 'a', to: 'd' }],
  ));
  assert.ok(res.ok, `connector params must pass through, got: ${errorCodes(res).join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The node re-cut: llm gains `mode`; the collapsed types are gone from the
//    registry but still lift; the UNRUNNABLE types are gone for good.
// ─────────────────────────────────────────────────────────────────────────────
test('re-cut: llm declares `mode` with the five modes', () => {
  const llm = nodeTypes.get('llm');
  const mode = llm.configSchema.find(f => f.key === 'mode');
  assert.ok(mode, 'llm must declare a `mode` config field');
  assert.deepEqual(
    [...mode.options].sort(),
    ['classify', 'extract', 'freeform', 'rewrite', 'summarize'],
  );
});

test('re-cut: the collapsed v1 types are no longer registered', () => {
  for (const t of ['summarize', 'extract', 'rewrite', 'daily_digest']) {
    assert.equal(nodeTypes.get(t), null, `${t} must no longer be a registered node type`);
  }
});

test('re-cut: the unrunnable types are rejected, not silently accepted', () => {
  // There is no ToolRegistry in this build (no src/tools/, never instantiated)
  // and FlowTester is built without `tools` — these threw at RUNTIME. Now they
  // fail at BUILD time, which is the whole point.
  for (const type of ['tool', 'mcp_tool', 'fetch']) {
    const res = validator.validate(spec(
      [
        { id: 'n', type, config: {} },
        { id: 'd', type: 'deliver', config: { channel: 'slack', target: '#c' } },
      ],
      [{ from: 'n', to: 'd' }],
    ));
    assert.ok(!res.ok, `${type} must not validate — it is not runnable in this build`);
    assert.ok(
      errorCodes(res).includes('REMOVED_NODE_TYPE'),
      `${type} must report REMOVED_NODE_TYPE, got: ${errorCodes(res).join(', ')}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The check must not be trivially satisfiable — an unknown key on a v1 type
//    is caught AFTER the lift, so the shim cannot be used to smuggle one in.
// ─────────────────────────────────────────────────────────────────────────────
test('UNKNOWN_CONFIG_KEY: a hallucinated key on a lifted v1 node is still caught', () => {
  const res = validator.validate(spec(
    [
      { id: 's', type: 'summarize', config: { instructions: 'brief', model: 'claude-opus-4-5' } },
      { id: 'd', type: 'deliver',   config: { channel: 'slack', target: '#c' } },
    ],
    [{ from: 's', to: 'd' }],
  ));
  assert.ok(!res.ok, 'the compat shim must not become a hole in the check');
  assert.ok(errorCodes(res).includes('UNKNOWN_CONFIG_KEY'), `got: ${errorCodes(res).join(', ')}`);
});
