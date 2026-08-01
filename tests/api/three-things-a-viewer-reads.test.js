/**
 * THREE PIECES OF TEXT A CUSTOMER READS CLOSELY, AND ALL THREE WERE WRONG.
 *
 * Each was found by using the product rather than reading it, and each sits on a screen
 * someone is pointing at — the two renderers here are on the FIRST card of the walkthrough
 * and on the step card immediately before Run test.
 *
 *   1. **A Gmail query rendered as garbage.** `_plainFilter` split on whitespace, so a
 *      real grouped query came out as
 *      *mentioning "(subject:(buy)", mentioning "OR", mentioning "buying"…*
 *      Carried as open since 2026-07-30 and never fixed because it never broke anything —
 *      it only ever looked broken.
 *   2. **"a Google Sheet"** on a build that knew exactly which sheet and tab it meant.
 *   3. **The changelog as a new user's welcome mat** — covered by its own assertions at
 *      the end, because the bug was not the missing gate but WHERE the gate looked.
 *
 * The renderers are extracted from `public/index.html` and EXECUTED, not copied. A copy is
 * what drifts; this is the same harness `step-approval-card.test.js` uses, for the same
 * reason.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/** Lift a method out of the page and make it callable, so a copy can never drift. */
function methods(...names) {
  const grab = (n) => {
    const i = HTML.indexOf(`  ${n}(`);
    assert.ok(i > 0, `${n} is gone from public/index.html — re-point this test`);
    const j = HTML.indexOf('\n  }', i);
    return HTML.slice(i, j + 4);
  };
  // eslint-disable-next-line no-new-func
  return new Function(`return {${names.map(grab).join(',')}}`)();
}

const ui = methods('_plainFilter', '_plainAge', '_destinationOf');

describe('a Gmail query reads as English, not as fragments', () => {
  test('THE PROD CASE — a grouped OR is ONE condition', () => {
    assert.equal(ui._plainFilter('subject:(buy OR buying OR purchase) is:unread'),
      'with buy, buying or purchase in the subject, that are unread');
  });

  test('the old rendering is gone for good', () => {
    // The exact shape that shipped: a bare parenthesis quoted back at the customer.
    const out = ui._plainFilter('subject:(buy OR buying OR purchase)');
    assert.doesNotMatch(out, /\(/, 'a parenthesis reached the customer-facing sentence');
    assert.doesNotMatch(out, /mentioning "OR"/i, '"OR" was described as a word to look for');
    assert.doesNotMatch(out, /subject:/, 'raw Gmail syntax reached the sentence');
  });

  test('a two-term group needs no comma', () => {
    assert.equal(ui._plainFilter('subject:(pricing OR cost)'), 'with pricing or cost in the subject');
  });

  test('a negated group still reads as an exclusion', () => {
    assert.match(ui._plainFilter('-from:(spam@x.com OR junk@y.com)'), /^not from spam@x\.com or junk@y\.com$/);
  });

  test('EVERY UNGROUPED FILTER RENDERS EXACTLY AS BEFORE', () => {
    // The change must be additive. These are the shapes the converger writes most, and a
    // regression here would be worse than the bug being fixed.
    const same = [
      ['is:unread', 'that are unread'],
      ['from:jane@acme.co has:attachment', 'from jane@acme.co, with an attachment'],
      ['-label:promotions is:unread', 'not labelled promotions, that are unread'],
      ['is:starred', 'that are starred'],
      ['newer_than:1d', 'from the last 1 day'],
      ['to:support@acme.co', 'sent to support@acme.co'],
    ];
    for (const [q, want] of same) assert.equal(ui._plainFilter(q), want, q);
  });

  test('an empty filter still says nothing at all', () => {
    for (const q of ['', '   ', null, undefined]) assert.equal(ui._plainFilter(q), '');
  });

  test('an unmatched parenthesis falls through rather than throwing', () => {
    // Malformed input must degrade to the old behaviour, never crash the card.
    assert.doesNotThrow(() => ui._plainFilter('subject:(buy OR'));
    assert.ok(ui._plainFilter('subject:(buy OR').length > 0);
  });
});

describe('the step card names the sheet it means', () => {
  const dest = (c) => ui._destinationOf({ channel: 'sheets_append', ...c });

  test('THE PROD CASE — tab and sheet name, when both are known', () => {
    assert.equal(dest({ spreadsheetId: 'Agntic CRM', range: 'Sheet1' }),
      'the Sheet1 tab of the Agntic CRM Google Sheet');
  });

  test('AN OPAQUE ID IS NEVER SHOWN TO A CUSTOMER', () => {
    // Once discovery resolves the sheet, the id is a 44-character key that tells a reader
    // nothing — and printing it is the errand this product spent a day removing.
    const out = dest({ spreadsheetId: '1DG5qZ9mHvTlTU34iGRKWf9-vPyegVufENVmoJLcdnSA', range: 'Sheet1' });
    assert.doesNotMatch(out, /1DG5qZ9/, 'the raw spreadsheet id reached the card');
    assert.equal(out, 'the Sheet1 tab of your Google Sheet');
  });

  test('a range with a cell span names only the tab', () => {
    assert.equal(dest({ range: 'Leads!A:E' }), 'the Leads tab of your Google Sheet');
  });

  test('knowing nothing still says something true', () => {
    assert.equal(dest({}), 'a Google Sheet');
  });

  test('no other destination wording changed', () => {
    for (const [cfg, want] of [
      [{ channel: 'docs_create' }, 'a new Google Doc'],
      [{ channel: 'in_app' }, 'your Atlas inbox'],
      [{ channel: 'calendar_create_event' }, 'a new Google Calendar event'],
      [{ channel: 'gmail_send', to: 'a@b.co' }, 'a@b.co'],
    ]) assert.equal(ui._destinationOf(cfg), want, JSON.stringify(cfg));
  });
});

describe('a new user is not handed the changelog', () => {
  /**
   * SOURCE-level, and weaker than the rest — the loader closes over component state and
   * fetch. Said plainly because the DEFECT here was subtle: a gate existed, and it looked
   * at the wrong thing.
   *
   * `atlas_tutorial_done` is per-ORIGIN, so it is shared by every Atlas account ever used
   * in that browser. Witnessed 2026-08-01: a brand-new workspace's first-ever login showed
   * the full v1.6.106 release notes, because the flag was already set by a different
   * account in the same Chrome profile.
   */
  test('the new-user test is keyed to the ACCOUNT, not the browser', () => {
    // Anchored on the DEFINITION, not the first `this._loadWhatsNew()` call site, which
    // appears earlier in the file and gave a window with none of the code in it.
    const at = HTML.indexOf('  _loadWhatsNew() {');
    assert.ok(at > 0, 're-point this test');
    const body = HTML.slice(at, at + 2200);
    assert.match(body, /atlas_tutorial_done:/, 'the flag is still shared across accounts');
    assert.match(body, /this\.state\.user/, 'the account is not consulted at all');
  });

  test('a brand-new account is marked caught up rather than shown the backlog', () => {
    const at = HTML.indexOf('  _loadWhatsNew() {');
    const body = HTML.slice(at, at + 2200);
    assert.match(body, /if \(isNewUser\) \{ self\._ackWhatsNew\(\); return; \}/);
  });

  test('and it defaults to NEW when nothing can be read', () => {
    // Fail toward silence: a new user seeing no notes loses nothing, while a new user
    // seeing the backlog is the defect.
    const at = HTML.indexOf('  _loadWhatsNew() {');
    assert.match(HTML.slice(at, at + 2200), /let isNewUser = true;/);
  });
});
