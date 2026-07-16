/**
 * ChatModel extended-thinking support (P12 Increment #22).
 *
 * The converger's `generate` step streams the model's OWN chain of thought to the
 * REASONING surface. That relies on ChatModel.stream():
 *   1. sending `thinking: {type:'enabled', budget_tokens}` to Anthropic ONLY when
 *      config.thinking is set (a tier that doesn't support it never receives it),
 *   2. forcing the API's required companions (temperature=1, max_tokens>budget),
 *   3. surfacing each `thinking_delta` via config.onThinking(delta),
 *   4. keeping thinking OUT of the yielded answer text (only `text` blocks stream),
 *   5. still collecting the final text answer so the caller can parse the JSON.
 *
 * The Anthropic SDK is mocked: we stub the ChatModel's client with a fake
 * `messages.stream()` that emits a thinking block then a text block, and capture
 * the params it was called with.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChatModel } from '../../src/llm/chat-model.js';

// Build a fake Anthropic streaming object from a list of SSE-shaped events.
function fakeStream(events, finalMessage) {
  return {
    async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
    async finalMessage() { return finalMessage; },
  };
}

// Stub the model's client so no network/SDK is touched. Records the last params.
function stubClient(model, streamFactory) {
  const calls = [];
  model._client = {
    messages: {
      stream(params) { calls.push(params); return streamFactory(params); },
    },
  };
  // _getClient() returns the cached _client, so this stub is used verbatim.
  return calls;
}

describe('ChatModel.stream extended thinking (anthropic)', () => {
  const THINK_EVENTS = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me pick ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the trigger.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig==' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"ok":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'true}' } },
  ];
  const FINAL = { usage: { input_tokens: 10, output_tokens: 42 }, stop_reason: 'end_turn', content: [] };

  test('forwards thinking deltas via onThinking, keeps them out of the answer text', async () => {
    const model = new ChatModel({ provider: 'anthropic', model: 'claude-opus-4-x', apiKey: 'x' });
    const calls = stubClient(model, () => fakeStream(THINK_EVENTS, FINAL));

    const thinking = [];
    const textChunks = [];
    for await (const chunk of model.stream('go', { thinking: 2048, onThinking: (d) => thinking.push(d) })) {
      if (chunk?.content) textChunks.push(chunk.content);
    }

    // 3: the model reasoned out loud, delta by delta…
    assert.deepEqual(thinking, ['Let me pick ', 'the trigger.']);
    // 4/5: …and the yielded text is ONLY the answer, reassembling to parseable JSON.
    const answer = textChunks.join('');
    assert.equal(answer, '{"ok":true}');
    assert.deepEqual(JSON.parse(answer), { ok: true });

    // 1/2: the request carried thinking, temperature was forced to 1, and
    // max_tokens was lifted above the budget.
    const p = calls[0];
    assert.deepEqual(p.thinking, { type: 'enabled', budget_tokens: 2048 });
    assert.equal(p.temperature, 1);
    assert.ok(p.max_tokens > 2048, 'max_tokens must exceed the thinking budget');
  });

  test('does NOT send thinking when config.thinking is absent', async () => {
    const model = new ChatModel({ provider: 'anthropic', model: 'claude-sonnet-4-x', apiKey: 'x' });
    const calls = stubClient(model, () => fakeStream(
      [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      ],
      { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', content: [] },
    ));

    const thinking = [];
    // eslint-disable-next-line no-unused-vars
    for await (const _ of model.stream('hi', { onThinking: (d) => thinking.push(d) })) { /* drain */ }

    assert.equal(calls[0].thinking, undefined);       // never sent to a non-thinking call
    assert.equal(thinking.length, 0);                 // no thinking deltas surfaced
  });

  test('a low budget is clamped to the API minimum (1024)', async () => {
    const model = new ChatModel({ provider: 'anthropic', model: 'claude-opus-4-x', apiKey: 'x' });
    const calls = stubClient(model, () => fakeStream(THINK_EVENTS, FINAL));
    // eslint-disable-next-line no-unused-vars
    for await (const _ of model.stream('go', { thinking: 100 })) { /* drain */ }
    assert.equal(calls[0].thinking.budget_tokens, 1024);
  });
});
