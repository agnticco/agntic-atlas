/**
 * Atlas must never describe its own navigation from the model's imagination.
 *
 * OBSERVED LIVE (twice, in independent conversations): a tester asked to connect
 * Notion. Atlas refused well — said Notion isn't available and offered two
 * workable alternatives — and then undid it with
 *
 *   "…head to your Agntic workspace settings and look for the 'Connectors' or
 *    'Integrations' section…"
 *
 * No such screen exists. `grep -rn "Integrations" src/ public/` and
 * `grep -rni "workspace settings" src/ public/` both return nothing. The real
 * surface is a sidebar entry labelled "Connections" (public/index.html:220-223).
 *
 * WHAT THIS SUITE PINS — and how it is constructed:
 *
 *   The first suite drives the REAL chat endpoint (POST /api/builder/chat) on a
 *   real express app with the real routes mounted, and asserts on THE TEXT THE
 *   USER WOULD SEE — reconstructed from the SSE stream using exactly the client's
 *   own rules (public/index.html:4978-5000: `reset` empties the bubble, `chunk`
 *   appends to it). Nothing here asserts that a function was called, and nothing
 *   asserts that a sentence is present in the prompt string — a presence check
 *   would prove a symbol exists, not that anything enforces it.
 *
 *   Only the model is faked, because the model is the thing under suspicion: the
 *   fake streams the exact bytes the real model streamed in the QA run. No live
 *   model call, no API key, no .env.
 *
 *   THE ANTI-FALSE-POSITIVE CASE IS THE MORE IMPORTANT ONE. Over-triggering here
 *   would corrupt ordinary conversation, so a legitimate reply that uses the same
 *   ordinary words must come back BYTE-IDENTICAL.
 */

import { test, describe, before, after } from 'node:test';
import assert  from 'node:assert/strict';
import http    from 'node:http';
import express from 'express';

import { mountBuilderRoutes } from '../../src/api/builder.js';
import {
  scrubInventedNavigation,
  CONNECTIONS_INSTRUCTION,
} from '../../src/api/chat-navigation-guard.js';

// ── The exact reply the tester saw ────────────────────────────────────────────
// Kept as one string so the invented sentence in the assertions and the one fed
// to the endpoint cannot drift apart.
const INVENTED_SENTENCE =
  "If you'd like Notion supported, head to your Agntic workspace settings and " +
  "look for the 'Connectors' or 'Integrations' section.";

const GOOD_REFUSAL =
  "Notion isn't something Atlas can connect to yet. " +
  'Two things that work today: forward the page to your connected inbox, ' +
  'or paste the text straight into this chat. ';

const QA_REPLY = GOOD_REFUSAL + INVENTED_SENTENCE;

// ── Harness ───────────────────────────────────────────────────────────────────

/**
 * Auth stub — and it MUST be async, exactly like the real one.
 *
 * This is not decoration. `express.json()` fully consumes the request body, and
 * Node then emits `close` on the request object on the next tick even though the
 * client is still there and the socket is wide open. The chat handler reads that
 * as "the caller hung up" and suppresses every byte of the SSE stream. In
 * production the route sits behind `requireAuth`, which `await`s
 * `authenticate(req)` (src/auth/middleware.js:70-73), so the handler attaches its
 * `close` listener AFTER that spurious event has already gone by and streaming
 * works. A SYNCHRONOUS stub here attaches the listener before it fires and the
 * endpoint silently returns nothing — a test of a program nobody runs. Verified
 * both ways while writing this suite.
 */
async function tenantMiddleware(req, _res, next) {
  await new Promise((r) => setImmediate(r)); // the real requireAuth awaits a lookup here
  req.tenant = { id: 'tenantA' };
  req.user   = { id: 'u1', email: 'op@example.com', display_name: 'Op' };
  next();
}

/**
 * A stand-in for the model that streams a fixed reply in the JSON envelope the
 * real model emits, in small token-sized pieces — so the endpoint's character-by-
 * character extractor runs for real, including across chunk boundaries.
 */
