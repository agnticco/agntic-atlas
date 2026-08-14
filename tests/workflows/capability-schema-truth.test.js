/**
 * IS THE CAPABILITY SCHEMA TRUE? — the adversary's pass on P12 Increment F.
 *
 * F made every capability's `configSchema` LOAD-BEARING: it is now the key set
 * `UNKNOWN_CONFIG_KEY` checks a `connector-action` against, AND the source of the
 * required params `MISSING_CONFIG` demands. That is only safe if the schemas are
 * TRUE — in both directions:
 *
 *   · a key the schema omits that a handler READS  ⇒ a valid spec is rejected;
 *   · a key the schema declares that nothing reads ⇒ the check is theatre.
 *
 * Increment C shipped the first kind live ("`sheets_append`'s handler reads
 * spreadsheetId/range, `deliver` declared neither, and EVERY delivery to a Sheet was
 * rejected at publish — while the converger's own prompt told users to build exactly
 * that"). F adds a THIRD direction nobody has checked yet:
 *
 *   · a key the schema marks REQUIRED that the handler treats as OPTIONAL
 *     (`const content = config.content ?? body`) ⇒ a runnable, documented shape is
 *     rejected at publish. Same defect, new door.
 *
 * `connector-schema.test.js` (the Builder's) checks the first two on the
 * connector-action side. It does not check the DELIVER side, and it does not check
 * required-ness against what the handlers actually do — which is where the misses are.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { productionCatalog }        from '../helpers/prod-catalog.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const catalog   = productionCatalog();
const validator = new WorkflowValidator({ nodeTypes, channelRegistry: catalog });

/** A workflow whose LAST step is the node under test — content arrives from `sum`. */
const delivering = (cfg) => ({
  name: 'T', version: 1, triggers: [{ type: 'manual' }],
  nodes: [
    { id: 'sum', type: 'llm',     label: 'Summarize', config: { mode: 'summarize', prompt: 'x' } },
    { id: 'out', type: 'deliver', label: 'Out',       config: cfg },
  ],
  edges: [{ from: 'sum', to: 'out' }],
});

const acting = (cfg) => ({
  name: 'T', version: 1, triggers: [{ type: 'manual' }],
  nodes: [
    { id: 'sum', type: 'llm',              label: 'Summarize', config: { mode: 'summarize', prompt: 'x' } },
    { id: 'act', type: 'connector-action', label: 'Act',       config: cfg },
    { id: 'out', type: 'deliver',          label: 'Out',       config: { channel: 'slack', target: '#ops' } },
  ],
  edges: [{ from: 'sum', to: 'act' }, { from: 'act', to: 'out' }],
});

const errsOn = (spec, id) => validator.validate(spec).errors.filter(e => e.nodeId === id);

// ── 1. The catalog the tests see must be the catalog publish sees ────────────

describe('the test catalog is the PRODUCTION catalog', () => {
  test('in_app — the DEFAULT delivery channel — resolves', () => {
    // `deliver.js` run(): `const channelId = cfg.channel ?? 'in_app'`. A catalog in
    // which the default channel does not exist is not the catalog production has, and
    // a validator built on it answers a different question than publish answers
    // (ENGINEERING-LOG.md, architectural flaw #2).
    assert.ok(catalog.get('in_app'), 'in_app is registered by registerBuiltInChannels (server.js:593)');
    assert.deepEqual(errsOn(delivering({ channel: 'in_app', title: 'Morning digest' }), 'out'), []);
  });

  test('webhook, filesystem_read and web_search resolve too', () => {
    for (const id of ['webhook', 'filesystem_read', 'filesystem_list', 'web_search', 'web_fetch']) {
      assert.ok(catalog.get(id), `${id} is registered by buildEngine() and must be in the catalog`);
    }
    // …and a spec using them publishes. `web_search` as a connector-action is the
    // primary web path (ENGINEERING-LOG.md, Web connector) — if the validator cannot resolve
    // it, UNKNOWN_CONNECTOR_ACTION rejects every web step in the product.
    assert.deepEqual(errsOn(acting({ action: 'web_search', query: 'atlas news' }), 'act'), []);
    assert.deepEqual(errsOn(acting({ action: 'filesystem_read', path: '/tmp/x.txt' }), 'act'), []);
  });
});

// ── 2. A required key the handler treats as optional ─────────────────────────

