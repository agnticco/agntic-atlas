/**
 * gap-scorer — what does this workflow still not know about itself?
 *
 * P12 Increment C. This replaces a hardcoded five-item checklist:
 *
 *   BEFORE  scoreGap(draft) → { needsTrigger, needsProcessing, needsDelivery, … }
 *   AFTER   scoreGap(spec, { capabilities }) → { gaps: [ … ], complete }
 *
 * The old checklist demanded "a trigger, a PROCESSING node, a delivery". That
 * middle demand is defect #4: asked to move an email into a spreadsheet — a
 * genuinely two-step workflow — the converger invented a pointless LLM step
 * purely to satisfy the checklist, and charged the user for it on every run. A
 * workflow is not complete because it has one of each node family. It is
 * complete when **it does what its outcome says**, and nothing it does is
 * under-specified.
 *
 * ── Three gap classes ───────────────────────────────────────────────────────
 *
 *   outcome    an assertion in the outcome contract that no node satisfies.
 *              (defect #1 — the "Slack AND email" silent drop.)
 *   coverage   an input nobody decided what to do with: a branch with no
 *              catch-all, a decision table with a hole, a UNIQUE table whose
 *              rules overlap. (defect #5 — zero exception questions, ever.)
 *   contract   a step that is under-specified or asks the engine for something
 *              it will silently ignore. (defect #3 — the dead `"model"` key.)
 *
 * ── Where the gaps come from, and why it is not a second opinion ────────────
 *
 * The contract and outcome gaps ARE the validator's issues. This file does not
 * re-implement them, and that is deliberate rather than lazy: a converger with
 * its own private idea of "complete" will happily ratify a spec that publish
 * then rejects, and the user lands in a dead end they cannot argue their way
 * out of — the builder says it's done, the save button says it isn't. One
 * oracle, consulted by both, cannot drift.
 *
 * As of Increment E that is true of the DMN coverage analysis too: it used to be
 * re-implemented here, because `decision` was not yet a registered node type and
 * the validator therefore never ran it. Now the validator owns it
 * (`_checkDecisionTables`) and this file classifies the result — so a table with a
 * hole is found on the way OUT (publish) as well as on the way IN (converge), and
 * there is one implementation of "is this table complete?", not two.
 *
 * What this file still adds on top: the EXCEPTION questions (§2b) — the ones that
 * are gaps in a workflow's story rather than errors in its shape.
 *
 * ── resolution, and the invariant that keeps `complete` honest ──────────────
 *
 *   resolution: 'unanswered' | 'answered' | 'escalated'
 *   complete  = no gap is left 'unanswered'
 *
 * A gap DEFAULTS to 'escalated' — nobody answered it, so a human deals with it —
 * which is what makes "Accept all defaults" an honest button rather than a way
 * to hide unknowns (converger-v2 §6.2.4).
 *
 * But it can only default that way when escalating is TRUE. So:
 *
 *   > **A BLOCKING gap — one that makes the spec fail validation — always
 *   > defaults to 'unanswered'.** It cannot be escalated, because escalation is
 *   > a promise that a human will handle this case AT RUN TIME, and a spec that
 *   > cannot publish never has a run time. Calling that "escalated" would be a
 *   > lie told in the language of safety.
 *
 * This gives the property the whole loop rests on, by construction:
 *
 *   > **complete ⇒ publishable.**
 *
 * (A blanket 'escalated' default — which is what an earlier draft of
 * converger-v2 §3 specified — is not merely wrong, it is unimplementable: it
 * makes `complete` unconditionally true, so an EMPTY draft scores complete and
 * the converger ratifies a workflow with no steps in it. A default that makes a
 * check vacuous is not a safety net; it is the bug. Same class as the
 * `?? 'unscoped'` tenant fallback that leaked across tenants in Increment B.
 * §3 is corrected.)
 *
 * @module src/converger/gap-scorer.js
 */

import { WorkflowValidator }       from '../workflows/workflow-validator.js';
import { NodeTypeRegistry }        from '../workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../workflows/node-types/index.js';
import { approvalChannelView }     from '../workflows/approval-channels.js';