function fakeLLM(replyText, { ready = false } = {}) {
  const envelope = JSON.stringify({ reply: replyText, ready_to_build: ready, build_intent: null });
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
 * person would actually be looking at. Mirrors public/index.html:4978-5000 —
 * `reset` clears the streaming bubble, `chunk` appends to it. This, not the
 * server's internals, is "what the user received".
 */
function bubbleTextFrom(events) {
  let text = '';
  for (const ev of events) {
    if (ev.type === 'reset') text = '';
    else if (ev.type === 'chunk') text += ev.text;
  }
  return text;
}

// ── The acceptance test: the real endpoint, the real SSE stream ───────────────

describe('POST /api/builder/chat — Atlas never sends a user to a screen that does not exist', () => {
  let server, port, spine;

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

  test('the invented "Agntic workspace settings / Integrations section" reply never reaches the user', async () => {
    spine.llm = fakeLLM(QA_REPLY);

    const { status, events } = await postChat(port, {
      messages: [{ role: 'user', content: 'Can you connect to my Notion?' }],
    });
    assert.equal(status, 200);

    const seen = bubbleTextFrom(events);

    // 1. The user is NOT sent to a screen that does not exist.
    assert.ok(!/workspace settings/i.test(seen),
      `the user was still told to open "workspace settings":\n${seen}`);
    assert.ok(!/integrations/i.test(seen),
      `the user was still sent to an "Integrations" section:\n${seen}`);
    assert.ok(!/connectors['’"]?\s+section/i.test(seen),
      `the user was still sent to a "Connectors" section:\n${seen}`);

    // 2. The user IS pointed at the one real place.
    assert.ok(seen.includes('open Connections in the left sidebar'),
      `the user was not pointed at Connections:\n${seen}`);

    // 3. The genuinely good part of the answer survives intact — the honest
    //    refusal and both alternatives. Stripping those would be its own failure.
    assert.ok(seen.includes("Notion isn't something Atlas can connect to yet"), seen);
    assert.ok(seen.includes('forward the page to your connected inbox'), seen);
    assert.ok(seen.includes('paste the text straight into this chat'), seen);

    // 4. The stream still terminates properly — the correction must not cost the
    //    user their Build button or leave the turn unfinished.
    assert.equal(events.at(-1)?.type, 'done');
  });

  test('a legitimate reply using the same ordinary words is delivered completely unchanged', async () => {
    // Every trigger word appears here — "workspace settings", "Integrations",
    // "Settings →" — and "Atlas" is named in the SAME sentence as each of them,
    // which is the hardest case: only the fact that the instruction belongs to
    // Slack keeps it safe. Over-triggering on this would corrupt normal chat,
    // which is worse than missing an invented instruction.
    const LEGIT =
      'Atlas cannot flip that switch itself, so in Slack go to your workspace ' +
      'settings and open Settings → Integrations, then approve the app. ' +
      'Notion has an Integrations page too, though Atlas cannot use it yet. ' +
      'Want me to draft the message once that is done?';

    spine.llm = fakeLLM(LEGIT);

    const { status, events } = await postChat(port, {
      messages: [{ role: 'user', content: 'How do I let you post into Slack?' }],
    });
    assert.equal(status, 200);

    const seen = bubbleTextFrom(events);

    // Byte-identical. Not "contains", not "close enough".
    assert.equal(seen, LEGIT);
    // And nothing was withdrawn from the screen mid-answer.
    assert.ok(!events.some((e) => e.type === 'reset'),
      'a legitimate reply was withdrawn and rewritten');
  });
});

// ── The pure function, on the shapes that decide safe vs. sorry ───────────────

describe('scrubInventedNavigation — what it catches and what it must not touch', () => {
  test('the observed sentence is replaced by the one true instruction', () => {
    const { text, changed } = scrubInventedNavigation(QA_REPLY);
    assert.equal(changed, true);
    assert.equal(text, (GOOD_REFUSAL + CONNECTIONS_INSTRUCTION).trim());
  });

  test('an invented Connectors/Integrations section attributed to Atlas is replaced', () => {
    const r = scrubInventedNavigation(
      'Sure. Open the Atlas Integrations tab and pick the app you want.');
    assert.equal(r.changed, true);
    // Only the offending sentence goes; the rest of the reply is untouched.
    assert.equal(r.text, `Sure. ${CONNECTIONS_INSTRUCTION}`);
  });

  test('a third-party instruction between the product name and the screen is LEFT ALONE', () => {
    // "Atlas" is present, but "Notion" sits between it and the screen name, so the
    // instruction belongs to Notion. Rewriting it would mangle a correct answer.
    const input = 'Atlas cannot do that, but in Notion you can go to Settings → Integrations.';
    const r = scrubInventedNavigation(input);
    assert.equal(r.changed, false);
    assert.equal(r.text, input);
  });

  test('an instruction about another product that never names Atlas is LEFT ALONE', () => {
    const input = 'Open Slack, then head to your workspace settings and look for the Integrations section.';
    const r = scrubInventedNavigation(input);
    assert.equal(r.changed, false);
    assert.equal(r.text, input);
  });

  test('ordinary conversation containing the trigger words is LEFT ALONE', () => {
    const inputs = [
      'Atlas can summarise those integrations for you if you paste them in.',
      'I can help you tidy up your workspace, and Atlas will remember the settings you pick.',
      'Atlas has no Integrations section, and that is fine.', // states a fact, gives no directive
      'Your Account settings are in the sidebar in Atlas.',   // a REAL screen, correctly named
    ];
    for (const input of inputs) {
      const r = scrubInventedNavigation(input);
      assert.equal(r.changed, false, `wrongly rewritten: ${input}`);
      assert.equal(r.text, input);
    }
  });

  test('several invented sentences collapse to ONE instruction, not three', () => {
    const r = scrubInventedNavigation(
      'Hello. Head to your Agntic workspace settings. ' +
      'Then open the Atlas Integrations page. Then you are done.');
    assert.equal(r.changed, true);
    assert.equal(r.text.match(/open Connections in the left sidebar/g).length, 1);
    assert.ok(r.text.startsWith('Hello.'));
    assert.ok(r.text.endsWith('Then you are done.'));
  });

  test('a reply with nothing to fix is returned as the very same string, and odd input never throws', () => {
    const clean = 'Morning! Want me to summarise yesterday’s orders?';
    assert.equal(scrubInventedNavigation(clean).text, clean);
    assert.equal(scrubInventedNavigation(clean).changed, false);
    for (const odd of ['', null, undefined, 42, {}, []]) {
      const r = scrubInventedNavigation(odd);
      assert.equal(r.changed, false);
      assert.equal(r.text, odd);
    }
  });
});
