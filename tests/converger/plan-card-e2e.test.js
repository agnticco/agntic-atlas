/**
 * THE PLAN CARD, DRIVEN THE WHOLE WAY: BROWSER → ENDPOINT → BACKGROUND BUILD → CARD.
 *
 * Before Atlas builds anything expensive it shows a plan: what starts the workflow, the
 * numbered steps, the routes it can take, and what happens if a step fails. This is the
 * ONE test in the tree that reaches that card the way a person does — a real
 * `POST /api/builder/sessions` on a real express app, a real background build job, and
 * a real `/status` poll to the `plan_review` interrupt. Only the model is stubbed.
 *
 * WHY THAT MATTERS MORE THAN WHAT IT ASSERTS. Two defects in this codebase have had the
 * same shape: something is computed correctly and then DROPPED at a boundary — the run
 * summary's evidence dropped at the POST, and the build offer's flag dropped on the
 * forced-final turn. Every unit-level guard passes in both cases. A harness that carries
 * a real request through the real endpoint to the real screen payload is the only kind
 * that can see it.
 *
 * RE-POINTED 2026-07-27. This file was `plan-said-words.test.js`, and it pinned the plan
 * card's word-level `you said` highlighting and its `you said / I found / I inferred`
 * badges. **That whole feature was removed by the operator's decision** — the complexity
 * was not worth what it delivered. The feature-specific assertions went with it; the
 * harness did not, because the coverage it gives is not about marks. It now asserts what
 * is still true and still worth protecting: a plan card is REACHED and it ARRIVES
 * RENDERABLE — trigger, steps, routes and failure line, as plain text — and it carries a
 * pre-selected default so the zero-typing accept path survives.
 */

import { test, describe, after, before } from 'node:test';
import assert                    from 'node:assert/strict';
import express                   from 'express';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir }                from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath }         from 'node:url';

import { mountBuilderRoutes } from '../../src/api/builder.js';
import { realCatalog }        from '../helpers/catalog.js';

// ── the stub model ─────────────────────────────────────────────────────────────

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
// eslint-disable-next-line no-unused-vars
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-plancard-')); tmpDirs.push(d); return d; };

const J = (o) => ({ content: JSON.stringify(o) });

/**
 * The plan a person is meant to see. Deliberately the FULL shape — a branching
 * workflow with a failure line — because the card's routes row and failure row are
 * `sc-if`-gated and a linear plan would never exercise them.
 */
const PLAN = {
  summary: 'Summarize each incoming email into your Atlas inbox',
  trigger: { text: 'Runs every morning at 8:00 AM local time' },
  steps: [
    { text: 'Summarize the shipping emails' },
    { text: 'Put the summary in your Atlas inbox' },
  ],
  branches: [
    { when: 'it is urgent',  then: 'page the on-call engineer' },
    { when: 'anything else', then: 'no action is taken' },
  ],
  error_handling: { text: 'Retry once, then flag it to you' },
  knowledge: [], upload_suggestion: null,
};

function makeLLM(plan) {
  return { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1',
      statement: 'Every incoming email is summarized into the Atlas inbox.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Email Summary' }] }] });
    if (p.includes('What starts this workflow')) return J({ trigger: { type: 'email', filter: 'is:unread' } });
    if (p.includes('CONCRETE example cases'))    return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('write the PLAN the user will approve')) return J(plan);
    if (p.includes('cases nobody has decided about')) {
      const ids = [...p.matchAll(/^ {2}- id: (\S+)$/gm)].map(m => m[1]);
      return J({ suggestions: ids.map(id => ({ gapId: id, answer: 'retry then tell a person' })) });
    }
    if (p.includes('Build the COMPLETE workflow')) {
      return J({ name: 'Email digest', triggers: [{ type: 'email', filter: 'is:unread' }],
        nodes: [
          { id: 'sum',  type: 'llm',     label: 'Summarize', config: { mode: 'summarize', instructions: 'Summarize the email.' } },
          { id: 'post', type: 'deliver', label: 'Save',      config: { channel: 'inbox_deliver' } },
        ],
        edges: [{ from: 'sum', to: 'post' }] });
    }
    return J({});
  } };
}

