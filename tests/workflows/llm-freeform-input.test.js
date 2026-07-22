/**
 * A FREEFORM `llm` STEP MUST HONOUR ITS `input` — it used to silently drop it.
 *
 * `input` ("Override input") is declared on the llm node type and every mode
 * resolves it through `resolveTransformInput`… except `freeform`, which always
 * injected `ctx.lastOutput` instead. So the key was declared, accepted by the
 * validator, emitted by the converger, and thrown away at run time.
 *
 * Found by running a real workflow, not by reading code. A 3-way email triage
 * routed `classify → branch → freeform llm`. The step's `input` was the extracted
 * email; freeform injected `lastOutput`, which straight after a classifier is the
 * single word "urgent". With no subject and no body the node hit the guard the
 * converger writes into every content step and emitted
 * "ERROR: required data not found" — which was then DELIVERED as a real Slack DM.
 * The other lane, identical but in `summarize` mode, was fine.
 *
 * The test asserts on the PROMPT the model would actually receive, because that is
 * the only place the difference shows: both versions run cleanly and return a
 * string, and the broken one merely returns the wrong one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { llmNodeType } from '../../src/workflows/node-types/llm.js';

/** Capture the prompt by standing in for the model. */
function captureLLM() {
  const seen = {};
  return {
    seen,
    llm: {
      invoke: async (messages) => {
        seen.messages = messages;
        seen.text = JSON.stringify(messages);
        return { content: 'ok' };
      },
    },
  };
}

const EMAIL = 'From: ops@corp.test\nSubject: Database is down\n\nAll queries failing since 09:14.';

async function runFreeform(cfg, ctx) {
  const cap = captureLLM();
  await llmNodeType.run(cfg, ctx, { llm: cap.llm });
  return cap.seen.text || '';
}

describe('a freeform llm step and its `input`', () => {
  test('uses `input` when set, not the previous step output', async () => {
    const text = await runFreeform(
      { mode: 'freeform', prompt: 'Compose a Slack alert.', input: EMAIL },
      { lastOutput: 'urgent', outputs: {} },
    );
    assert.ok(text.includes('Database is down'),
      'the declared `input` never reached the model — freeform dropped it (the original defect)');
    assert.ok(!/Input:\s*\\n*urgent/.test(text),
      'the classifier word was injected instead of the declared input');
  });

  test('still falls back to the previous step when no `input` is set', async () => {
    const text = await runFreeform(
      { mode: 'freeform', prompt: 'Compose a Slack alert.' },
      { lastOutput: EMAIL, outputs: {} },
    );
    assert.ok(text.includes('Database is down'),
      'the ordinary chain (no `input` override) must be unchanged');
  });

  test('an empty `input` does not blank out the previous step', async () => {
    const text = await runFreeform(
      { mode: 'freeform', prompt: 'Compose a Slack alert.', input: '   ' },
      { lastOutput: EMAIL, outputs: {} },
    );
    assert.ok(text.includes('Database is down'),
      'a whitespace-only override must be ignored, not treated as "no input"');
  });
});
