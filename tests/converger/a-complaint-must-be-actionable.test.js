/**
 * A CRITIC'S COMPLAINT MUST BE ACTIONABLE BEFORE IT IS WORTH A WHOLE-SPEC REBUILD.
 *
 * MEASURED 2026-08-01, driving two workflows as a new customer on a fresh tenant: the
 * sufficiency critic ordered **3 of the 5 total rebuild passes across both builds**, and
 * two of the three were answerable from the spec itself.
 *
 *   · *"branch node config: the branch must route on classify_inquiry output with cases
 *     for 'pricing_inquiry' (to compose_summary) and 'none' (to stop_no_action)"* — the
 *     branch did exactly that already. The walkthrough card listed those very cases.
 *   · *"the workflow lacks the actual connector-action configs for search_inbox and
 *     search_sent"* — `search_sent` is not a capability, so no rebuild could ever add it.
 *
 * THE ANTI-FALSE-POSITIVE CASES ARE THE POINT, and they are most of this file. Discarding
 * a legitimate gap ships a workflow with a real deficiency; buying an unnecessary pass
 * costs time and money. The first is worse, so every uncertain case keeps today's
 * behaviour — including the third complaint from that day, which named nothing checkable
 * and may well have been correct.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  sufficiencyUnactionable, namedIdentifiers, identifiersInSpec,
} from '../../src/converger/sufficiency-actionable.js';
import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';

/** The live catalog, so "does this capability exist" is the real question. */
function catalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  return reg;
}

/** Build 1's spec, in the shape the walkthrough showed. */
const SPEC = {
  nodes: [
    { id: 'classify_inquiry', type: 'llm', config: { mode: 'classify', categories: 'pricing_inquiry\nnone' } },
    { id: 'compose_summary', type: 'llm', config: { mode: 'summarize' } },
    { id: 'stop_no_action', type: 'stop', config: {} },
    { id: 'route', type: 'branch',
      config: { on: 'classify_inquiry.output',
                cases: [{ when: 'pricing_inquiry', to: 'compose_summary' }, { when: 'none', to: 'stop_no_action' }] } },
    { id: 'search', type: 'connector-action', config: { action: 'gmail_search' } },
  ],
};

const BUILD1 = "branch node config: the branch must route on classify_inquiry output with cases for 'pricing_inquiry' (to compose_summary) and 'none' (to stop_no_action)";
const BUILD2 = 'The workflow lacks the actual connector-action configs for search_inbox and search_sent';
const BUILD3 = 'A step that extracts individual email metadata (sender name, subject, received time) from the search results';

describe('THE TWO PROD COMPLAINTS THAT BOUGHT A PASS', () => {
  test('a complaint naming only what already exists is discarded', () => {
    assert.equal(sufficiencyUnactionable(BUILD1, SPEC, catalog()), 'names_only_what_already_exists');
  });

  test('…and it lands on THAT rule, not the phantom one', () => {
    // It named the branch's own CASE VALUES. Scanning node ids alone sent it down the
    // phantom-capability path — the right verdict for the wrong reason, which is a bug
    // waiting to be believed. The whole spec is scanned for exactly this.
    const r = sufficiencyUnactionable(BUILD1, SPEC, catalog());
    assert.doesNotMatch(r, /does_not_exist/);
  });

  test('a complaint naming something that exists nowhere is discarded', () => {
    const r = sufficiencyUnactionable(BUILD2, SPEC, catalog());
    assert.match(r, /^names_something_that_does_not_exist:/,
      'a rebuild was bought for a capability no rebuild can add');
  });

  test('and the reason says WHICH phantom, so a log reader can act on it', () => {
    assert.match(sufficiencyUnactionable(BUILD2, SPEC, catalog()), /search_/);
  });
});

