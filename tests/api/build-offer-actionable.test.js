/**
 * When Atlas OFFERS to build, the offer itself must be actionable.
 *
 * OBSERVED IN QA (2026-07-26, five builds by four testers): Atlas's first
 * restatement of the workflow ended "Want me to set this up?" with NO "Build it"
 * button. Every tester escaped the same way — by typing the literal phrase
 * "build it" — and that produced a SECOND restatement, this time with a real
 * button. So the user reads the same thing twice and has to type a password to
 * proceed.
 *
 * WHAT WAS ACTUALLY WRONG — and what was not:
 *
 *   NOT the envelope retry. `envelopeRetried` (src/api/builder.js) exists, is
 *   correctly implemented, and has NEVER FIRED: `chat.envelope.retry` appears
 *   zero times across all four memory/logs/atlas-events.log* files, and of 263
 *   `chat.reply` events exactly 4 carry `parsed:false`, all of them dated before
 *   the retry landed (2026-07-04, 2026-07-15 x2, 2026-07-16). The whole QA
 *   session logged `parsed:true, retried:false` on every turn. The envelope was
 *   never the problem.
 *
 *   IT WAS THE PROMPT, doing exactly what it was told. `buildChatSystem()`
 *   carried the literal string "Want me to set this up?" paired with an explicit
 *   instruction to keep ready_to_build:false. The behaviour was specified, not
 *   broken.
 *
 * WHAT THIS SUITE PINS — two different KINDS of guard, and they are worth
 * different amounts. Say so out loud rather than letting a reader assume:
 *
 *   1. THE MECHANISM (strong, behavioural). A `ready_to_build:true` envelope
 *      must reach the browser as an SSE `done` event with `readyToBuild:true`
 *      and the build_intent riding along, ON THE SAME TURN as the offer text.
 *      That flag is the only thing the client gates the button on
 *      (public/index.html: `if (twDone.readyToBuild)`), and until now NOTHING
 *      anywhere asserted it: `grep -rn "readyToBuild" tests/` returned nothing.
 *      This runs the REAL POST /api/builder/chat on a real express app; only the
 *      model is faked. Harness deliberately mirrors
 *      tests/api/chat-navigation-guard.test.js, including the ASYNC auth stub —
 *      see the note on it below, it is load-bearing.
 *
 *   1b. THE SAME MECHANISM ON THE SECOND PATH (strong, behavioural; added
 *      2026-07-27). The endpoint writes that `done` event in TWO places: the
 *      ordinary one inside the tool-round loop, and the FORCED-FINAL one taken
 *      when the model burns the whole tool budget without replying. Section 1
 *      pinned only the first. See the long note above that section for why the
 *      second is not hypothetical — it has fired for a real user.
 *
 *   2. THE PROMPT RULE (weak, textual). Whether the model actually complies is a
 *      BELIEF about model behaviour and no test can prove it. Asserting on prompt
 *      text only stops the instruction being silently reverted — which is exactly
 *      the failure that produced the QA finding. Same idiom as
 *      tests/converger/plan-grounding-prompt.test.js (the grounding prompt guard).
 *
 * DELIBERATELY NOT ASSERTED: that a user who answers "yes please" gets a button.
 * Every QA tester typed "build it" specifically; nobody ever tested a softer
 * affirmative, so what happens on that turn is unproven in both directions and
 * nothing here should pretend otherwise.
 */

import { test, describe, before, after } from 'node:test';
import assert  from 'node:assert/strict';
import http    from 'node:http';
import express from 'express';

import { mountBuilderRoutes, buildChatSystem } from '../../src/api/builder.js';
import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';

// ── Harness ───────────────────────────────────────────────────────────────────

