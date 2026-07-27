/**
 * EVERY WHOLE-SPEC REBUILD MUST SAY WHY IT IS HAPPENING, AND WHOSE BUILD IT IS.
 *
 * Rebuilding the whole workflow is the most expensive thing the builder does — one
 * Opus pass over every step, 90 to 400 seconds on the record — and SIX different
 * routes can order one. Three of them recorded nothing at all.
 *
 * What that cost, concretely: on 2026-07-26 four people built at once against one
 * server. Build `build-agntic-1785087187289` spent 8 minutes 16 seconds rebuilding
 * itself three times after the user's last answer, and the log could not say why. The
 * driving route had to be worked out by ELIMINATION — noticing that the
 * `converger.regen` line which the blocking-gap route emits was absent, and that the
 * preceding `analyze` had taken ~2s (one small model call), which left only the
 * "is this workflow finished?" check. Across two builds that afternoon that unlogged
 * check ordered five of seven whole-spec rebuilds and left no trace of any of them.
 * Meanwhile `converger.regen` itself carried no thread and no tenant, so in the one
 * situation this log exists for — several people building at once, one of them
 * looping — its lines could not be attributed to a build at all.
 *
 * These tests drive the real graph and read the real event log. They assert that a
 * person diagnosing the next occurrence can answer "how many rebuilds, ordered by
 * what, on whose build" from the file alone — in minutes, not in a round.
 */

// LOG_DIR is read when `event-log.js` is first evaluated, so it must be set BEFORE
// anything imports it — hence the dynamic imports below. `node --test` gives each
// test file its own process, so this cannot affect another file.
import { test, describe, after } from 'node:test';
import assert                    from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir }                from 'node:os';
import { join }                  from 'node:path';
import { readFile }              from 'node:fs/promises';
import { fileURLToPath }         from 'node:url';

const ROOT    = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const LOG_DIR = mkdtempSync(join(tmpdir(), 'atlas-regenlog-'));
process.env.LOG_DIR = LOG_DIR;

const { createConverger } = await import('../../src/converger/index.js');
const { realCatalog }     = await import('../helpers/catalog.js');

const tmpDirs = [LOG_DIR];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-regen-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

const J = (o) => ({ content: JSON.stringify(o) });

const CAPS = () => ({
  channels: realCatalog().getAll().map(c => ({ ...c, available: true })),
  connectors: { slack: { connected: true } },
  slackChannels: ['ops'],
});

const PLAN = {
  summary: 'Summarize each incoming email into your Atlas inbox',
  trigger: { text: 'A new email arrives in your Gmail' },
  steps: [{ text: 'Summarize the email' }, { text: 'Lay it out as a digest' }],
  branches: [], error_handling: { text: 'Retry once' }, knowledge: [], upload_suggestion: null,
};

const SPEC = () => ({
  name: 'Email digest',
  triggers: [{ type: 'email', filter: 'is:unread' }],
  nodes: [
    { id: 'sum',     type: 'llm',      label: 'Summarize',      config: { mode: 'summarize', instructions: 'Summarize the email.' } },
    { id: 'compose', type: 'assemble', label: 'Compose digest', config: { title: 'Daily digest' } },
    { id: 'post',    type: 'deliver',  label: 'Save',           config: { channel: 'in_app', title: 'Email Summary' } },
  ],
  edges: [{ from: 'sum', to: 'compose' }, { from: 'compose', to: 'post' }],
});