// ── THE WHOLE TRIP ─────────────────────────────────────────────────────────────

describe('POST /api/builder/sessions reaches a plan card a person can read and approve', () => {
  let server, port;

  before(async () => {
    const app = express();
    app.use(express.json());
    const spine = {
      llm: makeLLM(PLAN),
      engine: { channelRegistry: realCatalog(), capabilityRegistry: { list: () => [] } },
      auth:     { oauthTokenStore: null, tokenCipher: null },
      // The SHAPE production hands back — an object with an actions list, never
      // null. A `null` here made the system prompt throw on `c.actions`, which is
      // the "a check that constructs its subject differently from production is
      // testing a program nobody runs" trap, met head on inside this very suite.
      slack:    { resolveForTenant: async () => ({ connector: 'slack',  connected: false, grantedScopes: [], actions: [] }) },
      google:   { resolveForTenant: async () => ({ connector: 'google', connected: false, grantedScopes: [], actions: [] }) },
      airtable: { resolveForTenant: () => ({ connector: 'airtable', connected: false, grantedScopes: [], actions: [] }) },
      interactionStore: {
        startSession() {}, appendEvent() {},
        getSession: () => ({ completed_at: null }),
      },
      costTracker: { setSessionUser() {} },
    };
    // The auth stub MUST be async, like the real `requireAuth` — a synchronous one
    // changes when handlers see request lifecycle events. Same note as
    // tests/api/build-offer-actionable.test.js, which found that the hard way.
    const tenantMiddleware = async (req, _res, next) => {
      await new Promise((r) => setImmediate(r));
      req.tenant = { id: 'tenantA' };
      req.user   = { id: 'u1', email: 'op@example.com', display_name: 'Op' };
      next();
    };
    mountBuilderRoutes(app, { spine, requireActiveTenant: tenantMiddleware, requireAuth: tenantMiddleware });
    await new Promise((r) => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  });

  after(() => { try { server?.close(); } catch { /* ignore */ } });

  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json());

  /** Start a build the way the browser does, then poll to the plan card interrupt. */
  async function planInterruptFor(body) {
    const started = await post('/api/builder/sessions', body);
    assert.ok(started.threadId, `the build did not start: ${JSON.stringify(started)}`);
    for (let i = 0; i < 200; i++) {
      const s = await fetch(`http://127.0.0.1:${port}/api/builder/sessions/${started.threadId}/status`)
        .then(r => r.json());
      if (s.status === 'ready' && s.interrupt?.type === 'plan_review') return s.interrupt;
      if (s.status === 'error') assert.fail(`the build errored: ${s.error}`);
      await new Promise(r => setTimeout(r, 25));
    }
    assert.fail('the plan card never arrived — the harness, not the guard, is broken');
  }

  test('every line the card draws arrives, as plain text', async () => {
    const iv = await planInterruptFor({
      intent: 'Summarize the shipping emails every morning and put them in the inbox',
    });
    const plan = iv.plan;

    // What the card actually binds: `item.trigger.text`, `st.text`, `br.when` /
    // `br.then`, `item.errorText`. Assert the payload behind each of those, because a
    // missing one is a blank row on a screen a person is being asked to approve.
    assert.equal(plan.trigger.text, 'Runs every morning at 8:00 AM local time',
      'the TRIGGER row is drawn from this string');
    assert.deepEqual(plan.steps.map(s => s.text),
      ['Summarize the shipping emails', 'Put the summary in your Atlas inbox'],
      'the PROCEDURE rows are drawn from these, in order');
    assert.deepEqual(plan.branches.map(b => [b.when, b.then]),
      [['it is urgent', 'page the on-call engineer'], ['anything else', 'no action is taken']],
      'the ROUTES TO rows are drawn from these');
    assert.equal(plan.error_handling.text, 'Retry once, then flag it to you',
      'the ON FAILURE row is drawn from this');
    assert.equal(plan.summary, 'Summarize each incoming email into your Atlas inbox',
      'the PURPOSE row is drawn from this');
  });

  test('the card carries a pre-selected default, so Enter alone builds it', async () => {
    const iv = await planInterruptFor({ intent: 'Summarize the shipping emails every morning' });
    assert.ok(Array.isArray(iv.choices) && iv.choices.some(c => c.selected),
      'every interrupt carries a default (§11.9) — the zero-typing accept path depends on it');
  });

  test('NOTHING on the plan makes a claim about who said what', async () => {
    // The removed feature's payload. A future edit that re-adds a badge field would
    // ship a mark the card cannot draw — worse than no mark, because the next reader
    // assumes it is on screen. Pinned on the object the CLIENT receives.
    const iv = await planInterruptFor({
      intent: 'Summarize the shipping emails every morning at 8:00 AM',
    });
    const plan = iv.plan;
    const items = [plan.trigger, ...plan.steps, ...plan.branches, plan.error_handling];
    for (const it of items) {
      assert.equal('confidence' in it, false,
        `a per-line mark reached the client: ${JSON.stringify(it)}`);
      assert.equal('spans' in it, false, 'word-level highlight spans reached the client');
      assert.equal('whenSpans' in it, false);
      assert.equal('thenSpans' in it, false);
    }
    assert.equal('saidWordsChecked' in plan, false,
      'the plan still advertises a check that no longer exists');
  });
});

