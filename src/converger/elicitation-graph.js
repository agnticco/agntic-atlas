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
import { scoreGap }          from './gap-scorer.js';
import { applyProposal, assembleSpec } from './spec-assembler.js';
import {
  buildSystemPrompt,
  buildAnalyzePrompt,
  buildProposePrompt,
  buildModifyPrompt,
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

async function llmJson(llm, messages) {
  const res = await llm.invoke(messages);
  try {
    return JSON.parse(extractJson(typeof res === 'string' ? res : res.content));
  } catch {
    return null;
  }
}

export const DRAFT_DEFAULT = {
  name:          null,
  description:   null,
  triggers:      [],
  nodes:         [],
  edges:         [],
  errorHandling: {},
};

// ── Tier helpers ──────────────────────────────────────────────────────────────
// Always access models through tier names — never hardcode a provider or model
// ID here. Whoever configures the ModelPool decides what "fast" and "balanced"
// mean (Haiku/Sonnet, gpt-4o-mini/gpt-4o, local/local, etc.).

function tier(llm, name) {
  return llm.tiers?.[name] ?? llm.tiers?.balanced ?? llm;
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
      phase:        'analyzing',
      spec:         null,
      _pendingQuestion: null,

      // Accumulator fields (reducer: append)
      clarifications: {
        default:  [],
        reducer:  (prev, additions) => [...(prev ?? []), ...(additions ?? [])],
      },
      confirmationLog: {
        default:  [],
        reducer:  (prev, additions) => [...(prev ?? []), ...(additions ?? [])],
      },
    },
  });

  // ── analyze ────────────────────────────────────────────────────────────────
  // Check gap and intent clarity. Decide what to do next.
  // Hard cap: after MAX_CLARIFICATIONS rounds, always proceed — the converger
  // must not get stuck asking questions when answers are vague.
  const MAX_CLARIFICATIONS = 2;

  graph.addNode('analyze', async (state) => {
    const gap = scoreGap(state.draft);
    if (gap.complete) return { phase: 'ratifying' };

    const clarificationCount = (state.clarifications ?? []).length;
    if (clarificationCount >= MAX_CLARIFICATIONS) return { phase: 'proposing' };

    const sysmsg = new SystemMessage(buildSystemPrompt(state.capabilities));
    const usermsg = new HumanMessage(buildAnalyzePrompt({
      intent:         state.intent,
      clarifications: state.clarifications,
      capabilities:   state.capabilities,
    }));
    const parsed = await llmJson(tier(llm, 'fast'), [sysmsg, usermsg]);

    if (parsed?.ready === false && parsed.question) {
      return { phase: 'clarifying', _pendingQuestion: parsed.question };
    }
    return { phase: 'proposing' };
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
  graph.addNode('propose', async (state) => {
    const gap    = scoreGap(state.draft);
    const sysmsg = new SystemMessage(buildSystemPrompt(state.capabilities));
    const usermsg = new HumanMessage(buildProposePrompt({
      intent:         state.intent,
      clarifications: state.clarifications,
      draft:          state.draft,
      gap,
    }));

    const proposal = await llmJson(tier(llm, 'balanced'), [sysmsg, usermsg]);

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

    // HITL: pause for accept / reject / modify
    const confirmation = await interrupt({ type: 'proposal', proposal, step: state.step });

    let newDraft = state.draft;
    const logEntry = { step: state.step, type: 'proposal', proposal, confirmation };

    if (confirmation?.type === 'accept') {
      newDraft = applyProposal(state.draft, proposal, confirmation);
    } else if (confirmation?.type === 'modify') {
      // Apply modification: ask LLM to merge the user's override into the proposal
      const modSysmsg  = new SystemMessage(buildSystemPrompt(state.capabilities));
      const modUsermsg = new HumanMessage(buildModifyPrompt({
        original:     proposal,
        modification: confirmation.modification,
      }));
      const updated = await llmJson(tier(llm, 'fast'), [modSysmsg, modUsermsg]);
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

  // ── ratify ─────────────────────────────────────────────────────────────────
  // Present the completed draft for final HITL approval before publish.
  graph.addNode('ratify', async (state) => {
    const spec = assembleSpec(state.draft);

    const confirmation = await interrupt({ type: 'ratify', spec, step: state.step });

    const logEntry = { step: state.step, type: 'ratify', spec, confirmation };

    if (confirmation?.type === 'approve') {
      return {
        spec,
        phase:           'done',
        confirmationLog: [logEntry],
        step:            state.step + 1,
      };
    }

    // request_changes: go back to proposing with user's feedback noted
    if (confirmation?.feedback) {
      return {
        clarifications:  [{ q: '(ratify feedback)', a: confirmation.feedback }],
        phase:           'proposing',
        confirmationLog: [logEntry],
        step:            state.step + 1,
      };
    }

    return {
      phase:           'proposing',
      confirmationLog: [logEntry],
      step:            state.step + 1,
    };
  });

  // ── Routing ────────────────────────────────────────────────────────────────

  graph.setEntryPoint('analyze');

  graph.addConditionalEdges('analyze', (state) => {
    if (state.phase === 'ratifying')  return 'ratify';
    if (state.phase === 'clarifying') return 'clarify';
    return 'propose';
  });

  graph.addEdge('clarify', 'analyze');
  graph.addEdge('propose', 'analyze');

  graph.addConditionalEdges('ratify', (state) => {
    return state.phase === 'done' ? END : 'propose';
  });

  return graph.compile({
    checkpointer: new FileCheckpointer({ dir: checkpointerDir }),
  });
}