describe('a capability param is REQUIRED only if the handler actually requires it', () => {
  test('slack_file delivery: the content comes from the previous step, as the handler says', () => {
    // src/connectors/slack/index.js:345 —  `const content = config.content ?? body ?? '';`
    // The handler was WRITTEN to take its content from the upstream step: that is what a
    // `deliver` node IS. But the schema marks `content` `optional: false`
    // (src/connectors/slack/index.js:336), and P12 Increment F turned every capability's
    // required params into MISSING_CONFIG — so "summarize the thread and upload it to
    // #ops as a file" no longer publishes.
    //
    // This is the Increment C defect through a new door: enforcement against a schema
    // that lies. A key with a `?? body` fallback is not required — the handler says so
    // in code.
    const errs = errsOn(delivering({ channel: 'slack_file', target: '#ops', filename: 'digest.txt' }), 'out');
    assert.deepEqual(errs.map(e => `${e.code}(${e.field})`), [],
      'a deliver node whose content comes from the previous step is the ordinary shape, and the ' +
      'slack_file handler explicitly supports it (config.content ?? body)');
  });

  test('slack_topic action: the topic comes from the previous step, as the handler says', () => {
    // src/connectors/slack/index.js:425 — `const topic = config.topic ?? body;`
    // connector-action passes the upstream output as `body`
    // (src/workflows/node-types/connector-action.js:74), so this shape runs.
    const errs = errsOn(acting({ action: 'slack_topic', target: '#ops' }), 'act');
    assert.deepEqual(errs.map(e => `${e.code}(${e.field})`), [],
      'the slack_topic handler takes its topic from the upstream body when config omits it');
  });

  test('POSITIVE: a required param with NO fallback is still enforced', () => {
    // The rule must not be widened into "nothing is required". `airtable_create_record`
    // throws without a baseId — there is no `?? body` anywhere near it — so its absence
    // is still an error. This is the half of the check that must keep working.
    const codes = errsOn(acting({ action: 'airtable_create_record', tableId: 'Leads', fields: { Name: 'x' } }), 'act')
      .map(e => e.code);
    assert.ok(codes.includes('MISSING_CONFIG'),
      'a capability param the handler genuinely needs is still required');
  });
});

// ── 3. An action is a STEP capability, not just "a capability" ────────────────

describe('a connector-action must name something that can RUN as a step', () => {
  test('a TRIGGER capability is not an action', () => {
    // `gmail_new_message` is registered with positions:['trigger'] and has NO handle
    // (src/connectors/google/index.js:806-816). The validator asks the registry only
    // "does this id exist?" (workflow-validator.js:1217), and a trigger exists — so the
    // spec publishes clean and then dies at run time in
    // connector-action.js:66 (`Connector action "gmail_new_message" has no handler`),
    // at 6am, against a real customer's trigger. That is the exact failure
    // UNKNOWN_CONNECTOR_ACTION was added to prevent.
    //
    // It is also a converger/publish DIVERGENCE: the scorer's catalog view is built from
    // `getAll()`, which excludes triggers, so the converger says UNKNOWN_CONNECTOR_ACTION
    // and publish says fine. The two disagree about what a capability is.
    assert.equal(catalog.get('gmail_new_message')?.positions?.includes('step'), false,
      'precondition: gmail_new_message cannot occupy the step position');

    const codes = errsOn(acting({ action: 'gmail_new_message', query: 'is:unread' }), 'act').map(e => e.code);
    assert.ok(codes.includes('UNKNOWN_CONNECTOR_ACTION'),
      'a capability that cannot occupy the STEP position is not a connector-action a workflow may run');
  });

  test('POSITIVE: a step capability IS an action', () => {
    assert.deepEqual(errsOn(acting({ action: 'gmail_search', query: 'is:unread' }), 'act'), [],
      'gmail_search is positions:[step] and must stay accepted — the rule narrows what an action is, it does not ban actions');
  });

  test('an action whose capability is NOT READY is rejected at build time', () => {
    // Kills the mutation-sweep survivor at workflow-validator.js:1225
    // (`COND_FALSE  } else if (cap.available === false)`) — F added the check and no
    // test executed it, so it could be deleted with the whole suite green.
    const unready = productionCatalog();
    const get = unready.get.bind(unready);
    unready.get = (id) => {
      const ch = get(id);
      if (!ch) return null;
      return id === 'slack_history'
        ? { ...ch, available: false, unavailableReason: 'Slack is not connected' }
        : ch;
    };
    const v = new WorkflowValidator({ nodeTypes, channelRegistry: unready });
    const errs = v.validate(acting({ action: 'slack_history', target: '#ops' })).errors.filter(e => e.nodeId === 'act');

    assert.deepEqual(errs.map(e => e.code), ['CHANNEL_UNAVAILABLE'],
      'a connector-action on a capability the tenant has not connected must fail at BUILD time, ' +
      'not at 6am inside a run');
    assert.match(errs[0].message, /Slack is not connected/);
  });

  test('POSITIVE: the same action on a READY capability is accepted', () => {
    assert.deepEqual(errsOn(acting({ action: 'slack_history', target: '#ops' }), 'act'), [],
      'without this, CHANNEL_UNAVAILABLE would pass even if it rejected everything');
  });
});

// ── 4. Every capability the catalog OFFERS is one the validator ACCEPTS ──────

describe('the catalog and the validator agree about every capability', () => {
  test('a connector-action built from each capability\'s own required keys validates', () => {
    // The Builder's connector-schema.test.js runs this over `realCatalog()`, which is
    // missing in_app/webhook/filesystem/web. Over the PRODUCTION catalog it also covers
    // the capabilities buildEngine() registers last — the ones nobody has validated
    // against the new closed schema.
    const rejected = [];
    for (const cap of catalog.getAll()) {
      const cfg = { action: cap.id };
      for (const f of (cap.configSchema ?? [])) {
        if (!f.optional) cfg[f.key] = f.key === 'fields' ? { Name: 'x' } : 'x';
      }
      const bad = errsOn(acting(cfg), 'act');
      if (bad.length) rejected.push(`${cap.id}: ${bad.map(e => `${e.code}(${e.field})`).join(', ')}`);
    }
    assert.deepEqual(rejected, [],
      'a capability the builder offers must be one publish accepts (ENGINEERING-LOG.md, Increment C)');
  });
});
