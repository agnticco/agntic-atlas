/**
 * escalation — turning "a person will deal with it" into something that actually
 * asks a person. (P12 Increment D.)
 *
 * Increment C made escalation the DEFAULT resolution of every non-blocking gap,
 * which is what makes converger-v2 §6.2.4's *"Accept all defaults"* an honest
 * button rather than a way to bury unknowns: you are not saying "ignore this",
 * you are saying "don't make me decide it now — ask me when it actually happens".
 *
 * C could not keep that promise. It recorded escalated gaps as provenance and
 * emitted a spec in which precisely nothing asked anybody anything. The promise
 * was real at build time and empty at run time, which is the worst place for a
 * promise to be empty — the user has stopped worrying about it.
 *
 * This file is the payment. An escalated gap becomes a STRUCTURE IN THE SPEC that
 * routes the case to a person when it arises.
 *
 * ── The materialisation table ───────────────────────────────────────────────
 *
 *   NO_ERROR_PATH          →  on_error: { retry: 2, then: 'escalate' } on every
 *                             step that has no policy. A failure then lands in
 *                             the owner's Approvals list instead of a log nobody
 *                             reads — which is exactly what the gap's own message
 *                             promises ("right now the run just stops, and only a
 *                             log knows"). The run still FAILS, and it should: a
 *                             person acknowledging a failure does not turn it into
 *                             a success.
 *
 *   DECISION_TABLE_GAP     →  on_error: { retry: 1, then: 'escalate' } on the
 *                             DECISION itself (P12 Increment E). The gap's own
 *                             message says the workflow "would silently do nothing"
 *                             for the uncovered case, and its hint promises "an
 *                             unanticipated case goes to a person instead of
 *                             vanishing". `decision.run()` keeps the first half by
 *                             THROWING when no rule matches — refusing to guess —
 *                             and this keeps the second: the throw becomes an
 *                             escalation to the owner's Approvals list, rather than
 *                             a failed run in a log. Without it, the gap the user
 *                             was invited to escalate would be recorded and then
 *                             quietly do nothing, which is the exact lie this file
 *                             exists to stop telling.
 *
 *   CONDITIONAL_UNPROVEN   →  a real `human` gate in front of the step. The
 *                             outcome promised "…and over $50k it also pings
 *                             #sales-urgent", nothing in the workflow can tell a
 *                             $50k deal from a $5k one, and until Increment E
 *                             there is no decision table that could. The honest
 *                             escalation of "I cannot decide this" is to ASK: the
 *                             run pauses, a person says whether the condition
 *                             holds this time, and the branch routes on their
 *                             answer. Without this the workflow would ping
 *                             #sales-urgent for EVERY lead while its own contract
 *                             claimed the condition was honoured.
 *
 * Anything else escalated is REPORTED AS UNMATERIALISED, by name, with the reason.
 * A gap we said we would escalate and then quietly did nothing about is a lie in
 * the language of safety — the same class of failure as a blocking gap defaulting
 * to 'escalated' (which C corrected), and the caller must be able to tell the user
 * exactly which promises are structural and which are still only recorded.
 *
 * @module src/converger/escalation.js
 */

import { satisfiesAssertion } from '../workflows/outcome-oracle.js';

/** What a materialised gate asks over, and how long it waits. */
const GATE_TIMEOUT = { after: '48h', then: 'reject' };

/**
 * Steps that can carry an error policy. A `branch` failing is a spec bug, not an
 * incident.
 *
 * A `decision` CAN fail, and its failure is the most interesting one in the
 * engine: an input combination no rule covers, or an AI-judged input the model
 * could not place in the closed enum. Both are exactly the case a person must see.
 * Leaving `decision` out would mean the one node type built to surface the unknown
 * was the one type whose unknowns had nowhere to go. (P12 Increment E.)
 */
const CAN_FAIL = new Set(['llm', 'assemble', 'connector-action', 'search_web', 'deliver', 'foreach', 'decision']);

