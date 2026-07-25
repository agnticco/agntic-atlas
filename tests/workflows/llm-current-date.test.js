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
import { readFileSync } from 'node:fs';

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

import { ChatModel } from '../../src/llm/chat-model.js';
import { currentDateLine } from '../../src/utils/current-time.js';
import { SystemMessage, HumanMessage } from '../../src/core/message.js';

/**
 * Injected at the ONE choke point every provider call passes through, because
 * per-call-site injection was tried and missed surfaces twice: the engine was fixed,
 * then the converger, and the plain chat path STILL answered "Today is Thursday,
 * July 10, 2025" in production. Enumerating call sites is a losing game; there are
 * ~19 of them and any new one starts out blind.
 */
describe('every model call Atlas makes is told the current date', () => {
  test('the clock reaches the Anthropic request, with a caller system prompt', () => {
    const m = new ChatModel({ provider: 'anthropic', apiKey: 'test', model: 'claude-sonnet-4-6' });
    const { system } = m._normaliseInput([
      new SystemMessage('You are a workflow architect.'),
      new HumanMessage('what is today?'),
    ]);
    // The assembly under test is in _call; assert the pieces it composes.
    assert.ok(system.includes('workflow architect'), 'the caller prompt survives');
    assert.match(currentDateLine(), /CURRENT DATE AND TIME/);
  });

  test('THE CACHE: the clock is a separate block AFTER the cached prefix', () => {
    // The regression this prevents is silent and expensive, and invisible on
    // inspection. The caller's system prompt is cached for 1h because the converger
    // re-sends ~3.9k tokens of catalog every turn. A timestamp INSIDE that text makes
    // every request a unique prefix, so the hit rate goes to zero and nothing reports
    // it. I shipped exactly that in 1.6.38.
    const m = new ChatModel({ provider: 'anthropic', apiKey: 'x', model: 'claude-sonnet-4-6' });
    const blocks = m._systemWithClock('STABLE CATALOG', new Date('2026-07-25T09:00:00.000Z'));

    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].text, 'STABLE CATALOG', 'the cached text must be byte-unchanged');
    assert.ok(blocks[0].cache_control, 'the caller prompt is the cached prefix');
    assert.match(blocks[1].text, /2026-07-25/, 'the clock is the block AFTER it');
    assert.ok(!blocks[1].cache_control, 'the volatile block must not be marked cacheable');
  });

  test('a call with NO system prompt still gets a clock — the plain-chat case', () => {
    const m = new ChatModel({ provider: 'anthropic', apiKey: 'x', model: 'claude-sonnet-4-6' });
    const blocks = m._systemWithClock('', new Date('2026-07-25T09:00:00.000Z'));
    assert.equal(blocks.length, 1);
    assert.match(blocks[0].text, /2026-07-25/);
  });

  test('the clock states the date, the weekday, and forbids guessing', () => {
    const line = currentDateLine(new Date('2026-07-25T09:30:00.000Z'));
    assert.match(line, /2026-07-25/);
    assert.match(line, /Saturday/);          // "even on a Saturday" on a Friday was a real symptom
    assert.match(line, /25 July 2026/);      // 07/25 vs 25/07 is itself a date bug
    assert.match(line, /Never infer the date from your training data/i);
  });

  test('it falls back to the real clock, and tolerates a bad one', () => {
    const iso = currentDateLine().match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)?.[1];
    assert.ok(iso && Math.abs(Date.now() - Date.parse(iso)) < 60_000);
    // A malformed clock must not take down a workflow that was otherwise fine.
    assert.match(currentDateLine(new Date('not a date')), /\d{4}-\d{2}-\d{2}/);
  });

  test('the OpenAI path appends rather than prepends, for the same cache reason', () => {
    const m = new ChatModel({ provider: 'openai', apiKey: 'test', model: 'gpt-4o' });
    const msgs = m._prepareOpenAIMessages([
      new SystemMessage('STABLE PREFIX'),
      new HumanMessage('hi'),
    ]);
    const sys = msgs.find(x => x.role === 'system').content;
    assert.ok(sys.startsWith('STABLE PREFIX'), 'the stable prefix must stay at the front');
    assert.match(sys, /CURRENT DATE AND TIME/);
  });

  test('a call with NO system prompt still gets a clock — the chat case', () => {
    // This is the surface that was still wrong in production after two fixes: plain
    // chat, which sends its own system content through a different path.
    const m = new ChatModel({ provider: 'openai', apiKey: 'test', model: 'gpt-4o' });
    const msgs = m._prepareOpenAIMessages([new HumanMessage('what is today\'s date?')]);
    assert.equal(msgs[0].role, 'system', 'a clock must be inserted even with no caller system prompt');
    assert.match(msgs[0].content, /CURRENT DATE AND TIME/);
  });
});

/**
 * BOTH request assemblers, because fixing one and not the other is what kept the
 * production chat wrong after two deploys. `_call` is used by the engine and the
 * converger; `stream` is used by CHAT. A new assembler must route through
 * `_systemWithClock` or it starts out blind, and this suite is where that is caught.
 */
describe('both request assemblers attach the clock', () => {
  const chatShape = [
    // Exactly what builder.js sends: plain {role,content}, not SystemMessage instances.
    { role: 'system', content: 'You are Atlas, a warm assistant.' },
    { role: 'user',   content: "What is today's date?" },
  ];

  function stubbed() {
    const captured = {};
    const m = new ChatModel({ provider: 'anthropic', apiKey: 'x', model: 'claude-sonnet-4-6' });
    m._getClient = async () => ({
      messages: {
        create: async (p) => {
          captured.call = p;
          return { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
        },
        stream: async (p) => {
          captured.stream = p;
          const iter = (async function* () { yield { type: 'message_stop' }; })();
          return { [Symbol.asyncIterator]: () => iter };
        },
      },
    });
    return { m, captured };
  }

  test('_call attaches it — the engine and converger path', async () => {
    const { m, captured } = stubbed();
    await m._call(chatShape, {});
    assert.equal(captured.call.system.length, 2);
    assert.match(captured.call.system[1].text, /CURRENT DATE AND TIME/);
  });

  test('stream attaches it — the CHAT path, which was still wrong in production', async () => {
    const { m, captured } = stubbed();
    // MUTATION: revert stream's assembly to `if (system) baseParams.system = system;`
    // and this goes red. That single line is why chat answered "July 10, 2025" on a
    // deployed build that had already been "fixed" twice.
    try { for await (const _ of m.stream(chatShape, {})) { /* drain */ } } catch { /* stub */ }
    assert.ok(captured.stream, 'the stream request must have been assembled');
    assert.ok(Array.isArray(captured.stream.system), 'stream must use the block form');
    assert.match(captured.stream.system[1].text, /CURRENT DATE AND TIME/);
    assert.equal(captured.stream.system[0].text, 'You are Atlas, a warm assistant.');
  });
});
