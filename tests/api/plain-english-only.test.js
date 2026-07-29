/**
 * Nothing machine-shaped reaches a person.
 *
 * OPERATOR DIRECTIVES, 2026-07-28:
 *   · "No raw JSON or markdown anywhere in user facing anything."
 *   · "Never raw text, only plain english to users."
 *   · "Always needs to default to the user's browser timezone."
 *   · "The converger needs to confirm with the user the exact time and frequency
 *      of a scheduled workflow."
 *
 * Each came from something witnessed, not from taste:
 *   · an evidence row explaining a KEPT promise with
 *     `{"sender_name":"Patricia Gomez <patricia.gomez@…>","subje…`
 *   · step cards reading `urgent_complaint`, `normal_enquiry`, `spam`
 *   · a step card showing `{{extract_email.sender_name}}`
 *   · a schedule built as "Every Monday at 8am (UTC)" with nobody asked whose 8am
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSystemPrompt } from '../../src/converger/prompts.js';

const src = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

describe('identifiers stay in the codebase', () => {
  const fn = (() => {
    const i = src.indexOf('_plainId(id) {');
    assert.ok(i > 0, '_plainId must exist');
    return src.slice(i, i + 400);
  })();

  test('the identifier is no longer appended in parentheses', () => {
    assert.doesNotMatch(fn, /\+ ' \(' \+ raw \+ '\)'/,
      'urgent_complaint must not appear beside "Urgent complaint" on a step card');
  });

  test('it still produces English from a snake_case id', () => {
    assert.match(fn, /replace\(\/\[_-\]\+\/g, ' '\)/);
    assert.match(fn, /toUpperCase\(\)/, 'the sentence still starts with a capital');
  });
});

describe('no raw JSON or markdown reaches a reader', () => {
  const fn = (() => {
    const i = src.indexOf('_plainText(v, maxLen) {');
    assert.ok(i > 0, '_plainText must exist');
    return src.slice(i, i + 1800);
  })();

  test('a JSON object is reduced to its human values', () => {
    assert.match(fn, /JSON\.parse/);
    assert.match(fn, /vals\.join/, 'the values are joined into something readable');
  });

  test('markdown and Slack emphasis are stripped, not shown', () => {
    assert.match(fn, /\\\*\\\*/, 'bold markers');
    assert.match(fn, /#\{1,6\}/, 'headings');
    assert.match(fn, /```/, 'code fences');
  });

  test('a template reference becomes what it refers to, not braces', () => {
    assert.match(fn, /\\\{\\\{/, '{{extract_email.sender_name}} must not reach the card verbatim');
    assert.match(fn, /'the ' \+/, 'it reads as "the sender name"');
  });

  test('the evidence row uses it — that is where the JSON blob was seen', () => {
    // lastIndexOf: the phrase also appears in the comment explaining WHY this is
    // sanitised, and matching that would pass without the code being wired at all.
    const i = src.lastIndexOf('What came back matched the deal');
    const around = src.slice(i - 400, i + 400);
    assert.match(around, /_plainText/, 'the kept-promise explanation must be sanitised');
  });
});

describe('a schedule is confirmed, never guessed', () => {
  test('the user’s own timezone is the default when known', () => {
    const p = buildSystemPrompt({ userTimezone: 'Europe/London' });
    assert.match(p, /Europe\/London/);
    assert.match(p, /NEVER default to UTC/i);
  });

  test('with no timezone known it must ASK rather than assume UTC', () => {
    const p = buildSystemPrompt({});
    assert.match(p, /ASK which timezone/i);
    assert.doesNotMatch(p, /default to UTC(?! )/i);
  });

  test('both the time AND the frequency must be stated back', () => {
    const p = buildSystemPrompt({ userTimezone: 'Europe/London' });
    assert.match(p, /exact time/i);
    assert.match(p, /how often it runs/i);
    assert.match(p, /never a bare "8am"/i, 'a time without a zone is not a confirmed time');
  });

  test('the browser actually sends its timezone', () => {
    assert.match(src, /resolvedOptions\(\)\.timeZone/,
      'the browser knows the zone — it just was never asked');
    assert.match(src, /timezone: browserTz/, 'and it must reach the build');
  });
});

describe('a time is never shown without its zone', () => {
  // The chat says "8am Central" and the contract carries "8am Central time", but
  // the TRIGGER CARD — the one a person ticks to confirm what starts the workflow
  // — read a bare "Every day at 8:00 AM" (witnessed on prod, v1.6.51). The card
  // exists so a schedule can be checked by reading, and the half that matters most
  // to someone in another zone was the half missing.
  test('the humaniser takes a timezone and appends it', () => {
    const i = src.indexOf('_humanCron(cron, tz) {');
    assert.ok(i > 0, '_humanCron must accept the zone');
    const body = src.slice(i, i + 1200);
    assert.match(body, /withZone\("Every day"/, 'a daily schedule carries its zone');
    assert.match(body, /withZone\("Every weekday"/);
  });

  test('"On a schedule" with no parsed time is NOT given a zone', () => {
    const i = src.indexOf('_humanCron(cron, tz) {');
    const body = src.slice(i, i + 1200);
    assert.match(body, /t \? withZone\("On a schedule"/,
      '"On a schedule CDT" would be nonsense — the zone qualifies a TIME');
  });

  test('every caller passes the trigger’s zone through', () => {
    assert.doesNotMatch(src, /_humanCron\((?:t && )?t?\.?cron\)/,
      'a call site that drops the zone puts a bare time back on the card');
  });
});

describe('every surface agrees on what the workflow is', () => {
  test('the panel counts every step, as the approval queue does', () => {
    const i = src.indexOf('_stepShape(spec) {');
    const body = src.slice(i, i + 4600);
    // BOTH exits — branching and not — derive the count from one method, which also
    // counts the trigger the queue prepends. Fixing only one exit shipped a linear
    // workflow to prod still reading "3 steps" beside "STEP 1 OF 4".
    assert.equal((body.match(/_countedSteps\(spec, nodes\)/g) || []).length, 2,
      'a workflow cannot publish one number here and another in the queue');
  });
});