/**
 * @param {object} draft — the converger's draft (nodes, edges, outcome, …)
 * @param {Array<{id:string, code:string, message:string}>} escalatedGaps
 * @returns {{ draft: object, materialised: object[], unmaterialised: object[] }}
 */
export function materialiseEscalations(draft, escalatedGaps = []) {
  const materialised   = [];
  const unmaterialised = [];

  if (!Array.isArray(escalatedGaps) || !escalatedGaps.length) {
    return { draft, materialised, unmaterialised };
  }

  let nodes = [...(draft.nodes ?? [])];
  let edges = [...(draft.edges ?? [])];
  const assertions = Array.isArray(draft.outcome?.assertions) ? draft.outcome.assertions : [];

  for (const gap of escalatedGaps) {
    switch (gap.code) {
      // ── "Nothing says what happens if a step fails" ───────────────────────
      case 'NO_ERROR_PATH': {
        const touched = [];
        nodes = nodes.map((n) => {
          if (!CAN_FAIL.has(n.type) || n.on_error) return n;
          touched.push(n.id);
          // retry first — most failures are a flaky API, and asking a person to
          // look at a transient 502 teaches them to ignore the Approvals list.
          // Escalate only what survives two retries.
          return { ...n, on_error: { retry: 2, then: 'escalate' } };
        });
        if (touched.length) {
          materialised.push({
            gapId: gap.id, code: gap.code, how: 'on_error:escalate', nodeIds: touched,
            note: 'If a step fails, it is retried twice and then a person is told, in their Approvals list.',
          });
        } else {
          unmaterialised.push({ gapId: gap.id, code: gap.code, why: 'every step already declares what to do when it fails' });
        }
        break;
      }

      // ── "There's a case this table has no rule for" (P12 Increment E) ────
      //
      // The honest escalation of an uncovered case is NOT to invent a rule for it
      // — nobody asked the user what the answer should be, and guessing would put
      // a decision they never made into a table they are told they can audit.
      // It is to make sure that WHEN the case arrives, a person hears about it.
      //
      // `decision.run()` throws on an uncovered combination (it refuses to guess),
      // so the only thing missing is somewhere for the throw to go.
      case 'DECISION_TABLE_GAP': {
        const node = nodes.find(n => n?.id === gap.nodeId && n?.type === 'decision');
        if (!node) {
          unmaterialised.push({ gapId: gap.id, code: gap.code, why: 'the decision it refers to is no longer in the workflow' });
          break;
        }
        if (node.on_error?.then) {
          // It already has a declared failure path — the case reaches whatever that
          // path leads to. Nothing to add, and adding it anyway would silently
          // overwrite a policy the user chose.
          materialised.push({
            gapId: gap.id, code: gap.code, how: 'on_error (already declared)', nodeIds: [node.id],
            note: `An uncovered case fails "${node.label || node.id}", which already says what to do when it fails.`,
          });
          break;
        }
        nodes = nodes.map(n => (n.id === node.id
          // retry:1 because an AI-judged input can be a flake; a table lookup cannot.
          // Two retries of a genuinely uncovered combination is two identical failures.
          ? { ...n, on_error: { retry: 1, then: 'escalate' } }
          : n));
        materialised.push({
          gapId: gap.id, code: gap.code, how: 'on_error:escalate', nodeIds: [node.id],
          note: `If "${node.label || node.id}" meets a case no rule covers, the run stops and a person is told — instead of the workflow silently doing nothing.`,
        });
        break;
      }

      // ── "The outcome promises this only happens sometimes, and nothing
      //     decides when" ────────────────────────────────────────────────────
      case 'CONDITIONAL_UNPROVEN': {
        const assertion = assertions.find(a => gapIdFor(a) === gap.id);
        if (!assertion) {
          unmaterialised.push({ gapId: gap.id, code: gap.code, why: 'the assertion it refers to is no longer in the outcome' });
          break;
        }
        const target = nodes.find(n => satisfiesAssertion(assertion, n));
        if (!target) {
          unmaterialised.push({ gapId: gap.id, code: gap.code, why: `no step delivers "${assertion.target}", so there is nothing to gate` });
          break;
        }
        const gated = gateNode({ nodes, edges, target, assertion });
        nodes = gated.nodes;
        edges = gated.edges;
        materialised.push({
          gapId: gap.id, code: gap.code, how: 'human-gate',
          nodeIds: [gated.askId, gated.branchId],
          note: `Before "${target.label || target.id}" runs, a person is asked whether ${assertion.when}. If they say no, it is skipped.`,
        });
        break;
      }

      default:
        // Say what we did NOT do, and why. Silence here is how "escalated" becomes
        // a word that means nothing.
        unmaterialised.push({
          gapId: gap.id, code: gap.code,
          why: 'there is no run-time shape that can ask this yet — it is recorded on the workflow, but nothing will ask a person about it',
        });
    }
  }

  return { draft: { ...draft, nodes, edges }, materialised, unmaterialised };
}

