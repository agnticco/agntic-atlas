/**
 * elicitation-graph — the converger's StateGraph.
 *
 * Nodes:
 *   analyze   → decide: clarify (vague intent) or propose (enough signal)
 *   clarify   → ask one targeted question, interrupt for answer
 *   propose   → generate next component proposal, interrupt for confirmation
 *   ratify    → present complete draft for final HITL approval
 *
 * Routing:
 *   analyze → clarify | propose | ratify
 *   clarify → analyze
 *   propose → analyze
 *   ratify  → propose (if changes requested) | END (if approved)
 *
 * Persistence: FileCheckpointer — sessions survive restarts and are resumable
 * by threadId.
 */

import { StateGraph, END }   from '../graph/index.js';
import { FileCheckpointer }  from '../graph/checkpointer/index.js';
import { interrupt }         from '../graph/interrupt.js';
import { SystemMessage, HumanMessage } from '../core/message.js';
import { scoreGap, unansweredGaps } from './gap-scorer.js';
import { applyProposal, assembleSpec } from './spec-assembler.js';
import { materialiseEscalations } from './escalation.js';
import { nodeForAssertion, assertableConnectors, splitTarget } from '../workflows/outcome-oracle.js';
import {
  buildSystemPrompt,
  buildAnalyzePrompt,
  buildProposePrompt,
  buildModifyPrompt,
  buildOutcomePrompt,
  buildExamplesPrompt,
  buildGapPrompt,
  buildSufficiencyPrompt,
} from './prompts.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip markdown fences and extract raw JSON from LLM output. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const obj = text.match(/(\{[\s\S]*\})/);
  if (obj) return obj[1].trim();
  return text.trim();
}

async function llmJson(llm, messages, config = {}) {
  const res = await llm.invoke(messages, config);
  try {
    return JSON.parse(extractJson(typeof res === 'string' ? res : res.content));
  } catch {
    return null;
  }
}

export const DRAFT_DEFAULT = {
  name:          null,
  description:   null,
  outcome:       null,      // P12 Increment C — the contract this workflow is held to
  triggers:      [],
  nodes:         [],
  edges:         [],
  errorHandling: {},
};

// ── Tier config helper ────────────────────────────────────────────────────────
// Build an invoke config that routes through ModelPool to the requested tier.
// Always call llm.invoke(messages, tierCfg(name, sessionId)) rather than
// extracting a raw ChatModel — this keeps _trackUsage() in the call path so
// cost records are emitted for every converger turn.

function tierCfg(tierName, sessionId) {
  return { configurable: { modelTier: tierName, sessionId, costContext: 'converger' } };
}

// ── Graph builder ─────────────────────────────────────────────────────────────

/**
 * @param {{ llm: ModelPool, checkpointerDir?: string }} opts
 * @returns {CompiledGraph}
 */
