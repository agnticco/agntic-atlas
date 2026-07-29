/**
 * WHERE A WRITE LANDS IS DECLARED BY THE CAPABILITY — NEVER GUESSED FROM KEY NAMES.
 *
 * WITNESSED ON PROD, 2026-07-29, on a build started from one vague sentence. The
 * workflow was CORRECT: a Gmail trigger, a classifier, a branch, and a step creating
 * a Google Task. The oracle reported:
 *
 *     nothing reached "My Tasks" in tasks —
 *     this run delivered to {{extract_email.subject}} (tasks), and nothing else
 *
 * `tasks_create` takes `{title, notes, due, tasklistId}`. The oracle's fallback
 * `LOCATOR_KEYS` list — a fixed set of key names that USUALLY name a destination —
 * contains `title` and does NOT contain `tasklistId`. So it reported the task's own
 * NAME as the place the task was written to, and the promise "a record in My Tasks"
 * became unsatisfiable by any correct workflow.
 *
 * WHAT IT COST. The converger cannot tell a false complaint from a true one, so it
 * did what it is built to do: it rebuilt. Three times — `blocking_gaps`, then
 * `gap_answer`, then `verify_failed` twice — 355 seconds of Opus across four
 * generate passes, ~$1.40, and the build still could not go live. The spec was
 * right on pass one.
 *
 * THIS IS THE FOURTH TIME a rule scoped to the SHAPE OF A NAME has been the defect
 * here (`isWritingAction`, the trigger captions, the step-type tables, now this).
 * Hence: the capability DECLARES where it writes, and the tests below are written so
 * that re-deriving the answer from names cannot make them pass.
 *
 * TWO PLACES DECIDED THIS, AND THEY HAD DRIFTED. `nodeEffect` answers "can this node
 * satisfy the promise" at build time; `normalizeDelivery` builds the RECEIPT that the
 * runtime check matches and whose first entry gets quoted back to the user. Fixing
 * one alone leaves the other wrong, so both are pinned here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels, tasksCreate } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import {
  nodeEffect, normalizeDelivery, checkAssertionAtRuntime, deliveryTarget,
  setCapabilityCatalog,
} from '../../src/workflows/outcome-oracle.js';

/** The real shipped registry — not a fixture. */
function realCatalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  setCapabilityCatalog(reg);
  return reg;
}

/** The node exactly as prod generated it: no tasklistId, title is a template. */
const PROD_NODE = {
  id: 'create_task', type: 'connector-action',
  config: { action: 'tasks_create', title: '{{extract_email.subject}}', notes: '{{compose_notes.output}}' },
};
const PROMISE = { target: 'tasks:My Tasks', kind: 'record_exists' };
const receiptFor = (node) => normalizeDelivery(node, { dryRun: true, wouldDeliver: true });

describe('the prod case: a task goes to a LIST, not to its own title', () => {
  test('the destination is the list', () => {
    realCatalog();
    assert.deepEqual(nodeEffect(PROD_NODE).locators, ['My Tasks']);
  });

  test('the title is NOT reported as a destination', () => {
    // The single assertion that would have caught this on the way in.
    realCatalog();
    assert.ok(!nodeEffect(PROD_NODE).locators.includes('{{extract_email.subject}}'),
      "the task's own name is content, not a place");
  });

  test('and so the promise is keepable at all', () => {
    realCatalog();
    const r = checkAssertionAtRuntime(PROMISE, [receiptFor(PROD_NODE)]);
    assert.equal(r.ok, true, r.reason ?? '');
  });

  test('the exact sentence a person was shown is gone', () => {
    realCatalog();
    const r = checkAssertionAtRuntime(PROMISE, [receiptFor(PROD_NODE)]);
    assert.doesNotMatch(String(r.reason ?? ''), /\{\{.*\}\}/,
      'an unresolved template must never be quoted back as a destination');
  });
});

describe('both deciders agree — the duplication that let this drift', () => {
  test('the RECEIPT names the same destination as the build-time check', () => {
    realCatalog();
    assert.equal(receiptFor(PROD_NODE).target, nodeEffect(PROD_NODE).locators[0]);
  });

  test('the receipt puts the destination FIRST, because that is what gets quoted', () => {
    // Matching accepts any entry in the list, so a wrong entry is invisible to the
    // ok/not-ok result — it only shows up in the sentence the user reads. Ordering
    // is therefore untested by every other assertion in this file.
    realCatalog();
    assert.equal(receiptFor(PROD_NODE).locators[0], 'My Tasks');
  });

  test('a destination is seen as PRESENT, not merely as not-wrong', () => {
    // Declaring `locatorKeys` without a default would trade the wrong answer for
    // "no destination was filled in" — the same build failing for a new reason.
    realCatalog();
    assert.deepEqual(deliveryTarget(PROD_NODE), { present: true, locatorFree: false, target: 'My Tasks' });
  });
});

describe('an explicit destination always beats the implicit one', () => {
  const explicit = (tasklistId) => ({ ...PROD_NODE, config: { ...PROD_NODE.config, tasklistId } });

  test('a named list is used', () => {
    realCatalog();
    assert.deepEqual(nodeEffect(explicit('Work')).locators, ['Work']);
  });

  test('and a promise about a DIFFERENT list still fails', () => {
    // The fix must not become a fail-open: "it writes to tasks somewhere" is not
    // the same as "it writes to My Tasks".
    realCatalog();
    const r = checkAssertionAtRuntime(PROMISE, [receiptFor(explicit('Work'))]);
    assert.equal(r.ok, false, 'writing to the wrong list is not keeping the promise');
    assert.match(r.reason, /Work/, 'and the person must be told where it actually went');
  });

  test('a blank one falls back rather than reporting an empty destination', () => {
    realCatalog();
    assert.deepEqual(nodeEffect(explicit('   ')).locators, ['My Tasks']);
  });
});

