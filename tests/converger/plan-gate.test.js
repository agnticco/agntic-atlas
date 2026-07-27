/**
 * The PRE-BUILD PLAN GATE (agent-contracts increment 1).
 *
 * Drives `createConverger` → run → resume the way builder.js does, proving:
 *   · a `plan_review` interrupt fires ONCE, BEFORE the first build, carrying the plan
 *     projection and a pre-selected default (the zero-typing accept path);
 *   · approving it converges to a spec (the plan does not block the build);
 *   · it fires EXACTLY ONCE — never again on the silent regenerations the tail drives;
 *   · FAIL-SAFE: when the projection is unusable (the stub returns {}), no plan_review
 *     is raised and the build proceeds unchanged — which is why all pre-existing
 *     converger tests (whose stubs return {} for this prompt) keep their behaviour.
 *
 * Plus the grounding block of the plan prompt, including the ONE rule that survived the
 * removal of the plan card's marks on 2026-07-27: the plan must NOT announce that Atlas
 * will create a channel the tenant does not have. That decision belongs to the
 * create-or-pick conversation, after the build. This file and
 * `tests/converger/plan-grounding-prompt.test.js` are the only two places that pin it.
 */

import { test, describe, after } from 'node:test';
import assert                    from 'node:assert/strict';
import { mkdtempSync, rmSync }   from 'node:fs';
import { tmpdir }                from 'node:os';
import { join }                  from 'node:path';

import { createConverger } from '../../src/converger/index.js';
import { buildPlanPrompt } from '../../src/converger/prompts.js';
import { realCatalog }     from '../helpers/catalog.js';

const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-plan-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

const J = (o) => ({ content: JSON.stringify(o) });

const CAPS = () => ({
  channels: realCatalog().getAll().map(c => ({ ...c, available: true })),
  connectors: { slack: { connected: true }, airtable: { connected: false } },
  slackChannels: ['ops', 'general'],
});

// A stub model that builds a simple linear email → summarize → inbox workflow, and —
// crucially — answers the PLAN projection prompt with a real, readable plan.
const PLAN = {
  summary: 'Summarize each incoming email into your Atlas inbox',
  trigger: { text: 'A new email arrives in your Gmail' },
  steps: [{ text: 'Summarize the email' }],
  branches: [],
  error_handling: { text: 'Retry once, then flag it to you' },
  knowledge: [],
  upload_suggestion: null,
};

function makeLLM({ planResponse } = {}) {
  return { invoke: async (msgs) => {
    const p = String(msgs[msgs.length - 1].content);
    if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1',
      statement: 'Every incoming email is summarized into the Atlas inbox.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Email Summary' }] }] });
    if (p.includes('What starts this workflow')) return J({ trigger: { type: 'email', filter: 'is:unread' } });
    if (p.includes('CONCRETE example cases'))    return J({ examples: [] });
    if (p.includes('Analyze this automation intent')) return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
    if (p.includes('write the PLAN the user will approve')) return planResponse ?? J(PLAN);
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

