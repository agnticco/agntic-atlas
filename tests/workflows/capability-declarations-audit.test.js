/**
 * EVERY CAPABILITY, EVERY SPELLING, EVERY DESTINATION — ENUMERATED, NOT DISCOVERED.
 *
 * Six times on 2026-07-29 the same defect shape was found by a build failing:
 * a rule scoped to the FORM of a name rather than to what the thing MEANS.
 *
 *   · `isWritingAction`        — a verb regex
 *   · the trigger captions     — a name test
 *   · the step-type tables     — a name test
 *   · `tasks` missing from CONNECTOR_ALIASES  → a promise about a task list
 *                                               resolved to GMAIL
 *   · `title` in LOCATOR_KEYS  → a task's own NAME reported as the place it
 *                                was written, costing three Opus rebuilds
 *   · `gdrive` missing          → "that connector is not connected" about a
 *                                CONNECTED connector, after three turns of design
 *
 * Each was fixed where it was found. None of them was found by asking the whole
 * question at once, and the last one landed in a table I had edited hours earlier
 * without noticing its neighbours were also missing. So this file asks the whole
 * question: it walks the LIVE registry and fails when any capability is
 * undeclared, misclassified, unresolvable or missing its destination.
 *
 * The point is not the assertions that pass today. It is that adding a connector
 * without declaring it now fails HERE, loudly, instead of surfacing months later as
 * "Atlas said my connector wasn't connected".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { registerSlackTriggers } from '../../src/connectors/slack/index.js';
import { registerKnowledgeCapabilities } from '../../src/connectors/knowledge/index.js';
import { registerInboxCapability } from '../../src/inbox/index.js';
import { canonicalConnector, nodeEffect, setCapabilityCatalog } from '../../src/workflows/outcome-oracle.js';
import { isWritingAction, isWriteNode } from '../../src/workflows/workflow-validator.js';

/** The live, shipped registry — never a fixture. */
function registry() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  registerSlackTriggers(reg);
  // Knowledge is a connector like any other and must face the same audit — that is the
  // whole point of this file: a capability added without declaring itself fails HERE.
  registerKnowledgeCapabilities(reg, {
    forTenant:   async () => ({ query: async () => [], ingest: async () => 0 }),
    readSources: () => [],
  });
  // The inbox faces the audit too. Both its capabilities shipped DECLARING NOTHING —
  // `inbox_deliver` therefore fell back to the hardcoded channel table, which made the
  // message's own SUBJECT the place it was written.
  registerInboxCapability(reg, { inboxStore: {}, getRagInbox: async () => ({}) });
  setCapabilityCatalog(reg);
  return reg;
}

/** The connector keys the oracle, validator and gap scorer all reason about. */
const KNOWN_CONNECTORS = new Set(['slack', 'gmail', 'docs', 'drive', 'sheets', 'calendar',
                                  'airtable', 'inbox', 'webhook', 'filesystem', 'tasks',
                                  'knowledge', 'atlas']);

/**
 * GROUND TRUTH, written by reading what each capability does — not by asking the
 * code, which is the thing under test. A capability absent from this map fails the
 * completeness check below, so this cannot silently fall behind the registry.
 */
const TRUTH = {
  // reads
  gmail_search: 'read', gmail_get_message: 'read', calendar_list_events: 'read',
  drive_list_files: 'read', sheets_describe: 'read', sheets_read: 'read',
  docs_read: 'read', tasks_list: 'read', airtable_list_bases: 'read',
  airtable_describe_base: 'read', airtable_list_records: 'read',
  airtable_get_record: 'read', airtable_search_records: 'read',
  // writes that name a destination and can satisfy a promise
  gmail_send: 'write', calendar_create_event: 'write', drive_create_folder: 'write',
  sheets_append: 'write', docs_create: 'write', tasks_create: 'write',
  airtable_create_record: 'write', airtable_update_record: 'write',
  airtable_create_field: 'write',
  // Creates a CONTAINER, so its name really is the destination — unlike an event's
  // title. One-time setup, like `airtable_create_field`: `SETUP_ACTION_AS_STEP` keeps
  // it out of the run path, and it is invoked by the build's create-or-pick question.
  sheets_create: 'write',
  // MUTATIONS THAT ASSERT NOTHING. They change the world, so every guard must treat
  // them as writes — but "a record exists" is false of both, so they deliberately do
  // NOT declare an effect: that would let a delete satisfy a promise that something
  // exists. The vocabulary has no kind for "changed, nothing created"; adding one is
  // a real follow-up, and until then this is the honest position.
  gmail_mark_read: 'mutation', airtable_delete_record: 'mutation',
  // triggers never satisfy anything
  gmail_new_message: 'trigger', airtable_record_changed: 'trigger',
  slack_message: 'trigger', slack_mention: 'trigger',
  // Knowledge (2026-07-30) — the tenant's own documents as capabilities.
  knowledge_search: 'read', knowledge_write: 'write',
  // Atlas inbox (declared 2026-07-30 — both had shipped declaring nothing).
  search_inbox: 'read', inbox_deliver: 'write',
};