/**
 * Auth stub — and it MUST be async, exactly like the real one.
 *
 * `express.json()` fully consumes the request body and Node then emits `close` on
 * the request object on the next tick even though the socket is wide open. The
 * chat handler reads that as "the caller hung up" and suppresses every byte of
 * the SSE stream. In production the route sits behind `requireAuth`, which
 * `await`s `authenticate(req)` (src/auth/middleware.js), so the handler attaches
 * its `close` listener AFTER that spurious event has gone by. A SYNCHRONOUS stub
 * makes the endpoint return nothing — a test of a program nobody runs.
 */
async function tenantMiddleware(req, _res, next) {
  await new Promise((r) => setImmediate(r)); // the real requireAuth awaits a lookup here
  req.tenant = { id: 'tenantA' };
  req.user   = { id: 'u1', email: 'op@example.com', display_name: 'Op' };
  next();
}

/**
 * A stand-in for the model that streams the JSON envelope the real model emits,
 * in small token-sized pieces, so the endpoint's character-by-character extractor
 * runs for real across chunk boundaries. `buildIntent` is a real parameter here
 * (the navigation-guard suite's helper hardcodes null) because whether the intent
 * survives the trip is half of what this suite is for.
 */
function fakeLLM(replyText, { ready = false, buildIntent = null } = {}) {
  const envelope = JSON.stringify({
    reply: replyText,
    ready_to_build: ready,
    build_intent: buildIntent,
  });
  return {
    invoke: async () => ({ content: envelope }),
    async *stream() {
      for (let i = 0; i < envelope.length; i += 7) {
        yield { content: envelope.slice(i, i + 7) };
      }
    },
  };
}

/** POST to the chat endpoint and collect every SSE data event until the stream ends. */
function postChat(port, body, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    let timer;
    const finish = (v) => { clearTimeout(timer); resolve(v); };
    const req = http.request(
      {
        port, path: '/api/builder/chat', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        const events = [];
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          let idx;
          while ((idx = raw.indexOf('\n\n')) >= 0) {
            const frame = raw.slice(0, idx); raw = raw.slice(idx + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue; // heartbeat comment
            try { events.push(JSON.parse(dataLine.slice(5).trim())); } catch { /* ignore */ }
          }
        });
        res.on('end', () => finish({ status: res.statusCode, events }));
      },
    );
    req.on('error', () => finish({ status: 0, events: [] }));
    timer = setTimeout(() => { req.destroy(); finish({ status: 0, events: [], timedOut: true }); }, timeoutMs);
    req.end(payload);
  });
}

/**
 * Replay the SSE events through the CLIENT'S OWN rules to get the message text a
 * person is actually looking at: `reset` clears the streaming bubble, `chunk`
 * appends to it (public/index.html). This, not the server's internals, is "what
 * the user received".
 */
function bubbleTextFrom(events) {
  let text = '';
  for (const ev of events) {
    if (ev.type === 'reset') text = '';
    else if (ev.type === 'chunk') text += ev.text;
  }
  return text;
}

/**
 * Replay the terminal `done` event through the CLIENT'S OWN button rule and return
 * the Build it message a person would be looking at, or null if there isn't one.
 *
 * This mirrors `twTick` in public/index.html: on `done`, `if (twDone.readyToBuild)`
 * it pushes `{ isCta:true, ctaAction:'build', buildIntent, btn:'Build it →' }` and
 * the click handler calls `startBuild(buildIntent)`. Nothing else on the event can
 * produce that button — there is no text parser for "yes"/"go ahead" anywhere in
 * the client (a recorded decision), so the flag IS the button.
 *
 * Asserting on this rather than on the raw flag is the difference between "a field
 * had the right value" and "the user has something to press".
 */
function clientBuildCtaFrom(events) {
  const done = events.filter((e) => e.type === 'done').at(-1);
  if (!done) return null;
  if (!done.readyToBuild) return null;
  return { isCta: true, ctaAction: 'build', buildIntent: done.buildIntent || null, btn: 'Build it →' };
}

// ── 1. THE MECHANISM: the flag that draws the button actually reaches the browser ──