/** The id `gap-scorer.js` gives a CONDITIONAL_UNPROVEN gap. Kept in step with it. */
function gapIdFor(assertion) {
  return `gap_conditional_${assertion?.id ?? assertion?.target}`.toLowerCase();
}

/**
 * Put a `human` gate in front of `target`, and route on the answer.
 *
 *   …parents…  →  ask  →  gate ─approve─→  target
 *                              └─────*───→  target_skipped
 *
 * Every part of this shape is load-bearing, and the validator will reject it if
 * any is missing:
 *
 *   • The branch is NOT optional. A `human` node followed directly by the step it
 *     "approves" is an approval gate that IGNORES THE ANSWER — the step runs
 *     whether the person said yes or no. It looks exactly like a gate and does
 *     exactly nothing, which is worse than having none.
 *   • The catch-all (`*`) is mandatory (NON_EXHAUSTIVE_BRANCH), and it must go
 *     somewhere real — so `reject` and `timeout` both land on a step that records
 *     that nothing was sent, rather than the run silently stopping.
 *   • `target`'s original parents are REWIRED to the ask. If they still fed the
 *     target directly, its edge would be live regardless of the answer and the
 *     branch would decide nothing (BRANCH_TARGET_EXTRA_PARENT).
 */
function gateNode({ nodes, edges, target, assertion }) {
  const askId    = `ask_${target.id}`;
  const branchId = `gate_${target.id}`;
  const skipId   = `${target.id}_skipped`;

  const parents = edges.filter(e => e.to === target.id).map(e => e.from);

  const ask = {
    id: askId, type: 'human', label: 'Ask a person',
    config: {
      prompt: `${cap(assertion.when)}? If yes, "${target.label || target.id}" goes ahead.`,
      // What they actually see: the content this step would act on.
      ...(parents.length ? { preview: `{{${parents[0]}.output}}` } : {}),
      decisions: ['approve', 'reject'],
      // The in-app inbox: strong trust (an authenticated session), always
      // available, and it needs no connector — which is what lets escalation be a
      // default that always has somewhere to go.
      channels: [{ type: 'inbox' }],
      timeout: GATE_TIMEOUT,
    },
  };

  const branch = {
    id: branchId, type: 'branch', label: 'Approved?',
    config: {
      on: `{{${askId}.decision}}`,
      cases: [
        { when: 'approve', to: target.id },
        { when: '*',       to: skipId },
      ],
    },
  };

  const skipped = {
    id: skipId, type: 'assemble', label: 'Not approved',
    config: {
      title: `"${target.label || target.id}" was not approved, so it did not run.`,
      sections: '[]',
    },
  };

  const nextEdges = edges
    .filter(e => e.to !== target.id)                       // unhook the target's parents…
    .concat(parents.map(p => ({ from: p, to: askId })))    // …and hook them to the ask
    .concat([
      { from: askId,    to: branchId },
      { from: branchId, to: target.id },
      { from: branchId, to: skipId },
    ]);

  return {
    nodes: [...nodes, ask, branch, skipped],
    edges: nextEdges,
    askId, branchId, skipId,
  };
}

const cap = (s) => {
  const t = String(s ?? '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
