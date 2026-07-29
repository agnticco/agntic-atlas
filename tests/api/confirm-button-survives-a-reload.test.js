/**
 * THE CONFIRM BUTTON WENT DEAD, SILENTLY, AND FOR GOOD.
 *
 * WITNESSED ON PROD, 2026-07-29. Adding an Airtable column failed. The page was
 * reloaded, Atlas re-offered the same action, and "Confirm & run" did nothing at
 * all — no network request, no console error, no change on screen. Clicking it
 * again did nothing. There was no way for the person to tell why, or to recover.
 *
 * The card's id came from an in-memory counter:
 *
 *     const aid = "act" + (self._pc = (self._pc || 0) + 1);
 *
 * which restarts at 1 on every mount — while the RESTORED conversation still holds
 * the cards from before the reload. So the new card was minted as `act1`, the old
 * finished `act1` was still in `msgs`, and the click handler looked its card up by
 * id:
 *
 *     const cur = this.state.msgs.find(m => m._id === msgId);
 *     if (!cur || (cur.status && cur.status !== "pending")) return;
 *
 * `.find()` returned the OLD card, whose status was "error", and the guard returned.
 * The guard is right — a card must not run twice. It was reading the wrong card.
 *
 * Two independent fixes, because either alone leaves a hole: ids are now unique
 * across mounts, AND the lookup prefers the LAST match so a conversation restored
 * from before this fix still works.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

describe('the id survives a reload', () => {
  const mint = (() => {
    const i = HTML.indexOf('const aid = "act"');
    assert.ok(i > 0, 'the id is no longer minted here — re-point this test');
    return HTML.slice(i - 200, i + 200);
  })();

  test('it is seeded per mount, not a bare counter', () => {
    assert.match(mint, /_pcSeed/, 'a bare counter restarts at 1 and collides with a restored card');
    assert.match(mint, /const aid = "act" \+ self\._pcSeed \+ "-" \+/);
  });

  test('two mounts cannot mint the same id', () => {
    // The behaviour, not the spelling: simulate two component lifetimes.
    const mountOnce = (seed) => { const self = { _pcSeed: seed };
      return [1, 2].map(() => 'act' + self._pcSeed + '-' + (self._pc = (self._pc || 0) + 1)); };
    const a = mountOnce('abc'), b = mountOnce('xyz');
    assert.deepEqual(a, ['actabc-1', 'actabc-2']);
    assert.equal(new Set([...a, ...b]).size, 4, 'ids collided across mounts');
  });
});

describe('the lookup reads the card the person is looking at', () => {
  const fn = (() => {
    const i = HTML.indexOf('async _runChatActions(msgId) {');
    assert.ok(i > 0, '`_runChatActions` is gone — re-point this test');
    return HTML.slice(i, i + 1400);
  })();

  test('it takes the LAST match, not the first', () => {
    assert.match(fn, /filter\(m => m && m\._id === msgId\)/);
    assert.match(fn, /const cur = all\[all\.length - 1\]/);
    assert.doesNotMatch(fn.slice(0, fn.indexOf('const cur =')), /\.find\(m => m\._id === msgId\)/,
      'find() returns the stale card from before the reload');
  });

  test('THE PROD CASE, replayed', () => {
    // Two cards, same id: the old failed one and the live one. The live one must run.
    const msgs = [
      { _id: 'act1', status: 'error', actions: [{ name: 'airtable_create_field' }] },
      { _id: 'act1', status: 'pending', actions: [{ name: 'airtable_create_field' }] },
    ];
    const all = msgs.filter(m => m && m._id === 'act1');
    const cur = all[all.length - 1];
    assert.equal(cur.status, 'pending', 'this is the click that did nothing on prod');
  });

  test('and the guard still stops a card running twice', () => {
    // The guard was never the bug — it was reading the wrong card. It has to keep
    // working, or a double click fires a real write twice.
    assert.match(fn, /if \(!cur \|\| \(cur\.status && cur\.status !== "pending"\)\) return;/);
    const msgs = [{ _id: 'act9', status: 'done', actions: [] }];
    const all = msgs.filter(m => m && m._id === 'act9');
    const cur = all[all.length - 1];
    assert.ok(cur.status && cur.status !== 'pending', 'a finished card must not re-run');
  });

  test('an id that matches nothing is still safe', () => {
    const all = [{ _id: 'other' }].filter(m => m && m._id === 'act1');
    assert.equal(all[all.length - 1], undefined);
  });
});