/** Which class an issue belongs to. Anything unlisted is a contract gap. */
const OUTCOME_CODES  = new Set(['UNSATISFIED_ASSERTION', 'MALFORMED_ASSERTION', 'MISSING_OUTCOME']);
const COVERAGE_CODES = new Set([
  'NON_EXHAUSTIVE_BRANCH', 'LLM_INPUT_NOT_ENUM', 'BRANCH_BAD_ON', 'BRANCH_CASE_NOT_IN_ENUM',
  // The DMN analysis (P12 Increment E). These now come FROM the validator — see
  // the note where the hand-rolled copy used to be, below.
  'DECISION_TABLE_GAP', 'UNIQUE_HIT_OVERLAP', 'DECISION_UNDECIDABLE',
  'DECISION_BAD_CONDITION', 'DECISION_OUTPUT_NOT_IN_ENUM', 'DECISION_UNKNOWN_INPUT',
  'DECISION_TOO_WIDE',
]);

/**
 * A gap the system CANNOT ANSWER for the user, however hard it tries — as opposed
 * to one it merely has not answered yet. `decidable` drives the UI: a decidable
 * gap gets a pre-filled "Use the suggestion" button, and an undecidable one must
 * not, because there is no suggestion to make.
 *
 * The two DMN codes here are the honest half of the moat. A table whose domain is
 * unbounded ("subject", free text), or one carrying a condition the FEEL-A grammar
 * cannot read, is a table about which NO coverage claim can be made — not even a
 * negative one. Offering a confident answer for a case we cannot enumerate would be
 * a false proof, and a false proof is worse than no proof: the user stops looking.
 */
const UNDECIDABLE_CODES = new Set(['DECISION_UNDECIDABLE', 'DECISION_BAD_CONDITION']);

/**
 * The validator needs a node-type registry to see any config at all (without one
 * every node's `typeDef` is null and MISSING_CONFIG / UNKNOWN_CONFIG_KEY quietly
 * check nothing). Validation only reads `configSchema` and `validate()`, so no
 * services are needed and nothing is shared between calls.
 */
let _nodeTypes = null;
function nodeTypes() {
  if (!_nodeTypes) _nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
  return _nodeTypes;
}

/**
 * The converger's `capabilities.channels` IS the delivery catalog — the same
 * one the server's ChannelRegistry exposes, already narrowed to what this tenant
 * can actually run. Handing it to the validator is what keeps `complete ⇒
 * publishable` true: a delivery channel's config keys are declared by the
 * CHANNEL (an Airtable delivery needs a baseId; a Slack one does not), so a
 * scorer that cannot see the catalog would judge a valid Airtable delivery
 * against Slack's key set and call a correct spec broken — or, worse, would have
 * to stop checking, and let a hallucinated key through.
 */
function channelView(capabilities) {
  const chans = capabilities?.channels;
  if (!Array.isArray(chans) || !chans.length) return null;
  const byId = new Map(chans.filter(c => c?.id).map(c => [c.id, c]));
  return { get: (id) => byId.get(id) ?? null };
}

/**
 * The approval channels the tenant can actually be ASKED over (P12 Increment D).
 * Built by builder.js from the live catalog + the platform mailer and carried on
 * `capabilities`, for exactly the same reason as `channels`: the scorer must run
 * the checks publish runs, or `complete ⇒ publishable` is a slogan rather than a
 * property. Absent ⇒ null ⇒ the validator skips APPROVAL_CHANNEL_NOT_CONNECTED
 * and this file refuses to certify (below).
 */
function approvalView(capabilities) {
  return approvalChannelView(capabilities?.approvalChannels ?? null);
}

function validatorFor(capabilities) {
  return new WorkflowValidator({
    nodeTypes:        nodeTypes(),
    channelRegistry:  channelView(capabilities),
    approvalChannels: approvalView(capabilities),
  });
}

function classOf(code) {
  if (OUTCOME_CODES.has(code))  return 'outcome';
  if (COVERAGE_CODES.has(code)) return 'coverage';
  return 'contract';
}

/**
 * @param {object} spec  — a draft or a finished spec: { name, outcome?, triggers, nodes, edges }
 * @param {{ capabilities?: object, validator?: WorkflowValidator }} [opts]
 * @returns {{ gaps: object[], complete: boolean }}
 */
