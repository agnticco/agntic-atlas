/**
 * converger — public API.
 *
 * createConverger({ llm, capabilities, checkpointerDir?, interactionStore?, tenantId?, userId? })
 *   → { run, resume, getState }
 *
 * run(threadId, intent)
 *   Starts a new elicitation session. Returns on the first interrupt.
 *   Throws GraphInterrupt — caller inspects .interruptValue for the payload.
 *
 * resume(threadId, response)
 *   Resumes after a confirmation. Response shapes:
 *     Clarification:      { type: 'clarification', answer: string }
 *     Accept:             { type: 'accept' }
 *     Reject:             { type: 'reject' }
 *     Modify:             { type: 'modify', modification: string }
 *     Approve (ratify):   { type: 'approve' }
 *     Request changes:    { type: 'request_changes', feedback: string }
 *   Returns the next interrupt payload, or { type: 'done', spec, confirmationLog }.
 *
 * runHeadless(intent, capabilities)
 *   Auto-confirms every proposal. Used by the P3 gate harness.
 *   Returns { spec, confirmationLog }.
 *
 * Interaction logging:
 *   When interactionStore + tenantId are provided, every confirmation event is
 *   persisted asynchronously (fire-and-forget — never blocks the HITL loop).
 */

import { GraphInterrupt, Command } from '../graph/index.js';
import { buildElicitationGraph, DRAFT_DEFAULT } from './elicitation-graph.js';

function initialState(intent, capabilities) {
  return {
    intent,
    capabilities:     capabilities ?? {},
    draft:            { ...DRAFT_DEFAULT },
    clarifications:   [],
    confirmationLog:  [],
    step:             0,
    // P12 Increment C: elicitation now STARTS from the outcome, not the steps.
    // "What must be true when this has run?" precedes "what are the steps?" —
    // v1 asked them in the other order, which is why it could agree to a
    // delivery and then quietly not build it (converger-v2 §2.1).
    phase:            'outcome',
    proposeRounds:    0,
    gapRounds:        0,
    escalatedGaps:    [],
    spec:             null,
    _pendingQuestion: null,
  };
}

/** Fire-and-forget: log without blocking the HITL loop. */
function logAsync(store, tenantId, sessionId, entry) {
  if (!store || !tenantId) return;
  try { store.appendEvent(tenantId, sessionId, entry); } catch { /* ignore */ }
}

export function createConverger({
  llm,
  capabilities     = {},
  checkpointerDir,
  interactionStore = null,
  tenantId         = null,
  userId           = null,
} = {}) {
  const graph = buildElicitationGraph({ llm, checkpointerDir });

  // Each converger turn = ~3 node executions (analyze + propose/clarify + interrupt).
  const cfg = (threadId) => ({ configurable: { threadId }, recursionLimit: 300 });

  async function run(threadId, intent) {
    if (interactionStore && tenantId) {
      try { interactionStore.startSession(tenantId, threadId, { intent, userId }); } catch { /* ignore */ }
    }
    return graph.invoke(initialState(intent, capabilities), cfg(threadId));
  }

  async function resume(threadId, response) {
    try {
      const state = await graph.resume(threadId, new Command({ resume: response }), cfg(threadId));

      if (state.phase === 'done') {
        // Persist the full confirmation log on completion
        if (interactionStore && tenantId) {
          try {
            for (const entry of state.confirmationLog ?? []) {
              logAsync(interactionStore, tenantId, threadId, entry);
            }
            interactionStore.completeSession(tenantId, threadId, {
              outcome:   'ratified',
              finalSpec: state.spec,
              stepCount: state.step,
            });
          } catch { /* ignore */ }
        }
        return { type: 'done', spec: state.spec, confirmationLog: state.confirmationLog };
      }
      return { type: 'done', spec: state.spec, confirmationLog: state.confirmationLog };
    } catch (err) {
      if (err instanceof GraphInterrupt) {
        // Log this confirmation event immediately on each interrupt
        const iv = err.interruptValue;
        if (iv && interactionStore && tenantId) {
          logAsync(interactionStore, tenantId, threadId, iv);
        }
        return iv;
      }
      throw err;
    }
  }

  async function abandon(threadId) {
    if (interactionStore && tenantId) {
      try { interactionStore.completeSession(tenantId, threadId, { outcome: 'abandoned' }); } catch { /* ignore */ }
    }
  }

  async function getState(threadId) {
    return graph.getCheckpoint(threadId);
  }

  return { run, resume, abandon, getState };
}

/**
 * runHeadless — drives the full converger loop without human interaction.
 * Auto-confirms every clarification and proposal, approves the draft.
 * Used by the P3 gate harness.
 */
export async function runHeadless({ intent, capabilities, llm, checkpointerDir }) {
  const graph    = buildElicitationGraph({ llm, checkpointerDir });
  const threadId = `headless-${Date.now()}`;
  const config   = { configurable: { threadId }, recursionLimit: 300 };
  const MAX_STEPS = 40;
  let steps = 0;

  // Every interrupt carries a DEFAULT, and the default is always a valid answer
  // (converger-v2 §11.9). That is not a headless convenience — it is the same
  // property the zero-typing path depends on in the real UI: if a default is
  // missing here, a user pressing Enter would be stuck there too.
  function autoRespond(interruptVal) {
    const itype = interruptVal?.type;
    if (itype === 'clarification')   return { type: 'clarification', answer: 'Please proceed with your best inference.' };
    if (itype === 'ratify')          return { type: 'approve' };
    if (itype === 'outcome_check')   return { type: 'accept' };          // the pre-selected candidate
    if (itype === 'example_request') return { type: 'accept' };          // keep the proposed examples
    if (itype === 'gap_review')      return { type: 'accept_defaults' }; // answer / escalate, per row
    return { type: 'accept' };
  }

  let lastInterrupt = null;
  try {
    const state = await graph.invoke(initialState(intent, capabilities), config);
    if (state?.spec) return { spec: state.spec, confirmationLog: state.confirmationLog ?? [] };
  } catch (err) {
    if (!(err instanceof GraphInterrupt)) throw err;
    lastInterrupt = err;
  }

  while (lastInterrupt && steps++ < MAX_STEPS) {
    const response = autoRespond(lastInterrupt.interruptValue);
    lastInterrupt  = null;

    try {
      const state = await graph.resume(threadId, new Command({ resume: response }), config);
      if (state?.phase === 'done' || state?.spec) {
        return { spec: state.spec, confirmationLog: state.confirmationLog ?? [] };
      }
    } catch (err) {
      if (!(err instanceof GraphInterrupt)) throw err;
      lastInterrupt = err;
    }
  }

  throw new Error(`runHeadless: did not converge within ${MAX_STEPS} steps`);
}