describe('a real run can correct the declaration', () => {
  /** A gapi stub that answers the create and records nothing else. */
  const gapi = async () => ({ id: 'task-1' });

  test('the handler reports the list it wrote to', async () => {
    // Build-time truth comes from the declaration; runtime truth must come from
    // what actually happened, or a wrong declaration can never be caught by a run.
    const out = await tasksCreate(gapi, { title: 'Reply to Jane' });
    assert.equal(out.tasklistId, 'My Tasks');
  });

  test("and not with the provider's sentinel", () => {
    // '@default' is what the API takes; it identifies nothing to a reader and can
    // never match an outcome that promises "My Tasks".
    assert.ok(!JSON.stringify(PROD_NODE).includes('@default'));
    return tasksCreate(gapi, { title: 'x' }).then(o =>
      assert.notEqual(o.tasklistId, '@default'));
  });

  test('an explicitly named list is reported as itself', async () => {
    const out = await tasksCreate(gapi, { title: 'x', tasklistId: 'Work' });
    assert.equal(out.tasklistId, 'Work');
  });

  test("THE RUN'S ANSWER IS READ, not just the config", async () => {
    // The half that m4 caught: the handler can return the truth and the receipt can
    // still ignore it. Here config says one list and the run reports another — the
    // receipt must lead with what actually happened.
    realCatalog();
    const node = { ...PROD_NODE, config: { ...PROD_NODE.config, tasklistId: 'Work' } };
    const live = normalizeDelivery(node, await tasksCreate(gapi, { title: 'x', tasklistId: 'Personal' }));
    assert.equal(live.locators[0], 'Personal', 'the run overrules the declaration');
  });
});

describe('the DECLARATION decides, not the name', () => {
  test('a capability named nothing like a write, that declares one, is one', () => {
    // These two fixtures are the whole point: every real capability's name happens
    // to agree with its declaration, so a rule that re-derived the answer from the
    // id would pass every other test in this file.
    const reg = new CapabilityRegistry();
    reg.register({
      id: 'notion_page', positions: ['step'], connector: 'notion',
      effect: 'write', assertionKind: 'record_exists',
      locatorKeys: ['database'], handle: () => ({}),
    });
    setCapabilityCatalog(reg);
    const eff = nodeEffect({ type: 'connector-action', config: { action: 'notion_page', database: 'Leads', title: 'Acme' } });
    assert.ok(eff, 'a declared write with no write-ish verb in its id is still a write');
    assert.deepEqual(eff.locators, ['Leads'], 'and its DECLARED key wins over the guessable `title`');
  });

  test('a capability named exactly like a write, that declares a read, is a read', () => {
    const reg = new CapabilityRegistry();
    reg.register({ id: 'gmail_send_lookup', positions: ['step'], connector: 'gmail', effect: 'read', handle: () => ({}) });
    setCapabilityCatalog(reg);
    assert.equal(nodeEffect({ type: 'connector-action', config: { action: 'gmail_send_lookup', to: 'x@y.z' } }), null,
      'a read may never satisfy a promise, whatever it is called');
  });

  test('fetching a message is not sending one', () => {
    // `gmail_get_message` matches the `message_sent` verb regex (`…_message`), so
    // undeclared it counted as a send: a workflow that only READ mail could satisfy
    // an outcome promising mail was sent.
    realCatalog();
    assert.equal(nodeEffect({ type: 'connector-action', config: { action: 'gmail_get_message', messageId: 'm1' } }), null);
  });

  test('every shipped write capability declares where it writes', () => {
    // A trait one capability declares is a trait the next one silently skips. This
    // reads the live registry, so a new write added without a declaration fails here.
    const reg = realCatalog();
    const undeclared = reg.list()
      .filter(c => c.effect === 'write')
      .filter(c => !(Array.isArray(c.locatorKeys) && c.locatorKeys.length))
      .map(c => c.id);
    assert.deepEqual(undeclared, [], 'these fall back to guessing key names');
  });
});

describe('a capability that declares nothing still works', () => {
  test('the guess list remains the fallback', () => {
    // Capabilities from sources we do not control (an imported server, a generated
    // connector) declare nothing. Losing their destination entirely would be a
    // worse failure than guessing it.
    const reg = new CapabilityRegistry();
    reg.register({ id: 'zzz_create_record', positions: ['step'], connector: 'zzz', handle: () => ({}) });
    setCapabilityCatalog(reg);
    assert.deepEqual(
      nodeEffect({ type: 'connector-action', config: { action: 'zzz_create_record', table: 'Leads' } }).locators,
      ['Leads']);
  });

  test('and a default is never invented for one', () => {
    const reg = new CapabilityRegistry();
    reg.register({ id: 'zzz_create_record', positions: ['step'], connector: 'zzz', handle: () => ({}) });
    setCapabilityCatalog(reg);
    assert.deepEqual(nodeEffect({ type: 'connector-action', config: { action: 'zzz_create_record' } }).locators, []);
  });

  test('the registry stores a declared default, and defaults it to null', () => {
    const reg = new CapabilityRegistry();
    reg.register({ id: 'a', positions: ['step'], defaultLocator: '  My Tasks ', handle: () => ({}) });
    reg.register({ id: 'b', positions: ['step'], handle: () => ({}) });
    reg.register({ id: 'c', positions: ['step'], defaultLocator: '   ', handle: () => ({}) });
    assert.equal(reg.get('a').defaultLocator, 'My Tasks', 'trimmed');
    assert.equal(reg.get('b').defaultLocator, null);
    assert.equal(reg.get('c').defaultLocator, null, 'blank is not a destination');
  });
});