export function scoreGap(spec = {}, { capabilities = {}, validator = null } = {}) {
  const v      = validator ?? validatorFor(capabilities);
  const nodes  = Array.isArray(spec.nodes) ? spec.nodes : [];
  const gaps   = [];

  // ── 1 & 2. Outcome + contract gaps: the validator's issues, classified ────
  let issues = [];
  try {
    issues = v.validate(spec).issues ?? [];
  } catch (err) {
    // A validator that throws on a half-built draft must not take the whole
    // elicitation down with it — but it must not be silently ignored either, or
    // the converger would think a broken draft was complete.
    gaps.push({
      id: 'gap_validator_error', class: 'contract', nodeId: null,
      code: 'VALIDATOR_ERROR', severity: 'error',
      message: `The workflow couldn't be checked: ${err.message ?? String(err)}`,
      hint: null, resolution: 'unanswered', decidable: false, blocking: true,
    });
    return { gaps, complete: false };
  }

  issues.forEach((issue, i) => {
    const blocking = issue.severity === 'error';
    gaps.push({
      id:       `gap_${issue.code}_${issue.nodeId ?? 'spec'}_${i}`.toLowerCase(),
      class:    classOf(issue.code),
      nodeId:   issue.nodeId ?? null,
      code:     issue.code,
      severity: issue.severity,
      message:  issue.message,
      hint:     issue.hint ?? null,
      // A blocking gap cannot be escalated — see the header. It must be ANSWERED.
      resolution: blocking ? 'unanswered' : 'escalated',
      decidable:  !UNDECIDABLE_CODES.has(issue.code),
      blocking,
    });
  });

  // ── 2a. FAIL CLOSED when we cannot check what publish will check ─────────
  //
  // `complete ⇒ publishable` is the property this whole loop rests on. It is
  // FALSE the moment the scorer performs fewer checks than publish does — and
  // that is exactly what happened without a channel catalog: `channelView()`
  // returns null, the validator's `if (channelId && this.channelRegistry)` guard
  // (workflow-validator.js, _checkTypeSpecific) silently skips UNKNOWN_CHANNEL and
  // CHANNEL_UNAVAILABLE, and a spec delivering to a hallucinated `channel:
  // 'discord'` scores COMPLETE — then publish rejects it. A dead end the user
  // cannot argue their way out of.
  //
  // Worse, it disables itself precisely when it is most needed: `builder.js`
  // builds the catalog after three network-bound connector lookups inside a
  // "non-fatal" catch, so an expired refresh token drops the catalog — and in
  // that same state the model has no catalog in its prompt either, making it MOST
  // likely to invent a channel id.
  //
  // A silent degradation of a check is not a safety net; it IS the bug (CLAUDE.md
  // — the `?? 'unscoped'` tenant fallback). So: if a spec delivers somewhere and
  // we cannot see the catalog, we refuse to call it complete. Refusing to certify
  // is always available; certifying without checking is not.
  // (Found by the independent verifier.)
  const hasCatalog = Array.isArray(capabilities?.channels) && capabilities.channels.length > 0;
  const routed = nodes.filter(n => n?.type === 'deliver' && n.config?.channel);
  if (!hasCatalog && routed.length) {
    gaps.push({
      id: 'gap_channels_unverified', class: 'contract', nodeId: null,
      code: 'CHANNELS_UNVERIFIED', severity: 'error',
      message: 'I can\'t confirm the delivery destinations are real and connected — the connector catalog isn\'t loaded, so I won\'t claim this workflow is finished.',
      hint: 'Reconnect the connectors (or reload the page) and try again.',
      resolution: 'unanswered', decidable: false, blocking: true,
    });
  }

  // The SAME hole, one door along (P12 Increment D). A `human` node's channels
  // are checked by APPROVAL_CHANNEL_NOT_CONNECTED — but only when the validator
  // was handed an approval-channel view. Without one that check silently does not
  // run, so a pause asking over a Slack workspace nobody connected would score
  // COMPLETE here and be rejected at publish (which always has the view). That is
  // the C blocker exactly, and the lesson it taught is that the fix belongs on
  // BOTH sides: the validator skips what it cannot see, and the scorer refuses to
  // certify what it could not check.
  //
  // It is not merely a publish/score divergence, either: an approval nobody can
  // reach is a run that waits forever for an answer that cannot come.
  const asks = nodes.filter(n => n?.type === 'human');
  if (!Array.isArray(capabilities?.approvalChannels) && asks.length) {
    gaps.push({
      id: 'gap_approval_channels_unverified', class: 'contract', nodeId: asks[0].id,
      code: 'CHANNELS_UNVERIFIED', severity: 'error',
      message: 'This workflow stops to ask a person, but I can\'t confirm where that question can actually be delivered — so I won\'t claim it\'s finished.',
      hint: 'Reconnect the connectors (or reload the page) and try again.',
      resolution: 'unanswered', decidable: false, blocking: true,
    });
  }

  // ── 2b. The exception questions (defect #5: the converger asked ZERO, ever) ──

  // Nothing says what happens when a step FAILS. Today the run stops and the
  // failure lands in a log nobody reads. This is the one exception question that
  // applies to every workflow ever built, which is why defect #5 could go
  // unnoticed for so long: the converger had no shape to interrogate, so it
  // never asked the most basic question there is.
  if (nodes.length && !nodes.some(n => n?.on_error)) {
    gaps.push({
      id: 'gap_no_error_path', class: 'contract', nodeId: null,
      code: 'NO_ERROR_PATH', severity: 'warning',
      message: 'Nothing here says what should happen if a step fails — right now the run just stops, and only a log knows.',
      hint: 'The default is to retry twice and then tell a person. That is usually what you want.',
      resolution: 'escalated', decidable: true, blocking: false,
    });
  }

  // A CONDITIONAL promise ("…and over $50k also pings #sales-urgent") is one
  // this increment can find a node for, but CANNOT prove is gated: proving it
  // needs the decision table (Increment E) and the worked examples as a test
  // suite (Increment G). So we say exactly that, and we say it out loud.
  //
  // The alternative — treating a conditional assertion as satisfied by an
  // ungated node — would be a FALSE PROOF: the workflow would pass its own
  // contract while pinging #sales-urgent for every lead, not just the big ones.
  // Never imply a completeness proof you cannot make (converger-v2 §3); a claim
  // we did not check is worse than one we never made, because the user stops
  // looking.
  for (const a of (Array.isArray(spec.outcome?.assertions) ? spec.outcome.assertions : [])) {
    if (!a?.when) continue;
    gaps.push({
      id: `gap_conditional_${a.id ?? a.target}`.toLowerCase(),
      class: 'coverage', nodeId: null,
      code: 'CONDITIONAL_UNPROVEN', severity: 'warning',
      message: `The outcome says ${a.target} should happen only when ${a.when} — but nothing in the workflow checks that yet, so it would happen on every run.`,
      hint: 'Add a step that classifies the input, and route on it — or accept that it fires every time.',
      resolution: 'escalated', decidable: false, blocking: false,
    });
  }

  // ── 3. The DMN coverage analysis ─────────────────────────────────────────
  //
  // It used to be RE-IMPLEMENTED here, because Increment C's validator did not
  // run it: `decision` was not a registered node type, so a table could only be
  // reasoned about on the way IN (converge), never on the way OUT (publish).
  //
  // Increment E makes `decision` runnable, and moves the analysis into the
  // validator (`_checkDecisionTables`) — where publish, the builder, the API and
  // this scorer all reach it through ONE oracle. That is not tidying: two copies
  // of "is this table complete?" drift, and the day they drift is the day the
  // converger ratifies a spec that publish rejects. It is the same rule
  // outcome-oracle.js exists to enforce, and it is what keeps `complete ⇒
  // publishable` a property rather than a slogan.
  //
  // So the DMN gaps arrive above, with everything else, as validator issues —
  // classified as `coverage` by COVERAGE_CODES, and given a resolution by the one
  // severity rule that governs every gap: an error must be ANSWERED; a warning may
  // be ESCALATED. Which is exactly the resolution the hand-written block assigned.

  return { gaps, complete: gaps.every(g => g.resolution !== 'unanswered') };
}

