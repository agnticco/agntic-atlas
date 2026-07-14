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
 * What this file adds on top is the DMN coverage analysis (decision-analysis.js),
 * which the validator does not do until Increment E.
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
import { analyzeTable }            from '../workflows/decision-analysis.js';

/** Which class an issue belongs to. Anything unlisted is a contract gap. */
const OUTCOME_CODES  = new Set(['UNSATISFIED_ASSERTION', 'MALFORMED_ASSERTION', 'MISSING_OUTCOME']);
const COVERAGE_CODES = new Set([
  'NON_EXHAUSTIVE_BRANCH', 'LLM_INPUT_NOT_ENUM', 'BRANCH_BAD_ON',
  'DECISION_TABLE_GAP', 'UNIQUE_HIT_OVERLAP',
]);

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

function validatorFor(capabilities) {
  return new WorkflowValidator({
    nodeTypes:       nodeTypes(),
    channelRegistry: channelView(capabilities),
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
      decidable:  true,
      blocking,
    });
  });

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

  // ── 3. Coverage gaps the validator does not compute (until Increment E) ───
  // The DMN analysis: an input combination no rule matches, and — under UNIQUE —
  // rules that overlap. Box subtraction, never cross-product enumeration.
  for (const node of nodes) {
    if (node?.type !== 'decision') continue;

    const table = {
      inputs:    node.inputs    ?? node.config?.inputs    ?? [],
      rules:     node.rules     ?? node.config?.rules     ?? [],
      hitPolicy: node.hitPolicy ?? node.config?.hitPolicy ?? 'FIRST',
    };
    const analysis = analyzeTable(table);

    // UNDECIDABLE. Say so plainly, and offer the only honest resolution: a
    // catch-all. Never imply a completeness proof we cannot make — that is the
    // whole moat (converger-v2 §3).
    if (!analysis.decidable) {
      for (const u of analysis.undecidable) {
        gaps.push({
          id: `gap_undecidable_${node.id}_${u.key}`.toLowerCase(),
          class: 'coverage', nodeId: node.id,
          code: 'DECISION_UNDECIDABLE', severity: analysis.hasCatchAll ? 'warning' : 'error',
          message: `"${node.label || node.id}" decides on "${u.key}", but ${u.reason} — so I can't prove every case is covered.`,
          hint: 'Give it a closed list of possible values, or add a catch-all rule (every input "-") so an unanticipated input still goes somewhere.',
          resolution: analysis.hasCatchAll ? 'escalated' : 'unanswered',
          decidable: false,
          blocking: !analysis.hasCatchAll,
        });
      }
      for (const b of analysis.badConditions) {
        gaps.push({
          id: `gap_badcond_${node.id}_${b.rule}_${b.key}`.toLowerCase(),
          class: 'coverage', nodeId: node.id,
          code: 'DECISION_BAD_CONDITION', severity: 'error',
          message: `Rule ${b.rule + 1} of "${node.label || node.id}" tests "${b.key}" with "${b.condition}", which isn't a condition this system can check.`,
          hint: 'Allowed: a literal, a comma list, < <= > >=, an interval like [10..50], not(...), or "-" for "don\'t care".',
          resolution: 'unanswered', decidable: false, blocking: true,
        });
      }
      continue;   // no coverage claim is made about a table we cannot read
    }

    for (const box of analysis.uncovered) {
      const where = Object.entries(box).map(([k, v]) => `${k} ${v}`).join(', ');
      gaps.push({
        id: `gap_uncovered_${node.id}_${gaps.length}`.toLowerCase(),
        class: 'coverage', nodeId: node.id,
        code: 'DECISION_TABLE_GAP', severity: 'warning',
        message: `"${node.label || node.id}" has no rule for: ${where}. Right now the workflow would silently do nothing for those.`,
        hint: 'Answer it, or let it escalate — an unanticipated case goes to a person instead of vanishing.',
        resolution: 'escalated', decidable: true, blocking: false,
      });
    }
    if (analysis.truncated) {
      gaps.push({
        id: `gap_uncovered_more_${node.id}`.toLowerCase(),
        class: 'coverage', nodeId: node.id,
        code: 'DECISION_TABLE_GAP', severity: 'warning',
        message: `"${node.label || node.id}" has ${analysis.truncated} further uncovered combination${analysis.truncated > 1 ? 's' : ''} beyond the ones listed.`,
        hint: 'A table with this many holes is usually two decisions wearing one hat. Consider splitting it.',
        resolution: 'escalated', decidable: true, blocking: false,
      });
    }

    for (const o of analysis.overlaps) {
      const where = Object.entries(o.where).map(([k, v]) => `${k} ${v}`).join(', ');
      gaps.push({
        id: `gap_overlap_${node.id}_${o.rules.join('_')}`.toLowerCase(),
        class: 'coverage', nodeId: node.id,
        code: 'UNIQUE_HIT_OVERLAP', severity: 'error',
        message: `"${node.label || node.id}" promises exactly one rule ever matches, but rules ${o.rules[0] + 1} and ${o.rules[1] + 1} both match ${where}.`,
        hint: 'Either narrow the rules so they cannot both match, or change the hit policy to "first match wins".',
        resolution: 'unanswered', decidable: true, blocking: true,
      });
    }
  }

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
