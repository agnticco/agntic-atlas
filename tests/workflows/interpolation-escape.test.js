/**
 * A multi-line AI answer must not be able to destroy the config value it lands in.
 *
 * WHAT HAPPENED
 * ─────────────
 * A workflow that summarised with an AI step and then posted the summary died on
 * TWELVE of twelve runs across two independent builds, every one with the same
 * error: `assemble sections is invalid JSON: Bad control character in string
 * literal`. The stored config was valid JSON:
 *
 *   [{"heading":"Dental Emergency — Forwarded to Nurses","content":"{{format_emergency.output}}"}]
 *
 * At run time the placeholder was replaced with what the AI wrote, RAW, so the
 * first line break in a written summary ended the JSON string literal. The
 * workflow passed every build-time check and then failed 100% of the time.
 *
 * WHAT THESE TESTS PIN — TWO HALVES, AND THE SECOND IS THE IMPORTANT ONE
 * ─────────────────────────────────────────────────────────────────────
 *   1. Substituted into a JSON string literal → JSON-string-escaped, so the
 *      downstream parse survives and the RENDERED DOCUMENT carries the text
 *      verbatim, real line breaks and all.
 *   2. Substituted into a PLAIN-TEXT field (an AI step's prompt, a delivery body)
 *      → byte for byte unchanged. Escaping unconditionally would make every
 *      workflow in the product start emitting literal `\n` into the messages
 *      customers read — a worse bug than the one being fixed.
 *
 * Every check drives the REAL engine (`FlowTester`) with the REAL node-type
 * registry, exactly as `buildEngine()` in src/api/server.js constructs it, and
 * asserts what was RENDERED or SENT — never that a step ran. A check that asserts
 * "the assemble step completed" passes on an engine that assembled the wrong
 * document.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FlowTester } from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { landsInsideJsonString, escapeJsonStringBody } from '../../src/workflows/template-escape.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

/**
 * What an AI actually writes: line breaks, and — because the escape must be
 * complete, not just newline-shaped — a carriage return, a tab, a double quote
 * and a backslash. Any ONE of these breaks a JSON string literal.
 */
const AI_ANSWER = [
  'Patient reports severe pain in the lower left molar.',
  '',
  'She said "it started on Tuesday" and the notes are at C:\\clinic\\notes.',
  'Triage\tPriority\tOwner',
].join('\n') + '\r\nForwarded to the on-call nurse.';

/** A deterministic stub model — no network, no key. */
const stubLlm = (reply) => ({ invoke: async () => ({ content: reply }) });

/**
 * A recording channel registry. `deliver` and `connector-action` both resolve a
 * channel and then its handler, so a stub needs BOTH — same shape the rest of the
 * suite uses, and the same one production satisfies.
 */
function recordingChannels(sent) {
  return {
    get: (id) => ({ id, available: true }),
    getHandler: () => async (args) => { sent.push(args); return { delivered: true, ts: '1.0' }; },
  };
}

async function runAll(tester, flow, options = {}) {
  const events = [];
  for await (const evt of tester.run(flow, options)) events.push(evt);
  return events;
}

const failures = (events) => events
  .filter(e => e.type === 'step_failed' || e.type === 'run_failed')
  .map(e => `${e.nodeId ?? 'run'}: ${e.error}`);