describe('the audit is complete', () => {
  test('every registered capability has ground truth recorded here', () => {
    // The check that stops this file rotting: a new capability must be classified by
    // a human before any of the assertions below can pass.
    const missing = registry().list().map(c => c.id).filter(id => !TRUTH[id]);
    assert.deepEqual(missing, [], 'add these to TRUTH, having read what they do');
  });

  test('and nothing in here has been removed from the product', () => {
    const ids = new Set(registry().list().map(c => c.id));
    assert.deepEqual(Object.keys(TRUTH).filter(id => !ids.has(id)), []);
  });
});

describe('every capability DECLARES what it does', () => {
  test('no shipped capability leaves the oracle guessing', () => {
    // 19 of 28 declared nothing before this audit, so a verb regex decided. Two are
    // deliberate exceptions, named in TRUTH and justified there.
    const undeclared = registry().list()
      .filter(c => c.effect !== 'read' && c.effect !== 'write')
      .map(c => c.id)
      .filter(id => TRUTH[id] !== 'mutation');
    assert.deepEqual(undeclared, [], 'declare effect: read | write on these');
  });

  test('the declaration matches the truth', () => {
    for (const c of registry().list()) {
      const truth = TRUTH[c.id];
      if (truth === 'mutation') continue;
      const want = truth === 'trigger' ? 'read' : truth;
      assert.equal(c.effect, want, `${c.id} declares ${c.effect}, truth is ${truth}`);
    }
  });
});

describe('the oracle classifies every capability correctly', () => {
  test('a read can never satisfy a promise', () => {
    // The fail-OPEN direction: a read mistaken for a write lets a workflow that only
    // looked at something certify as having done it. `gmail_get_message` did exactly
    // this — `…_message` matched the message_sent verb.
    for (const c of registry().list()) {
      if (TRUTH[c.id] !== 'read' && TRUTH[c.id] !== 'trigger' && TRUTH[c.id] !== 'mutation') continue;
      const eff = nodeEffect({ type: 'connector-action', config: { action: c.id } });
      assert.equal(eff, null, `${c.id} is a ${TRUTH[c.id]} but the oracle sees an effect`);
    }
  });

  test('every real write is seen as one', () => {
    for (const c of registry().list()) {
      if (TRUTH[c.id] !== 'write') continue;
      const eff = nodeEffect({ type: 'connector-action', config: { action: c.id } });
      assert.ok(eff, `${c.id} writes but the oracle sees nothing`);
    }
  });
});

describe('every write names WHERE it writes', () => {
  test('locatorKeys are declared, never guessed from key names', () => {
    // Guessing gave a Google Task's own title as the place it was written, and cost
    // three whole-spec Opus rebuilds before anyone could tell the oracle was wrong.
    //
    // THREE legitimate shapes, not two — the third was added 2026-07-30 when
    // `knowledge_write` became the first shipped capability with ONE fixed destination:
    //   · keys declared          → read the destination from config
    //   · `locatorKeys: []` + a `defaultLocator` → the destination is FIXED and says so
    //   · neither                → undeclared, and that is what this test refuses
    // Declaring `[]` WITHOUT a default would be the worst of both: a capability that
    // claims to know where it writes and then names nowhere.
    const undeclared = registry().list()
      .filter(c => c.effect === 'write')
      .filter(c => !(Array.isArray(c.locatorKeys)
        && (c.locatorKeys.length || (typeof c.defaultLocator === 'string' && c.defaultLocator.trim()))))
      .map(c => c.id);
    assert.deepEqual(undeclared, [], 'declare locatorKeys (or [] plus a defaultLocator) on these');
  });

  test('a FIXED-destination write names that destination', () => {
    // The new category, held to its own bargain: no keys means `defaultLocator` is the
    // whole answer, so it must exist and must not be blank.
    for (const c of registry().list()) {
      if (c.effect !== 'write') continue;
      if (!Array.isArray(c.locatorKeys) || c.locatorKeys.length) continue;
      assert.ok(typeof c.defaultLocator === 'string' && c.defaultLocator.trim(),
        `${c.id} declares no locator keys, so it must declare where it always writes`);
    }
  });

  test('an optional destination declares its default', () => {
    // Declaring the key without a default trades "wrong destination" for "no
    // destination" — the same build failing for a new reason.
    for (const c of registry().list()) {
      if (c.effect !== 'write' || !Array.isArray(c.locatorKeys)) continue;
      const schema = c.configSchema ?? [];
      const allOptional = c.locatorKeys.every(k => {
        const f = schema.find(x => x.key === k);
        return f ? f.optional === true : true;
      });
      if (allOptional && c.locatorKeys.length) {
        assert.ok(c.defaultLocator, `${c.id}: every locator key is optional, so it needs a defaultLocator`);
      }
    }
  });
});

