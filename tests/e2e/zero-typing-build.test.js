/**
 * THE ZERO-TYPING PATH — P12 Increment G's gate. (§11.9)
 *
 * v2 elicits STRICTLY MORE than v1 — an outcome contract, worked examples, decision
 * tables, exception paths. If that arrives as a 40-question interrogation it kills
 * activation, and a v2 that elicits more but converts LESS is a net loss. Prod today
 * is 5 signups, 1 workflow, 0 subscriptions; activation is the actual business
 * problem.
 *
 * The property that makes the extra rigour affordable: **every interrupt carries a
 * pre-selected default, and the default for every unknown is "escalate to a
 * person"** (§7) — which is safe, correct and honest. So a user can publish a
 * PROVABLY-COMPLETE workflow having answered NOTHING: the gaps become a backlog that
 * fills in as real escalations arrive, not a wall that blocks the save button.
 *
 * This test proves that end to end: drive the whole converger answering EVERY
 * interrupt with its default (`runHeadless`'s autoRespond — the same defaults the UI
 * pre-selects), and require the result to be a spec that PUBLISHES. If a defaults-
 * only build ever produced an unpublishable spec, the "Accept all defaults" button
 * would be a lie, and the whole activation story with it.
 *
 * Real model (self-skips without a key; the gate sets one and fails closed on a skip,
 * so this cannot pass un-run).
 */

import { test, before, after } from 'node:test';
import assert                  from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir }              from 'node:os';
import { join }                from 'node:path';

import { runHeadless }              from '../../src/converger/index.js';
import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { scoreGap }                 from '../../src/converger/gap-scorer.js';
import { realCatalog }              from '../helpers/catalog.js';
import { ChatModel }                from '../../src/llm/chat-model.js';
import { ModelPool }                from '../../src/llm/model-pool.js';

const NEED_KEY = !process.env.ANTHROPIC_API_KEY;

// The same tiered LLM the server builds (buildLLM), so the converger sees the model
// tiers it expects — `fast`/`balanced` per tierCfg — rather than a bare ChatModel
// that ignores the tier config.
function buildTestLLM() {
  const key = process.env.ANTHROPIC_API_KEY.trim();
  const fast     = new ChatModel({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: key });
  const balanced = new ChatModel({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: key });
  return new ModelPool({ tiers: { fast, balanced, powerful: balanced }, defaultTier: 'balanced' });
}

let tmp, llm, catalog, CAPS, validator;
before(() => {
  tmp     = mkdtempSync(join(tmpdir(), 'atlas-zt-'));
  catalog = realCatalog();
  CAPS    = { channels: catalog.getAll().map(c => ({ ...c, available: true })) };
  validator = new WorkflowValidator({ nodeTypes: registerBuiltInNodeTypes(new NodeTypeRegistry()), channelRegistry: catalog });
  if (!NEED_KEY) llm = buildTestLLM();
});
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test('a build answered entirely by defaults yields a PUBLISHABLE spec (§11.9)', { skip: NEED_KEY ? 'requires ANTHROPIC_API_KEY (runs on VPS + in the gate)' : false }, async () => {
  const { spec, confirmationLog } = await runHeadless({
    intent: 'When a customer emails support@acme.com, summarize it and post the summary to Slack #support.',
    capabilities: CAPS,
    llm,
    checkpointerDir: join(tmp, 'converger'),
  });

  assert.ok(spec, 'the converger returned a spec');

  // ── IT PUBLISHES ──────────────────────────────────────────────────────────
  // The whole point: a defaults-only build is not a draft with holes, it is a
  // finished, savable workflow. Validate it the way PUBLISH does (real catalog).
  const res = validator.validate(spec);
  assert.equal(res.ok, true,
    `a defaults-only build must publish; got: ${res.errors.map(e => `${e.code}: ${e.message}`).join(' | ')}`);

  // ── AND THE CONVERGER CERTIFIES IT — complete ⇒ publishable ───────────────
  const { complete, gaps } = scoreGap(spec, { capabilities: CAPS });
  assert.equal(complete, true,
    `unanswered: ${gaps.filter(g => g.resolution === 'unanswered').map(g => g.code).join(', ')}`);

  // ── IT DELIVERS ON ITS OWN CONTRACT ───────────────────────────────────────
  // A publishable spec with an empty outcome would pass the two checks above and
  // still be a workflow that promises nothing. §11.9 is about a REAL build.
  assert.ok(spec.outcome && Array.isArray(spec.outcome.assertions) && spec.outcome.assertions.length >= 1,
    'the build produced an outcome contract with at least one assertion');
  assert.ok(spec.nodes.some(n => n.type === 'deliver' || (n.type === 'connector-action')),
    'and a step that actually does something');

  // ── EVERY UNKNOWN DEFAULTED TO ESCALATE, HONESTLY ─────────────────────────
  // The gap review ran, and the defaults resolved it — that is what "Accept all
  // defaults" does, and it is why the spec above is publishable rather than a wall.
  const gapReview = (confirmationLog ?? []).find(e => e.type === 'gap_review');
  assert.ok(gapReview, 'the build reached the gap review — it did not skip the rigour, it defaulted through it');
});
