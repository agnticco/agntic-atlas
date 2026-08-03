/**
 * A SCHEDULE AND AN EVENT MUST NOT LOOK THE SAME.
 *
 * Charles, 2026-08-03, once both trigger types were finally proven working in
 * production: these are the two kinds of trigger the product actually has, and a
 * person should be able to tell which one starts a workflow at a glance.
 *
 * They were drawn identically. `_nodeShape` gave the BOLT to every non-email
 * trigger, so a 9am schedule and an inbound Slack message were the same picture —
 * on the build canvas, the step cards, and the exported procedure document.
 *
 * `_triggerGlyph` already had it right (⏱ / ⚡) and the DIAGRAM decided
 * separately. That is the same drift that once gave a clock to an Airtable record
 * change, and this codebase records paying for it repeatedly: one question, two
 * answers, and eventually one of them is wrong.
 *
 * THE MEANINGS, which is why these two symbols and not any others:
 *   ⏱  a stopwatch — it starts ITSELF, on a clock
 *   ⚡  a bolt      — something OUT THERE happened
 * Email keeps its envelope; a trigger nothing recognises still gets the hollow
 * circle that says "we cannot tell" rather than borrowing either.
 *
 * ── Mutations, run by hand (2026-08-03) ─────────────────────────────────────
 *   M1  the diagram gives a schedule the bolt again → 1 red
 *   M2  an Airtable event gets its own mark back    → 1 red
 *   M3  the stopwatch is not rendered               → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/** The REAL glyph rule, lifted and executed — never a copy. */
const glyphFor = (() => {
  const i = HTML.indexOf('  _triggerGlyph(t) {');
  assert.notEqual(i, -1, '`_triggerGlyph` is GONE — re-point this, do not delete the test');
  const body = HTML.slice(i, HTML.indexOf('\n  }', i) + 4);
  // eslint-disable-next-line no-new-func
  return new Function('t', body.replace('_triggerGlyph(t) {', 'const f = function(t) {').replace(/\}$/, '};') + ' return f(t);');
})();

describe('the glyph tells you which kind of trigger it is', () => {
  test('a schedule is a stopwatch — it starts itself', () => {
    assert.equal(glyphFor({ type: 'schedule', cron: '0 9 * * *' }), '⏱');
  });

  test('an event is a bolt — something out there happened', () => {
    assert.equal(glyphFor({ type: 'event', connector: 'slack', event: 'message' }), '⚡');
  });

  test('EVERY event is the same bolt, whichever connector raised it', () => {
    // Airtable used to get its own mark, splitting one idea across two pictures so
    // a reader had to learn a second symbol for the same kind of thing.
    const bolts = ['slack', 'airtable', 'notion', ''].map(c => glyphFor({ type: 'event', connector: c }));
    assert.deepEqual(bolts, ['⚡', '⚡', '⚡', '⚡']);
  });

  test('and the two are never the same symbol', () => {
    assert.notEqual(glyphFor({ type: 'schedule' }), glyphFor({ type: 'event', connector: 'slack' }));
  });

  test('email keeps its envelope, and the unknown keeps its hollow circle', () => {
    // The anti-overreach direction. A trigger nothing recognises must not borrow
    // either meaning — "we cannot tell" is the honest picture.
    assert.equal(glyphFor({ type: 'email' }), '✉');
    assert.equal(glyphFor({ type: 'connector_event' }), '◯');
    assert.equal(glyphFor({}), '◯');
  });
});

describe('the diagram agrees with the glyph, rather than deciding again', () => {
  const shape = (() => {
    const i = HTML.indexOf("    if (T === 'trigger') {");
    assert.notEqual(i, -1, 'the trigger branch of `_nodeShape` moved — re-point this');
    return HTML.slice(i, i + 1400);
  })();

  test('a scheduled trigger draws the stopwatch, not the bolt', () => {
    assert.match(shape, /M === 'schedule'[\s\S]{0,60}set\('icoClock'\)/,
      'a 9am schedule and an inbound message were the same picture');
  });

  test('an event still draws the bolt', () => {
    assert.match(shape, /set\('icoBolt'\)/);
  });

  test('and the stopwatch is actually rendered on the canvas', () => {
    // A flag nothing draws is a rule that does not reach a reader.
    assert.match(HTML, /an\.icoClock/, 'the icon must be bound in the graph template');
    assert.ok((HTML.match(/an\.icoClock/g) || []).length >= 2,
      'both graph templates draw it — the build canvas and the console');
    // AND THE FLAG MUST REACH THEM. The template binding alone passed while the
    // view-model stopped carrying `icoClock` — a picture bound to a value nobody
    // sets draws nothing, and the mutation survived until this was added.
    assert.ok((HTML.match(/icoClock: !!icons\.icoClock/g) || []).length >= 2,
      'every view-model that carries icoBolt must carry icoClock beside it');
  });
});