describe('IT MUST NOT SILENCE A REAL GAP', () => {
  test('prose naming nothing checkable still buys the pass', () => {
    // The third complaint from that day. It may well have been right, and nothing here
    // can tell — so it is untouched.
    assert.equal(sufficiencyUnactionable(BUILD3, SPEC, catalog()), null);
    assert.equal(sufficiencyUnactionable('The workflow never sends anything to the customer', SPEC, catalog()), null);
  });

  test('a REAL capability the spec lacks is a genuine, fixable gap', () => {
    // `sheets_append` exists and is not in this spec: a rebuild can add it, so it must.
    assert.equal(sufficiencyUnactionable('There is no step that calls sheets_append to log the row', SPEC, catalog()), null);
  });

  test('a mix of present and genuinely-addable names still buys the pass', () => {
    assert.equal(
      sufficiencyUnactionable('classify_inquiry runs but nothing calls docs_create afterwards', SPEC, catalog()),
      null);
  });

  test('with NO catalog it never claims something is phantom', () => {
    // Absence is unknowable without the catalog, and this must not guess. Rule 1 still
    // applies, because that reads the spec alone.
    assert.equal(sufficiencyUnactionable(BUILD2, SPEC, null), null);
    assert.equal(sufficiencyUnactionable(BUILD1, SPEC, null), 'names_only_what_already_exists');
  });

  test('an empty or absent complaint is not discarded by this check', () => {
    for (const c of [null, undefined, '', '   ']) {
      assert.equal(sufficiencyUnactionable(c, SPEC, catalog()), null, JSON.stringify(c));
    }
  });

  test('an empty spec cannot make everything look present', () => {
    // The dangerous direction: if the spec scan returned everything, every complaint
    // would read as already-covered and the critic would be silenced entirely.
    assert.equal(sufficiencyUnactionable('nothing calls gmail_search', { nodes: [] }, catalog()), null);
  });
});

describe('what counts as an identifier', () => {
  test('snake_case is read; ordinary prose is not', () => {
    assert.deepEqual(namedIdentifiers('add a gmail_search step and a summary'), ['gmail_search']);
    assert.deepEqual(namedIdentifiers('The workflow needs a summary step'), []);
    assert.deepEqual(namedIdentifiers('Sender name, subject and received time'), []);
  });

  test('repeats are collapsed', () => {
    assert.deepEqual(namedIdentifiers('gmail_search then gmail_search again'), ['gmail_search']);
  });

  test('the spec scan finds ids, case values and field names alike', () => {
    const ids = identifiersInSpec(SPEC);
    for (const id of ['classify_inquiry', 'compose_summary', 'stop_no_action', 'pricing_inquiry', 'gmail_search']) {
      assert.ok(ids.has(id), `${id} was not found in the spec`);
    }
  });

  test('a spec that cannot be serialised yields nothing rather than throwing', () => {
    const cyclic = { nodes: [] }; cyclic.self = cyclic;
    assert.doesNotThrow(() => identifiersInSpec(cyclic));
    assert.equal(identifiersInSpec(cyclic).size, 0);
  });
});

describe('it is actually consulted by the critic', () => {
  /**
   * SOURCE-level, and weaker than the rest — the sufficiency node closes over the LLM and
   * graph state and cannot be lifted. Added after mutation: neutralising the call site
   * left all 14 behavioural tests green, which means the whole module could have been
   * dead code and nothing would have said so.
   */
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const SRC = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');

  test('the sufficiency gate calls it, with the live catalog', () => {
    assert.match(SRC, /const unactionable = sufficiencyUnactionable\(verdict\.missing, draft, capabilityCatalog\)/,
      'the critic no longer asks whether its complaint is actionable');
  });

  test('and an unactionable verdict overrules the rebuild', () => {
    const at = SRC.indexOf('const unactionable =');
    assert.ok(at > 0, 're-point this test');
    const body = SRC.slice(at, at + 700);
    assert.match(body, /covered \|\| repeated \|\| contradictsUser \|\| unactionable/,
      'the verdict is computed but not acted on');
    assert.match(body, /reason:/, 'the reason must reach the log so a silenced complaint is visible');
  });
});
