/**
 * ATLAS TOLD A USER THEIR CONNECTED CONNECTOR WASN'T CONNECTED.
 *
 * WITNESSED ON PROD, 2026-07-29. Asked for a weekly CRM digest written into a Google
 * Doc, Atlas spent three turns designing it — reading the real table, catching that
 * the base has no last-modified field, agreeing what to put in the doc — produced a
 * plan, took the approval, and then refused to build:
 *
 *     I can't include gdrive — that connector is not connected, so I won't promise
 *     something the workflow can't actually do. Connect it and I'll add it.
 *
 * Google Workspace WAS connected (`hello@agntic.co`, alongside Slack, Airtable and
 * Web). The refusal itself is the right instinct — never promise what cannot be
 * delivered — but it fired on a false premise, so a workflow Atlas could run
 * perfectly well was declined and the user was told their working connector was
 * missing.
 *
 * THE CAUSE WAS ONE MISSING WORD. `CONNECTOR_ALIASES` spells out `gdocs` and `gcal`;
 * nobody wrote `gdrive` or `gsheets`. `canonicalConnector` splits compound names on
 * `_`/`-`/`.`, so `google_drive` resolved and `gdrive` did not. This is the same
 * one-word omission as the missing `tasks` entry earlier the same day, and the same
 * cost: a correct workflow refused.
 *
 * SO IT IS FIXED AS A FAMILY, NOT AS INSTANCES. A vendor prefix run together with
 * the service name is a pattern; the spellings a model might choose are unbounded.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalConnector } from '../../src/workflows/outcome-oracle.js';

/** The keys the rest of the oracle, the validator and the gap scorer reason about. */
const KNOWN = new Set(['slack', 'gmail', 'docs', 'drive', 'sheets', 'calendar',
                       'airtable', 'inbox', 'webhook', 'filesystem', 'tasks']);

describe('THE PROD CASE', () => {
  test('gdrive resolves to drive', () => {
    assert.equal(canonicalConnector('gdrive'), 'drive');
  });

  test('and gsheets, the other one nobody wrote down', () => {
    assert.equal(canonicalConnector('gsheets'), 'sheets');
  });
});

describe('every spelling a model actually writes', () => {
  // Deliberately enumerated rather than generated: this is the list of things that
  // have to work, and a reader should be able to see it.
  const SPELLINGS = [
    ['gdrive', 'drive'], ['gdocs', 'docs'], ['gsheets', 'sheets'],
    ['gcal', 'calendar'], ['gtasks', 'tasks'],
    ['googledrive', 'drive'], ['googledocs', 'docs'], ['googlesheets', 'sheets'],
    ['googlecalendar', 'calendar'], ['googletasks', 'tasks'],
    ['google_drive', 'drive'], ['google_docs', 'docs'], ['google_sheets', 'sheets'],
    ['google_calendar', 'calendar'], ['google_tasks', 'tasks'],
    ['drive', 'drive'], ['docs', 'docs'], ['sheets', 'sheets'],
    ['calendar', 'calendar'], ['tasks', 'tasks'],
  ];

  for (const [written, want] of SPELLINGS) {
    test(`"${written}" → ${want}`, () => assert.equal(canonicalConnector(written), want));
  }

  test('all of them land on a key the rest of the system knows', () => {
    for (const [written] of SPELLINGS) {
      assert.ok(KNOWN.has(canonicalConnector(written)), written);
    }
  });
});

describe('nothing is over-flattened', () => {
  test('gmail stays gmail — it is not "mail"', () => {
    // The sharpest risk in stripping a leading `g`: gmail is a connector in its own
    // right and must be returned long before it could be shortened.
    assert.equal(canonicalConnector('gmail'), 'gmail');
  });

  test('googlemail also lands on gmail', () => {
    assert.equal(canonicalConnector('googlemail'), 'gmail');
  });

  test('a connector with nothing to strip is untouched', () => {
    for (const c of ['slack', 'airtable', 'inbox', 'webhook', 'filesystem']) {
      assert.equal(canonicalConnector(c), c);
    }
  });

  test('an unknown connector is returned as itself, not guessed at', () => {
    // A name we do not know must stay unknown: inventing a match here would let a
    // spec promise a connector nobody has.
    for (const c of ['notion', 'hubspot', 'zzz', 'g', 'google']) {
      const r = canonicalConnector(c);
      assert.ok(r === c || KNOWN.has(r), `${c} → ${r}`);
    }
    assert.equal(canonicalConnector('notion'), 'notion');
    assert.equal(canonicalConnector('hubspot'), 'hubspot');
  });

  test('the prefix rule needs something left after it', () => {
    // "g" and "google" alone name no service.
    assert.equal(canonicalConnector('g'), 'g');
    assert.doesNotMatch(String(canonicalConnector('google')), /^(drive|docs|sheets|tasks)$/);
  });

  test('empty and rubbish input do not throw', () => {
    for (const v of ['', '   ', null, undefined]) assert.equal(typeof canonicalConnector(v), 'string');
  });
});
