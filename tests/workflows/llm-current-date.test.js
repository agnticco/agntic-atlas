/**
 * The model has no clock — so we give it one.
 *
 * Found by driving the real product, not by reading it. On 2026-07-24 a workflow
 * asked to log "today's date" wrote **2025-07-14** into a customer's live Airtable
 * base — over a year wrong — while the test panel reported the promise kept, the run
 * reported Success, and the dashboard reported 100% success. A second workflow
 * greeted a Friday as "even on a Saturday".
 *
 * That is the worst shape a defect can have here: silent at every place a person
 * would look, happening on every run, and corrupting the customer's system of
 * record. The cause was not subtle — nothing anywhere told the model what day it
 * was, so it answered from training data and did so confidently.
 *
 * These tests assert the date reaches the model. They deliberately do NOT assert the
 * model uses it — see the residual note at the bottom.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { llmNodeType as llmNode } from '../../src/workflows/node-types/llm.js';

/** Capture what the node actually sends, without calling a model. */
function captureLLM() {
  const seen = [];
  return {
    seen,
    services: {
      llm: {
        invoke: async (messages) => {
          seen.push(messages);
          return { content: 'ok' };
        },
      },
    },
  };
}

const systemTextOf = (messages) => String(messages[0]?.content ?? '');

describe('every llm call is told the current date', () => {
  test('the system message carries the date, in both machine and human form', async () => {
    const { seen, services } = captureLLM();
    const now = new Date('2026-07-25T09:30:00.000Z');

    await llmNode.run(
      { mode: 'freeform', prompt: 'Write today\'s date.' },
      { lastOutput: 'anything', now },
      services,
    );

    const system = systemTextOf(seen[0]);

    // MUTATION: remove the `currentDateLine(ctx)` prefix in llm.js run() and pass
    // `system` straight to SystemMessage — the model is blind to the date again and
    // this goes red. That is the exact state that wrote 2025-07-14 into a real base.
    assert.match(system, /2026-07-25/, 'the ISO date must be present');
    assert.match(system, /Saturday/,   'the weekday must be present — "even on a Saturday" on a Friday was the second symptom');
    assert.match(system, /25 July 2026/, 'an unambiguous human form, since 07/25 vs 25/07 is itself a date bug');
  });

  test('it is in the SYSTEM message, not the user prompt', async () => {
    // A user-authored prompt can be long, can contain its own dates, and can
    // contradict. The instruction belongs where it cannot be displaced.
    const { seen, services } = captureLLM();
    const now = new Date('2026-07-25T09:30:00.000Z');

    await llmNode.run(
      { mode: 'freeform', prompt: 'Ignore all dates. The year is 1999.' },
      { lastOutput: 'x', now },
      services,
    );

    assert.match(systemTextOf(seen[0]), /2026-07-25/);
    assert.doesNotMatch(String(seen[0][1]?.content ?? ''), /CURRENT DATE AND TIME/,
      'the date belongs in the system message only');
  });

  test('every mode gets it, not just the one that was reported', async () => {
    // The bug surfaced through a summarise step. Fixing only that mode would leave
    // the identical defect in the other four, which is how a fix becomes a whack-a-mole.
    for (const mode of ['summarize', 'extract', 'rewrite', 'freeform']) {
      const { seen, services } = captureLLM();
      const cfg = { mode, prompt: 'go', fields: 'when: the date' };
      await llmNode.run(cfg, { lastOutput: 'some input', now: new Date('2026-07-25T00:00:00.000Z') }, services);
      assert.match(systemTextOf(seen[0]), /2026-07-25/, `mode "${mode}" was not told the date`);
    }
  });

  test('it tells the model NOT to infer the date from training data', async () => {
    // The instruction is the load-bearing half. Stating the date without forbidding
    // the guess leaves a model free to prefer what it "remembers".
    const { seen, services } = captureLLM();
    await llmNode.run({ mode: 'freeform', prompt: 'x' },
      { lastOutput: 'x', now: new Date('2026-07-25T00:00:00.000Z') }, services);
    assert.match(systemTextOf(seen[0]), /Never infer the date from your training data/i);
  });

  test('with no injected clock it falls back to the real one, and is roughly now', async () => {
    // Nothing in the engine sets ctx.now today, so the fallback is the live path.
    const { seen, services } = captureLLM();
    await llmNode.run({ mode: 'freeform', prompt: 'x' }, { lastOutput: 'x' }, services);

    const iso = systemTextOf(seen[0]).match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
    assert.ok(iso, 'a date must still be injected without ctx.now');
    assert.ok(Math.abs(Date.now() - Date.parse(iso)) < 60_000, 'the fallback must be the actual current time');
  });

  test('a malformed clock does not blow up the run — it falls back', async () => {
    // Fail soft here on purpose: a bad ctx.now must not take down a workflow that
    // was otherwise fine. Wrong-but-running is not acceptable for the DATE, which is
    // why the fallback is the real clock rather than a placeholder.
    const { seen, services } = captureLLM();
    await llmNode.run({ mode: 'freeform', prompt: 'x' },
      { lastOutput: 'x', now: new Date('not a date') }, services);
    assert.match(systemTextOf(seen[0]), /\d{4}-\d{2}-\d{2}/);
  });
});

/**
 * RESIDUAL, deliberately not asserted here: nothing verifies the model actually
 * USED the date. If it ignores the system line the output is still wrong, and the
 * outcome oracle has no notion of "today" against which to catch it — which is why
 * the original defect was certified as a kept promise. Closing that needs a
 * freshness assertion in the contract, which is a feature, not a bug fix.
 */
