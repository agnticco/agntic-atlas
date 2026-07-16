/**
 * The generate node's streaming JSON call (P12 Increment #22).
 *
 * `llmJsonStreaming` is what the `generate` node uses instead of the blocking
 * `llmJson`: it streams the model's answer, forwards extended-thinking deltas to
 * `onThinking` as they arrive, and returns the parsed JSON. Its load-bearing
 * property is that it is ADDITIVE and NON-BREAKING:
 *   1. on a healthy stream it returns the same parsed JSON llmJson would, AND
 *      forwards thinking deltas live, AND enables thinking on the call,
 *   2. if streaming THROWS, it falls back to the blocking llm.invoke() so the
 *      build still completes,
 *   3. if the model has no .stream(), it uses the blocking path,
 *   4. a completed stream whose text isn't JSON returns null (llmJson's contract),
 *      WITHOUT paying for a second blocking call.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { llmJsonStreaming } from '../../src/converger/elicitation-graph.js';

// A fake ModelPool-shaped llm: `stream` yields {content} chunks (and pushes any
// onThinking deltas the caller wired), `invoke` is the blocking fallback.
function fakeLLM({ streamChunks, streamThrows, thinkingDeltas = [], invokeResult, noStream } = {}) {
  const calls = { stream: 0, invoke: 0, lastStreamCfg: null };
  const llm = {
    async invoke(_messages, _cfg) { calls.invoke++; return invokeResult; },
  };
  if (!noStream) {
    llm.stream = async function* (_messages, cfg) {
      calls.stream++; calls.lastStreamCfg = cfg;
      for (const d of thinkingDeltas) cfg?.onThinking?.(d);
      if (streamThrows) throw new Error('stream boom');
      for (const c of streamChunks) yield { content: c };
    };
  }
  return { llm, calls };
}

describe('llmJsonStreaming', () => {
  test('streams, forwards thinking, enables thinking, returns parsed JSON', async () => {
    const { llm, calls } = fakeLLM({
      streamChunks: ['{"nodes":', '[1,2]}'],
      thinkingDeltas: ['pick trigger ', 'then deliver'],
    });
    const seen = [];
    const out = await llmJsonStreaming(llm, [], { configurable: { modelTier: 'architect' } },
      { onThinking: (d) => seen.push(d) });

    assert.deepEqual(out, { nodes: [1, 2] });        // 1: same result as blocking parse
    assert.deepEqual(seen, ['pick trigger ', 'then deliver']); // 1: thinking forwarded live
    assert.equal(calls.stream, 1);
    assert.equal(calls.invoke, 0);                    // did NOT also call the blocking path
    assert.ok(calls.lastStreamCfg.thinking, 'thinking was enabled on the streamed call');
  });

  test('falls back to blocking llm.invoke() when the stream throws', async () => {
    const { llm, calls } = fakeLLM({
      streamChunks: [], streamThrows: true,
      invokeResult: { content: '{"nodes":["fallback"]}' },
    });
    const out = await llmJsonStreaming(llm, [], {});
    assert.deepEqual(out, { nodes: ['fallback'] });   // 2: build still completes
    assert.equal(calls.stream, 1);
    assert.equal(calls.invoke, 1);                     // 2: blocking path was used
  });

  test('uses the blocking path when the llm has no .stream()', async () => {
    const { llm, calls } = fakeLLM({ noStream: true, invokeResult: '{"ok":true}' });
    const out = await llmJsonStreaming(llm, [], {});
    assert.deepEqual(out, { ok: true });               // 3
    assert.equal(calls.invoke, 1);
  });

  test('a completed non-JSON stream returns null WITHOUT a second blocking call', async () => {
    const { llm, calls } = fakeLLM({
      streamChunks: ['not json at all'],
      invokeResult: { content: '{"should":"not be used"}' },
    });
    const out = await llmJsonStreaming(llm, [], {});
    assert.equal(out, null);                            // 4: llmJson's contract
    assert.equal(calls.stream, 1);
    assert.equal(calls.invoke, 0);                      // 4: no wasted blocking call
  });
});