export function buildElicitationGraph({ llm, checkpointerDir = './memory/converger' }) {
  const graph = new StateGraph({
    stateSchema: {
      // Plain defaults (no reducer — replacement semantics)
      intent:       '',
      capabilities: {},
      draft:        null,
      step:         0,
      phase:        'outcome',
      spec:         null,
      _pendingQuestion: null,

      // P12 Increment C. Both are LOOP BOUNDS, not bookkeeping: a gap the model
      // cannot close would otherwise spin to the recursion limit and die with a
      // stack trace instead of asking the user a question.
      proposeRounds:     0,
      gapRounds:         0,
      sufficiencyChecks: 0,
      _missingNote:      null,
      // Gaps the user (or the default) sent to a human rather than answering.
      // Kept in STATE and persisted to the interaction store — never in the spec.
      // It is provenance, and it feeds the SOP: "these cases were not decided;
      // they go to a person."
      escalatedGaps: {
        default: [],
        reducer: (prev, additions) => [...(prev ?? []), ...(additions ?? [])],
      },

      // Accumulator fields (reducer: append)
      clarifications: {
        default:  [],
        reducer:  (prev, additions) => [...(prev ?? []), ...(additions ?? [])],
      },
      confirmationLog: {
        default:  [],
        reducer:  (prev, additions) => [...(prev ?? []), ...(additions ?? [])],
      },
      // Setup results: resources created before the workflow runs (e.g. Drive folders).
      // Keyed by stores_as; each value is the action result. Merged, never replaced.
      setup_results: {
        default: {},
        reducer: (prev, next) => ({ ...(prev ?? {}), ...(next ?? {}) }),
      },
    },
  });

  // ── outcome ────────────────────────────────────────────────────────────────
  // "How would we know this worked?"  (P12 Increment C)
  //
  // FIRST, before any node is proposed — because the outcome is what every later
  // turn is measured against. v1 started from the STEPS, which is why it could
  // agree to post to Slack AND email the team, build only the Slack step, and
  // have nothing in the system notice: no part of the spec ever said what the
  // finished workflow was supposed to produce.
  //
  // The user RECOGNISES rather than RECALLS: 2-3 candidate contracts, the most
  // likely pre-selected. Pressing Enter is a valid answer (converger-v2 §6.2).
  graph.addNode('outcome', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;

    const sysmsg  = new SystemMessage(buildSystemPrompt(state.capabilities));
    const usermsg = new HumanMessage(buildOutcomePrompt({
      intent: state.intent, capabilities: state.capabilities,
    }));
    const parsed = await llmJson(llm, [sysmsg, usermsg], tierCfg('balanced', sessionId));

    // A CONTRACT MAY ONLY PROMISE WHAT THIS TENANT CAN ACTUALLY DELIVER.
    //
    // Asked to "make my business better", the model invented an assertion against
    // `airtable:business improvements` for a tenant with no Airtable connected.
    // That promise can never be satisfied by any node, so the spec can never
    // publish — and the user is left in a dead end, having been told the system
    // understood them. A model asked for a contract will always produce one; the
    // prompt cannot be the guarantee, so the code is.
    //
    // Filtering CANDIDATES is not the same sin as dropping an ASSERTION: nothing
    // has been agreed yet. A candidate is a guess, and a guess we know to be
    // unfulfillable is one we must not offer. If that leaves nothing to offer, we
    // ASK — which is the honest answer to an intent we cannot serve.
    const canPromise = assertableConnectors(state.capabilities);
    const unreachable = new Set();                   // connectors we had to refuse
    const offerable  = (parsed?.candidates ?? []).filter(c => {
      if (!c?.statement) return false;
      if (!canPromise.size) return true;             // unknown catalog — nothing to check against
      const bad = (c.assertions ?? []).filter(a => {
        const { connector } = splitTarget(a?.target);
        return connector && !canPromise.has(connector);
      });
      for (const a of bad) unreachable.add(splitTarget(a.target).connector);
      return bad.length === 0;
    });

    const candidates = offerable;

    // AND THE USER IS TOLD WHAT WE REFUSED TO PROMISE.
    //
    // Filtering a candidate is legitimate — nothing was agreed yet. Filtering it
    // WITHOUT SAYING SO is defect #1 relocated from the spec into the candidate
    // list: the user asked for Notion, a Notion-less candidate was quietly
    // offered instead, and nobody ever mentioned Notion again. The whole point of
    // this increment is that a request is never dropped in silence.
    // (Found by the independent verifier.)
    const notice = unreachable.size
      ? `I can't include ${[...unreachable].join(' or ')} — ${unreachable.size > 1 ? 'those connectors are' : 'that connector is'} not connected, so I won't promise something the workflow can't actually do. Connect ${unreachable.size > 1 ? 'them' : 'it'} and I'll add it.`
      : null;
    if (!candidates.length) {
      // No contract could be drawn from the intent. Do NOT invent one — an
      // outcome nobody agreed to is worse than none, because every later turn is
      // then measured against a guess, and the user is told their workflow meets
      // a promise they never made. Ask instead.
      //
      // After two attempts, fall back to the v1 path with NO outcome rather than
      // dead-ending: a spec with no outcome is still a perfectly runnable v1 spec
      // (§8 — absent version ⇒ 1), so the user gets their workflow. They lose the
      // contract check, which is a real loss; they do not lose the product.
      if ((state.clarifications ?? []).length >= 2) {
        return { draft: { ...state.draft, outcome: null }, phase: 'analyzing' };
      }
      const q = notice
        ? `${notice} What should this workflow do with what IS connected?`
        : 'What should be true once this has run? (e.g. "every UPS email is summarized into #logistics")';
      const answer = await interrupt({ type: 'clarification', question: q, step: state.step });
      return {
        clarifications:  [{ q, a: answer?.answer ?? String(answer) }],
        confirmationLog: [{ step: state.step, type: 'clarification', question: q, answer }],
        step:  state.step + 1,
        phase: 'outcome',
      };
    }

    const confirmation = await interrupt({
      type:       'outcome_check',
      candidates,
      notice,                                         // what we refused to promise, and why

      // Every interrupt carries a default (§11.9). The first candidate is the
      // model's best guess, and it is pre-selected.
      choices:    candidates.map((c, i) => ({
        id: c.id ?? `c${i + 1}`, label: c.statement,
        hint: (c.assertions ?? []).map(a => `${a.kind} → ${a.target}`).join(' · '),
        selected: i === 0,
      })),
      step: state.step,
    });

    const pickedId = confirmation?.id ?? confirmation?.choice ?? candidates[0].id ?? 'c1';
    let picked = candidates.find((c, i) => (c.id ?? `c${i + 1}`) === pickedId) ?? candidates[0];

    // "Close, but…" — merge the correction rather than starting over.
    if (confirmation?.type === 'modify' && confirmation.modification) {
      const merged = await llmJson(llm, [
        new SystemMessage(buildSystemPrompt(state.capabilities)),
        new HumanMessage(buildModifyPrompt({ original: picked, modification: confirmation.modification })),
      ], tierCfg('fast', sessionId));
      if (merged?.statement) picked = merged;
    }

    const outcome = {
      statement:  picked.statement,
      assertions: (picked.assertions ?? []).map((a, i) => ({ ...a, id: a.id ?? `a${i + 1}` })),
      examples:   [],
    };

    return {
      draft: { ...state.draft, outcome },
      confirmationLog: [{ step: state.step, type: 'outcome_check', outcome, confirmation }],
      step:  state.step + 1,
      phase: 'examples',
    };
  });

  // ── examples ───────────────────────────────────────────────────────────────
  // "Show me a case." The SME's rows — which become the ACCEPTANCE SUITE, not
  // just colour. Skipping is one click and is a legitimate answer.
  //
  // The example PICKER (pull three real emails from the user's actual inbox via
  // gmail_search, and let them click) is Increment F. Until then this offers the
  // model's proposed cases and a skip, and never demands typing.
  graph.addNode('examples', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;

    const parsed = await llmJson(llm, [
      new SystemMessage(buildSystemPrompt(state.capabilities)),
      new HumanMessage(buildExamplesPrompt({ intent: state.intent, outcome: state.draft?.outcome })),
    ], tierCfg('fast', sessionId));

    const proposed = (parsed?.examples ?? []).filter(e => e?.given);
    if (!proposed.length) return { phase: 'process' };

    const confirmation = await interrupt({
      type:        'example_request',
      source:      null,               // Increment F fills this from a live connector
      items:       proposed.map((e, i) => ({ id: e.id ?? `e${i + 1}`, preview: e.label ?? JSON.stringify(e.given), raw: e })),
      allowManual: true,
      allowSkip:   true,
      choices:     proposed.map((e, i) => ({ id: e.id ?? `e${i + 1}`, label: e.label ?? JSON.stringify(e.given), selected: true })),
      step:        state.step,
    });

    // Default (skip, or Enter) keeps every proposed example: they cost nothing,
    // they are the test suite, and a user who does not care should still get one.
    const keepIds = Array.isArray(confirmation?.ids) ? new Set(confirmation.ids) : null;
    const kept = confirmation?.type === 'skip' ? []
               : keepIds ? proposed.filter((e, i) => keepIds.has(e.id ?? `e${i + 1}`))
               : proposed;

    return {
      draft: { ...state.draft, outcome: { ...(state.draft?.outcome ?? {}), examples: kept } },
      confirmationLog: [{ step: state.step, type: 'example_request', examples: kept, confirmation }],
      step:  state.step + 1,
      phase: 'process',
    };
  });

  // ── process ────────────────────────────────────────────────────────────────
  // Backward-chain the graph from the assertions. Non-interactive, no LLM call.
  //
  // Every assertion whose satisfying node is UNAMBIGUOUS gets built directly —
  // "post to #logistics" has exactly one shape, and asking a model to invent it
  // is a paid round-trip that can only get it wrong. This is also what keeps the
  // contract and the spec in agreement BY CONSTRUCTION: the delivery node is
  // derived FROM the assertion, so it cannot target a different channel than the
  // one the user just confirmed.
  //
  // Where the shape is not derivable (an Airtable write needs a base and a table
  // — Increment F reads those from the connector), nothing is invented: the
  // assertion simply stays an open gap and the propose loop fills it.
  graph.addNode('process', async (state) => {
    const draft = state.draft ?? { ...DRAFT_DEFAULT };
    const assertions = draft.outcome?.assertions ?? [];
    if (!assertions.length) return { phase: 'analyzing' };

    const nodes = [...(draft.nodes ?? [])];
    const derived = [];
    for (const a of assertions) {
      const node = nodeForAssertion(a, { capabilities: state.capabilities });
      if (!node) continue;
      if (nodes.some(n => n.id === node.id)) continue;
      nodes.push(node);
      derived.push({ assertionId: a.id, nodeId: node.id });
    }
    if (!derived.length) return { phase: 'analyzing' };

    return {
      draft: { ...draft, nodes },
      confirmationLog: [{ step: state.step, type: 'process', derived }],
      step:  state.step + 1,
      phase: 'analyzing',
    };
  });

  // ── analyze ────────────────────────────────────────────────────────────────
  // Check gap and intent clarity. Decide what to do next.
  // Hard cap: after MAX_CLARIFICATIONS rounds, always proceed — the converger
  // must not get stuck asking questions when answers are vague.
  const MAX_CLARIFICATIONS = 2;

  // The propose loop must terminate. A gap the model cannot close (a connector
  // that isn't connected, a template it keeps getting wrong) would otherwise
  // spin until the recursion limit and die with a stack trace instead of a
  // question. After this many rounds we stop guessing and ASK — which is the
  // honest move, and the one the user can actually act on.
  const MAX_PROPOSE_ROUNDS = 14;

  // How many times the model may say "not finished yet" once the gap floor is
  // already met. Bounded, because a model asked "is it done?" will always find
  // something to add if you let it.
  const MAX_SUFFICIENCY_CHECKS = 4;

  graph.addNode('analyze', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;
    const gap = scoreGap(state.draft, { capabilities: state.capabilities });

    if (gap.complete) {
      // THE FLOOR IS MET: the spec is valid and it delivers everything the
      // outcome promises. But the outcome cannot express every transformation —
      // "a summary of the email" and "the email" reach Slack as the same
      // assertion. So the intent gets the last word, once, and only to add a
      // component it can NAME. (v1 instead demanded a "processing" node from a
      // hardcoded checklist, and invented one for workflows that needed none —
      // defect #4. Here "finished" is the default answer, not the exception.)
      if ((state.sufficiencyChecks ?? 0) >= MAX_SUFFICIENCY_CHECKS) return { phase: 'gapping' };

      const verdict = await llmJson(llm, [
        new SystemMessage(buildSystemPrompt(state.capabilities)),
        new HumanMessage(buildSufficiencyPrompt({ intent: state.intent, draft: state.draft })),
      ], tierCfg('fast', sessionId));

      if (verdict?.complete === false && verdict.missing) {
        return {
          phase:             'proposing',
          proposeRounds:     (state.proposeRounds ?? 0) + 1,
          sufficiencyChecks: (state.sufficiencyChecks ?? 0) + 1,
          _missingNote:      String(verdict.missing),
        };
      }
      return { phase: 'gapping' };
    }

    if ((state.proposeRounds ?? 0) >= MAX_PROPOSE_ROUNDS) return { phase: 'gapping' };

    const clarificationCount = (state.clarifications ?? []).length;
    if (clarificationCount >= MAX_CLARIFICATIONS) return { phase: 'proposing' };

    const sysmsg = new SystemMessage(buildSystemPrompt(state.capabilities));
    const usermsg = new HumanMessage(buildAnalyzePrompt({
      intent:         state.intent,
      clarifications: state.clarifications,
      capabilities:   state.capabilities,
    }));
    const parsed = await llmJson(llm, [sysmsg, usermsg], tierCfg('fast', sessionId));

    if (parsed?.ready === false && parsed.question) {
      return { phase: 'clarifying', _pendingQuestion: parsed.question };
    }
    // analyze runs before every propose, so counting here counts propose rounds
    // exactly once each — without threading a counter through propose's five
    // return paths, where the next person to add a sixth would forget it.
    return { phase: 'proposing', proposeRounds: (state.proposeRounds ?? 0) + 1 };
  });

  // ── clarify ────────────────────────────────────────────────────────────────
  // Ask one focused question; interrupt for the user's answer.
  graph.addNode('clarify', async (state) => {
    const question = state._pendingQuestion ?? 'Could you tell me more about what you need?';

    const answer = await interrupt({ type: 'clarification', question, step: state.step });

    return {
      clarifications:  [{ q: question, a: answer?.answer ?? String(answer) }],
      confirmationLog: [{ step: state.step, type: 'clarification', question, answer }],
      step:            state.step + 1,
      phase:           'analyzing',
      _pendingQuestion: null,
    };
  });

  // ── propose ────────────────────────────────────────────────────────────────
  // Generate the next component proposal; interrupt for 3-way confirmation.
  graph.addNode('propose', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;
    const gap    = scoreGap(state.draft, { capabilities: state.capabilities });
    const sysmsg = new SystemMessage(buildSystemPrompt(state.capabilities));
    const usermsg = new HumanMessage(buildProposePrompt({
      intent:         state.intent,
      clarifications: state.clarifications,
      draft:          state.draft,
      gap,
      setupResults:   state.setup_results,
      missingNote:    state._missingNote,
    }));

    const proposal = await llmJson(llm, [sysmsg, usermsg], tierCfg('balanced', sessionId));

    // If the LLM returned unparseable output, surface it as a clarification
    // rather than silently skipping — guarantees we always interrupt so the
    // graph never tight-loops through analyze→propose without pausing.
    if (!proposal?.component) {
      const fallbackQ = 'I need a bit more detail to build the next step. Could you describe more specifically what should happen?';
      const answer = await interrupt({ type: 'clarification', question: fallbackQ, step: state.step });
      return {
        clarifications:  [{ q: fallbackQ, a: answer?.answer ?? String(answer) }],
        confirmationLog: [{ step: state.step, type: 'clarification', question: fallbackQ, answer }],
        step:            state.step + 1,
        phase:           'analyzing',
      };
    }

    // HITL: pause for accept / reject / modify / setup
    const confirmation = await interrupt({ type: 'proposal', proposal, step: state.step });

    const logEntry = { step: state.step, type: 'proposal', proposal, confirmation };

    // setup_action: create a resource before the workflow runs. Never applied to draft.
    if (proposal.component === 'setup_action') {
      if (confirmation?.type === 'setup_executed') {
        const key    = proposal.stores_as ?? 'setup_result';
        const result = confirmation.result ?? {};
        return {
          setup_results:   { [key]: result },
          clarifications:  [{ q: `(setup: ${proposal.capabilityId})`, a: JSON.stringify(result) }],
          confirmationLog: [logEntry],
          step:            state.step + 1,
          phase:           'analyzing',
        };
      }
      // skipped or rejected: continue without storing
      return {
        confirmationLog: [logEntry],
        step:            state.step + 1,
        phase:           'analyzing',
      };
    }

    let newDraft = state.draft;

    if (confirmation?.type === 'accept') {
      newDraft = applyProposal(state.draft, proposal, confirmation);
    } else if (confirmation?.type === 'modify') {
      // Apply modification: ask LLM to merge the user's override into the proposal
      const modSysmsg  = new SystemMessage(buildSystemPrompt(state.capabilities));
      const modUsermsg = new HumanMessage(buildModifyPrompt({
        original:     proposal,
        modification: confirmation.modification,
      }));
      const updated = await llmJson(llm, [modSysmsg, modUsermsg], tierCfg('fast', sessionId));
      const merged  = updated ?? proposal;
      newDraft = applyProposal(state.draft, merged, { type: 'accept' });
      logEntry.mergedProposal = merged;
      // Propagate the modification as a clarification so all future proposals
      // inherit this correction (e.g. a company name fix applies everywhere)
      return {
        draft:           newDraft,
        clarifications:  [{ q: `(user modified ${proposal.component})`, a: confirmation.modification }],
        confirmationLog: [logEntry],
        step:            state.step + 1,
        phase:           'analyzing',
      };
    }
    // reject: don't apply — LLM will re-propose on next iteration

    return {
      draft:           newDraft,
      confirmationLog: [logEntry],
      step:            state.step + 1,
      phase:           'analyzing',
    };
  });

  // ── gaps ───────────────────────────────────────────────────────────────────
  // "Here are the cases you haven't told me about."  (P12 Increment C)
  //
  // THE killer surface (converger-v2 §6.4). Every row is pre-filled with the
  // model's best answer and pre-selected to ESCALATE — so the user can publish a
  // provably-complete workflow having answered NOTHING, because the default
  // resolution for every unknown is "a person deals with it", which is safe,
  // correct and honest.
  //
  // This is the mechanism that lets v2 demand more rigour WITHOUT demanding more
  // typing. It is also the answer to defect #5 — the converger asked zero
  // exception questions, ever, because it had no shape to interrogate. Now it
  // has one.
  const MAX_GAP_ROUNDS = 1;

  graph.addNode('gaps', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;
    const result    = scoreGap(state.draft, { capabilities: state.capabilities });

    const blocking = unansweredGaps(result);                       // must be ANSWERED
    const soft     = result.gaps.filter(g => !g.blocking);         // may be ESCALATED

    if (!blocking.length && !soft.length) return { phase: 'ratifying' };

    // One cheap call so every row arrives with an answer already in it. A gap
    // list with empty boxes is an interrogation; a gap list with defaults is a
    // review. The difference is the whole product.
    const suggested = await llmJson(llm, [
      new SystemMessage(buildSystemPrompt(state.capabilities)),
      new HumanMessage(buildGapPrompt({ intent: state.intent, gaps: [...blocking, ...soft] })),
    ], tierCfg('fast', sessionId));
    const suggestionFor = (id) =>
      (suggested?.suggestions ?? []).find(s => s.gapId === id)?.answer ?? null;

    const confirmation = await interrupt({
      type: 'gap_review',
      gaps: [...blocking, ...soft].map(g => ({
        id: g.id, class: g.class, message: g.message, hint: g.hint,
        blocking: g.blocking, decidable: g.decidable,
        suggestedAnswer: suggestionFor(g.id),
        // A blocking gap CANNOT be escalated: escalation promises a person will
        // handle it at run time, and a spec that cannot publish has no run time.
        // Offering "escalate" there would be a lie told in the language of safety.
        defaultResolution: g.blocking ? 'answer' : 'escalate',
        resolutions: g.blocking ? ['answer'] : ['answer', 'escalate', 'ignore'],
      })),
      acceptAllDefaults: true,
      step: state.step,
    });

    const answers     = confirmation?.answers ?? {};
    const resolutions = confirmation?.resolutions ?? {};

    // Accept-all-defaults (or Enter) takes the model's suggestion for anything
    // blocking, and escalates everything else.
    const clarifications = [];
    for (const g of blocking) {
      const a = answers[g.id] ?? suggestionFor(g.id);
      if (a) clarifications.push({ q: g.message, a: String(a) });
    }

    const escalated = soft
      .filter(g => (resolutions[g.id] ?? 'escalate') === 'escalate')
      .map(g => ({ id: g.id, class: g.class, code: g.code, message: g.message, resolution: 'escalated' }));

    const logEntry = {
      step: state.step, type: 'gap_review',
      gaps: [...blocking, ...soft].map(g => ({ id: g.id, code: g.code, class: g.class, blocking: g.blocking })),
      escalated, answers, confirmation,
    };

    // Answers to BLOCKING gaps go back through the propose loop, which is the
    // only thing that can actually change the spec. Bounded, so a gap the model
    // cannot close ends in a question rather than a spin.
    if (clarifications.length && (state.gapRounds ?? 0) < MAX_GAP_ROUNDS) {
      return {
        clarifications,
        confirmationLog: [logEntry],
        escalatedGaps:   escalated,
        gapRounds:       (state.gapRounds ?? 0) + 1,
        proposeRounds:   0,
        step:            state.step + 1,
        phase:           'proposing',
      };
    }

    return {
      confirmationLog: [logEntry],
      escalatedGaps:   escalated,
      step:            state.step + 1,
      phase:           'ratifying',
    };
  });

  // ── ratify ─────────────────────────────────────────────────────────────────
  // Present the completed draft for final HITL approval before publish.
  graph.addNode('ratify', async (state) => {
    // ESCALATION BECOMES STRUCTURE HERE (P12 Increment D).
    //
    // Everything the user chose not to decide — every gap left on its default —
    // has been carried this far as a NOTE. A note asks nobody anything. Before the
    // spec is shown or saved, each escalated gap becomes a real shape in the
    // graph: a failure policy that reaches a person's Approvals list, or a `human`
    // gate that stops the run and asks. Otherwise "I'll ask you when it comes up"
    // is a sentence with no mechanism behind it — and the user has already stopped
    // worrying about it, which is the whole danger.
    //
    // It runs BEFORE the gap score below, deliberately: the materialised nodes are
    // part of the spec and must be validated like anything else. A gate that would
    // not publish is not a gate.
    const { draft: materialisedDraft, materialised, unmaterialised } =
      materialiseEscalations(state.draft, state.escalatedGaps ?? []);

    const spec = assembleSpec(materialisedDraft);

    // WHAT STILL BLOCKS PUBLISH TRAVELS WITH THE DRAFT.
    //
    // The gaps node falls through to `ratifying` when the propose loop cannot
    // close a blocking gap within its bounds — which is the right call (a loop
    // that cannot converge must end in a question, not a spin). But it used to
    // arrive here silently, so the user was shown a finished-looking workflow and
    // discovered only on clicking Publish that it could not be saved, with no
    // explanation of what to do. Ship the reason with the draft.
    // (Found by the independent verifier.)
    const score    = scoreGap(materialisedDraft, { capabilities: state.capabilities });
    const blockers = unansweredGaps(score).map(g => ({
      code: g.code, message: g.message, hint: g.hint, nodeId: g.nodeId,
    }));

    const confirmation = await interrupt({
      type: 'ratify', spec, step: state.step,
      publishable: blockers.length === 0,
      blockers,
      // What escalating actually BUILT, and — just as important — what it could
      // not. An escalation we quietly failed to materialise must be named, or
      // "escalated" degrades into a word that means nothing (§7.6.2).
      escalations: materialised,
      unmaterialisedEscalations: unmaterialised,
    });

    const logEntry = { step: state.step, type: 'ratify', spec, confirmation };

    if (confirmation?.type === 'approve') {
      return {
        spec,
        phase:           'done',
        confirmationLog: [logEntry],
        step:            state.step + 1,
      };
    }

    // request_changes: go back to proposing with user's feedback noted.
    //
    // The loop bounds MUST be reset here. `proposeRounds` is at or near its cap
    // by the time we reach ratify, so leaving it would send analyze straight back
    // to `gaps` without ever proposing the change the user just asked for — the
    // build would appear to ignore them.
    if (confirmation?.feedback) {
      return {
        clarifications:  [{ q: '(ratify feedback)', a: confirmation.feedback }],
        phase:           'proposing',
        proposeRounds:   0,
        gapRounds:       0,
        confirmationLog: [logEntry],
        step:            state.step + 1,
      };
    }

    return {
      phase:           'proposing',
      proposeRounds:   0,
      gapRounds:       0,
      confirmationLog: [logEntry],
      step:            state.step + 1,
    };
  });

  // ── Routing ────────────────────────────────────────────────────────────────

  // The elicitation order (converger-v2 §2.1). Rev 1 had this backwards: it
  // started from the STEPS. Decisions and outcomes are the hard part and come
  // FIRST; the process is derived from them, which is why `process` needs almost
  // no user turns at all.
  //
  //   outcome → examples → process → (analyze ⇄ clarify|propose) → gaps → ratify
  //
  // analyze/clarify/propose are v1's loop, kept intact and now driven by the new
  // gap oracle rather than the old five-item checklist.
  graph.setEntryPoint('outcome');

  graph.addConditionalEdges('outcome', (state) => {
    if (state.phase === 'examples')  return 'examples';
    if (state.phase === 'analyzing') return 'analyze';   // no contract could be formed — v1 path
    return 'outcome';                                     // asked a question; re-derive with the answer
  });

  graph.addEdge('examples', 'process');
  graph.addEdge('process', 'analyze');

  graph.addConditionalEdges('analyze', (state) => {
    if (state.phase === 'gapping')    return 'gaps';
    if (state.phase === 'ratifying')  return 'ratify';
    if (state.phase === 'clarifying') return 'clarify';
    return 'propose';
  });

  graph.addEdge('clarify', 'analyze');
  graph.addEdge('propose', 'analyze');

  graph.addConditionalEdges('gaps', (state) => {
    return state.phase === 'proposing' ? 'propose' : 'ratify';
  });

  graph.addConditionalEdges('ratify', (state) => {
    return state.phase === 'done' ? END : 'propose';
  });

  return graph.compile({
    checkpointer: new FileCheckpointer({ dir: checkpointerDir }),
  });
}