/** Drive the loop; collect every interrupt seen. `onPlan` picks the reply to plan_review. */
async function drive({ llm, onPlan = () => ({ type: 'accept' }) }) {
  const conv = createConverger({ llm, capabilities: CAPS(), invokeCapability: null, checkpointerDir: scratch() });
  const seen = [];
  const replyFor = (iv) => {
    switch (iv.type) {
      case 'outcome_check': return { id: 'c1' };
      case 'plan_review':   return onPlan(iv);
      case 'clarification': return { answer: 'retry then tell a person' };
      case 'proposal':      return { type: 'approve' };
      case 'ratify':        return { type: 'approve' };
      default:              return { type: 'accept' };
    }
  };

  let iv;
  try { await conv.run('g1', 'summarize my emails to my inbox'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 60 && iv?.type !== 'done'; i++) {
    seen.push(iv);
    iv = await conv.resume('g1', replyFor(iv));
  }
  return { spec: iv?.spec ?? null, seen };
}

describe('the plan gate fires once, before the build, and does not block it', () => {
  test('a plan_review interrupt is raised carrying a readable plan', async () => {
    let planIv = null;
    const { spec } = await drive({ llm: makeLLM(), onPlan: (iv) => { planIv = iv; return { type: 'accept' }; } });
    assert.ok(planIv, 'a plan_review interrupt must be surfaced before the build');
    assert.ok(planIv.plan && Array.isArray(planIv.plan.steps) && planIv.plan.steps.length,
      'the interrupt MUST carry a plan with at least one step');
    assert.equal(planIv.plan.trigger.text, 'A new email arrives in your Gmail',
      'the line the TRIGGER row draws must survive the trip');
    assert.equal(planIv.plan.steps[0].text, 'Summarize the email');
    assert.equal(planIv.plan.error_handling.text, 'Retry once, then flag it to you');
    // Every interrupt carries a default so Enter is always valid (§11.9).
    assert.ok(Array.isArray(planIv.choices) && planIv.choices.some(c => c.selected),
      'the plan interrupt must carry a pre-selected default choice');
    assert.ok(spec, 'approving the plan converges to a spec');
  });

  test('the plan is shown EXACTLY ONCE — never on the tail regenerations', async () => {
    const { seen, spec } = await drive({ llm: makeLLM() });
    const planCount = seen.filter(iv => iv.type === 'plan_review').length;
    assert.equal(planCount, 1, `plan_review must fire exactly once; fired ${planCount} times`);
    assert.ok(spec, 'converged');
  });

  test('the approved plan reaches the build (spec is produced)', async () => {
    const { spec } = await drive({ llm: makeLLM() });
    assert.ok(spec && Array.isArray(spec.nodes) && spec.nodes.length, 'a built spec is returned');
  });
});

describe('the grounding pass surfaces live connector facts in the plan (increment 2)', () => {
  const outcome = { statement: 's', assertions: [
    { kind: 'message_sent', target: 'slack:#support' },
    { kind: 'message_sent', target: 'slack:#sales' },
  ] };

  // CHANGED 2026-07-26. This used to assert `/Atlas will CREATE the channel/` — it was
  // pinning the instruction that manufactured the false "YOU SAID" mark a tester saw on
  // the line "Atlas will create the #ops channel". Naming a channel is not saying what
  // should happen when it doesn't exist, and that question is asked properly after the
  // build (create-or-pick). The check is not weakened: it pins the honest contract, and
  // the full argument plus the anti-regression cases live in plan-grounding-prompt.test.js.
  // RE-POINTED 2026-07-27 when the plan card's marks were removed: the `confidence`
  // half of these assertions went with the feature; the create-or-pick rule did NOT,
  // and this is one of only two places pinning it.
  test('a channel that EXISTS is described as existing; one that does NOT is left undecided', () => {
    const p = buildPlanPrompt({ intent: 'x', outcome, triggers: [],
      grounding: { slack: { checked: true, known: ['#support'], absent: ['#sales'] } } });
    assert.match(p, /EXIST in the connected workspace: #support/);
    assert.match(p, /say it posts to the EXISTING channel/);
    assert.match(p, /do NOT exist in the workspace yet: #sales/);
    assert.match(p, /Do NOT state that Atlas will create it/);
    assert.doesNotMatch(p, /Atlas will CREATE the channel/);
  });

  test('no grounding block is emitted when nothing could be verified (no live list)', () => {
    const p = buildPlanPrompt({ intent: 'x', outcome, triggers: [] });
    assert.doesNotMatch(p, /GROUNDING — verified live/);
  });

  test('an Airtable write is grounded with the REAL table + columns from the live schema', () => {
    const p = buildPlanPrompt({ intent: 'x',
      outcome: { statement: 's', assertions: [{ kind: 'record_exists', target: 'airtable:Leads' }] },
      triggers: [],
      grounding: { airtable: { base: 'CRM', table: 'Leads', columns: ['Name', 'Email', 'Budget'] } } });
    assert.match(p, /base "CRM" has a table "Leads"/);
    assert.match(p, /columns: Name, Email, Budget/);
    assert.match(p, /name the REAL table and its columns in the step text/);
  });
});

describe('FAIL-SAFE: an unusable projection skips the gate, never blocks the build', () => {
  test('when the plan projection returns {}, no plan_review is raised and the build proceeds', async () => {
    const { seen, spec } = await drive({ llm: makeLLM({ planResponse: J({}) }) });
    const planCount = seen.filter(iv => iv.type === 'plan_review').length;
    assert.equal(planCount, 0, 'an empty projection must NOT raise a plan_review interrupt');
    assert.ok(spec, 'the build still converges to a spec (fail-safe skip)');
  });
});