/** The event log is written fire-and-forget; give it a moment, then read the lines. */
async function readLog() {
  const file = join(LOG_DIR, 'atlas-events.log');
  for (let i = 0; i < 40 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 25));
  await new Promise(r => setTimeout(r, 100));
  const raw = await readFile(file, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * Drive a build to completion. `sufficiency` and `onWalkthrough` let a scenario steer
 * which of the six routes into `generate` actually fires.
 */
async function drive({ threadId, sufficiency = () => ({ complete: true }), onWalkthrough = () => ({ type: 'accept' }) }) {
  let suffCalls = 0;
  const llm = { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1',
      statement: 'Every incoming email is summarized into the Atlas inbox.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Email Summary' }] }] });
    if (p.includes('What starts this workflow')) return J({ trigger: { type: 'email', filter: 'is:unread' } });
    if (p.includes('CONCRETE example cases'))    return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))      return J(sufficiency(++suffCalls));
    if (p.includes('write the PLAN the user will approve')) return J(PLAN);
    if (p.includes('cases nobody has decided about')) {
      const ids = [...p.matchAll(/^ {2}- id: (\S+)$/gm)].map(m => m[1]);
      return J({ suggestions: ids.map(id => ({ gapId: id, answer: 'retry then tell a person' })) });
    }
    if (p.includes('Build the COMPLETE workflow')) return J(SPEC());
    return J({});
  } };

  const conv = createConverger({ llm, capabilities: CAPS(), invokeCapability: null, checkpointerDir: scratch() });
  const replyFor = (iv) => {
    switch (iv.type) {
      case 'outcome_check':      return { id: 'c1' };
      case 'plan_review':        return { type: 'accept' };
      case 'clarification':      return { answer: 'retry then tell a person' };
      case 'proposal':           return { type: 'approve' };
      case 'generated_workflow': return onWalkthrough(iv);
      case 'ratify':             return { type: 'approve' };
      default:                   return { type: 'accept' };
    }
  };
  let iv;
  try { await conv.run(threadId, 'summarize my emails to my inbox'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 60 && iv?.type !== 'done'; i++) iv = await conv.resume(threadId, replyFor(iv));
  return iv;
}