/** The output a step produced, as the run stream carries it. */
const outputOf = (events, nodeId) =>
  events.find(e => e.type === 'step_completed' && e.nodeId === nodeId)?.output;

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE OBSERVED FAILURE — a JSON-structured field survives a written answer.
// ─────────────────────────────────────────────────────────────────────────────
describe('a written AI answer inside a JSON config value', () => {
  /** The exact stored shape the QA manager read out of the database. */
  const digestFlow = {
    nodes: [
      { id: 'format_emergency', type: 'llm', config: { mode: 'summarize' } },
      { id: 'assemble_sections', type: 'assemble', config: {
        title: 'Dental Emergency',
        sections: '[{"heading":"Dental Emergency — Forwarded to Nurses","content":"{{format_emergency.output}}"}]',
      } },
    ],
    edges: [{ from: 'format_emergency', to: 'assemble_sections' }],
  };

  test('THE ACCEPTANCE: the document renders the answer verbatim and the run does not throw', async () => {
    const tester = new FlowTester({ nodeTypes, llm: stubLlm(AI_ANSWER), channelRegistry: recordingChannels([]) });
    const events = await runAll(tester, digestFlow, { initialContext: 'a patient called about severe pain' });

    assert.deepEqual(failures(events), [], 'the run must not fail');

    // Assert the RENDERED DOCUMENT, not that the step ran.
    const doc = outputOf(events, 'assemble_sections');
    assert.equal(typeof doc, 'string', 'the assemble step must render a markdown document');
    assert.ok(doc.includes('## Dental Emergency — Forwarded to Nurses'), 'the heading must survive');

    // Verbatim, with REAL line breaks — the escaping is undone by the JSON.parse
    // inside assemble's run(), so the reader sees the text the AI wrote.
    assert.ok(doc.includes(AI_ANSWER), 'the document must contain the AI answer verbatim');
    assert.ok(
      doc.includes('lower left molar.\n\nShe said'),
      'the blank line the AI wrote must be a REAL line break in the document',
    );
    assert.ok(doc.includes('C:\\clinic\\notes'), 'a backslash must survive as one backslash');
    assert.ok(doc.includes('"it started on Tuesday"'), 'double quotes must survive');
    assert.ok(doc.includes('Triage\tPriority'), 'a tab must survive as a tab');
    assert.ok(doc.includes('\r\nForwarded to the on-call nurse.'), 'a carriage return must survive');
  });

  test('the same holds for {{prev}}, not just {{step.output}}', async () => {
    const flow = {
      nodes: [
        { id: 'write_it', type: 'llm', config: { mode: 'summarize' } },
        { id: 'doc', type: 'assemble', config: {
          title: 'Digest',
          sections: '[{"heading":"Today","content":"{{prev}}"}]',
        } },
      ],
      edges: [{ from: 'write_it', to: 'doc' }],
    };
    const tester = new FlowTester({ nodeTypes, llm: stubLlm(AI_ANSWER), channelRegistry: recordingChannels([]) });
    const events = await runAll(tester, flow, { initialContext: 'seed' });

    assert.deepEqual(failures(events), []);
    assert.ok(String(outputOf(events, 'doc')).includes(AI_ANSWER));
  });

  test('a step output that is an OBJECT (its own quotes and braces) also survives', async () => {
    // `extract` mode returns a parsed object; the engine stringifies it to JSON
    // before substitution, so the substituted text is full of double quotes.
    const flow = {
      nodes: [
        { id: 'pull', type: 'llm', config: { mode: 'extract', fields: 'name: who\nnote: what' } },
        { id: 'doc', type: 'assemble', config: {
          title: 'Digest',
          sections: '[{"heading":"Extracted","content":"{{pull.output}}"}]',
        } },
      ],
      edges: [{ from: 'pull', to: 'doc' }],
    };
    const tester = new FlowTester({
      nodeTypes,
      llm: stubLlm(JSON.stringify({ name: 'Dana', note: 'line one\nline two' })),
      channelRegistry: recordingChannels([]),
    });
    const events = await runAll(tester, flow, { initialContext: 'seed' });

    assert.deepEqual(failures(events), []);
    assert.ok(String(outputOf(events, 'doc')).includes('"name":"Dana"'), 'the object must render, quotes and all');
  });

  test('GENERALITY: a connector write whose params are a JSON map is fixed by the same change', async () => {
    // `src/connectors/airtable/index.js` does `JSON.parse(fields)` on a string
    // `fields`. Before this fix, a multi-line AI answer in any column killed the
    // write the same way it killed the digest — this is why the escape lives at
    // the point of interpolation and not inside `assemble`.
    const sent = [];
    const flow = {
      nodes: [
        { id: 'summarise', type: 'llm', config: { mode: 'summarize' } },
        { id: 'log_it', type: 'connector-action', config: {
          action: 'airtable_create_record',
          baseId: 'appX', tableId: 'tblY',
          fields: '{"Notes":"{{summarise.output}}","Status":"Open"}',
        } },
      ],
      edges: [{ from: 'summarise', to: 'log_it' }],
    };
    const tester = new FlowTester({ nodeTypes, llm: stubLlm(AI_ANSWER), channelRegistry: recordingChannels(sent) });
    const events = await runAll(tester, flow, { initialContext: 'seed' });

    assert.deepEqual(failures(events), []);
    assert.equal(sent.length, 1, 'the write must reach the connector');

    // Assert what was SENT, parsed the way the connector parses it.
    const parsed = JSON.parse(sent[0].config.fields);
    assert.equal(parsed.Notes, AI_ANSWER, 'the column must receive the answer verbatim');
    assert.equal(parsed.Status, 'Open', 'the other columns must be untouched');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE ANTI-OVER-ESCAPING GUARD — plain text must arrive unchanged.
//    This is the more important half: it protects every workflow in the product.
// ─────────────────────────────────────────────────────────────────────────────
describe('a written AI answer inside a PLAIN-TEXT config value', () => {
  test('THE ACCEPTANCE: an AI step\'s prompt receives REAL line breaks, not the characters \\ and n', async () => {
    const seen = [];
    const capturingLlm = {
      invoke: async (messages) => {
        seen.push(String(messages[1]?.content ?? ''));
        return { content: AI_ANSWER };
      },
    };
    const flow = {
      nodes: [
        { id: 'draft', type: 'llm', config: { mode: 'summarize' } },
        { id: 'polish', type: 'llm', config: {
          mode: 'freeform',
          prompt: 'Rewrite the following for a nurse:\n\n{{draft.output}}',
        } },
      ],
      edges: [{ from: 'draft', to: 'polish' }],
    };
    const tester = new FlowTester({ nodeTypes, llm: capturingLlm, channelRegistry: recordingChannels([]) });
    const events = await runAll(tester, flow, { initialContext: 'seed' });

    assert.deepEqual(failures(events), []);
    assert.equal(seen.length, 2, 'both AI steps must have been called');

    // Assert what was SENT to the model.
    const prompt = seen[1];
    assert.ok(prompt.includes(AI_ANSWER), 'the model must receive the answer byte for byte');
    assert.ok(
      prompt.includes('lower left molar.\n\nShe said'),
      'the model must receive a REAL line break',
    );
    assert.ok(
      !prompt.includes('lower left molar.\\n\\nShe said'),
      'the model must NOT receive the two characters \\ and n where a line break belongs',
    );
    assert.ok(!prompt.includes('\\t'), 'a tab must not arrive as the characters \\ and t');
    assert.ok(!prompt.includes('\\"'), 'a quote must not arrive backslash-escaped');
    assert.ok(prompt.includes('C:\\clinic\\notes'), 'one backslash must not become two');
  });

  test('THE ACCEPTANCE: a delivery body receives REAL line breaks, not the characters \\ and n', async () => {
    const sent = [];
    const flow = {
      nodes: [
        { id: 'draft', type: 'llm', config: { mode: 'summarize' } },
        { id: 'post', type: 'deliver', config: {
          channel: 'in_app',
          title: 'Dental emergency',
          body: 'From the front desk:\n\n{{draft.output}}',
        } },
      ],
      edges: [{ from: 'draft', to: 'post' }],
    };
    const tester = new FlowTester({ nodeTypes, llm: stubLlm(AI_ANSWER), channelRegistry: recordingChannels(sent) });
    const events = await runAll(tester, flow, { initialContext: 'seed' });

    assert.deepEqual(failures(events), []);
    assert.equal(sent.length, 1, 'the message must have been delivered');

    // Assert what was DELIVERED.
    const body = sent[0].body;
    assert.ok(body.includes(AI_ANSWER), 'the recipient must get the answer byte for byte');
    assert.ok(body.includes('lower left molar.\n\nShe said'), 'a REAL line break reaches the recipient');
    assert.ok(
      !body.includes('lower left molar.\\n\\nShe said'),
      'the recipient must NOT see the two characters \\ and n where a line break belongs',
    );
    assert.ok(!body.includes('\\t') && !body.includes('\\"'), 'no tab or quote is backslash-escaped');
    assert.ok(body.includes('C:\\clinic\\notes'), 'one backslash must not become two');
  });

  test('a plain-text body that merely LOOKS quoted is still plain text', async () => {
    // `"{{draft.output}}"` — a person quoting the summary — parses as a bare JSON
    // string. Treating that as structured would be exactly the over-escaping
    // regression above, so only an object or an array counts as structured.
    const sent = [];
    const flow = {
      nodes: [
        { id: 'draft', type: 'llm', config: { mode: 'summarize' } },
        { id: 'post', type: 'deliver', config: { channel: 'in_app', body: '"{{draft.output}}"' } },
      ],
      edges: [{ from: 'draft', to: 'post' }],
    };
    const tester = new FlowTester({ nodeTypes, llm: stubLlm(AI_ANSWER), channelRegistry: recordingChannels(sent) });
    const events = await runAll(tester, flow, { initialContext: 'seed' });

    assert.deepEqual(failures(events), []);
    assert.equal(sent[0].body, `"${AI_ANSWER}"`, 'the body is the answer in quotes, unescaped');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The decision itself, in isolation. Supplementary to the engine checks above
//    — it explains WHERE the line is drawn, it does not stand in for them.
// ─────────────────────────────────────────────────────────────────────────────
describe('where the line between structured and plain text is drawn', () => {
  test('a JSON array or object whose references sit in string literals is structured', () => {
    assert.equal(landsInsideJsonString('[{"heading":"H","content":"{{a.output}}"}]'), true);
    assert.equal(landsInsideJsonString('{"Notes":"{{a.output}}","Status":"Open"}'), true);
    assert.equal(landsInsideJsonString('{"{{a.output}}":"v"}'), true, 'a templated KEY counts too');
  });

  test('plain text is not structured — including text that contains JSON', () => {
    assert.equal(landsInsideJsonString('Rewrite this:\n\n{{a.output}}'), false);
    assert.equal(landsInsideJsonString('{{prev}}'), false);
    assert.equal(landsInsideJsonString('"{{prev}}"'), false, 'a bare JSON string is not a structure');
    assert.equal(landsInsideJsonString('Here is an example: [{"a":"{{b.output}}"}]'), false);
  });

  test('a reference OUTSIDE a string literal is left alone — the build-time check owns that', () => {
    // `{"n": {{count.output}}}` cannot parse with the reference neutralised, so it
    // is not treated as structured. It is already refused at build time by the
    // identical probe in node-types/assemble.js; silently escaping it here would
    // paper over a spec that is wrong in a different way.
    assert.equal(landsInsideJsonString('{"n": {{count.output}}}'), false);
  });

  test('a value with no references at all is never touched', () => {
    assert.equal(landsInsideJsonString('[{"heading":"H","content":"static"}]'), false);
  });

  test('the escape covers every character that can end a JSON string literal', () => {
    const body = escapeJsonStringBody('a\nb\rc\td"e\\f\u0001g');
    assert.equal(body, 'a\\nb\\rc\\td\\"e\\\\f\\u0001g');
    assert.equal(JSON.parse(`"${body}"`), 'a\nb\rc\td"e\\f\u0001g', 'and it round-trips exactly');
  });
});
