/**
 * THE INTERVIEW MAY ONLY OFFER TRIGGERS SOMETHING CAN ACTUALLY START.
 *
 * THIS IS THE THIRD INSTANCE OF ONE DEFECT, AND THE FIRST TIME ANYTHING ENFORCES IT.
 *
 *   · 2026-07-27 — `connector_event`. It appeared in exactly one place in all of `src/`:
 *     the elicitation prompt, listing it among the types the model may return. Nothing
 *     consumed it — not the scheduler, not the Gmail poller, not the Slack or Airtable
 *     dispatchers. Eight stored workflows carried it; all published, none could ever
 *     fire. That entry in CLAUDE.md ends: *"Keep the runnable set in step with the
 *     consumers; this check failing a publish is the signal that someone added one
 *     without the other."*
 *   · 2026-07-30 — `webhook`. Asked for a contact form that POSTs to a URL, Atlas
 *     replied *"your form POSTs to a webhook URL that Atlas generates when the workflow
 *     is built — that URL becomes the trigger"* and asked detail questions as though the
 *     mechanism were settled. There is no URL generation and no inbound route.
 *   · 2026-07-30 — `one_time`, found while fixing the above and WORSE, because nobody
 *     had noticed it. "Do this now" and "run this once" are among the most natural
 *     things a person asks for, and the prompt routed them at a type that can never
 *     publish. It sat in TWO copies of the trigger-inference table.
 *
 * Every one was a type the prompt taught the model to emit that no consumer could
 * honour. The publish guard (`TRIGGER_NOT_RUNNABLE`) refuses them — correctly, and
 * loudly — but only AFTER the customer has had the whole conversation, and after Atlas
 * has already described a mechanism that does not exist.
 *
 * A prompt is a belief about model behaviour and is pinned by nothing. This file is
 * what makes being wrong about it cheap: the moment someone adds a trigger type here
 * without teaching a consumer, this goes red instead of a customer finding out.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildSystemPrompt } from '../../src/converger/prompts.js';
import { RUNNABLE_TRIGGER_TYPES, isRunnableTrigger } from '../../src/workflows/trigger-runnable.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'src/converger/prompts.js'), 'utf8');

/**
 * Every trigger type the prompt SOURCE names, read from the two shapes it uses:
 * a `{"type":"…"}` example and a `→ <type> trigger` / `→ <type> (no need to ask)`
 * inference rule. Read from source rather than from a rendered prompt because some of
 * these strings live in prompts this test does not build.
 */
function triggerTypesNamedInSource() {
  const out = new Set();
  for (const m of SRC.matchAll(/"component"\s*:\s*"trigger"[^}]*"type"\s*:\s*"([a-z_]+)"/g)) out.add(m[1]);
  for (const m of SRC.matchAll(/→\s*([a-z_]+)\s+trigger/g)) out.add(m[1]);
  for (const m of SRC.matchAll(/→\s*([a-z_]+)\s+\(no need to ask\)/g)) out.add(m[1]);
  return [...out];
}

describe('the prompt and the runnable set agree', () => {
  test('the source names at least the triggers we know about', () => {
    // A scraper that silently matches nothing would make every assertion below vacuous.
    const named = triggerTypesNamedInSource();
    assert.ok(named.length >= 4, `only found ${named.length}: ${named.join(', ')} — the scrape has broken`);
    for (const t of ['email', 'schedule', 'manual', 'event']) {
      assert.ok(named.includes(t), `expected the prompt to still offer "${t}"`);
    }
  });

  test('EVERY trigger type the prompt names can actually start a workflow', () => {
    const bad = triggerTypesNamedInSource().filter(t => !RUNNABLE_TRIGGER_TYPES.includes(t));
    assert.deepEqual(bad, [],
      `the interview offers these, and nothing can honour them: ${bad.join(', ')}. ` +
      'Either teach a consumer (scheduler / poller / dispatcher / capability) and add it to ' +
      'RUNNABLE_TRIGGER_TYPES, or remove it from the prompt. Do not leave it here.');
  });

  test('and the publish guard agrees with the runnable set', () => {
    // The two sources of truth this file exists to keep together.
    for (const t of RUNNABLE_TRIGGER_TYPES) {
      const trig = t === 'event' ? { type: t, connector: 'slack' } : { type: t };
      assert.equal(isRunnableTrigger(trig), true, t);
    }
  });

  test('the two types removed on 2026-07-30 are gone from the OFFERED list', () => {
    // Named explicitly so a re-introduction is loud rather than a diff nobody reads.
    const named = triggerTypesNamedInSource();
    assert.ok(!named.includes('webhook'), 'webhook is not a way to START a workflow');
    assert.ok(!named.includes('one_time'), 'one_time can never publish; "run this once" is manual');
    assert.ok(!named.includes('connector_event'), 'the 2026-07-27 defect must not come back');
  });
});

describe('what a person asks for still reaches a real trigger', () => {
  // Removing a type must not leave the intent unrouted — "run this once" is a common
  // request and has to land somewhere that works.
  test('"do this now / run this once" is routed to manual', () => {
    assert.match(SRC, /do this now\/run this once[^\n]*→ manual/);
  });

  test('the rendered prompt still describes the runnable triggers', () => {
    const p = buildSystemPrompt({});
    for (const t of ['email', 'schedule', 'manual', 'event']) {
      assert.match(p, new RegExp(`\\b${t}\\b`), t);
    }
  });

  test('the rendered prompt no longer offers a webhook TRIGGER', () => {
    const p = buildSystemPrompt({});
    assert.doesNotMatch(p, /"type"\s*:\s*"webhook"/);
    assert.doesNotMatch(p, /→\s*webhook\b/);
  });
});

describe('webhook is still a DELIVERY channel', () => {
  test('posting to a URL is real and must not have been removed with it', () => {
    // The distinction the fix turns on: Atlas can POST to a URL as an action; it cannot
    // be STARTED by one. Deleting both would have been an over-correction.
    assert.match(SRC, /channel "webhook": POST to a URL/);
  });
});