describe('POST /api/builder/chat — the turn that offers to build carries the Build it button', () => {
  let server, port, spine;

  // The offer sentence QA saw, verbatim, and a build_intent of the shape the
  // prompt asks for (trigger + steps + destination in one paragraph).
  const OFFER_REPLY =
    "Got it — every time an order confirmation lands in your inbox I'll pull out the " +
    "order number and the total, and post a one-line summary into #orders. " +
    'Want me to set this up?';
  const BUILD_INTENT =
    'When an email arrives in the connected inbox that looks like an order confirmation, ' +
    'extract the order number and the total, and post a one-line summary to the Slack ' +
    'channel #orders.';

  before(async () => {
    const app = express();
    app.use(express.json());
    // `spine` is a live reference the fake model is swapped into per-test, so the
    // route is mounted exactly once, the way server.js mounts it.
    // SLACK IS CONNECTED HERE, and it has to be: `BUILD_INTENT` posts to a Slack
    // channel, and since 2026-08-01 the endpoint withdraws the Build it button when the
    // intent names a service the workspace does not have (a fresh tenant was offered a
    // build for Slack it did not own — see `no-build-button-for-what-you-lack.test.js`).
    // This harness modelled no connectors at all, so it was asking the endpoint to offer
    // a Slack build on an EMPTY workspace — a state production never puts it in. The
    // sibling harness below already resolves connectors; these two now agree.
    spine = {
      llm: fakeLLM(''),
      slack:    { resolveForTenant: async () => ({ connected: true }) },
      // GOOGLE CONNECTED TOO, and it has to be: `BUILD_INTENT` is EMAIL-TRIGGERED
      // ("when an email arrives"), and since 2026-08-01 that is read as requiring Gmail —
      // email as a TRIGGER can only mean the connected Google account, even though email
      // as a DESTINATION may mean the Atlas inbox. A workspace with Slack but no Google
      // could not run this workflow, so asserting a build offer for it was asserting a
      // state production never produces.
      google:   { resolveForTenant: async () => ({ connected: true }) },
      airtable: { resolveForTenant: () => ({ connected: false }) },
    };
    mountBuilderRoutes(app, {
      spine,
      requireActiveTenant: tenantMiddleware,
      requireAuth: tenantMiddleware,
    });
    await new Promise((r) => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  });

  after(() => { try { server?.close(); } catch { /* ignore */ } });

  test('a ready_to_build:true envelope ends the turn with readyToBuild:true and the intent intact', async () => {
    spine.llm = fakeLLM(OFFER_REPLY, { ready: true, buildIntent: BUILD_INTENT });

    const { status, events } = await postChat(port, {
      messages: [{ role: 'user', content: 'Summarise my order confirmation emails into Slack' }],
    });
    assert.equal(status, 200);

    const done = events.at(-1);
    assert.equal(done?.type, 'done', 'the stream did not finish with a done event');

    // THE flag. This is the only thing the client gates the button on
    // (public/index.html: `if (twDone.readyToBuild)`), so this assertion is the
    // difference between an offer the user can press and one they cannot.
    assert.equal(done.readyToBuild, true,
      'the model said ready_to_build:true and the browser was told false — no Build it button');

    // The intent must ride along on the same event: it is what the build is
    // started FROM (`self.startBuild(buildIntent)`), and losing it silently
    // degrades the build to a reconstruction.
    assert.equal(done.buildIntent, BUILD_INTENT,
      'the build_intent did not survive the trip to the browser');

    // ONE act: the offer text and the button arrive together. If the reply were
    // lost, the user would get a bare button with nothing to agree to — which is
    // the same defect wearing the other shoe.
    assert.equal(bubbleTextFrom(events), OFFER_REPLY);
    assert.ok(bubbleTextFrom(events).includes('Want me to set this up?'),
      'the offer sentence itself never reached the user');
  });

  test('a ready_to_build:false envelope ends the turn with readyToBuild:false and no intent', async () => {
    // The anti-false-pass half. A guard that only ever checks the true case
    // passes on an endpoint hardwired to true, which would put a Build it button
    // on every clarifying question in the conversation.
    const QUESTION = 'Happy to help. Which inbox should I watch for those emails?';
    spine.llm = fakeLLM(QUESTION, { ready: false });

    const { status, events } = await postChat(port, {
      messages: [{ role: 'user', content: 'I want to automate something with email' }],
    });
    assert.equal(status, 200);

    const done = events.at(-1);
    assert.equal(done?.type, 'done');
    assert.equal(done.readyToBuild, false,
      'a plain clarifying question drew a Build it button');
    assert.equal(done.buildIntent, null);
    assert.equal(bubbleTextFrom(events), QUESTION);
  });

  test('a build_intent that is blank or missing is reported as null, never as an empty string', async () => {
    // startBuild() reconstructs the intent when it is null; an empty string is a
    // truthy-looking absence that would be handed onward as the whole brief.
    spine.llm = fakeLLM('Want me to set this up?', { ready: true, buildIntent: '   ' });

    const { events } = await postChat(port, {
      messages: [{ role: 'user', content: 'go on then' }],
    });
    const done = events.at(-1);
    assert.equal(done.readyToBuild, true);
    assert.equal(done.buildIntent, null);
  });
});

// ── 1b. THE SAME MECHANISM ON THE QUIETER PATH: the forced final reply ────────

/**
 * There are TWO places a chat turn can end with the ready-to-build flag set, and
 * until now only one of them was pinned.
 *
 *   ORDINARY PATH — the model produces its text reply inside the tool-round loop
 *   (src/api/builder.js, the `sseWrite({type:'done'…})` at the end of the loop
 *   body). Covered by the suite above.
 *
 *   FORCED-FINAL PATH — the model burns the whole tool-round budget
 *   (`MAX_TOOL_ROUNDS`) without ever producing a text reply. Rather than dumping
 *   an error on the user, the endpoint takes one more turn with tools DISABLED
 *   ("You now have enough information. Do NOT call any more tools…") and ends the
 *   turn from whatever comes back. It reads `ready_to_build`, normalises
 *   `build_intent` and writes its own `done` event — a SECOND, independent copy of
 *   the mechanism.
 *
 * This is the shape CLAUDE.md warns about in as many words: "a new control type is
 * not done until it is in both sets — this exact line has been the defect three
 * times." A fix applied to one copy and not the other is invisible until a user
 * lands on the quiet one.
 *
 * AND IT IS NOT HYPOTHETICAL. Measured across all four memory/logs/atlas-events.log*
 * files on 2026-07-27: `forcedFinal:true` appears on a real `chat.reply` line, once
 * — 2026-07-15T12:31:44.826Z — the same day the path landed (601cb34). So a real
 * user's turn HAS ended here. (That one carried readyToBuild:false, so the offer
 * case on this path is unobserved; nothing here claims otherwise. Compare the
 * envelope retry, which has fired zero times ever.)
 *
 * THIS SECTION ADDS NO BEHAVIOUR. It only pins what the forced-final path already
 * does.
 */

/**
 * A model that will not answer while it still has tools, exactly like the one that
 * produced the real forced-final line: it calls a tool on every round until the
 * endpoint takes the budget away, and only then replies.
 *
 * It decides which turn it is on from the endpoint's OWN forced-final instruction
 * rather than by counting to six, so the guard does not quietly stop exercising the
 * path if `MAX_TOOL_ROUNDS` is ever retuned.
 */
function fakeToolLoopLLM(replyText, { ready = false, buildIntent = null, toolName = 'slack_list_channels' } = {}) {
  const envelope = JSON.stringify({
    reply: replyText,
    ready_to_build: ready,
    build_intent: buildIntent,
  });
  const state = { streamCalls: 0, toolRounds: 0, forcedFinalSeen: false, toolsOnForcedTurn: null, toolsOnRounds: null };

  const isForcedFinalTurn = (msgs) => {
    const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : null;
    const content = typeof last?.content === 'string' ? last.content : '';
    return content.includes('Do NOT call any more tools');
  };

  return {
    _state: state,
    invoke: async () => ({ content: envelope }),
    async *stream(msgs, config) {
      state.streamCalls++;
      if (isForcedFinalTurn(msgs)) {
        state.forcedFinalSeen = true;
        state.toolsOnForcedTurn = Array.isArray(config?.tools) ? config.tools.length : 0;
        // Same 7-character dribble as the other fake, so the endpoint's
        // character-by-character envelope extractor runs for real here too.
        for (let i = 0; i < envelope.length; i += 7) yield { content: envelope.slice(i, i + 7) };
        return;
      }
      state.toolRounds++;
      state.toolsOnRounds = Array.isArray(config?.tools) ? config.tools.length : 0;
      // The shape a real Anthropic tool round yields: one summary chunk carrying
      // toolCalls and no usable text. `id` is load-bearing — the executor pairs its
      // ToolMessage result to it, and a missing one makes the next turn 400.
      yield {
        content: '',
        additionalKwargs: {
          toolCalls: [{ name: toolName, id: `call_${state.toolRounds}`, args: { query: 'order confirmation' } }],
        },
      };
    },
  };
}

describe('POST /api/builder/chat — a turn that ends on the FORCED-FINAL path still carries the button', () => {
  let server, port, spine;

  const OFFER_REPLY =
    "I've had a look through the inbox — every order confirmation that lands there, " +
    "I'll pull out the order number and the total and post a one-line summary into " +
    '#orders. Want me to set this up?';
  const BUILD_INTENT =
    'When an email arrives in the connected inbox that looks like an order confirmation, ' +
    'extract the order number and the total, and post a one-line summary to the Slack ' +
    'channel #orders.';

  before(async () => {
    const app = express();
    app.use(express.json());
    // THIS HARNESS MUST CARRY REAL TOOLS, and that is not decoration.
    //
    // The forced-final path is only REACHABLE when the model has tools to burn the
    // round budget on — a tool-less turn answers on round one every time. A fixture
    // with an empty tool list would therefore be exercising a path production
    // cannot take, and worse, it would make the "the forced turn is issued with
    // tools DISABLED" assertion below unfalsifiable: with no tools anywhere, that
    // turn is tool-less no matter what the endpoint does.
    //
    // So: the REAL CapabilityRegistry, a real read-only capability on a connected
    // connector, and the credential path the executor actually walks
    // (injectCapabilityCredentials → getSlackToken → cipher.decrypt), so the tool
    // rounds run through the real executor with a real handler and no error branch.
    const registry = new CapabilityRegistry();
    registry.register({
      id:          'slack_list_channels',
      connector:   'slack',
      name:        'List Slack channels',
      description: 'List the channels the bot can see.',
      positions:   ['step'],
      effect:      'read',
      configSchema: [{ key: 'query', label: 'Query', type: 'text' }],
      isReady: () => true,
      handle: async () => ({ channels: ['#orders', '#ops'] }),
    });

    spine = {
      llm: fakeToolLoopLLM(''),
      engine:   { capabilityRegistry: registry },
      slack:    { resolveForTenant: async () => ({ connected: true }) },
      // GOOGLE CONNECTED TOO, and it has to be: `BUILD_INTENT` is EMAIL-TRIGGERED
      // ("when an email arrives"), and since 2026-08-01 that is read as requiring Gmail —
      // email as a TRIGGER can only mean the connected Google account, even though email
      // as a DESTINATION may mean the Atlas inbox. A workspace with Slack but no Google
      // could not run this workflow, so asserting a build offer for it was asserting a
      // state production never produces.
      google:   { resolveForTenant: async () => ({ connected: true }) },
      airtable: { resolveForTenant: () => ({ connected: false }) },
      auth: {
        oauthTokenStore: { get: () => ({ access_token_enc: 'enc', scope: 'channels:read', account: 'acme' }) },
        tokenCipher:     { decrypt: () => 'xoxb-test-token' },
      },
    };
    mountBuilderRoutes(app, {
      spine,
      requireActiveTenant: tenantMiddleware,
      requireAuth: tenantMiddleware,
    });
    await new Promise((r) => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  });

  after(() => { try { server?.close(); } catch { /* ignore */ } });

  test('flag SET on the forced final reply → the browser gets a drawable Build it button', async () => {
    const llm = fakeToolLoopLLM(OFFER_REPLY, { ready: true, buildIntent: BUILD_INTENT });
    spine.llm = llm;

    const { status, events } = await postChat(port, {
      messages: [{ role: 'user', content: 'Summarise my order confirmation emails into Slack' }],
    }, { timeoutMs: 10000 });
    assert.equal(status, 200);

    // ── First prove we are on the path we think we are on ──────────────────────
    // Without this, a model that simply answered on round one would pass every
    // assertion below and the forced-final copy would still be pinned by nothing.
    assert.ok(llm._state.toolRounds >= 2,
      `the tool-round budget was never exhausted (${llm._state.toolRounds} round(s)) — this turn did not reach the forced-final path`);
    assert.equal(llm._state.forcedFinalSeen, true,
      'the endpoint never issued its tools-disabled final turn');
    assert.ok(llm._state.toolsOnRounds > 0,
      'the fixture handed the model no tools, so this turn could not have burned a tool budget the way production does');
    assert.equal(llm._state.toolsOnForcedTurn, 0,
      'the forced final turn was issued WITH tools — the model could start another round instead of answering');
    const toolEvents = events.filter((e) => e.type === 'tool');
    assert.equal(toolEvents.length, llm._state.toolRounds,
      'the user was not shown one tool indicator per round the model actually took');

    // ── Now the invariant ──────────────────────────────────────────────────────
    const done = events.at(-1);
    assert.equal(done?.type, 'done', 'the stream did not finish with a done event');
    assert.equal(done.readyToBuild, true,
      'the model said ready_to_build:true on the forced final reply and the browser was told false — no Build it button');
    assert.equal(done.buildIntent, BUILD_INTENT,
      'the build_intent was dropped on the forced-final path');

    // What the person is actually looking at, by the client's own rule.
    const cta = clientBuildCtaFrom(events);
    assert.ok(cta, 'the reply reached the browser with nothing to press');
    assert.equal(cta.btn, 'Build it →');
    assert.equal(cta.buildIntent, BUILD_INTENT,
      'the button is there but would start the build from a reconstruction instead of the intent Atlas wrote');

    // The offer and the button are ONE act here too.
    assert.equal(bubbleTextFrom(events), OFFER_REPLY);
    assert.ok(bubbleTextFrom(events).includes('Want me to set this up?'),
      'the offer sentence itself never reached the user');
  });

  test('flag CLEAR on the forced final reply → no button, and nothing to press', async () => {
    // The anti-false-pass half. An endpoint hardwired to true on this path would
    // put a Build it button under every tool-heavy turn that merely reported what
    // it found.
    const REPORT =
      "I looked through the last week of mail and found 14 order confirmations. " +
      'Which Slack channel should the summaries go to?';
    const llm = fakeToolLoopLLM(REPORT, { ready: false });
    spine.llm = llm;

    const { status, events } = await postChat(port, {
      messages: [{ role: 'user', content: 'Have a look at my order emails' }],
    }, { timeoutMs: 10000 });
    assert.equal(status, 200);

    assert.ok(llm._state.toolRounds >= 2, 'this turn did not reach the forced-final path');
    assert.equal(llm._state.forcedFinalSeen, true, 'the endpoint never issued its tools-disabled final turn');

    const done = events.at(-1);
    assert.equal(done?.type, 'done');
    assert.equal(done.readyToBuild, false,
      'a turn that only reported findings drew a Build it button');
    assert.equal(done.buildIntent, null);
    assert.equal(clientBuildCtaFrom(events), null,
      'the client would draw a Build it button on a turn that never offered to build');
    assert.equal(bubbleTextFrom(events), REPORT);
  });

  test('a blank build_intent on the forced final reply is reported as null, never as an empty string', async () => {
    // The same normalisation the ordinary path has, in its second copy. An empty
    // string is a truthy-looking absence that would be handed onward as the whole
    // brief instead of letting startBuild() derive one from the conversation.
    const llm = fakeToolLoopLLM('Want me to set this up?', { ready: true, buildIntent: '   ' });
    spine.llm = llm;

    const { events } = await postChat(port, {
      messages: [{ role: 'user', content: 'go on then' }],
    }, { timeoutMs: 10000 });

    assert.equal(llm._state.forcedFinalSeen, true, 'this turn did not reach the forced-final path');
    const done = events.at(-1);
    assert.equal(done.readyToBuild, true);
    assert.equal(done.buildIntent, null);
  });
});

// ── 2. THE PROMPT RULE: weaker on purpose, and it says so ─────────────────────

describe('the chat prompt never tells Atlas to offer a build while holding the flag false', () => {
  // Read this before trusting it: these assertions pin the INSTRUCTION, not the
  // model's compliance with it. No test can prove what the model will do. What
  // they do buy is that the exact sentence which produced the QA finding cannot
  // be reinstated without a check going red.

  const prompt = () => buildChatSystem([], { name: 'Op', email: 'op@example.com' });

  test('the instruction to keep the flag false while offering is GONE', () => {
    const p = prompt();
    // The literal rule that was in the prompt during the QA session:
    //   "If they seem close but haven't confirmed, gently offer ('Want me to set
    //    this up?') but keep ready_to_build:false."
    assert.doesNotMatch(p, /but keep ready_to_build:\s*false/i,
      'the prompt again tells Atlas to make an offer while withholding the button');
    assert.doesNotMatch(p, /gently offer[^.]*keep ready_to_build/i,
      'the offer is once more paired with holding the flag false');
  });

  test('the prompt says an offer and the button are one act', () => {
    const p = prompt();
    assert.match(p, /NEVER make a build offer while holding ready_to_build:false/,
      'nothing in the prompt forbids the offer-without-a-button turn that QA saw');
    assert.match(p, /Want me to set this up\?/,
      'the offer sentence should still be modelled — the fix is to arm it, not to ban offering');
  });

  test('the offer case is explicitly one of the cases that sets the flag TRUE', () => {
    const p = prompt();
    assert.match(p, /YOU are the one offering/,
      'the prompt does not name Atlas-initiated offers as a ready_to_build:true case');
    assert.match(p, /ready_to_build:true[\s\S]{0,400}Build it/,
      'the prompt never explains that the flag is what puts the button on screen');
  });

  test('the flag is still described as something the user acts on, not as consent already given', () => {
    // Guards the other direction: arming the offer must not become "the model can
    // decide the user agreed". Pressing the button IS the confirmation.
    const p = prompt();
    assert.match(p, /does not skip their consent/i,
      'the prompt no longer states that setting the flag is not consent');
    assert.match(p, /still press the button/i,
      'the prompt no longer states that the user still has to press Build it');
  });

  test('the rules the offer sits between are still intact', () => {
    // These three were paid for in earlier rounds and live immediately around the
    // lines this change touched. A careless edit to the block would take them out
    // silently.
    const p = prompt();
    assert.match(p, /MAILBOX \/ SOURCE GROUNDING/,      'the mailbox-grounding rule was lost');
    assert.match(p, /ATLAS'S OWN SCREENS/,               'the do-not-describe-our-own-screens rule was lost');
    assert.match(p, /SLACK CHANNELS/,                    'the Slack-channel rule was lost');
    assert.match(p, /Connections, in the left sidebar/,  'the one nameable screen was lost');
  });
});