describe('every connector name a model might write resolves', () => {
  test('each WRITE capability id prefix lands on a known connector', () => {
    // Assertions are written in sub-service names (`tasks:My Tasks`), which come from
    // the id prefix — so every prefix that can BECOME an assertion target has to be a
    // name the system knows.
    //
    // Scoped to writes, 2026-07-30, and the reason is the rule's own: a READ produces no
    // assertion, so its prefix is never a destination. `search_inbox` is the one shipped
    // capability named `<verb>_<noun>` instead of `<connector>_<verb>`, so its prefix is
    // "search" — meaningless as a connector and harmless as one, because nothing ever
    // asks where a search wrote. Renaming it to `inbox_search` would be tidier and is
    // recorded as a residual; it is an ID change and stored specs carry ids, so it is not
    // worth breaking them for consistency alone.
    for (const c of registry().list()) {
      if (c.effect !== 'write') continue;
      const prefix = c.id.split('_')[0];
      const canon = canonicalConnector(prefix);
      assert.ok(KNOWN_CONNECTORS.has(canon), `${c.id}: prefix "${prefix}" → "${canon}", unknown`);
    }
  });

  test('a READ with an odd prefix is still classified correctly', () => {
    // The other half: relaxing the prefix rule must not stop a read being a read.
    const searchInbox = registry().list().find(c => c.id === 'search_inbox');
    assert.ok(searchInbox, 'search_inbox is gone — if it was renamed, update TRUTH too');
    assert.equal(searchInbox.effect, 'read');
    assert.equal(nodeEffect({ type: 'connector-action', config: { action: 'search_inbox', query: 'x' } }), null);
  });

  test('and so does the connector each capability declares', () => {
    for (const c of registry().list()) {
      if (!c.connector) continue;
      const canon = canonicalConnector(c.connector);
      assert.ok(KNOWN_CONNECTORS.has(canon) || canon === 'google',
        `${c.id}: connector "${c.connector}" → "${canon}", unknown`);
    }
  });

  test('the vendor-prefixed spellings resolve for every Google service', () => {
    // The `gdrive` defect, generalised: whatever a model runs together, it resolves.
    for (const svc of ['drive', 'docs', 'sheets', 'calendar', 'tasks']) {
      for (const written of [svc, 'g' + svc, 'google' + svc, 'google_' + svc]) {
        assert.equal(canonicalConnector(written), svc, `"${written}"`);
      }
    }
  });
});

describe('nothing that changes the world escapes the guards', () => {
  test('every write and mutation is a writing action', () => {
    // Feeds WRITE_WITHOUT_IDEMPOTENCY and the approval-strength check.
    // `airtable_delete_record` — the most destructive capability shipped — escaped
    // BOTH, because the verb list enumerated only verbs that create.
    for (const c of registry().list()) {
      if (TRUTH[c.id] !== 'write' && TRUTH[c.id] !== 'mutation') continue;
      assert.ok(isWritingAction(c.id), `${c.id} changes the world but is not a writing action`);
    }
  });

  test('destroying is guarded even undeclared', () => {
    // The regex remains only for capabilities from sources we do not control, so it
    // has to cover destruction as well as creation — `airtable_delete_record` escaped
    // both guards precisely because it enumerated only verbs that create.
    for (const id of ['notion_delete_page', 'zzz_remove_row', 'foo_archive_thread',
                      'bar_trash_file', 'abc_mark_read']) {
      assert.ok(isWritingAction(id), id);
    }
  });

  test('but `update`/`move` are deliberately NOT guessed', () => {
    // Not an oversight — a decision, and a test elsewhere depends on it.
    // `notion_update_page` is the CONTROL in `source-agnostic-catalog.test.js` proving
    // that a DECLARATION is what makes a strangely-named write count, not this regex.
    // Widening the guess to cover `update` would make the guessing more load-bearing,
    // which is the direction this whole audit exists to move away from: a shipped
    // capability that updates something declares `effect: 'write'` and never reaches
    // the regex at all.
    for (const id of ['notion_update_page', 'zzz_move_item', 'foo_set_status']) {
      assert.equal(isWritingAction(id), false, `${id} must be caught by declaration, not by name`);
    }
  });

  test('a read is still not a writing action', () => {
    // The other direction matters: treating reads as writes would demand approval
    // for looking at something, which trains people to click through gates.
    for (const c of registry().list()) {
      if (TRUTH[c.id] !== 'read') continue;
      assert.ok(!isWritingAction(c.id), `${c.id} only reads but is treated as a write`);
    }
  });

  test('a delete node counts as a write node', () => {
    assert.ok(isWriteNode({ type: 'connector-action', config: { action: 'airtable_delete_record' } }));
  });
});