// ── WHAT IS ACTUALLY ON SCREEN ─────────────────────────────────────────────────
//
// The template IS the renderer here: there is nothing to execute without a DOM, so
// these pin its STRUCTURE — that each plan row binds the plain text the endpoint above
// was just proved to send. Stated honestly: this half proves the markup binds those
// fields, not that a browser paints them.

const HTML = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');

describe('the plan card\'s markup draws plain lines, and no marks at all', () => {
  const planCard = () => {
    const start = HTML.indexOf('<!-- PLAN CARD (plan_review)');
    assert.notEqual(start, -1, 'the plan card markup is GONE from public/index.html — re-point this extraction.');
    const end = HTML.indexOf('<!-- CoT IN THE CHAT', start);
    assert.notEqual(end, -1, 'the plan card markup no longer ends where this extraction expects — re-point it.');
    return HTML.slice(start, end);
  };

  for (const [what, binding] of [
    ['the trigger',            '{{ item.trigger.text }}'],
    ['each step',              '{{ st.text }}'],
    ['each route\'s condition', '{{ br.when }}'],
    ['each route',             '{{ br.then }}'],
    ['the failure line',       '{{ item.errorText }}'],
  ]) {
    test(`${what} is drawn as plain text`, () => {
      assert.equal(planCard().includes(binding), true,
        `${what} is not on the card — a plan row a person is asked to approve is blank`);
    });
  }

  test('no highlight spans, no badges and no legend survive on the card', () => {
    const card = planCard();
    for (const gone of [
      'item.trigger.spans', 'st.spans', 'br.thenSpans', 'br.whenSpans', 'item.errorSpans',
      'chip.label', 'chip.style', 'item.legend',
    ]) {
      assert.equal(card.includes(gone), false,
        `\`${gone}\` is still bound by the plan card — the marking was supposed to go entirely`);
    }
  });

  test('the card still has the parts that are NOT this feature', () => {
    const card = planCard();
    // The zero-typing accept path and the SOP letterhead are a different decision and
    // must not have been taken out with the marks.
    for (const kept of [
      '{{ item.onBuild }}', '{{ item.onChange }}', '{{ item.summary }}',
      '{{ item.titleHead }}', 'OPERATING PROCEDURE', 'PREPARED BY',
      '{{ item.knowledge }}', '{{ item.upload.artifact }}',
    ]) {
      assert.equal(card.includes(kept), true,
        `\`${kept}\` was removed with the marks and is not part of them`);
    }
  });
});
