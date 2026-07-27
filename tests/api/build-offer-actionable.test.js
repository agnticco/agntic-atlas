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
 *   2. THE PROMPT RULE (weak, textual). Whether the model actually complies is a
 *      BELIEF about model behaviour and no test can prove it. Asserting on prompt
 *      text only stops the instruction being silently reverted — which is exactly
 *      the failure that produced the QA finding. Same idiom as
 *      tests/converger/plan-provenance.test.js (the grounding prompt guard).
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
    spine = { llm: fakeLLM('') };
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