describe('every whole-spec rebuild is attributable from the log alone', () => {
  test('each pass names the build, the tenant and the route that ordered it', async () => {
    // One walkthrough revise (an explicit user change) plus the automatic routes the
    // tail drives, so several different callers are exercised in one run.
    let revised = false;
    await drive({
      threadId: 'attr-1',
      sufficiency: (n) => (n === 1 ? { complete: false, missing: 'a step that lays out the digest' } : { complete: true }),
      onWalkthrough: () => (revised ? { type: 'accept' } : (revised = true, { type: 'modify', modification: 'also cc my manager' })),
    });

    const passes = (await readLog()).filter(e => e.kind === 'converger.generate_pass' && e.thread === 'attr-1');
    assert.ok(passes.length >= 3,
      `this scenario must run several whole-spec passes to be a test of attributing them; it ran ${passes.length}`);

    for (const p of passes) {
      assert.equal(p.thread, 'attr-1',
        'a pass line that cannot name the build is unreadable the moment two people build at once — which is exactly when it is needed');
      assert.ok('tenant' in p,
        'the line must carry a tenant field so spend and looping are answerable per customer');
      assert.notEqual(p.route, 'unattributed',
        `a whole-spec rebuild was ordered by a route that did not say why (step ${p.step}) — that is the hole this closes`);
      assert.ok(typeof p.route === 'string' && p.route.length > 0, 'every pass must carry a route label');
      assert.equal(typeof p.round, 'number', 'the line must say how much of the rebuild budget had been spent');
      assert.equal(typeof p.regeneration, 'boolean', 'a first build and a rebuild must be tellable apart');
    }
  });

  test('the FIRST build and the rebuilds are labelled differently', async () => {
    await drive({
      threadId: 'attr-2',
      sufficiency: (n) => (n === 1 ? { complete: false, missing: 'a step that lays out the digest' } : { complete: true }),
    });
    const passes = (await readLog()).filter(e => e.kind === 'converger.generate_pass' && e.thread === 'attr-2');
    assert.ok(passes.length >= 2, 'need a first build and at least one rebuild');
    assert.equal(passes[0].regeneration, false, 'the first build is not a regeneration and must not read as one');
    assert.equal(passes[0].route, 'first_build');
    assert.ok(passes.slice(1).every(p => p.regeneration === true),
      'every pass after the first is a rebuild and must be counted as one');
  });

  test('the sufficiency check — the biggest unlogged driver on the record — now says so, with what it wanted', async () => {
    await drive({
      threadId: 'attr-3',
      sufficiency: (n) => (n === 1 ? { complete: false, missing: 'a step that lays out the digest' } : { complete: true }),
    });
    const passes = (await readLog()).filter(e => e.kind === 'converger.generate_pass' && e.thread === 'attr-3');
    const suff = passes.find(p => p.route === 'sufficiency');
    assert.ok(suff, 'the "is this workflow finished?" rebuild is still invisible in the log');
    assert.match(String(suff.detail ?? ''), /lays out the digest/,
      'knowing THAT it asked for a rebuild is not enough — the log must say what it said was missing, or the next occurrence costs another round to diagnose');
  });

  test('a user asking for a change is distinguishable from the builder looping on its own', async () => {
    // A person waiting nine minutes wants to know whether they caused it. An automatic
    // rebuild and a requested one must never be counted as the same thing.
    let revised = false;
    await drive({
      threadId: 'attr-4',
      onWalkthrough: () => (revised ? { type: 'accept' } : (revised = true, { type: 'modify', modification: 'also cc my manager' })),
    });
    const passes = (await readLog()).filter(e => e.kind === 'converger.generate_pass' && e.thread === 'attr-4');
    const user = passes.find(p => p.route === 'user_change_request');
    assert.ok(user, 'a rebuild the USER asked for is not distinguishable from one the builder chose');
    assert.match(String(user.detail ?? ''), /cc my manager/, 'what the user actually asked for must be on the line');
  });

  test('the repairs the pass was told about are on its line', async () => {
    // The other half of the fix is only checkable if the log says whether a pass was
    // handed the previous repair. Without it, "did the amnesia fix reach this build?"
    // is unanswerable after the fact.
    await drive({
      threadId: 'attr-5',
      sufficiency: (n) => (n === 1 ? { complete: false, missing: 'a step that lays out the digest' } : { complete: true }),
    });
    const passes = (await readLog()).filter(e => e.kind === 'converger.generate_pass' && e.thread === 'attr-5');
    const withRepairs = passes.filter(p => Array.isArray(p.repairs) && p.repairs.length);
    assert.ok(withRepairs.length, 'no pass recorded which repairs it was shown');
    assert.ok(withRepairs.some(p => p.repairs.includes('DIGEST_MISSING_SECTIONS')),
      'the repair the live builds re-introduced on every pass is not named on the line that carried it');
  });

  test('the older rebuild-decision lines can name their build too', async () => {
    // `converger.regen` / `regen_skipped` / `regen_noop` record the decision NOT to
    // rebuild, or a rebuild that changed nothing. They carried no ids at all, so on a
    // shared server they belonged to nobody.
    await drive({ threadId: 'attr-6' });
    const log = await readLog();
    const decisions = log.filter(e => ['converger.regen', 'converger.regen_skipped', 'converger.regen_noop'].includes(e.kind));
    assert.ok(decisions.length, 'the scenario produced no rebuild-decision lines to check');
    for (const d of decisions) {
      assert.ok('thread' in d && 'tenant' in d,
        `${d.kind} still cannot be attributed to a build — on a shared server it is noise`);
    }
  });
});

describe('a seventh route cannot be added without saying why it rebuilds', () => {
  test('every route that sends the build back to generate sets a reason', async () => {
    // A COMPLETENESS TRIPWIRE, not a behaviour check — the behaviour is pinned above.
    // Six routes set `phase:'proposing'`, which the graph's edges map to `generate`.
    // The next person to add a seventh will not know that, so this fails loudly rather
    // than letting a silent rebuild path back in.
    const src = await readFile(join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');
    const lines = src.split('\n');
    const missing = [];
    lines.forEach((line, i) => {
      if (!/phase:\s*'proposing'/.test(line)) return;
      if (/^\s*\/\//.test(line)) return;                       // a comment about the route, not a route
      // The reason may sit on the same object literal, a few lines either side.
      const window = lines.slice(Math.max(0, i - 12), i + 12).join('\n');
      if (!/_regenReason/.test(window)) missing.push(i + 1);
    });
    assert.deepEqual(missing, [],
      `these lines route the build back into the expensive whole-spec rebuild without recording why: ${missing.join(', ')}`);
  });
});
