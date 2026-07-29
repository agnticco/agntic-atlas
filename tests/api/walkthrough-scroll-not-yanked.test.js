/**
 * THE APPROVE CONTROL MUST STAY WHERE THE PERSON PUT IT.
 *
 * WITNESSED ON PROD, 2026-07-28 (v1.6.53), driving a real 12-step build. Steps 1–6
 * approved normally. Step 7 — "Compose urgent complaint message", whose card carries
 * a long AI instruction — could not be approved AT ALL. The only approve control is a
 * ~10px tick on the node in the FLOW DIAGRAM, the diagram sits ABOVE the step card,
 * and the card was tall enough that pinning the conversation to its bottom pushed the
 * diagram off the top of the viewport. Scrolling up to reach it worked for about ten
 * seconds and then the page dragged itself back down.
 *
 * TWO FAULTS, COMPOUNDING — both pinned here, because either alone leaves it broken:
 *
 *  1. `componentDidUpdate` pinned the conversation to the bottom on EVERY render.
 *     Right while a reply streams in; wrong the instant the reader scrolls up. It made
 *     the walkthrough unrecoverable rather than merely jumpy.
 *
 *  2. The curated-fact ticker (added 2026-07-28 in the same session) kept firing a
 *     `setState` every 11 seconds THROUGHOUT the walkthrough, because `phase` stays
 *     "building" until the walkthrough is accepted. Each fire was a render, and every
 *     render hit fault 1. The "Building…" line those facts animate is long gone by
 *     then, so the ticker was buying nothing and costing the page.
 *
 * The regression this must never allow back: a person who scrolls up to look at
 * something has the page yanked out from under them. Streaming must still follow.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function bodyFrom(i) {
  let j = HTML.indexOf('{', i), depth = 0;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

function methodSrc(name) {
  const start = HTML.indexOf('\n  ' + name + '(');
  assert.notEqual(start, -1,
    `\`${name}\` is GONE from public/index.html — re-point this extraction, do not delete the test.`);
  return HTML.slice(start + 1, bodyFrom(start));
}

/** The real `_atBottom`, executed. */
const atBottom = eval('(' + (() => {
  const s = methodSrc('_atBottom');
  return 'function ' + s.trim().replace(/^_atBottom/, '_atBottom');
})() + ')');

describe('the reader decides whether the page follows the bottom', () => {
  test('someone parked at the bottom is followed', () => {
    assert.equal(atBottom({ scrollHeight: 4000, scrollTop: 3400, clientHeight: 600 }), true);
  });

  test('someone who scrolled up to look at the diagram is NOT dragged back', () => {
    // The prod case: the flow diagram is ~500px above the bottom of a tall card.
    assert.equal(atBottom({ scrollHeight: 4000, scrollTop: 2900, clientHeight: 600 }), false,
      'this is the person trying to click a node — following the bottom removes their target');
  });

  test('a few pixels of slack still counts as "at the bottom"', () => {
    // Nobody sits at exactly 0, and a jittery gate would stutter mid-stream.
    assert.equal(atBottom({ scrollHeight: 4000, scrollTop: 3350, clientHeight: 600 }), true);
    assert.equal(atBottom({ scrollHeight: 4000, scrollTop: 3319, clientHeight: 600 }), false,
      '81px away is a deliberate scroll, not jitter');
  });

  test('a conversation shorter than its own viewport is always "at the bottom"', () => {
    assert.equal(atBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 600 }), true,
      'a fresh chat must still follow its first reply');
  });
});

describe('the render still follows the bottom by default', () => {
  const src = methodSrc('componentDidUpdate');

  test('it consults the flag rather than pinning unconditionally', () => {
    assert.match(src, /this\._stick !== false/,
      'an unconditional scrollTop = scrollHeight is the defect');
  });

  test('and `!== false` is deliberate — an untouched page still follows', () => {
    // `_stick` is undefined until the person actually scrolls, so a brand new build
    // streams normally. A truthy test (`if (this._stick)`) would break streaming
    // until the first scroll event, which no one would notice until a demo.
    assert.doesNotMatch(src, /if \(this\.el && this\._stick\)/);
  });

  test('the scroll listener that sets the flag is wired to the container', () => {
    const i = HTML.indexOf('scrollRef: (el)');
    assert.ok(i > 0, 'the scroll container ref moved — re-point this test');
    const around = HTML.slice(i, i + 500);
    assert.match(around, /addEventListener\('scroll'/, 'nothing would ever set _stick');
    assert.match(around, /_atBottom\(el\)/, 'the listener must use the same derivation');
    assert.match(around, /_stickWired/, 'a ref fires on every render — the listener must attach once');
  });
});

describe('the fact ticker stops when the person starts approving', () => {
  const i = HTML.indexOf('this._factT = setInterval');
  const src = HTML.slice(i, i + 700);

  test('it stops at the walkthrough, not merely when the phase changes', () => {
    assert.match(src, /awaitingGraphApproval/,
      '`phase` stays "building" through the walkthrough, so a phase-only check never fires');
    assert.match(src, /clearInterval/);
  });

  test('it still stops when the build ends some other way', () => {
    assert.match(src, /phase !== "building"/, 'the original guard must survive');
  });
});