/** The gaps still blocking a publish. `complete` is exactly "this list is empty". */
export function unansweredGaps(result) {
  return (result?.gaps ?? []).filter(g => g.resolution === 'unanswered');
}

/**
 * The next gap for the converger to work on. Outcome first (what must this
 * workflow produce), then contract (can each step actually run), then coverage
 * (what did nobody think about) — the order the elicitation asks in.
 */
export function nextGap(result) {
  const open = unansweredGaps(result);
  const rank = { outcome: 0, contract: 1, coverage: 2 };
  return [...open].sort((a, b) => (rank[a.class] ?? 9) - (rank[b.class] ?? 9))[0] ?? null;
}

/**
 * A one-line description of what the workflow still needs — fed to the propose
 * prompt. It now carries the validator's own message and hint, so the model is
 * told exactly what is wrong and exactly how to fix it, rather than being handed
 * a vague checklist item and left to guess (which is how the dead `"model"` key
 * survived: nothing ever told the model it was wrong).
 */
export function gapLabel(result) {
  // Tolerate being handed a single gap as well as a whole result.
  const gap = result?.gaps ? nextGap(result) : result;
  if (!gap) return 'nothing — the workflow does everything its outcome promises';
  return gap.hint ? `${gap.message}  → ${gap.hint}` : gap.message;
}
