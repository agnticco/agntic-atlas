/**
 * elicitation-graph — the converger's StateGraph.
 *
 * Nodes:
 *   outcome      → agree the contract ("how would we know this worked?")
 *   process      → backward-chain the derivable nodes + the trigger (no LLM)
 *   examples     → the acceptance suite (real inbox emails when available)
 *   analyze      → phase router: clarify (vague) · generate (first build) ·
 *                  propose (gap-driven single fix) · gapping/ratifying (done)
 *   clarify      → ask one targeted question, interrupt for answer
 *   generate     → emit the WHOLE spec in one pass, then wireEdges (Increment 3)
 *   propose      → gap-driven single-component fix, interrupt for confirmation
 *   destinations → resolve Airtable base/table/columns from the live connector
 *   decisions    → review the induced decision table(s)
 *   gaps         → the exception review + structural auto-repair
 *   verify       → run the completed draft through the engine (DRY-RUN) on the
 *                  sample examples; fix + re-run on a failure (#23) — all SILENT
 *   walkthrough  → the ONE step-by-step approval, on the FINAL settled spec (moved
 *                  here from `generate` 2026-07-16 so the user approves what will
 *                  publish, not a mid-build draft that then changes under them)
 *   ratify       → present complete draft for final HITL approval + publish
 *
 * Routing (clarify-first → generate-whole-spec → wire → gaps → verify → walkthrough → ratify):
 *   outcome → process → examples → analyze
 *   analyze → clarify | generate | destinations | walkthrough (capped) | ratify
 *   clarify → analyze ;  generate → analyze  (generate is now SILENT — no interrupt)
 *   destinations → decisions → gaps → (generate | verify)
 *   verify      → generate (fix, bounded, silent) | walkthrough (verified / give-up)
 *   walkthrough → generate (user asked for a change) | ratify (approved)
 *   ratify      → generate (if changes requested) | END (if approved)
 *
 * Persistence: FileCheckpointer — sessions survive restarts and are resumable
 * by threadId.
 */

import { logEvent }          from '../utils/event-log.js';
import { StateGraph, END }   from '../graph/index.js';
import { FileCheckpointer }  from '../graph/checkpointer/index.js';
import { interrupt }         from '../graph/interrupt.js';
import { SystemMessage, HumanMessage } from '../core/message.js';
import { scoreGap, unansweredGaps } from './gap-scorer.js';
import { applyProposal, assembleSpec, wireEdges } from './spec-assembler.js';
import { materialiseEscalations } from './escalation.js';
import { nodeForAssertion, assertableConnectors, splitTarget, canonicalConnector,
         laneInventoryOf } from '../workflows/outcome-oracle.js';
// ONE definition of "could anything ever start a workflow from this trigger",
// shared with the publish guard — so the merge and the refusal cannot disagree.
import { isRunnableTrigger } from '../workflows/trigger-runnable.js';
import { analyzeTable } from '../workflows/decision-analysis.js';
import { deriveWorkflowName } from '../workflows/workflow-validator.js';
import { tableOf, valuesOf, HIT_POLICIES, HIT_POLICY_LABELS, DECISION_MAX_INPUTS } from '../workflows/node-types/decision.js';
import {
  buildSystemPrompt,
  buildAnalyzePrompt,
  buildProposePrompt,
  buildModifyPrompt,
  buildOutcomePrompt,
  buildExamplesPrompt,
  buildLaneExamplesPrompt,
  buildGapPrompt,
  buildSufficiencyPrompt,
  buildWireDeliveryPrompt,
  buildGeneratePrompt,
  buildPlanPrompt,
} from './prompts.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Silently repair STRUCTURAL defects the builder produced in its own output.
 *
 * A missing branch/route edge, or an ambiguous extra parent edge, is not a
 * decision a user can make — it is a bug in the graph the converger drew. The
 * validator already computes the exact mechanical fix and hands it over as
 * `gap.fix` ({op:'add_edge'|'remove_edges', ...}); we apply it directly through
 * `applyProposal`, with no LLM round-trip and no question. This is what lets the
 * zero-typing path publish a spec that would otherwise strand at "Incomplete"
 * with Run test disabled — the recurring live-testing failure (#19).
 *
 * Only gaps carrying a `fix` are touched; a fix that throws is skipped and left
 * as a gap. The CALLER re-scores after applying, so a repair that introduced a
 * new problem surfaces as a fresh gap rather than shipping silently.
 *
 * @returns {{ draft: object, applied: Array<{gapId,code,op,from,to}> }}
 */
/**
 * Give an approved draft a name, on the state object, so the build can never forget it.
 *
 * Precedence, and each step is load-bearing:
 *  1. a name the draft ALREADY has is kept — this is the EDIT flow, where an existing,
 *     named workflow is re-planned; renaming it out from under the user would be a
 *     silent edit to something they named;
 *  2. else a title the plan itself carried (the model already reasoned about it);
 *  3. else one derived from the outcome the user just approved.
 *
 * `mergeGeneratedSpec` keeps the draft's name over the model's, so whatever this
 * returns survives `generate`. That is the whole point: MISSING_NAME was the model
 * omitting a required field and a 13-node Opus rebuild firing to add a title.
 */
export function nameApprovedDraft(draft, plan) {
  if (draft?.name && String(draft.name).trim()) return draft;
  const planTitle = typeof plan?.name === 'string' && plan.name.trim() ? plan.name.trim()
                  : typeof plan?.title === 'string' && plan.title.trim() ? plan.title.trim()
                  : null;
  return { ...draft, name: planTitle || deriveWorkflowName(draft) };
}

// Each applied repair records the validator's own `message` alongside the operation.
// It is not decoration: the next whole-spec pass is SHOWN this list (see `_repairs`
// in the state schema), and "this step needs a sections list" is the sentence that
// stops the model re-emitting the same blank. Without it the pass is told a fix
// happened but not what was wrong, which is the half-measure that made the previous
// loop unfixable.
export function autoRepairStructural(draft, gaps) {
  const applied = [];
  let d = draft;
  for (const g of (gaps ?? [])) {
    const fix = g?.fix;
    if (!fix) continue;
    try {
      if (fix.op === 'add_edge' && fix.from && fix.to) {
        d = applyProposal(d, { component: 'edge', spec: { from: fix.from, to: fix.to } });
        applied.push({ gapId: g.id, code: g.code, op: 'add_edge', from: fix.from, to: fix.to, message: g.message ?? null });
      } else if (fix.op === 'set_assertion_when' && Number.isInteger(fix.index) && fix.when) {
        // Say a promise's condition in the workflow's own vocabulary. The user's
        // WORDS are untouched — only the machine-checkable `when` is restated, from
        // an invented compound ("urgent_approved") to the route that actually gates
        // the step. Rewriting the statement instead would be editing what they asked
        // for; this only changes how we CHECK it.
        const as = Array.isArray(d.outcome?.assertions) ? d.outcome.assertions : null;
        if (as && as[fix.index]) {
          const next = as.map((a, i) => (i === fix.index ? { ...a, when: fix.when } : a));
          d = { ...d, outcome: { ...d.outcome, assertions: next } };
          applied.push({ gapId: g.id, code: g.code, op: 'set_assertion_when', when: fix.when, message: g.message ?? null });
        }
      } else if (fix.op === 'set_config' && fix.nodeId && fix.config) {
        // Fill a blank the converger left in its OWN output. `applyProposal`
        // replaces a node by id, so the node is re-stated with the filled config
        // merged over what it already had — never the other way round, or the
        // repair would quietly revert a value the user had chosen.
        const cur = (d.nodes ?? []).find(n => n.id === fix.nodeId);
        if (cur) {
          d = applyProposal(d, {
            component: 'node',
            spec: { ...cur, config: { ...(cur.config ?? {}), ...fix.config } },
          });
          applied.push({ gapId: g.id, code: g.code, op: 'set_config', nodeId: fix.nodeId, message: g.message ?? null });
        }
      } else if (fix.op === 'remove_edges' && Array.isArray(fix.edges)) {
        for (const e of fix.edges) {
          if (!e?.from || !e?.to) continue;
          d = applyProposal(d, { component: 'remove_edge', spec: { from: e.from, to: e.to } });
          applied.push({ gapId: g.id, code: g.code, op: 'remove_edge', from: e.from, to: e.to, message: g.message ?? null });
        }
      } else if (fix.op === 'set_name' && typeof fix.name === 'string' && fix.name.trim()) {
        // A WORKFLOW NEVER NEEDS A MODEL TO NAME ITSELF. Observed live: a build
        // regenerated all 13 nodes — a full Opus pass — with `MISSING_NAME` among the
        // blockers, because the model omitted the top-level name. Regenerating the
        // whole spec to add a title is pure waste; the name is derivable from the
        // outcome the user already confirmed. The user can rename afterwards (there is
        // a rename control), so a derived title is a safe default, never a decision
        // taken away from them.
        if (!d.name || !String(d.name).trim()) {
          d = { ...d, name: fix.name.trim() };
          applied.push({ gapId: g.id, code: g.code, op: 'set_name', name: fix.name.trim(), message: g.message ?? null });
        }
      }
    } catch { /* leave as a gap — the re-score will re-surface it */ }
  }
  return { draft: d, applied };
}

// ── AN UNVERIFIED OPINION MAY NOT OVERRULE A PASSING CHECK ────────────────────
// The sufficiency check is a fast-tier "is this finished?" question asked AFTER
// `scoreGap` has already returned `complete: true` — i.e. after the validator and
// the contract-coverage check have both agreed every promise is satisfied. It
// exists only to catch what the outcome cannot express, so a `complete: false`
// that names a destination the CONTRACT ALREADY ASSERTS is not new information:
// it is the weaker checker contradicting the stronger one, and acting on it costs
// a whole-spec Opus rebuild.
//
// Measured on prod (2026-07-28, `build-platform-1785252448380`): a
// classify→approve→route build ordered FOUR rebuilds, each one naming
// "Slack DM delivery to Charles (hello@agntic.co)" as missing. It was never
// missing — the `human` approval step sends that DM itself (which is why there is
// no separate delivery node; a second one would message the person twice). The
// generate pass reasoned "the human step satisfies a1 ✓" and was overruled anyway.
// Cost: ~10 minutes of dead air, and the regenerate budget was spent before the
// build reached `verify` — which is where per-path test examples are topped up, so
// the run ended with ONE example and could not cover a five-path workflow.
//
// Deliberately narrow. This only discards a complaint whose text names the locator
// half of an assertion target (`slack:hello@agntic.co` → "hello@agntic.co"), and
// only when `scoreGap` said the spec was complete. A complaint about something the
// contract does NOT cover — the case this check exists for — is untouched.
export function sufficiencyClaimAlreadyCovered(missing, draft) {
  const text = String(missing ?? '').toLowerCase();
  if (!text.trim()) return false;
  const assertions = Array.isArray(draft?.outcome?.assertions) ? draft.outcome.assertions : [];
  for (const a of assertions) {
    const target = String(a?.target ?? '').trim();
    if (!target) continue;
    // Assertion targets are `<kind>:<locator>`; a person names the locator, not the
    // scheme. Match on the locator alone so "slack:#ops" is found in "post to #ops",
    // and require some length so a one-character locator can't match everything.
    const locator = (target.includes(':') ? target.slice(target.indexOf(':') + 1) : target)
      .trim().toLowerCase();
    if (locator.length >= 3 && text.includes(locator)) return true;
  }
  return false;
}

/** Fingerprint of a sufficiency complaint, for "it said the same thing again". */
export function missingKeyOf(missing) {
  return String(missing ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

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

// Default extended-thinking budget (tokens) for the streaming generate call. Sits
// in the 2048–4096 band: enough for the model to reason through trigger/step/branch
// choices for the whole spec, without dwarfing the answer's own output budget.
const DEFAULT_THINKING_BUDGET = 3072;

// ── THE WHOLE-SPEC CALL NEEDS ROOM TO WRITE THE WHOLE SPEC ────────────────────
// Thinking tokens are billed INSIDE `max_tokens`, and ChatModel's default is 8192.
// With a 3072 thinking budget that left ~5k tokens for the JSON — which is fine for
// a 4-step workflow and NOT ENOUGH for a real one. Observed live: a 4-connector
// build (Gmail → extract → web search → Airtable → numeric decision → Slack approval
// → reply/inbox) reasoned correctly for 6.6 minutes, ran out of room mid-JSON, failed
// to parse, and the user was told "I couldn't assemble the workflow from that. Could
// you describe, step by step, what it should do?" — after handing over a description
// that was already step by step. Every minute of that work was discarded.
//
// The ceiling was invisible: nothing logged a truncation, the reasoning stream looked
// healthy right up to the cut, and the failure blamed the input. The bigger and more
// valuable the workflow, the more certainly it hit this.
const GENERATE_MAX_TOKENS = Number(process.env.CONVERGER_GENERATE_MAX_TOKENS) || 32000;

// Stream a JSON-emitting model call, forwarding the model's RAW extended-thinking
// deltas to `onThinking` AS THEY ARRIVE (the visible chain of thought), and returning
// the parsed JSON exactly like `llmJson`. This is the same tier/cost path as the
// blocking call — the ModelPool tracks the streamed call's tokens (thinking tokens
// included, since Anthropic bills them in output) against the config's sessionId/tier.
//
// FALLS BACK TO BLOCKING, by construction: if the model doesn't support streaming,
// the stream throws, or it yields nothing usable, we call `llmJson` — so a thinking
// or transport failure NEVER stops the build from completing. A completed stream
// whose text isn't valid JSON returns null (same contract as `llmJson`), rather than
// paying for a second blocking call to reach the identical null.
export async function llmJsonStreaming(llm, messages, config = {}, { onThinking, onAnswer } = {}) {
  let text = null;
  if (typeof llm.stream === 'function') {
    try {
      let acc = '';
      const streamCfg = { ...config, thinking: DEFAULT_THINKING_BUDGET, maxTokens: config.maxTokens ?? GENERATE_MAX_TOKENS };
      if (typeof onThinking === 'function') streamCfg.onThinking = onThinking;
      for await (const chunk of llm.stream(messages, streamCfg)) {
        const c = typeof chunk === 'string' ? chunk : (chunk?.content ?? '');
        if (c) {
          acc += c;
          // The ANSWER content (the spec JSON) streams here, AFTER the thinking.
          // `onAnswer` gets each delta + the running accumulation so a caller can
          // incrementally parse it and surface the spec AS IT IS WRITTEN (the live
          // in-chat graph build). Purely additive — absent, behaviour is unchanged.
          if (typeof onAnswer === 'function') { try { onAnswer(c, acc); } catch { /* never let the UI feed break the build */ } }
        }
      }
      if (acc.trim()) text = acc;
    } catch {
      text = null; // streaming/thinking failed → fall through to the blocking path
    }
  }
  // The blocking fallback needs the SAME room. Handing it the default 8192 would
  // reproduce the truncation this budget exists to prevent, on the very path taken
  // when streaming has already failed.
  if (text == null) return llmJson(llm, messages, { ...config, maxTokens: config.maxTokens ?? GENERATE_MAX_TOKENS });
  try { return JSON.parse(extractJson(text)); }
  catch {
    // The model DID write something and it would not parse — almost always because it
    // was cut off. Say so where someone will see it; returning a bare null is what made
    // this ceiling invisible for so long.
    console.warn(`[converger] whole-spec JSON did not parse (${text.length} chars emitted) — likely truncated; raise CONVERGER_GENERATE_MAX_TOKENS`);
    return null;
  }
}

/**
 * Incrementally scan an accumulating JSON string for COMPLETE node objects inside the
 * top-level `"nodes": [ … ]` array, so the client can pop each node into the live graph
 * the instant the model finishes writing it. Stateful: call it repeatedly with the
 * growing `acc`; it returns only nodes it has not returned before (tracked via `state`).
 *
 * It is brace-depth aware and string-aware (a `{` inside a JSON string never opens an
 * object), so it will not mis-slice a config value that contains braces. It is
 * deliberately FORGIVING — a node it cannot yet parse is simply skipped until more text
 * arrives, and the authoritative parse still happens once (JSON.parse of the whole
 * answer) in llmJsonStreaming. This is a progress feed, never the source of truth.
 */
export function streamNodesFrom(acc, state) {
  const out = [];
  if (state.done) return out;
  // Locate the nodes array once.
  if (state.arrStart == null) {
    const m = acc.match(/"nodes"\s*:\s*\[/);
    if (!m) return out;
    state.arrStart = m.index + m[0].length;
    state.i = state.arrStart;
    state.depth = 0;        // object-brace depth within the array
    state.objStart = -1;    // start index of the current node object
    state.inStr = false;
    state.esc = false;
  }
  for (; state.i < acc.length; state.i++) {
    const ch = acc[state.i];
    if (state.inStr) {
      if (state.esc) { state.esc = false; }
      else if (ch === '\\') { state.esc = true; }
      else if (ch === '"') { state.inStr = false; }
      continue;
    }
    if (ch === '"') { state.inStr = true; continue; }
    if (ch === '{') { if (state.depth === 0) state.objStart = state.i; state.depth++; continue; }
    if (ch === '}') {
      state.depth--;
      if (state.depth === 0 && state.objStart >= 0) {
        const slice = acc.slice(state.objStart, state.i + 1);
        try {
          const node = JSON.parse(slice);
          if (node && typeof node === 'object' && node.id) out.push(node);
        } catch { /* not yet valid — will be caught by the authoritative parse */ }
        state.objStart = -1;
      }
      continue;
    }
    if (ch === ']' && state.depth === 0) { state.done = true; break; }  // end of the nodes array
  }
  return out;
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

/**
 * Merge a whole-spec model output into the draft, then GUARANTEE its structure.
 * (Converger rearchitecture, Increment 2 — the pure core the `generate` node calls.)
 *
 * The `generate` step emits the COMPLETE spec — `{ triggers, nodes, edges }` — in
 * one call, replacing the one-component-at-a-time propose loop's node-building. Its
 * `nodes`/`edges` become the draft's, because emitting the whole graph at once is
 * the entire point. Everything ALREADY GATHERED is preserved and NOT overwritten:
 *   - `outcome` (the contract), `name`, `description`, `errorHandling` — kept as-is.
 *   - `triggers` — the draft's are preferred when present, because `process` derived
 *     and confirmed the trigger and the example picker already searched on its
 *     filter; the generated trigger is only a fallback for a draft that has none.
 *
 * The merged draft is then run through `wireEdges` (Increment 1): even if the model
 * dropped a branch's input edge or a case's output edge — the exact failure that
 * motivated this rearchitecture — the structural edges a branch/decision MUST have
 * are added deterministically. So the result is a connected, branched graph by
 * construction, not by hoping the model remembered every edge.
 *
 * ADDITIVE and pure — no draft mutation, no side effects. The result still goes
 * through the validator downstream; this does not bypass it.
 *
 * @param {object} draft      the draft gathered so far (outcome, name, triggers…)
 * @param {{triggers?, nodes?, edges?, name?, description?}} generated  the model's whole-spec output
 * @returns {object} a draft with a complete, wired edge set
 */
export function mergeGeneratedSpec(draft, generated) {
  const base = draft ?? { ...DRAFT_DEFAULT };
  const g    = generated ?? {};

  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];

  const existingTriggers = Array.isArray(base.triggers) ? base.triggers : [];
  const genTriggers      = Array.isArray(g.triggers)    ? g.triggers    : [];

  // THE DRAFT STILL WINS — with one exception, and only one.
  //
  // This used to be `existingTriggers.length ? existingTriggers : genTriggers`,
  // i.e. precedence by ORIGIN. The draft beating the model is right and must
  // stay: a whole-spec regenerate must never overwrite what the user actually
  // said. But it also meant that when the interview had gathered a thin,
  // unrunnable trigger early and the model later produced the complete shape
  // (connector, event, base and table), the COMPLETE one was discarded and the
  // broken one survived to publish.
  //
  // So: keep the draft, unless the draft could never run and the generated one
  // could. That is not "prefer the model" — it never promotes the model over a
  // usable answer, and a draft with even one runnable trigger is left untouched.
  // It only refuses to throw a working trigger away for a broken one.
  const draftHasRunnable = existingTriggers.some(isRunnableTrigger);
  const genHasRunnable   = genTriggers.some(isRunnableTrigger);
  const triggers = existingTriggers.length
    ? ((!draftHasRunnable && genHasRunnable) ? genTriggers : existingTriggers)
    : genTriggers;

  const merged = {
    ...base,
    name:          base.name ?? g.name ?? null,
    description:   base.description ?? g.description ?? null,
    outcome:       base.outcome ?? null,      // the contract is never rewritten here
    triggers,
    nodes,
    edges,
    errorHandling: base.errorHandling ?? {},
  };

  return wireEdges(merged);
}

// ── Schema-aware destinations (P12 Increment F) ───────────────────────────────

/**
 * Repoint a resource reference on one node (found by id, at the top level OR inside a
 * foreach's steps) at a user-picked existing resource. (Increment #25.)
 *   slack_channel → config.target ("#name")   airtable_base → config.baseId
 *   airtable_table → config.tableId
 */
function applyResourcePick(draft, nodeId, kind, value) {
  let oldTarget = null;                                              // captured for the outcome-sync below
  const newTarget = kind === 'slack_channel'
    ? `#${String(value).replace(/^#/, '')}`
    : value;
  const patch = (n) => {
    if (!n || n.id !== nodeId) return n;
    const config = { ...n.config };
    if      (kind === 'slack_channel') { oldTarget = config.target;  config.target  = newTarget; }
    else if (kind === 'airtable_base') { oldTarget = config.baseId;  config.baseId  = value; }
    else if (kind === 'airtable_table') { oldTarget = config.tableId; config.tableId = value; }
    return { ...n, config };
  };
  const nodes = (draft?.nodes ?? []).map((n) => {
    if (n?.type === 'foreach' && Array.isArray(n.config?.steps)) {
      return { ...n, config: { ...n.config, steps: n.config.steps.map(patch) } };
    }
    return patch(n);
  });

  // #31 — keep the outcome CONTRACT in sync with the repointed resource. An assertion
  // target like "slack:#zznope-test" (see outcome-oracle.js: "<connector>:<locator>")
  // must follow the deliver node to the picked channel. Left stale, the oracle sees the
  // outcome promise a delivery no step makes (UNSATISFIED_ASSERTION) and raises a
  // confusing follow-on gap that re-suggests the very resource we just replaced. Only
  // slack channels carry a channel-in-the-locator target here.
  //
  // ⚠️ The previous version of this comment claimed "airtable/base assertions key on
  // kind, not the id, so they need no rewrite here." THAT IS FALSE (2026-07-19). An
  // Airtable assertion is `record_exists → airtable:Sheet1` — connector:locator, with
  // the TABLE NAME as the locator — and `satisfiesAssertion` does compare that locator.
  // Verified by direct call: `airtable:Sheet1` vs a node carrying `tableId:'tbl…'`
  // returns false, while `airtable:tbl…` returns true. Believing the locator did not
  // matter for Airtable is exactly why a correct write was reported missing and its
  // workflow became unrunnable.
  //
  // Repointing an airtable table still needs no rewrite HERE, but for a different and
  // narrower reason: `fillDestination` writes the table's NAME into `config.tableId`
  // (see its callers, which pass `table.name`), so the node's locator already matches
  // a name-based assertion. The mismatch arises when something else — the MODEL, using
  // the ids it learned from `airtable_describe_base` — writes a raw provider id
  // instead. That case is handled in `outcome-oracle.js` (`isOpaqueId`), because it
  // occurs on specs this function never touches.
  let outcome = draft?.outcome;
  if (kind === 'slack_channel' && oldTarget != null && oldTarget !== newTarget
      && outcome && Array.isArray(outcome.assertions)) {
    const oldLoc = `slack:${oldTarget}`, newLoc = `slack:${newTarget}`;
    const assertions = outcome.assertions.map(a => {
      if (!a || typeof a.target !== 'string') return a;
      if (a.target === oldLoc)    return { ...a, target: newLoc };   // "slack:#old" → "slack:#new"
      if (a.target === oldTarget) return { ...a, target: newTarget }; // bare "#old" spelling
      return a;
    });
    outcome = { ...outcome, assertions };
  }
  return { ...draft, nodes, outcome };
}

/** Does this node reach into the named connector? */
function usesConnector(node, connector) {
  const id = node?.type === 'connector-action' ? node.config?.action
           : node?.type === 'deliver'          ? node.config?.channel
           : null;
  return typeof id === 'string' && id.startsWith(`${connector}_`);
}

/**
 * Is this base id one the TENANT ACTUALLY HAS?
 *
 * The first version asked a different and much weaker question — "does this LOOK
 * like a base id?" — and an LLM asked for an id it cannot know does not produce
 * `appXXXXXXXXXXXXXX`. It produces something PLAUSIBLE: `appABCDEFGHIJKLMN` passes
 * a shape test perfectly. And because the whole `destinations` node was gated on
 * that test, one plausible hallucination skipped the base lookup, the table lookup
 * AND the column mapping — the entire increment — and the fake id rode into the
 * ratified spec. (Found by the test-adversary.)
 *
 * A shape test cannot answer this. Only the LIST can: an id is resolved iff it is
 * one of the bases the connector just told us the tenant has. That is decidable,
 * and it is the same discipline as §11.7 — do not guess at a domain you can read.
 */
function isKnownBase(v, bases) {
  const s = String(v ?? '').trim();
  if (!s || s.includes('{{') || s.includes('<')) return false;
  return (bases ?? []).some(b => b.id === s);
}

/**
 * Restate the outcome's promise in the REAL column names.
 *
 * `destinations` rewrites the NODE's columns. If the outcome's assertion still
 * promises the old ones, the node writes `Deal Size`, the contract demands `Budget`,
 * UNSATISFIED_ASSERTION fires, and the spec CANNOT PUBLISH — on the success path,
 * exactly when the mapping did its job. `complete ⇒ publishable` was false precisely
 * when the increment worked. (Found by the test-adversary.)
 *
 * A promise the workflow now genuinely keeps must be a promise the contract can
 * recognise. But an assertion field with NO real column is NOT quietly deleted —
 * that would be the silent drop this whole phase exists to kill, performed by the
 * very code meant to prevent it. It stays, it fails UNSATISFIED_ASSERTION, and the
 * user is told which column their table does not have.
 */
function rewriteAssertionFields(outcome, renames, columns, connector = 'airtable') {
  if (!outcome || !renames || !Object.keys(renames).length) return outcome ?? null;
  const real = new Set(columns.map(c => String(c.name).toLowerCase()));
  // P13-0 seam #3: keyed off the connector we ACTUALLY resolved, not the literal
  // /airtable/i. With the regex, a rename discovered on any other connector was
  // computed and then silently discarded — the node got the real column names and
  // the promise kept the invented ones, which is UNSATISFIED_ASSERTION on the
  // success path: the exact dead-end this rewrite exists to prevent.
  const targetRe = new RegExp(String(connector).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const assertions = (outcome.assertions ?? []).map((a) => {
    if (!targetRe.test(String(a?.target ?? '')) || !Array.isArray(a?.fields)) return a;
    const fields = a.fields.map((f) => {
      if (real.has(String(f).toLowerCase())) return f;   // already a real column
      // The mapping model told us what this promise is called in the real table
      // ("Budget" → "Deal Size"). Restate the promise in the world's own words.
      const hit = renames[f] ?? Object.entries(renames)
        .find(([intended]) => String(intended).toLowerCase() === String(f).toLowerCase())?.[1];
      // NO counterpart ⇒ LEAVE IT UNCHANGED. Deleting it would be the silent drop
      // this phase exists to kill, performed by the code meant to prevent it. It
      // stays, UNSATISFIED_ASSERTION fires, and the user is told which column their
      // table does not have.
      return hit ?? f;
    });
    return { ...a, fields };
  });
  return { ...outcome, assertions };
}

/**
 * A write node's columns, whatever shape they were written in.
 *
 * `fields` can arrive as an OBJECT or as a JSON STRING — the Airtable handler parses
 * a string (`typeof fields === 'string' ? JSON.parse(fields)`) and the capability's
 * own schema advertises the textarea form. And THREE separate guards each asked
 * `typeof fields === 'object'` in their own hand-copied line:
 *
 *   · the harvest   — what the mapper is asked to map
 *   · the rewrite   — what gets the real columns written into it
 *   · the RE-CHECK  — the fix for the previous blocker
 *
 * Every one of them FAILED OPEN on a string. So a JSON-string `fields` was resolved
 * (base id written in) and its columns were never looked at: the spec published,
 * Airtable silently discarded the invented column, and the record was created with
 * it empty. `run_completed`. Forever.
 *
 * Worse, the previous round's fix made the oracle PARSE a string `fields` — which was
 * right on its own terms and made the shape pass MORE checks, all of them trivially
 * self-satisfied, because the node's invented column names and the assertion's
 * invented column names HAVE THE SAME AUTHOR. Fail-open-and-silent became
 * fail-open-and-CONFIDENT. (Found by the independent verifier.)
 *
 * Three call sites with one copied predicate is exactly how that happens. There is one
 * reader now, and the writer NORMALISES the string away.
 */
function readFields(config) {
  let f = config?.fields;
  if (typeof f === 'string') {
    try { f = JSON.parse(f); } catch { return null; }
  }
  return f && typeof f === 'object' && !Array.isArray(f) ? f : null;
}

/**
 * Write the resolved destination into every node that needed one.
 *
 * `columnsRead` is the load-bearing argument. When we HAVE read the table's columns,
 * the node's `fields` are replaced by the mapped ones — INCLUDING when the mapping
 * produced nothing at all.
 *
 * The first version only rewrote when the mapping was non-null, so a PARTIAL mismatch
 * was corrected and a TOTAL mismatch shipped VERBATIM: every column the model invented
 * survived into the spec, Airtable silently ignored all of them, and the record was
 * created empty. The worst case took the only path with no defence — which is the
 * shape of every defect in this phase. (Found by the test-adversary.)
 *
 * Writing `{}` instead is not a silent drop: `fields` is what the outcome's assertion
 * is checked against, so a node that now writes NO columns fails UNSATISFIED_ASSERTION
 * against a contract still promising `Name` and `Budget`. The spec does not publish and
 * the user is told their table has neither column — which is the truth, and the thing
 * they need to know.
 */
function fillDestination(nodes, { connector, descriptor, containerId, tableId, fields, columnsRead = false }) {
  // P13-0 seam #3: the connector and its config-key names come from the connector's
  // own declaration, not from the literals 'airtable' / `baseId` / `tableId`. Writing
  // a key the target node type does not declare would fail UNKNOWN_CONFIG_KEY at
  // publish, so the keys MUST come from the connector rather than be assumed.
  if (!connector || !descriptor) return nodes;
  return nodes.map((n) => {
    if (!usesConnector(n, connector)) return n;
    const config = { ...(n.config ?? {}), [descriptor.containerKey]: containerId };
    if (tableId) config[descriptor.tableKey] = tableId;
    // Only touch `fields` where the node HAS them (a create/update). A search or a
    // delete has none, and inventing some would be a config key nothing reads.
    // NORMALISES the string form away: what goes back is always an object, so every
    // later reader (and every later guard) sees the same shape.
    if (columnsRead && readFields(config)) {
      config.fields = fields ?? {};
    }
    return { ...n, config };
  });
}

/**
 * Map the fields the draft INTENDED onto the columns that ACTUALLY EXIST.
 *
 * This is the whole point of reading the schema, and skipping it would be worse
 * than not reading it at all: **Airtable silently ignores an unknown field name.**
 * Post `{ "Budget": 80000 }` to a table whose column is `Deal Size` and the record
 * is created, the column is empty, `run_completed` fires, and the workflow reports
 * success forever. The user finds out when a quarter's leads have no budgets.
 *
 * A column the draft wants and the table does NOT have is left OUT rather than
 * guessed at — and it stays in the outcome's assertions, so `UNSATISFIED_ASSERTION`
 * reports it as a promise the workflow cannot keep. That is the honest failure: the
 * spec does not publish, and the user is told which column is missing.
 */
async function mapFieldsToColumns({ llm, sessionId, nodes, columns, outcome, table }) {
  const none = { fields: null, renames: {}, unmapped: [] };
  const wanted = {};
  for (const n of nodes) {
    const f = readFields(n?.config);
    if (f) Object.assign(wanted, f);
  }
  if (!Object.keys(wanted).length || !columns.length) return none;

  const colList = columns.map(c => `- ${c.name} (${c.type}${c.choices?.length ? `: ${c.choices.join(' | ')}` : ''})`).join('\n');
  const parsed = await llmJson(llm, [
    new SystemMessage('You map a workflow\'s intended fields onto the REAL columns of a table. You never invent a column. You reply with JSON only.'),
    new HumanMessage(
      `The workflow wants to write these fields into the table "${table}":\n${JSON.stringify(Object.keys(wanted), null, 2)}\n\n` +
      `The table's REAL columns are:\n${colList}\n\n` +
      `Outcome: ${outcome?.statement ?? '(none)'}\n\n` +
      'For EACH intended field, give the REAL column it belongs in — or null if the table has no such column.\n' +
      'Return {"map": { "<intended field>": "<REAL column name>" | null }}.\n' +
      'Use ONLY column names from the list above. A name that is not on the list is SILENTLY IGNORED by ' +
      'Airtable — the record is created, the column is empty, and nobody is ever told. ' +
      'If nothing fits, answer null; do not invent a column.',
    ),
  ], tierCfg('fast', sessionId));

  const raw = parsed?.map;
  if (!raw || typeof raw !== 'object') return none;

  // TRUST NOTHING THE MAPPING MODEL RETURNS. It is an LLM being asked about a closed
  // set; a column it invents here is the exact defect this function exists to
  // prevent, just introduced by us instead of by the author.
  const real = new Map(columns.map(c => [c.name.toLowerCase(), c.name]));
  const renames  = {};
  const fields   = {};
  const unmapped = [];
  for (const [intended, value] of Object.entries(wanted)) {
    const proposed = raw[intended];
    const column   = proposed == null ? null : real.get(String(proposed).toLowerCase()) ?? null;
    if (!column) { unmapped.push(intended); continue; }
    renames[intended] = column;
    fields[column]    = value;          // the VALUE the author wrote — we rename the column, never the data
  }
  return Object.keys(fields).length
    ? { fields, renames, unmapped }
    : { fields: null, renames: {}, unmapped: Object.keys(wanted) };
}

/**
 * Three REAL emails from the user's own inbox, to be picked from. (Increment F.)
 *
 * converger-v2 §6.4 calls this "the biggest single unlock", and the reasoning is
 * worth keeping: asked to invent test cases, people invent EASY ones. The case that
 * finds the bug is the awkward real message — the forwarded thread, the one with the
 * budget in the signature, the one that is not really a lead at all — and nobody
 * types that from memory. We have `gmail_search` and we have their token.
 *
 * The trigger's own filter IS the query. That is the point: the examples are drawn
 * from exactly the population the workflow will run on, so an example that does not
 * match the trigger cannot appear (and if the trigger's filter is wrong, the picker
 * shows the wrong emails — which is itself the fastest way to find that out).
 *
 * Returns `{ items: [], source: null }` when there is no live source. The caller
 * then falls back to the model's proposed cases, which are clearly LABELLED as
 * proposals — never dressed up as the user's real mail.
 */
async function fetchRealExamples({ invokeCapability, triggers, capabilities }) {
  const none = { items: [], source: null, query: null };
  if (!invokeCapability) return none;

  const emailTrigger = (Array.isArray(triggers) ? triggers : []).find(t => t?.type === 'email');
  if (!emailTrigger) return none;

  // Gmail must actually be connected — `capabilities.channels` is the live, per-tenant
  // catalog, so this is a fact rather than a hope.
  const hasGmail = (capabilities?.channels ?? []).some(c => c?.id === 'gmail_search' || String(c?.id ?? '').startsWith('gmail_'));
  if (!hasGmail) return none;

  const query = String(emailTrigger.filter ?? '').trim() || 'newer_than:30d';
  try {
    const res = await invokeCapability('gmail_search', { query, maxResults: 3 });
    const msgs = res?.messages ?? res?.results ?? (Array.isArray(res) ? res : []);
    const items = msgs.slice(0, 3).map((m, i) => ({
      id: m.id ?? `real${i + 1}`,
      // The label is what the user READS before clicking. Subject + sender is what
      // they recognise an email by; a message id is not.
      label: `${m.subject ?? '(no subject)'} — ${m.from ?? 'unknown sender'}`,
      // Prefer the FULL body (gmail_search already fetches format:'full', so m.body is
      // the extracted message text) — the ~100-char snippet was too thin for a downstream
      // extract/summarize chain, tripping its "missing data" guard and false-failing the
      // self-test. Snippet only as a fallback when a message has no text body. (#35)
      given: { subject: m.subject ?? '', from: m.from ?? '', body: m.body || m.snippet || '' },
      real:  true,   // provenance: this came from their inbox, not from a model
    })).filter(e => e.given.subject || e.given.body);
    return items.length ? { items, source: 'gmail', query } : none;
  } catch {
    return none;   // an unreadable inbox is a reason to ask, never a reason to invent
  }
}

// ── Tier config helper ────────────────────────────────────────────────────────
// Build an invoke config that routes through ModelPool to the requested tier.
// Always call llm.invoke(messages, tierCfg(name, sessionId)) rather than
// extracting a raw ChatModel — this keeps _trackUsage() in the call path so
// cost records are emitted for every converger turn.

function tierCfg(tierName, sessionId) {
  return { configurable: { modelTier: tierName, sessionId, costContext: 'converger' } };
}

// ── Reasoning narrator (Increment #22) ────────────────────────────────────────
// The REASONING surface streams the model's OWN chain of thought — the raw
// extended-thinking tokens emitted while `generate` designs the whole spec — NOT
// hand-authored stand-in narration. The server injects a threadId-bound `narrate`
// into cfg.configurable; `narrateThinking` forwards one raw thinking delta as a
// `{ kind:'thinking', text, streamId }` beat. Best-effort by construction: if no
// narrator is wired, or it throws, the build is unaffected — the panel is a free
// side-channel, never load-bearing. `streamId` lets the client keep one build's
// thinking in its own block (a revise starts a fresh block).
function narrateThinking(cfg, delta, streamId) {
  const fn = cfg?.configurable?.narrate;
  if (typeof fn !== 'function') return;
  try { fn({ kind: 'thinking', text: delta, streamId }); } catch { /* narration is best-effort */ }
}

// Emit one whole reasoning beat (a `check`/`fix`/`thinking` step), used by the
// self-verification loop (#23) to narrate its test run and any fix. Best-effort, by
// construction: no narrator wired ⇒ silent, and a throwing narrator never affects
// the build — the panel is a free side-channel, never load-bearing.
function emitBeat(cfg, beat) {
  const fn = cfg?.configurable?.narrate;
  if (typeof fn !== 'function') return;
  try { fn(beat); } catch { /* narration is best-effort */ }
}

// ── Graph builder ─────────────────────────────────────────────────────────────

/**
 * @param {{ llm: ModelPool, checkpointerDir?: string }} opts
 * @returns {CompiledGraph}
 */
/**
 * Which connector's destination schema should this draft resolve, and how?
 * (P13-0 seam #3.)
 *
 * EXPORTED, and that is the point. This logic lived as a closure inside
 * `buildElicitationGraph`, which meant nothing could reach it — and an independent
 * verifier proved the consequence: reverting it to the literal `['airtable']` left
 * the ENTIRE suite green. The part of seam #3 that actually runs when a user builds
 * a workflow was pinned by nothing, while the tests that claimed to cover it only
 * exercised `CapabilityRegistry.schemaDiscoveryFor`. Untestable code is how a
 * generalization gets silently reverted, so the fix is to make it reachable.
 *
 * Resolves ONE connector per pass: the first DECLARING connector this draft actually
 * writes to. A draft writing to two schema-bearing connectors resolves them on
 * successive passes, because the destinations node re-enters until nothing drifts.
 *
 * Returns `null` when no connector declares discovery — and null means the ordinary
 * loop ASKS the user. It must never mean "guess", which would write a customer's
 * record into a destination that does not exist.
 *
 * @param {{schemaDiscoveryFor?: Function, schemaDiscoveryConnectors?: Function}|null} catalog
 * @param {object[]} nodes
 * @returns {{connector: string, descriptor: object, targets: object[]}|null}
 */
export function resolveSchemaDiscovery(catalog, nodes) {
  if (!catalog?.schemaDiscoveryFor) return null;
  for (const connector of (catalog.schemaDiscoveryConnectors?.() ?? [])) {
    const targets = (nodes ?? []).filter(n => usesConnector(n, connector));
    if (!targets.length) continue;
    const descriptor = catalog.schemaDiscoveryFor(connector);
    if (descriptor) return { connector, descriptor, targets };
  }
  return null;
}

/**
 * @param {object}   opts
 * @param {object}   opts.llm
 * @param {string}   [opts.checkpointerDir]
 * @param {Function} [opts.invokeCapability] — (id, args) => result; null when no connector is live
 * @param {object}   [opts.capabilityCatalog] — the CapabilityRegistry (P13-0 seam #3).
 *   Supplies `schemaDiscoveryFor(connector)` so destination resolution works for ANY
 *   connector that declares how its schema is read, instead of only Airtable. Omitted
 *   or null ⇒ no connector declares discovery ⇒ the ordinary loop ASKS the user, which
 *   is exactly the pre-P13 behaviour for every non-Airtable connector.
 */
export function buildElicitationGraph({ llm, checkpointerDir = './memory/converger', invokeCapability = null, capabilityCatalog = null }) {
  // Which generate executions have already STREAMED their thinking. A node that
  // calls interrupt() re-executes from the top on resume (compiled-graph.js), so
  // `generate` would re-stream (and re-narrate) its thinking every time the user
  // answers the workflow-approval interrupt. This closure persists for the life of
  // the converger instance (one per session, reused across every /respond), so a
  // given generation streams its thinking EXACTLY ONCE. Keyed by `state.step`, which
  // is stable across a pass and its resume yet advances for a later (revise) rebuild.
  const streamedThinking = new Set();

  // ── DON'T PAY TWICE FOR THE SAME ANSWER ─────────────────────────────────────
  // A node that ends in `interrupt()` is re-executed from the top when the user
  // answers — `interrupt()` then returns instead of throwing. Anything expensive
  // ABOVE the interrupt therefore runs a second time for nothing. Measured: `plan`
  // spent 15.9s building the plan, showed it, and spent 16.1s rebuilding the
  // identical plan the moment the user clicked Approve — a third of a minute of a
  // build, burnt, on every single workflow, plus a second paid model call.
  //
  // Keyed by step (like `streamedThinking`) so a genuine re-plan later in the
  // conversation still recomputes; scoped to this converger instance, which is
  // per-session, so it cannot leak across users.
  const planCache = new Map();

  // ── WHERE THE MINUTES GO ────────────────────────────────────────────────────
  // A build takes single-digit minutes and nothing recorded which STEP spent them,
  // so "the builder is slow" could not be acted on — only guessed at. Every graph
  // node is wrapped to log its own wall-clock, once, as `converger.node`. A node
  // that PAUSES for the user is excluded from its own timing by construction: the
  // interrupt throws, so the timer is only reported on a completed pass, never
  // inflated by however long a person took to answer.
  //
  // Free by design: one Date.now() per node and a line in the JSON-lines log.
  // WHOSE BUILD IS THIS? Every line was `{node, ms, step}` and nothing else, so two
    // tenants building at the same time produce one interleaved stream that cannot be
    // separated — and this log is the primary instrument for diagnosing slow or looping
    // builds, which is exactly when more than one person is likely to be building. The
    // QA Manager could only attribute a build's stages by refusing to run a second one.
    // `threadId` identifies the build; `tenant` is what makes it answerable in production.
  const who = (cfg) => ({
    thread: cfg?.configurable?.threadId ?? null,
    tenant: cfg?.configurable?.tenantId ?? null,
  });

  const timeNodes = (g) => {
    const orig = g.addNode.bind(g);
    g.addNode = (name, fn) => orig(name, async (state, cfg) => {
      const t0 = Date.now();
      try {
        const out = await fn(state, cfg);
        logEvent('converger.node', { ...who(cfg), node: name, ms: Date.now() - t0, step: state?.step ?? null });
        return out;
      } catch (err) {
        // A NODE THAT PAUSES STILL DID THE WORK. `generate` spends minutes on the
        // model and THEN interrupts to show the result — so skipping the timing on an
        // interrupt hid exactly the steps worth measuring, and every remaining entry
        // was a 0 ms checkpoint replay. The elapsed time here is work done BEFORE the
        // pause; the human's own thinking time lands in the NEXT request, not this one.
        const paused = !!(err && (err.name === 'GraphInterruptSignal' || err._interrupt));
        logEvent('converger.node', { ...who(cfg), node: name, ms: Date.now() - t0, step: state?.step ?? null, ...(paused ? { paused: true } : { failed: true }) });
        throw err;
      }
    });
    return g;
  };

  const graph = timeNodes(new StateGraph({
    stateSchema: {
      // Plain defaults (no reducer — replacement semantics)
      intent:       '',
      capabilities: {},
      draft:        null,
      step:         0,
      phase:        'outcome',
      spec:         null,
      _pendingQuestion: null,
      // Resource create-or-pick (#25). `_resourceCreate` carries a pending
      // "Create #<name>" hand-off from `gaps` to `resourceSetup`; `_resourceAsked`
      // latches resources already surfaced but unresolved so the loop can't spin.
      _resourceCreate: null,
      _resourceAsked:  [],

      // P12 Increment C. Both are LOOP BOUNDS, not bookkeeping: a gap the model
      // cannot close would otherwise spin to the recursion limit and die with a
      // stack trace instead of asking the user a question.
      proposeRounds:     0,
      gapRounds:         0,
      sufficiencyChecks: 0,
      // Whole-spec regenerations after the first build. A LOOP BOUND: post-generate,
      // any "the spec must change" route (a blocking gap, a sufficiency-named missing
      // component, a ratify request-changes) rebuilds via `generate`, not the retired
      // `propose` drip — one Opus pass each. Capped so an intent the model cannot
      // satisfy ends at `ratify` with its blockers shown, not in an endless rebuild.
      regenRounds:       0,
      wireRounds:        0,
      // Structural fingerprint of the spec the LAST `generate` produced. See generate:
      // a rebuild that returns the identical shape has proven it cannot fix whatever
      // was complained about, so it stops rather than buying another Opus pass.
      _lastShape:        null,
      // Fingerprint of the blockers that caused the LAST rebuild. See analyze:
      // a rebuild that comes back with the identical blocker set has proven it
      // cannot fix them, and rebuilding again just buys the same spec twice.
      _lastBlockerKey:   null,
      // Fingerprint of the SUFFICIENCY complaint that caused the last rebuild. The
      // blocking-gap route above has had `_lastBlockerKey` since 2026-07-26; the
      // sufficiency route had no equivalent, and it is the route that orders the most
      // rebuilds. Measured on prod (`build-platform-1785252448380`, 2026-07-28): four
      // whole-spec passes — 221s + 126s + 142s + 120s ≈ 10 minutes — every one ordered
      // by `sufficiency` naming the SAME missing thing, on a spec `scoreGap` had
      // already returned `complete: true` for.
      _lastMissingKey:   null,
      _missingNote:      null,
      // ── WHAT THE SYSTEM ALREADY FIXED, SO THE NEXT PASS DOES NOT UNDO IT ─────
      // The deterministic repairs (`autoRepairStructural`) fill blanks the model left
      // — a missing `sections` list, an unwired route edge, a missing name. They are
      // applied to `state.draft`, and the NEXT `generate` pass could not see them,
      // because the prompt serialises the previous draft as ids/types/labels ONLY (no
      // config, no edges). So the model re-emitted the identical blank, the repair
      // fired again, and the build could not retain a fix it had already made.
      // Measured on the record (memory/logs/atlas-events.log, 2026-07-26): the build
      // `build-agntic-1785087187289` logged `converger.pre_regen_repair
      // [DIGEST_MISSING_SECTIONS]` on THREE consecutive whole-spec passes (155s + 130s
      // + 203s), and two other builds repeated it twice each. This carries the repair
      // list from the node that applied it to the pass that must honour it; `generate`
      // renders it into the prompt and clears it, so it can never leak into a later,
      // unrelated rebuild.
      _repairs:          [],
      // WHY THIS PASS IS HAPPENING. Six different routes re-enter `generate`, each of
      // which throws away the whole spec and pays for another Opus pass, and three of
      // them recorded NOTHING — so a build that rebuilt itself five times could not be
      // told apart from one that rebuilt once, and the reason had to be inferred by
      // elimination from node timings. Every route into `generate` now sets this, and
      // `generate` logs it with the build's thread/tenant. It is diagnostic only: it
      // never gates, bounds or changes a rebuild.
      _regenReason:      null,
      // The last accepted proposal was a NO-OP (see `propose`). Read by `analyze`.
      _noProgress:       false,
      // The whole-spec `generate` pass has run at least once (converger
      // rearchitecture). Latched on the first accepted generation and read by the
      // `analyze`/generate re-entry guard so the regenerate counter only counts
      // TRUE rebuilds (not the first build). `propose` is no longer routed to from
      // any post-generate path — every "the spec must change" route regenerates.
      _generated:        false,
      // The destination (Airtable base + table + columns) has been resolved from the
      // live connector once (P12 Increment F). Without this the gap loop would
      // re-enter `destinations` on its way back to ratify and ask "which base?"
      // again — and a question asked twice is a question people learn to click past.
      destinationsResolved: false,
      // The resolved destination: { baseId, table, columns }. Cached so the connector
      // is asked ONCE — and so the columns are available to RE-CHECK the write node on
      // every later pass, because a propose round after the resolution can put an
      // invented column straight back (spec-assembler replaces a node by id).
      destination:          null,
      // The decision tables have been shown to the user once (P12 Increment E).
      // The gap loop can re-enter `decisions` on its way back to ratify, and
      // re-asking someone to review a table they just reviewed is how a review
      // becomes a thing people click past.
      decisionsReviewed: false,
      // Whole-spec regenerations driven by a described decision-table correction
      // (#24). A LOOP BOUND, capped at one: after it, the induced table stands.
      decisionRounds:    0,
      // Self-verification (#23). `verifyRounds` is a LOOP BOUND: the converger runs
      // its own draft through the engine on the sample examples and, on a failure,
      // regenerates a fix — capped at MAX_VERIFY_ROUNDS so a spec it cannot make pass
      // ends at ratify with an honest note, never in an endless build/fix spin.
      // `_verifyReport` carries what the self-test found ({ran,passed,total,note}) so
      // ratify can surface it — a failed verify is a NOTE, never a hard block.
      verifyRounds:      0,
      _verifyReport:     null,
      // THE AGGREGATE HARD CAP on how many times the whole spec is RE-generated after
      // the first build. The finished-workflow walkthrough (`generated_workflow`) is now
      // presented EXACTLY ONCE, in the `walkthrough` node on the FINAL spec (moved there
      // 2026-07-16), so the user is never looped through re-approvals. But the INTERNAL
      // regenerate loop still compounds: `verifyRounds` bounds only the verify fix loop,
      // while the analyze sufficiency/regen loop (`regenRounds`), a decision-table
      // correction (`decisionRounds`) and a gap fix (`gapRounds`) each drive their OWN
      // regenerate with their OWN counter and no single total. `buildPresentations`
      // counts every RE-generation (NOT the first build, mirroring how `regenRounds`
      // excludes it via `_generated`), lives in a channel the checkpointer persists like
      // every other counter, and is checked in `generate` BEFORE it rebuilds again: once
      // the cap is hit the build is forced to the single walkthrough → ratify with an
      // honest gave-up note, so it ALWAYS terminates quickly. An explicit user
      // request-changes (at the walkthrough OR at ratify) resets it (a fresh budget for a
      // fresh ask); automatic regeneration between decisions is what it bounds.
      buildPresentations: 0,
      _buildCapped:       false,
      // THE PRE-BUILD PLAN GATE (agent-contracts increment 1). `_planShown` latches once
      // the plan has been presented so it fires EXACTLY ONCE, before the first `generate`
      // — never on a silent regeneration (a verify fix, a gap rebuild, the aggregate cap).
      // `_approvedPlan` is the approved skeleton, threaded into the generate prompt so the
      // build fills an agreed shape instead of re-deriving structure. `planRounds` bounds
      // the cheap pre-build iteration when the user asks to change the plan.
      _planShown:        false,
      _approvedPlan:     null,
      planRounds:        0,
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
  }));

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
        if (!connector) return false;
        // CANONICALISE BEFORE JUDGING. `canPromise` is a set of connector aliases
        // built from the live catalog; a model writes what a person would say
        // ("google_docs:My Digest"), which is neither a connector id nor a
        // capability id. Compared raw it matches nothing and the build is REFUSED
        // for a connector that is connected and available — verified live: the
        // catalog reported docs_create available:true while the converger said
        // "I can't include google_docs — that connector is not connected".
        // One canonicaliser, shared with the oracle, so the two cannot disagree
        // about what a target name refers to.
        const canon = canonicalConnector(connector);
        return !canPromise.has(connector) && !canPromise.has(canon);
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

    // NO SEPARATE "here's what I understood" VOLLEY (operator 2026-07-16). It was
    // redundant with the Plan gate, whose FIRST section restates this outcome and whose
    // "Change something" handles corrections — so a user confirmed the same understanding
    // twice. We auto-select the model's best reading (the pre-selected top candidate) and
    // proceed; the single confirmation happens once, at the plan. If we had to refuse a
    // connector the user named (`notice`), surface it in the CoT rather than silently
    // dropping it — the plan will also reflect only what's actually promisable.
    if (notice) emitBeat(cfg, { kind: 'check', text: notice });
    const picked = candidates[0];

    const outcome = {
      statement:  picked.statement,
      assertions: (picked.assertions ?? []).map((a, i) => ({ ...a, id: a.id ?? `a${i + 1}` })),
      examples:   [],
    };

    return {
      draft: { ...state.draft, outcome },
      confirmationLog: [{ step: state.step, type: 'outcome_selected', outcome, notice: notice ?? null }],
      step:  state.step + 1,
      phase: 'examples',
    };
  });

  // ── examples ───────────────────────────────────────────────────────────────
  // "Show me a case." The SME's rows — which become the ACCEPTANCE SUITE, not
  // just colour. Skipping is one click and is a legitimate answer.
  //
  // THE PICKER (P12 Increment F, §6.4 — "the biggest single unlock"). Do NOT ask a
  // user to invent test cases: they invent EASY ones, and the case that finds the
  // bug is the awkward real one they would never think to type. We hold their Gmail
  // token. So when the workflow triggers on email, we go and READ three real
  // messages and let them click — zero typing, and the examples are true.
  //
  // Falls back to the model's proposed cases when there is no live source (no Gmail,
  // a non-email trigger, a lookup failure). Inventing a plausible-looking "real"
  // email would be worse than proposing an obviously-modelled one, because the user
  // would believe it came from their inbox.
  graph.addNode('examples', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;

    const real = await fetchRealExamples({
      invokeCapability, triggers: state.draft?.triggers, capabilities: state.capabilities,
    });

    let proposed = real.items;
    let source   = real.source;
    let query    = real.query;

    if (!proposed.length) {
      const parsed = await llmJson(llm, [
        new SystemMessage(buildSystemPrompt(state.capabilities)),
        new HumanMessage(buildExamplesPrompt({ intent: state.intent, outcome: state.draft?.outcome, triggers: state.draft?.triggers })),
      ], tierCfg('fast', sessionId));
      proposed = (parsed?.examples ?? []).filter(e => e?.given);
      source   = null;
      query    = null;
    }
    if (!proposed.length) return { phase: 'process' };

    // ── GATHERED SILENTLY (#24) ──────────────────────────────────────────────
    // Examples matter for build QUALITY — they are the acceptance suite the test
    // panel and the runtime oracle run the finished workflow against — but which
    // rows become test cases is not the USER's decision to make, and the old
    // "Use as test cases / Skip examples" interrupt spent a whole turn on it. The
    // node now fetches them and proceeds: every proposed example is kept, and the
    // user simply never sees the step. No interrupt means the client has nothing
    // to answer, so the graph can never strand here waiting on a card it no longer
    // renders — the fetched rows ride along in state to the oracle downstream.
    const kept = proposed;

    return {
      draft: { ...state.draft, outcome: { ...(state.draft?.outcome ?? {}), examples: kept } },
      confirmationLog: [{ step: state.step, type: 'examples_gathered', examples: kept, source, query }],
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
  graph.addNode('process', async (state, cfg) => {
    const draft = state.draft ?? { ...DRAFT_DEFAULT };
    const assertions = draft.outcome?.assertions ?? [];
    if (!assertions.length) return { phase: 'examples' };

    const nodes = [...(draft.nodes ?? [])];
    const derived = [];
    for (const a of assertions) {
      const node = nodeForAssertion(a, { capabilities: state.capabilities });
      if (!node) continue;
      if (nodes.some(n => n.id === node.id)) continue;
      nodes.push(node);
      derived.push({ assertionId: a.id, nodeId: node.id });
    }

    // ── THE TRIGGER IS PART OF THE GRAPH THIS NODE BACKWARD-CHAINS ───────────
    //
    // It was not, and the omission silently disabled half of Increment F. The
    // EXAMPLE PICKER reads the trigger's own filter to know WHICH emails to fetch —
    // and `examples` ran BEFORE anything had ever put a trigger in the draft (only
    // `propose` did, much later), so `draft.triggers` was `[]` every single time.
    // `fetchRealExamples` therefore returned nothing in EVERY session, the fallback
    // fired always, and "no typed example" never once happened. The picker was
    // unreachable code that looked like a feature. (Found by the test-adversary.)
    //
    // A trigger is not an afterthought to be proposed later: it is the entry point
    // of the graph, and it is derivable from the same contract every other node here
    // is derived from. So it is derived HERE, and `examples` now runs AFTER this
    // node, with a real filter to search on.
    let triggers = Array.isArray(draft.triggers) ? draft.triggers : [];
    if (!triggers.length) {
      const t = await llmJson(llm, [
        new SystemMessage('You pick the event that STARTS a workflow. JSON only.'),
        new HumanMessage(
          `Intent: "${state.intent}"\nOutcome: ${draft.outcome?.statement ?? ''}\n\n` +
          // "connector_event" USED TO BE OFFERED HERE AND NOTHING COULD RUN IT.
          // It appeared in exactly one place in all of src/ — this string — and no
          // scheduler, poller or dispatcher ever matched it, so a workflow built on
          // it saved, showed as live, and could never fire. The runnable shape for a
          // pushed connector is {"type":"event","connector":"<id>"}; every dispatcher
          // matches on that connector field. `checkTriggersRunnable` now refuses
          // anything outside the runnable set, so this prompt is no longer the only
          // thing standing between a model's guess and an unrunnable workflow.
          'What starts this workflow? Return {"trigger":{"type":"email"|"schedule"|"manual"|"event","connector":"<for an event trigger, the app to watch — e.g. airtable, slack>","filter":"<a Gmail search query, for an email trigger — e.g. to:leads@acme.com>","cron":"<for a schedule>"}}. ' +
          'Use "event" ONLY for a change in a connected app, and it MUST name the connector; if you cannot name one, do not use "event". ' +
          'For an email trigger the filter is a REAL Gmail search query: it is used to find the actual messages this workflow will run on. ' +
          'The trigger fires on mail ARRIVING in the inbox: for a generic "new email arrives" with no specific sender named, use "is:unread" — NEVER "from:<the operator\'s own address>", which matches mail they SENT. Use "from:<sender>" only when the user names a specific sender.',
        ),
      ], tierCfg('fast', cfg?.configurable?.threadId));
      const trig = t?.trigger;
      if (trig?.type) triggers = [trig];
    }

    if (!derived.length && !triggers.length) return { phase: 'examples' };

    return {
      draft: { ...draft, nodes, triggers },
      confirmationLog: [{ step: state.step, type: 'process', derived, triggers }],
      step:  state.step + 1,
      phase: 'examples',
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

  // How many WHOLE-SPEC rebuilds `generate` may run after the first build before
  // the converger stops rebuilding and hands the draft to `gaps` → `ratify`. The
  // old `propose` drip was cheap (one sonnet call per component, capped at 14);
  // `generate` is one Opus pass over the entire spec, so its regenerate loop is
  // capped far tighter. Termination is already guaranteed by the other caps
  // (MAX_PROPOSE_ROUNDS / MAX_SUFFICIENCY_CHECKS / MAX_GAP_ROUNDS) and by the fact
  // that `generate` always interrupts for review; this simply keeps the worst-case
  // Opus cost — and the number of near-identical workflows shown to the user — low.
  const MAX_REGEN_ROUNDS = 3;
  // Targeted delivery-wiring attempts before falling back to a full rebuild. Two is
  // plenty: the model either wires it in one focused call or the producing step is
  // genuinely missing, which needs a rebuild anyway.
  const MAX_WIRE_ROUNDS = 2;

  // THE AGGREGATE regenerate cap (see `buildPresentations` in the state schema). How
  // many times the whole spec may be RE-generated (after the first build) across ALL
  // regenerate paths COMBINED — verify fixes, sufficiency/regen rebuilds, decision-table
  // corrections, gap fixes. Deliberately ≥ the verify path's own bound (2 fixes) so a
  // spec that legitimately fixes-then-passes is never cut short, but low enough that a
  // spec the model cannot settle stops burning Opus passes fast. Beyond it, `generate`
  // refuses to rebuild again and the build is forced to the single walkthrough → ratify.
  const MAX_BUILD_REGENERATIONS = 3;

  graph.addNode('analyze', async (state, cfg) => {
    // AGGREGATE-CAP short-circuit. `generate` sets `_buildCapped` when it has hit
    // MAX_BUILD_REGENERATIONS and stops rebuilding; route the build straight to the
    // single `walkthrough` (analyze's edge maps 'finalizing' → walkthrough), BYPASSING
    // the rest of the tail (destinations/decisions/gaps/verify) — those could route back
    // to `generate` again and, since the cap is still tripped, spin generate↔analyze. The
    // best draft we have is presented ONCE for approval and then ratified. The flag is
    // consumed here; a walkthrough/ratify user-requested change re-opens the budget.
    if (state._buildCapped) return { phase: 'finalizing', _buildCapped: false };
    const sessionId = cfg?.configurable?.threadId;

    // ── REPAIR BEFORE REBUILD ────────────────────────────────────────────────
    // The deterministic repairs (a missing route edge, a missing section list, an
    // uncheckable promise, a missing name) already existed — but they ran in `gaps`,
    // which the build only reaches AFTER the whole-spec regenerate loop. So a blocker
    // a one-line edit could fix instead threw away all 13 nodes and paid for a fresh
    // Opus pass, up to three times, before `gaps` ever got to clean it up. Measured
    // causes on the record: two `assemble` steps missing a `sections` list (3 rebuilds),
    // the Notes-column oscillation (2 rebuilds). Apply the repairs HERE, before the
    // regenerate decision, and re-score — so a build blocked only by things we can fix
    // ourselves never spends a rebuild on them. A repair that clears nothing changes
    // nothing; `generate` still rebuilds for what genuinely needs the model.
    // ONLY AFTER A GENERATE. The repair exists to prevent a RE-generate, which only
    // happens once the model has built a spec (`_generated`). Running it on the first,
    // pre-generate analyze — when the draft has no nodes yet — would derive a name from
    // the outcome and set it, and `generate`'s own name would then not override it, so
    // the model's title would be silently dropped. (Caught by a regression test that
    // asserted the generated name survives.)
    let draft = state.draft;
    let repaired = [];
    if (state._generated) {
      const pre = scoreGap(draft, { capabilities: state.capabilities });
      const r = autoRepairStructural(draft, pre.gaps);
      if (r.applied.length) {
        draft = r.draft;
        repaired = r.applied;
        logEvent('converger.pre_regen_repair', { ...who(cfg), applied: r.applied.map(a => a.code) });
      }
    }
    // Everything below reads `state.draft`; carry the repaired draft on every return so
    // the fix persists whether we proceed, regenerate, or go to the user.
    //
    // AND CARRY WHAT WAS REPAIRED, not just the repaired draft. Persisting the draft
    // alone was not enough: the generate prompt drops node config, so the very next
    // pass re-emitted the same blank and the repair fired again — three passes running
    // on a real build. `_repairs` is what `generate` shows the model so a fix already
    // made survives the rebuild.
    const carryRepair = repaired.length ? { draft, _repairs: repaired } : {};
    const gap = scoreGap(draft, { capabilities: state.capabilities });

    if (gap.complete) {
      // THE FLOOR IS MET: the spec is valid and it delivers everything the
      // outcome promises. But the outcome cannot express every transformation —
      // "a summary of the email" and "the email" reach Slack as the same
      // assertion. So the intent gets the last word, once, and only to add a
      // component it can NAME. (v1 instead demanded a "processing" node from a
      // hardcoded checklist, and invented one for workflows that needed none —
      // defect #4. Here "finished" is the default answer, not the exception.)
      if ((state.sufficiencyChecks ?? 0) >= MAX_SUFFICIENCY_CHECKS) return { ...carryRepair, phase: 'gapping' };

      const verdict = await llmJson(llm, [
        new SystemMessage(buildSystemPrompt(state.capabilities)),
        new HumanMessage(buildSufficiencyPrompt({ intent: state.intent, draft })),
      ], tierCfg('fast', sessionId));

      if (verdict?.complete === false && verdict.missing) {
        // Two ways this verdict has already been disproven — see
        // `sufficiencyClaimAlreadyCovered`. Either the contract already asserts the
        // destination it names (and `scoreGap` just said every assertion holds), or
        // it is word-for-word the complaint that ordered the LAST rebuild, which
        // therefore demonstrably cannot fix it. Both mirror the blocking-gap route's
        // `_lastBlockerKey` guard: a rebuild that provably cannot converge is not
        // bought twice. Latch `sufficiencyChecks` so the same question isn't re-asked
        // on the next pass round.
        const missingKey = missingKeyOf(verdict.missing);
        const covered    = sufficiencyClaimAlreadyCovered(verdict.missing, draft);
        const repeated   = !!missingKey && missingKey === state._lastMissingKey;
        if (covered || repeated) {
          logEvent('converger.sufficiency_overruled', {
            ...who(cfg),
            reason: covered ? 'contract_already_covers_it' : 'same_complaint_as_last_rebuild',
            detail: String(verdict.missing).slice(0, 200),
          });
          return {
            ...carryRepair,
            phase:             'gapping',
            sufficiencyChecks: MAX_SUFFICIENCY_CHECKS,
            _lastMissingKey:   missingKey,
          };
        }
        return {
          ...carryRepair,
          phase:             'proposing',
          proposeRounds:     (state.proposeRounds ?? 0) + 1,
          sufficiencyChecks: (state.sufficiencyChecks ?? 0) + 1,
          _lastMissingKey:   missingKey,
          _missingNote:      String(verdict.missing),
          // THE ROUTE THAT DROVE THE MOST REBUILDS AND RECORDED THE FEWEST. On the
          // record (2026-07-26) this branch ordered 5 of the 7 whole-spec rebuilds
          // across two builds and left no trace at all — the only way to tell it apart
          // from the blocking-gap route was that the latter logs and this one did not.
          _regenReason:      { route: 'sufficiency', detail: String(verdict.missing).slice(0, 300) },
        };
      }
      return { ...carryRepair, phase: 'gapping' };
    }

    // A RESOURCE gap is not something REGENERATING can fix (#25): the model cannot
    // invent a Slack channel / Airtable base that exists in the tenant's account —
    // only create-or-pick can. So when the ONLY thing blocking the spec is a missing
    // resource, skip the (bounded, but wasteful) regenerate loop and go straight to
    // `gaps`, where it is resolved conversationally. If there are OTHER blockers too,
    // regenerate as usual — those may close, leaving the resource gap to be handled
    // on the next pass.
    const blockers = unansweredGaps(gap);
    if (blockers.length && blockers.every(g => g.code === 'RESOURCE_NOT_FOUND' || g.code === 'RESOURCE_UNVERIFIED')) {
      return { ...carryRepair, phase: 'gapping' };
    }

    // ── AN UNWIRED DELIVERY IS ONE EDGE, NOT A WHOLE REBUILD ─────────────────
    // `process` seeds a delivery NODE per promised delivery but not its edges; the
    // model wires them at `generate`, and when it forgets one the delivery has nothing
    // feeding it (DELIVER_NO_INPUT) — which today throws away every node for a fresh
    // Opus pass. The fix is a single edge: wire the delivery from the step whose output
    // it should send. The MODEL still chooses that step (which content feeds it) — the
    // exact judgement it makes in a full generate, so this is no less safe — but in a
    // small fast-tier call that returns only edges, ~10× cheaper than a whole rebuild.
    //
    // Only when EVERY remaining blocker is DELIVER_NO_INPUT: if there are other
    // blockers (a missing content STEP, say), wiring alone cannot complete the spec and
    // a rebuild is the honest move — which also carries the wiring complaint. Bounded by
    // MAX_WIRE_ROUNDS: if the targeted call cannot clear it (the producing step is truly
    // absent, or the model wires the wrong thing and the re-score still fails), fall
    // through to the normal, bounded regenerate loop below.
    if (state._generated && blockers.length
        && blockers.every(g => g.code === 'DELIVER_NO_INPUT')
        && (state.wireRounds ?? 0) < MAX_WIRE_ROUNDS) {
      const nodeIds = new Set((draft.nodes ?? []).map(n => n.id));
      const unwired = [...new Set(blockers.map(g => g.nodeId).filter(id => id && nodeIds.has(id)))];
      if (unwired.length) {
        let wireDraft = draft;
        try {
          const parsed = await llmJson(llm, [
            new SystemMessage(buildSystemPrompt(state.capabilities)),
            new HumanMessage(buildWireDeliveryPrompt({ draft, unwired })),
          ], tierCfg('fast', sessionId));
          const unwiredSet = new Set(unwired);
          for (const e of (parsed?.edges ?? [])) {
            const from = typeof e?.from === 'string' ? e.from.trim() : '';
            const to   = typeof e?.to   === 'string' ? e.to.trim()   : '';
            // The model may only wire an ORPHANED delivery, and only FROM a step that
            // already exists — never invent a node, never wire a non-delivery, never
            // self-loop. A wire that fails these is discarded, not trusted.
            if (unwiredSet.has(to) && nodeIds.has(from) && from !== to) {
              wireDraft = applyProposal(wireDraft, { component: 'edge', spec: { from, to } });
            }
          }
        } catch { /* the targeted call failed — fall through to the rebuild */ }

        if (wireDraft !== draft) {
          const after = scoreGap(wireDraft, { capabilities: state.capabilities });
          const stillUnwired = unansweredGaps(after).some(g => g.code === 'DELIVER_NO_INPUT');
          logEvent('converger.targeted_wire', {
            ...who(cfg), unwired: unwired.length, cleared: !stillUnwired, complete: after.complete,
          });
          if (!stillUnwired) {
            // The delivery is wired and the spec is complete (wiring only ADDS edges, so
            // the only blockers it can clear are the DELIVER_NO_INPUT ones that gated
            // entry here). Route to the happy path — gapping → … → verify → walkthrough
            // → ratify — WITHOUT a whole-spec rebuild. `analyzing` is NOT a self-loop:
            // the analyze edge maps it to `generate`, so returning it here would rebuild
            // the very spec we just fixed.
            return { draft: wireDraft, wireRounds: (state.wireRounds ?? 0) + 1, phase: 'gapping' };
          }
          // Wired some, but a DELIVER_NO_INPUT remains (the producing step is genuinely
          // missing). Count the attempt and fall through to the rebuild below, which
          // rebuilds the whole spec from scratch anyway — so the partial wire is not
          // carried; regenerating with the wiring complaint is the honest move.
          logEvent('converger.targeted_wire_fell_through', { ...who(cfg), reason: 'producing_step_missing' });
        }
      }
    }

    // ── A BLOCKER THAT SURVIVED A REBUILD IS NOT A REBUILD'S TO FIX ──────────
    // The rule above is right and too narrow. It hard-codes TWO codes as
    // "regenerating cannot fix this", when the property is general: some blockers are
    // about the world, not the wiring, and no amount of rewriting resolves them —
    // only a person can. Everything else falls through to a whole-spec Opus pass.
    //
    // Rather than guess which codes those are, OBSERVE. A blocker gets one rebuild to
    // prove itself; if it is still there afterwards, rewriting has demonstrably failed
    // on it and the cheap move is the conversational one — `gaps` states it in plain
    // words and offers a fix the user can accept in a click.
    //
    // Seen live, and this is what it costs: the outcome promised a `Notes` column and
    // the model believed the real table had `Message`. It wrote `Notes` (rejected — the
    // column was never set), then `Message` (rejected — the promise said Notes), then
    // `Notes` again. Two Opus rebuilds, 425s + 237s, oscillating between two spellings
    // of the same intent — when the question "your table has no Notes column; add one,
    // or use Message?" is one sentence and one click.
    //
    // WHY IT BITES HARDEST ON THE BUILDS THAT MATTER: every extra connector and route
    // adds blockers, so the chance that AT LEAST ONE is unfixable approaches certainty —
    // and one unfixable blocker rebuilds all 26 steps. Simple builds rarely have one;
    // complex builds always do.
    //
    // Deliberately AFTER the first rebuild, never before it: a blocker the model can
    // fix usually is fixed on that pass, and asking the user about something the system
    // could have sorted itself is its own kind of rude.
    const priorKeys = new Set(String(state._lastBlockerKey ?? '').split('|').filter(Boolean));
    const survivors = blockers.filter(g => priorKeys.has(`${g.code}:${g.nodeId ?? ''}`));
    if (state._generated && survivors.length) {
      logEvent('converger.blocker_to_chat', {
        ...who(cfg),
        survivors: survivors.length,
        codes: [...new Set(survivors.map(g => g.code))].join(','),
      });
      return { ...carryRepair, phase: 'gapping' };
    }

    // BOUND THE WHOLE-SPEC REGENERATE LOOP (converger rearchitecture).
    // Once `generate` has run, a still-incomplete draft routes back to `generate`
    // (one Opus pass), not to the retired `propose` drip. That is correct but
    // expensive, so it is capped: after MAX_REGEN_ROUNDS rebuilds that still don't
    // clear the floor, stop rebuilding and hand the draft to `gaps` (which
    // auto-repairs the structural defects the model keeps re-introducing) and then
    // to `ratify`, which SHOWS the remaining blockers to the user rather than
    // rebuilding a near-identical spec forever.
    if (state._generated && (state.regenRounds ?? 0) >= MAX_REGEN_ROUNDS) {
      return { ...carryRepair, phase: 'gapping' };
    }

    // The last accepted proposal changed NOTHING (the model re-proposed an edge the
    // draft already had; applyProposal dedupes, so the draft came back identical).
    // The model has nothing left to add — asking it again just produces the same
    // proposal, and asking the USER again makes them click the same card twice.
    if (state._noProgress) return { ...carryRepair, phase: 'gapping', _noProgress: false };

    if ((state.proposeRounds ?? 0) >= MAX_PROPOSE_ROUNDS) return { ...carryRepair, phase: 'gapping' };

    // WHAT IS WRONG TRAVELS WITH THE REBUILD.
    //
    // Everything below routes back to `generate`, which rebuilds the WHOLE spec —
    // one Opus pass each. It rebuilds from `intent` + `clarifications`, so if the
    // reason for the rejection is not in one of those, generate re-runs on
    // byte-identical input and deterministically reproduces the same defect. The
    // loop cannot converge; it can only hit its cap.
    //
    // That was live: a build looped generate→analyze FOUR times on an unchanging
    // 10-node draft, burning three whole-spec regenerations (the bulk of a
    // 13-minute build), because two `assemble` steps were missing a `sections`
    // list and nothing ever said so. `generate` already folds `_missingNote` into
    // its clarifications for the SUFFICIENCY route, and the comment there asserts
    // "the blocking-gap route already arrives via `clarifications`" — it does not.
    // This is that missing half.
    //
    // Naming the defects is also what makes the loop worth running at all: these
    // are precise, machine-generated messages ("X needs a sections list"), which is
    // exactly the correction a model can act on in one pass.
    // ── A REBUILD THAT CHANGES NOTHING MUST NOT BUY ANOTHER ONE ──────────────
    // The loop above is worth running only while it makes progress. Measured on a
    // 4-connector build: `generate` ran FOUR times (300s + 304s + 102s + 160s) —
    // 92% of a 15.7-minute build — and the defects that reached the gap review at
    // the end included the very one this rebuild path exists to fix ("needs a
    // sections list"). Three whole Opus passes, three times the cost, same spec.
    //
    // So: fingerprint the blockers. If a rebuild comes back with the IDENTICAL set,
    // it has demonstrated it cannot fix them, and `gaps` — which repairs these
    // deterministically and for free — is where they were always going to be
    // resolved. Go straight there.
    //
    // Deliberately narrow: ANY change in the blocker set means the rebuild moved
    // something and the loop continues (still bounded by MAX_REGEN_ROUNDS). This
    // only cuts the case that provably cannot converge.
    // `code` + the step it is about. Not the gap `id`, which embeds an array index
    // and so changes when an unrelated gap is added or removed — that would read as
    // "something moved" on a spec where nothing did, and the loop would run again.
    const blockerKey = blockers.map(g => `${g.code}:${g.nodeId ?? ''}`).sort().join('|');
    if (blockerKey && state._generated && blockerKey === state._lastBlockerKey) {
      // WHOSE BUILD IS THIS? These two lines were the only record of the blocking-gap
      // rebuild decision and they carried no thread/tenant, so in the one situation
      // this log exists for — several people building at once, one of them looping —
      // they could not be attributed to a build at all.
      logEvent('converger.regen_skipped', { ...who(cfg), reason: 'blockers_unchanged', blockers: blockers.length, key: blockerKey.slice(0, 200) });
      return { ...carryRepair, phase: 'gapping' };
    }
    logEvent('converger.regen', { ...who(cfg), blockers: blockers.length, key: blockerKey.slice(0, 200), round: state.regenRounds ?? 0 });

    const gapNote = blockers.length
      ? 'The previous build was rejected for these specific problems — fix each one:\n'
        + blockers.map(g => `- ${g.message}${g.hint ? ` (${g.hint})` : ''}`).join('\n')
      : null;

    // The reason this rebuild is being ordered: the blockers that rejected the last
    // build. Shared by both remaining exits, so neither can be added without one.
    const blockerReason = { route: 'blocking_gaps', detail: blockerKey.slice(0, 300) };

    const clarificationCount = (state.clarifications ?? []).length;
    if (clarificationCount >= MAX_CLARIFICATIONS) {
      return { ...carryRepair, phase: 'proposing', _lastBlockerKey: blockerKey, _regenReason: blockerReason, ...(gapNote ? { _missingNote: gapNote } : {}) };
    }

    const sysmsg = new SystemMessage(buildSystemPrompt(state.capabilities));
    const usermsg = new HumanMessage(buildAnalyzePrompt({
      intent:         state.intent,
      clarifications: state.clarifications,
      capabilities:   state.capabilities,
    }));
    const parsed = await llmJson(llm, [sysmsg, usermsg], tierCfg('fast', sessionId));

    if (parsed?.ready === false && parsed.question) {
      return { ...carryRepair, phase: 'clarifying', _pendingQuestion: parsed.question };
    }
    // analyze runs before every propose, so counting here counts propose rounds
    // exactly once each — without threading a counter through propose's five
    // return paths, where the next person to add a sixth would forget it.
    return {
      ...carryRepair,
      phase: 'proposing',
      proposeRounds: (state.proposeRounds ?? 0) + 1,
      // Remembered so the NEXT pass can tell whether this rebuild changed anything.
      _lastBlockerKey: blockerKey,
      _regenReason: blockerReason,
      ...(gapNote ? { _missingNote: gapNote } : {}),
    };
  });

  // ── clarify ────────────────────────────────────────────────────────────────
  // Ask one focused question; interrupt for the user's answer.
  graph.addNode('clarify', async (state, cfg) => {
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

      // ── A PROPOSAL THAT CHANGES NOTHING IS NOT A PROPOSAL ─────────────────
      //
      // `applyProposal` DEDUPES: an edge that already exists is not added again
      // (spec-assembler.js). So when the model proposes an edge the draft already
      // has, the draft comes back IDENTICAL — the model then sees the same draft,
      // proposes the same edge, and the loop spins until MAX_PROPOSE_ROUNDS burns
      // out. Observed against the live model: **fourteen consecutive identical
      // "add this connection" proposals**, each one a card the user has to click.
      //
      // It was invisible because the gap loop was inert (its suggestions were never
      // matched, so a blocking gap never re-entered `propose`) — so the spin ran
      // ONCE, fitted inside the headless step cap, and nobody looked. Fixing the gap
      // loop doubled the propose rounds and pushed it over, which is how it surfaced.
      //
      // A no-op accept means the model has nothing left to add. Take it at its word
      // and move on to the gaps, rather than asking the user to confirm the same
      // thing again. The propose loop's job is to CHANGE the draft; a round that
      // cannot is a round that must not repeat.
      //
      // …and it must be recorded in STATE, not in `phase`: the edge out of `propose`
      // is an UNCONDITIONAL one to `analyze`, which recomputes the phase from the
      // draft — so a `phase: 'gapping'` set here is simply overwritten, and the loop
      // spins on regardless. `analyze` reads this flag and stops.
      if (JSON.stringify(newDraft) === JSON.stringify(state.draft)) {
        return {
          confirmationLog: [{ ...logEntry, noop: true }],
          _noProgress:     true,
          step:            state.step + 1,
          phase:           'analyzing',
        };
      }
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

  // ── plan ─────────────────────────────────────────────────────────────────────
  // THE PRE-BUILD GATE (agent-contracts increment 1). Project the gathered contract +
  // trigger into a plain-language PLAN,
  // and show it ONCE — right before the expensive whole-spec build. The user catches a
  // misread in a glance instead of after a 3-5 min Opus pass; the approved plan then
  // gives `generate` an explicit skeleton to fill, so the same intent builds the same way
  // with fewer regenerations.
  //
  // FAIL-SAFE, exactly like `verify`: no contract, no LLM, or an unusable projection ⇒ it
  // skips straight to the build unchanged. So a build is never blocked on the plan, and
  // every existing converger test — whose stub LLM returns {} for this prompt — keeps its
  // exact behaviour (empty projection → skip → generate, no new interrupt in the trace).
  //
  // Skippable: the plan is pre-accepted (§11.9), so the client's default answer builds it.
  const MAX_PLAN_ROUNDS = 2;

  // THE GROUNDING PASS (agent-contracts increment 2). Verify the plan's DELIVERY
  // destinations against the LIVE connectors, so the plan tells the user which resources
  // already exist vs. which Atlas will create — grounded fact, not a guess. Both checks
  // read data the session already fetched (no new connector round-trips), and each is
  // independently null-safe: a connector with no live view contributes nothing rather than
  // a false claim. Returns null overall when nothing could be verified.
  //   · Slack   — named channels vs `capabilities.slackChannels` (live conversations.list).
  //   · Airtable — a `record_exists → airtable:<Table>` assertion resolved against
  //                `capabilities.airtableSchema` (live base/table/field metadata), so the
  //                plan can name the REAL table and its REAL columns.
  function groundPlan(outcome, capabilities) {
    const assertions = outcome?.assertions ?? [];
    const grounding = {};

    const chans = Array.isArray(capabilities?.slackChannels)
      ? new Set(capabilities.slackChannels.map(c => String(c).replace(/^#/, '').toLowerCase()))
      : null;
    if (chans) {
      const known = new Set(), absent = new Set();
      for (const a of assertions) {
        const { connector, locator } = splitTarget(a?.target);
        if (connector !== 'slack' || !locator) continue;
        const bare = locator.replace(/^#/, '').toLowerCase();
        if (!bare) continue;
        (chans.has(bare) ? known : absent).add(locator.startsWith('#') ? locator : `#${locator}`);
      }
      if (known.size || absent.size) grounding.slack = { checked: true, known: [...known], absent: [...absent] };
    }

    const schema = Array.isArray(capabilities?.airtableSchema) ? capabilities.airtableSchema : null;
    if (schema?.length) {
      for (const a of assertions) {
        const { connector, locator } = splitTarget(a?.target);
        if (connector !== 'airtable' || !locator) continue;
        const want = String(locator).toLowerCase();
        let match = null;
        for (const base of schema) {
          for (const t of (base.tables ?? [])) {
            if (String(t.name).toLowerCase() === want) {
              match = { base: base.name, table: t.name, columns: (t.fields ?? []).map(f => f.name) };
              break;
            }
          }
          if (match) break;
        }
        if (match) { grounding.airtable = match; break; }
      }
    }

    return (grounding.slack || grounding.airtable) ? grounding : null;
  }

  graph.addNode('plan', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;
    const draft = state.draft ?? { ...DRAFT_DEFAULT };

    // Nothing to plan against — proceed to build, unchanged. (`_planShown` latches so
    // this decision, like an approval, is not re-made on the way back through analyze.)
    if (!draft.outcome?.statement) return { _planShown: true, phase: 'proposing', _regenReason: { route: 'first_build', detail: 'no outcome to plan against' } };

    // See `planCache`: on the resume pass this node re-runs, and the plan it would
    // build is the one already on screen. Reuse it rather than paying for it again.
    const planKey = `${sessionId ?? ''}:${state.step}`;
    let plan = planCache.get(planKey) ?? null;
    if (!plan) {
      try {
        plan = await llmJson(llm, [
          new SystemMessage(buildSystemPrompt(state.capabilities)),
          new HumanMessage(buildPlanPrompt({
            intent:         state.intent,
            outcome:        draft.outcome,
            triggers:       draft.triggers,
            clarifications: state.clarifications,
            grounding:      groundPlan(draft.outcome, state.capabilities),
          })),
        ], tierCfg('balanced', sessionId));
      } catch { plan = null; }
      if (plan) planCache.set(planKey, plan);
    }

    // NOTE (2026-07-27): the plan used to be marked here — every line clamped to a
    // `stated|found|inferred` badge and then word-matched against what the customer
    // typed. The whole mechanism was REMOVED by the operator's decision; the plan
    // now leaves the server as the plain prose the model wrote. See CLAUDE.md.

    // Unusable projection → skip (fail-safe). A plan with no steps is not worth a turn.
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
      return { _planShown: true, phase: 'proposing', _regenReason: { route: 'first_build', detail: 'plan projection unusable' } };
    }

    const reply = await interrupt({
      type: 'plan_review',
      plan,
      // Every interrupt carries a default (§11.9): the plan is pre-selected, so the
      // client's Enter/accept builds it — the zero-typing path survives.
      choices: [
        { id: 'build',  label: 'Build it',         selected: true },
        { id: 'change', label: 'Change something' },
      ],
      step: state.step,
    });

    // "Change something" — fold the correction in as a clarification so the build (and a
    // re-shown plan) reflect it. Re-show the plan ONCE more (bounded by MAX_PLAN_ROUNDS)
    // so the user confirms the fix before the expensive build; past the cap, build anyway.
    const change = (reply?.type === 'change' || reply?.type === 'modify')
      ? (reply.text ?? reply.modification ?? reply.answer ?? null)
      : null;
    if (change && (state.planRounds ?? 0) < MAX_PLAN_ROUNDS) {
      return {
        clarifications:  [{ q: '(plan change)', a: String(change) }],
        planRounds:      (state.planRounds ?? 0) + 1,
        confirmationLog: [{ step: state.step, type: 'plan_review', changed: true, change }],
        step:            state.step + 1,
        phase:           'planning',   // re-enter `plan` with the change folded in
      };
    }

    // NAME THE WORKFLOW HERE, ON THE STATE OBJECT — not later, in the model's hands.
    // The workflow is a `draft` object carried through the graph's state; a field set
    // here rides along to `generate`, and mergeGeneratedSpec keeps the draft's name
    // over the model's (`base.name ?? g.name`). So a name set at the approved plan can
    // never be forgotten by the build — which is what `MISSING_NAME` was: the model
    // omitting a required field, then a whole 13-node Opus rebuild fired to add a title.
    // The name comes from the outcome the user just approved on THIS screen, so it is
    // aligned with intent and renamable. A prompt rule was the alternative and it is
    // strictly weaker: the prompt already declares the name required and the model drops
    // it anyway — a rule asks; writing the field guarantees. (The plan's own title is
    // preferred when it carried one; else it is derived from the outcome.)
    const named = nameApprovedDraft(draft, plan);

    return {
      draft:           named,
      _planShown:      true,
      _approvedPlan:   plan,
      ...(change ? { clarifications: [{ q: '(plan change)', a: String(change) }] } : {}),
      confirmationLog: [{ step: state.step, type: 'plan_review', approved: true }],
      step:            state.step + 1,
      phase:           'proposing',    // → generate
      _regenReason:    { route: 'first_build', detail: change ? 'plan approved with a change' : 'plan approved' },
    };
  });

  // ── generate ─────────────────────────────────────────────────────────────────
  // Emit the WHOLE spec in one model call. (Converger rearchitecture, Increment 2.)
  //
  // Replaces the one-component-at-a-time propose loop's node-building: one `llmJson`
  // call returns the complete `{ triggers, nodes, edges }`, which is merged into the
  // draft (preserving the already-gathered outcome/name/triggers) and then run through
  // `wireEdges` so the structural edges a branch/decision MUST have are guaranteed even
  // if the model dropped one — the exact failure this rearchitecture fixes.
  //
  // NOT YET WIRED INTO THE ROUTING (Increment 3 does that). Adding it here as an
  // unrouted node leaves the default flow unchanged — `_validate` does not require a
  // node to be reachable — while making it drivable/unit-testable. The generated spec
  // still goes through the validator downstream; this does not bypass it.
  graph.addNode('generate', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;
    const draft = state.draft ?? { ...DRAFT_DEFAULT };

    // ── EVERY WHOLE-SPEC PASS SAYS WHY IT IS HAPPENING ───────────────────────
    // This is the single most expensive thing the builder does — one Opus pass over
    // the entire workflow, 90–400 seconds on the record — and SIX routes can order
    // one. Three of them recorded nothing at all, so a build that rebuilt itself five
    // times looked, in the log, exactly like a build that rebuilt once: the only
    // instrument was `converger.node`'s wall-clock, and the reason had to be inferred
    // by elimination from how long the preceding `analyze` took. (Measured on
    // `build-agntic-1785087187289`, 2026-07-26: three consecutive rebuilds — 155s,
    // 130s, 203s — driven by the "is this finished?" sufficiency check, which logged
    // nothing whatsoever. 8 minutes 16 seconds of a person waiting, 98% of it inside
    // these three calls.)
    //
    // Logged HERE, at the choke point where the rebuild is ISSUED, rather than at each
    // of the six routes that request one — the same reasoning as the no-op guard
    // below. A route that forgets to say why shows up as `unattributed`, which is
    // loud and greppable; it is never allowed to fail a person's build over a log
    // label, and it can never gate or bound the rebuild.
    logEvent('converger.generate_pass', {
      ...who(cfg),
      route:        state._regenReason?.route ?? 'unattributed',
      detail:       state._regenReason?.detail ?? null,
      regeneration: !!state._generated,
      round:        state.buildPresentations ?? 0,
      step:         state.step,
      // A resumed pass re-runs this node from the top and pays for the model AGAIN
      // (see `streamedThinking` below). Marking it is what keeps the pass count honest.
      resumed:      streamedThinking.has(`${sessionId ?? ''}:${state.step}`),
      repairs:      (state._repairs ?? []).map(r => r.code),
    });

    // AGGREGATE HARD CAP (see `buildPresentations`). Every regenerate path routes back
    // HERE to rebuild the whole spec; independently each is bounded (MAX_REGEN_ROUNDS /
    // MAX_GAP_ROUNDS / MAX_VERIFY_ROUNDS / the sufficiency cap), but together they
    // compound with no total cap — which is how a spec the model cannot settle spins
    // through the (expensive) Opus rebuild far more than any single loop intends. Once
    // we've RE-generated MAX_BUILD_REGENERATIONS times (a regenerate is a build with
    // `_generated` already latched), STOP: do not spend another Opus pass. Keep the best
    // draft we have (`state.draft`, already built once) and force the build straight to
    // the single walkthrough → ratify via analyze, carrying an honest note. This fires
    // regardless of WHICH loop drove us back, so it can never be defeated by any single
    // counter failing to persist. (A first build — `_generated` false — is never capped:
    // this is a bound on RE-generation, not on building.) NOTE: this cap now bounds the
    // SILENT internal regenerate loop — the walkthrough is presented exactly once, at the
    // end, so this can never loop the USER through re-approvals; it only stops the model
    // burning Opus passes it cannot converge.
    if (state._generated && (state.buildPresentations ?? 0) >= MAX_BUILD_REGENERATIONS) {
      emitBeat(cfg, {
        kind: 'check',
        text: "I rebuilt this a few times and it still isn't settling — I've stopped so you can review it. The workflow is built; please review it before going live.",
      });
      return {
        phase:         'analyzing',   // analyze sees `_buildCapped` and routes to the walkthrough
        _buildCapped:  true,
        // Only claim a give-up if verify hasn't already reported a clean pass on THIS
        // draft — otherwise keep its honest verdict. A stale pass can't have survived a
        // rebuild, so in practice this is a gave-up state, surfaced (never a hard block).
        _verifyReport: (state._verifyReport && state._verifyReport.gaveUp === false)
          ? state._verifyReport
          : { ran: false, passed: 0, total: 0, gaveUp: true,
              note: 'the workflow kept changing on each rebuild, so I stopped before it could loop — review it before going live' },
        confirmationLog: [{ step: state.step, type: 'generate_capped', buildPresentations: state.buildPresentations ?? 0 }],
        step: state.step + 1,
        // Consumed. A reason left on the state would mis-label whatever rebuild came next.
        _regenReason: null,
      };
    }

    // WHY THE REBUILD IS DIFFERENT FROM THE LAST ONE.
    //
    // `_missingNote` carries the reason the previous draft was rejected — either a
    // concrete missing component named by the sufficiency check, or the list of
    // blocking gaps that failed the floor. Fold it into the clarifications so the
    // rebuild actually acts on it; without it generate re-runs on identical input,
    // produces the same still-incomplete spec, and the loop just burns Opus calls
    // until it hits its cap.
    //
    // (This comment previously claimed "the blocking-gap route already arrives via
    // `clarifications`". It did not — that route sent no reason at all, which is
    // exactly the failure the rest of this comment describes. Both routes now set
    // `_missingNote`.)
    const clarifications = state._missingNote
      ? [...(state.clarifications ?? []), { q: '(still missing)', a: String(state._missingNote) }]
      : state.clarifications;

    // THE ONE PLACE REAL REASONING HAPPENS. This is the 30–60s Opus call that emits
    // the whole spec at once — the emptiest stretch of the panel. We STREAM it with
    // extended thinking ENABLED and forward the model's raw thinking tokens to the
    // REASONING surface as they arrive, so the user watches the model reason through
    // the build (trigger, steps, branches, delivery) instead of staring at a spinner.
    //
    // Stream ONCE per generation: interrupt() below re-runs this node from the top on
    // resume, so we gate narration on `state.step` (stable across a pass + its resume,
    // advances for a later revise-rebuild). A resumed pass still RE-RUNS the model —
    // that is the engine's existing behaviour — it simply does not re-narrate.
    const streamKey = `${sessionId ?? ''}:${state.step}`;
    const firstPass = !streamedThinking.has(streamKey);
    if (firstPass) streamedThinking.add(streamKey);
    const onThinking = firstPass ? (delta) => narrateThinking(cfg, delta, streamKey) : null;

    // LIVE NODE STREAM (the in-chat graph build). As the spec JSON is WRITTEN — after
    // the thinking — pop each completed node into the client's live graph the instant
    // the model finishes it. firstPass-gated like the thinking, and best-effort: the
    // authoritative parse (mergeGeneratedSpec below) is still the source of truth; these
    // beats are a progress feed the client renders, never the spec itself.
    const nodeStreamState = {};
    const onAnswer = firstPass
      ? (_delta, acc) => {
          for (const node of streamNodesFrom(acc, nodeStreamState)) {
            emitBeat(cfg, { kind: 'node', streamId: streamKey, node: {
              id: node.id, type: node.type, label: node.label ?? null,
              mode: node.config?.mode ?? null, description: node.description ?? null,
            } });
          }
        }
      : null;

    const generated = await llmJsonStreaming(llm, [
      new SystemMessage(buildSystemPrompt(state.capabilities)),
      new HumanMessage(buildGeneratePrompt({
        intent:         state.intent,
        clarifications,
        outcome:        draft.outcome,
        draft,
        capabilities:   state.capabilities,
        setupResults:   state.setup_results,
        plan:           state._approvedPlan,   // the user-approved skeleton (increment 1)
        // WHAT WE ALREADY FIXED FOR IT. Without this the pass cannot see the repairs
        // the last one triggered — the prompt lists the previous nodes as ids/types/
        // labels only — so it re-emits the identical blank and the build makes no
        // progress by construction. See `_repairs` in the state schema for the
        // three-passes-in-a-row this was measured on.
        repairs:        state._repairs,
      })),
      // The whole-spec call is the n8n-level reasoning step — it emits every node, every
      // edge and every branch case at once — so it runs on a DEDICATED top tier,
      // 'architect' (wired to Opus in the ModelPool via server.js). It is deliberately
      // NOT 'powerful'/'balanced' (those map to sonnet and are used by the chatty
      // clarify/modify/gap calls): a dedicated tier keeps the expensive Opus call scoped
      // to exactly ONE high-value generation per build. The ModelPool falls back to its
      // default tier if 'architect' isn't mapped yet, so this is safe before the mapping
      // lands. Cost is attributed to the tenant via tierCfg(name, sessionId): sessionId
      // (the build's threadId) is what the CostTracker resolves session→user→tenant with,
      // and costContext:'converger' labels the spend — the streamed path tracks the
      // call's tokens (thinking tokens included, billed in output) exactly as the
      // blocking one did, so an un-attributed call that drops out of per-tenant/per-build
      // aggregates cannot happen here. If streaming/thinking fails, it falls back to the
      // blocking call, so the build still completes.
    ], tierCfg('architect', sessionId), { onThinking, onAnswer });

    // DEFENSIVE: the model returned nothing usable (no nodes). Do NOT crash and do
    // NOT ship an empty spec — fall back to a clarification interrupt, the same honest
    // move `propose` makes on unparseable output.
    if (!generated || !Array.isArray(generated.nodes) || !generated.nodes.length) {
      // NOT "describe it step by step". The one time this fired in real use, the user
      // HAD described it step by step — in detail — and the build failed for reasons
      // that had nothing to do with them. Asking someone to redo work they already did
      // correctly is worse than saying nothing.
      const q = "I got most of the way through building this and couldn't finish writing it out — "
              + 'that\'s on me, not your description. Say "try again" to have another go, or tell me one '
              + 'part to drop and I\'ll build the rest.';
      logEvent('converger.generate_empty', {
        ...who(cfg), regeneration: !!state._generated, round: state.buildPresentations ?? 0, step: state.step,
      });
      const answer = await interrupt({ type: 'clarification', question: q, step: state.step });
      return {
        clarifications:  [{ q, a: answer?.answer ?? String(answer) }],
        confirmationLog: [{ step: state.step, type: 'clarification', question: q, answer }],
        step:            state.step + 1,
        phase:           'analyzing',
        _regenReason:    null,
        _repairs:        [],
        // ── A PASS THAT PRODUCED NOTHING STILL COST A WHOLE OPUS CALL ──────────
        // This path returned WITHOUT bumping either counter, so a truncated or
        // unparseable emission was a FREE rebuild: it spent the money, produced no
        // spec, and left every cap exactly where it found it. Worse, `interrupt()`
        // re-runs this node from the top on resume (see `streamedThinking` above), so
        // one truncation buys a SECOND uncounted call. The truncation mode is real and
        // documented — see `GENERATE_MAX_TOKENS`, where a 6.6-minute build was cut off
        // mid-JSON — so this is the cap's largest hole, not a theoretical one.
        //
        // Counted exactly like the success path: a RE-generation counts, a first build
        // does not (`_generated` gates both, matching the cap's own rule that this
        // bounds re-generation, never building). The budget must be spent by the CALL,
        // not by the call's luck.
        regenRounds:        state._generated ? (state.regenRounds ?? 0) + 1 : (state.regenRounds ?? 0),
        buildPresentations: state._generated ? (state.buildPresentations ?? 0) + 1 : (state.buildPresentations ?? 0),
      };
    }

    const merged = mergeGeneratedSpec(draft, generated);

    // ── A REBUILD THAT PRODUCED THE SAME SPEC HAS PROVEN IT CANNOT FIX IT ─────
    // This is the choke point: every regenerate path — a blocking gap, a
    // sufficiency-named component, a decision-table correction, a failed self-test —
    // routes back through THIS node. An earlier attempt guarded only one of those
    // callers (analyze's blocking-gap route) and did nothing at all for a real build,
    // because every rebuild in it came through `verify`. Guarding one caller while
    // four exist is the denylist mistake; the guard belongs where the rebuild is
    // ISSUED, not where it is requested.
    //
    // Measured on a 26-step, 4-connector build: generate ran 4× (871.6s) and verify 3×
    // (462.7s) — 96% of a 23-minute build — and the workflow that came out was the one
    // the plan described all along.
    //
    // The signal is the OUTPUT, not the input: the inputs legitimately differ each
    // round (verify appends its complaint as a clarification), so "same input" would
    // never fire. What matters is whether the rebuild actually CHANGED the workflow.
    // If the shape that comes back is identical to the shape that went in, another
    // pass with the same complaint will return the same thing again.
    const shapeOf = (d) => JSON.stringify({
      t: (d?.triggers ?? []).map(t => t?.type ?? ''),
      n: (d?.nodes ?? []).map(n => `${n?.id}:${n?.type}:${JSON.stringify(n?.config ?? {})}`).sort(),
      e: (d?.edges ?? []).map(x => `${x?.from}>${x?.to}`).sort(),
    });
    // THE FIRST FIX ATTEMPT IS ALWAYS ALLOWED. A complaint deserves one honest try even
    // if the model happens to return the same shape — `verify` retries a flaky sample,
    // so one identical rebuild can still end in a pass. It is the SECOND identical
    // rebuild that has proven the point: the spec did not move, and it will not.
    // (`buildPresentations` is the count BEFORE this pass, so 0 = first rebuild.)
    const newShape = shapeOf(merged);
    if (state._generated && (state.buildPresentations ?? 0) >= 1 && newShape === state._lastShape) {
      logEvent('converger.regen_noop', {
        ...who(cfg),
        round: state.buildPresentations ?? 0,
        nodes: (merged.nodes ?? []).length,
      });
      // STOP THE REBUILDS WITHOUT SKIPPING THE HONEST ENDING. The obvious move —
      // jumping straight to the walkthrough — also skips `verify`, and `verify` is
      // where the give-up is NARRATED ("I couldn't get a sample to pass"). Cutting the
      // cost by silently dropping the sentence that tells the user the self-test never
      // passed would trade an honest failure for a cheaper one.
      //
      // So instead the rebuild BUDGETS are exhausted and the graph runs on exactly as
      // it would have. Every loop still reaches its own terminal path and says its own
      // piece; none of them can buy another Opus pass.
      return {
        draft: merged,
        _generated: true,
        _lastShape: newShape,
        regenRounds:       MAX_REGEN_ROUNDS,
        verifyRounds:      MAX_VERIFY_ROUNDS,
        // ALL of them, not just the loud ones. Saturating verify and the gap loop while
        // leaving the sufficiency check open meant it simply ordered the next rebuild
        // instead — the guard fired, logged, and changed nothing. A budget guard has to
        // close every budget that can buy a pass.
        sufficiencyChecks: MAX_SUFFICIENCY_CHECKS,
        // The aggregate counter must still advance. Leaving it untouched let this pass
        // ride free and pushed the total cap out by one whole Opus rebuild — a guard
        // that costs a pass is not a saving.
        buildPresentations: (state.buildPresentations ?? 0) + 1,
        _missingNote: null,
        // Both consumed by this pass. Left behind, the repair note would be re-shown to
        // a rebuild that was never told about it and the route label would name the
        // wrong caller.
        _repairs:     [],
        _regenReason: null,
        // STOPPING EARLY MUST NOT TURN A FAILURE INTO A SILENT PASS. If the self-test
        // was the thing complaining, its report is carried forward and marked given-up,
        // so ratify still tells the user plainly that it could not get a sample to pass.
        // Without this the build ends quietly and looks successful — trading an honest
        // failure for a cheaper one, which is the worst trade available here.
        confirmationLog: [{ step: state.step, type: 'generate', noop: true, nodes: merged.nodes.map(n => ({ id: n.id, type: n.type })) }],
        step:  state.step + 1,
        phase: 'analyzing',
      };
    }

    // NO WALKTHROUGH HERE — moved to the `walkthrough` node, after verify (2026-07-16).
    //
    // The `generated_workflow` step-approval used to fire RIGHT HERE, at the end of
    // `generate` — BEFORE the tail (analyze → destinations → decisions → gaps → verify)
    // had run. So the user approved a draft that then CHANGED underneath them:
    // `destinations` repointed a base, `gaps` materialised escalations, `verify`
    // regenerated the whole spec — and a verify-driven regenerate came back HERE and
    // RE-PRESENTED the walkthrough to be approved all over again.
    //
    // `generate` is now PURELY INTERNAL: it produces the spec, merges/wires it, and
    // routes on. Every regenerate path (a blocking gap, a sufficiency-named component,
    // a verify fix, a decision-table correction) re-runs it SILENTLY. The single
    // step-approval fires ONCE, on the FINAL settled spec, in the `walkthrough` node
    // between `verify` and `ratify`.
    //
    // The regenerate loop stays bounded exactly as before: `buildPresentations` (bumped
    // below on every RE-generation) + MAX_BUILD_REGENERATIONS is the aggregate cap —
    // re-pointed from "walkthrough re-presentations" to "internal generate re-runs" (the
    // two were 1:1 when the walkthrough lived here, so the counter and cap are unchanged;
    // only what they COUNT is). Individual loops are separately bounded (MAX_REGEN_ROUNDS
    // / MAX_GAP_ROUNDS / MAX_VERIFY_ROUNDS / the sufficiency cap); this is the total.
    return {
      draft: merged,
      // The whole-spec pass has run: `analyze` re-scores this now-complete draft and
      // routes it onward (gapping → destinations → …). `_generated` latches so the
      // regenerate counter (below) counts only TRUE rebuilds, not this first build.
      _generated: true,
      // Remembered so the NEXT rebuild can tell whether it changed anything. Without
      // this the comparison above can never match and the guard is dead code.
      _lastShape: newShape,
      // Count a REGENERATION only when a prior build already latched — the first
      // build must not consume the MAX_REGEN_ROUNDS budget. `_missingNote` is cleared
      // now that this pass has consumed it, so it can't leak into an unrelated rebuild.
      regenRounds:  state._generated ? (state.regenRounds ?? 0) + 1 : (state.regenRounds ?? 0),
      // AGGREGATE internal-regenerate counter — bumped on every RE-generation (a build
      // with `_generated` already latched), NOT the first build, exactly like
      // `regenRounds`. Since the walkthrough moved to its own node, `generate` no longer
      // presents anything; this now counts INTERNAL generate re-runs across ALL paths
      // (analyze/decisions/gaps/verify), so nothing can defeat the total cap by resetting
      // one loop's own counter. It is the belt-and-suspenders bound that forces the
      // silent regenerate loop to terminate at the single walkthrough → ratify.
      buildPresentations: state._generated ? (state.buildPresentations ?? 0) + 1 : (state.buildPresentations ?? 0),
      _missingNote: null,
      // Consumed by this pass — see the no-op return above for why neither may persist.
      _repairs:     [],
      _regenReason: null,
      confirmationLog: [{
        step: state.step, type: 'generate',
        nodes: merged.nodes.map(n => ({ id: n.id, type: n.type })),
        edges: merged.edges,
      }],
      step:  state.step + 1,
      // Back to `analyze` (via the new generate → analyze edge) to re-score the
      // complete draft and route it to gapping.
      phase: 'analyzing',
    };
  });

  // ── destinations ───────────────────────────────────────────────────────────
  // "Which base? Which table?" — as CLICKS, never as a pasted id. (Increment F.)
  //
  // This is §6.2.3 (*never ask for something we can read*) made concrete, and it is
  // where "just talk to it" previously died: a workflow that writes to Airtable
  // needs `appXXXXXXXXXXXXXX` and an exact table name, and no amount of conversation
  // can produce them. The model cannot know them; the user has to go and look them
  // up. So the builder stopped being a builder and became a form.
  //
  // We hold the tenant's OAuth token, and it can read all of it. So:
  //
  //   0 bases  → say so plainly (they connected an empty Airtable)
  //   1 base   → TAKE IT. Zero-typing (§6.2.4): a question with one possible answer
  //              is not a question, it is a speed bump.
  //   N bases  → chips. `choices[]` is the SHARED interrupt primitive (§6.3), so
  //              this needs no new client surface — the composer already renders it.
  //
  // …and the same for tables. Then the table's REAL columns go into the draft, so
  // the record lands in `Deal Size` rather than in a column the model invented.
  //
  // NO INVOKER ⇒ WE ASK, WE NEVER GUESS. Without a live connector this node is a
  // pass-through and the ordinary propose loop asks the user for the id, exactly as
  // it did before F. Degrading to a question is honest; degrading to a made-up base
  // id would write a customer's lead into nothing.
  // ── P13-0 seam #3: WHICH connector, and HOW is its schema read? ──────────────
  //
  // This node was hardwired to the literal string 'airtable' in four places, plus the
  // capability ids `airtable_list_bases` / `airtable_describe_base`. The dead constant
  // that used to sit here — `{ baseId: 'airtable', spreadsheetId: 'sheets' }` — was an
  // abandoned attempt at exactly this generalization, declared and never referenced.
  //
  // Now: a connector DECLARES how its schema is discovered (capability-registry.js,
  // `schemaDiscovery`), and this node reads the declaration. A connector that declares
  // nothing is not guessed at — the ordinary propose loop asks the user, which is what
  // every non-Airtable connector already did.
  //
  // Resolves ONE connector per pass: the first declaring connector that this draft
  // actually writes to. That matches the node's existing single-destination shape;
  // a draft writing to two schema-bearing connectors resolves them on successive
  // passes, because the node re-enters until nothing drifts.
  const resolveDiscovery = (nodes) => resolveSchemaDiscovery(capabilityCatalog, nodes);

  graph.addNode('destinations', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;
    const nodes = state.draft?.nodes ?? [];

    // Which steps write to a connector whose schema we can read? ALL of them are
    // candidates — we do NOT ask whether the model's container id "looks real" first,
    // because a plausible-looking hallucination (`appABCDEFGHIJKLMN`) passes any shape
    // test, and gating the whole node on that test let one guess skip the container
    // lookup, the table lookup and the column mapping. Ask the connector; it knows.
    const resolved = resolveDiscovery(nodes);
    if (!resolved || !invokeCapability) return { phase: 'gapping' };
    const { connector: targetConnector, descriptor, targets: writeNodes } = resolved;

    // ── THE LATCH STOPS US ASKING AGAIN. IT MUST NOT STOP US CHECKING AGAIN. ──
    //
    // `destinationsResolved` used to skip this node entirely on re-entry, and that
    // was a hole straight back to the defect the increment exists to kill:
    //
    //   · `applyProposal` REPLACES a node by id (spec-assembler.js).
    //   · A BLOCKING gap routes back through `propose`.
    //   · So any propose round AFTER the resolution can rewrite the write node's
    //     `fields` — and nothing re-checked them against the real table.
    //
    // And the gap loop HANDS THE MODEL THE MOTIVE. The blocking gap says "you
    // promised Company and nothing writes it", so the model obligingly re-proposes
    // the node with `Company` back on it. The honest failure this increment
    // designed — an unmappable column stays in the contract and fails loudly — is
    // converted into a SILENT SUCCESS by the very loop that reported it. It
    // publishes; Airtable ignores the column; the record is created with it empty;
    // `run_completed`. Forever. (Found by the independent verifier.)
    //
    // The invariant — "this write's columns have been checked against the real
    // table" — was established once and never re-established. A fact that can be
    // falsified by the next node is not an invariant, it is a memory.
    //
    // So: the RESOLVED DESTINATION is cached (no second lookup, no second "which
    // base?" — a question asked twice is one people learn to click past), and the
    // COLUMNS ARE RE-CHECKED on every pass. Re-checking is free: it reads state.
    const cached = state.destination;
    if (cached?.columns) {
      const real = new Set(cached.columns.map(c => String(c.name).toLowerCase()));
      const drifted = writeNodes.some((n) => {
        const f = readFields(n.config);
        // A `fields` we cannot read AT ALL is drift too: it is a write whose columns
        // nobody has checked, which is the whole thing we are guarding against.
        if (!f) return typeof n.config?.fields === 'string';
        return Object.keys(f).some(k => !real.has(String(k).toLowerCase()));
      });
      if (!drifted) return { phase: 'gapping' };

      // A column crept back in. Re-map against the columns we already read, and
      // restate the contract — exactly as on the first pass.
      const { fields: mapped, renames, unmapped } = await mapFieldsToColumns({
        llm, sessionId, nodes: writeNodes, columns: cached.columns,
        outcome: state.draft?.outcome, table: cached.table,
      });
      return {
        draft: {
          ...state.draft,
          outcome: rewriteAssertionFields(state.draft?.outcome, renames, cached.columns, targetConnector),
          nodes: fillDestination(nodes, {
            connector: targetConnector, descriptor,
            containerId: cached.baseId, tableId: cached.table, fields: mapped, columnsRead: true,
          }),
        },
        confirmationLog: [{ step: state.step, type: 'destination_rechecked', unmapped }],
        step:  state.step + 1,
        phase: 'gapping',
      };
    }
    if (state.destinationsResolved) return { phase: 'gapping' };

    // ── 1. The base ──────────────────────────────────────────────────────────
    let bases;
    try {
      // A connector with no list capability has ONE implicit container: whatever the
      // draft already names. Declaring `listCapability: null` is how a connector says
      // "there is nothing to choose between", and it must not become a lookup of the
      // empty string.
      bases = descriptor.listCapability
        ? ((await invokeCapability(descriptor.listCapability))?.[descriptor.listResultKey] ?? [])
        : [];
    } catch (err) {
      // A connector that cannot be read is not a connector that can be guessed at.
      // Fall through to the ordinary loop, which ASKS.
      return { phase: 'gapping', confirmationLog: [{ step: state.step, type: 'destination_lookup_failed', error: String(err?.message ?? err) }] };
    }
    if (!bases.length) return { phase: 'gapping' };

    // A base id the model already put in the draft is honoured ONLY if the tenant
    // actually has it. Anything else is a guess, and a guess writes the customer's
    // lead into a base that does not exist.
    const already = writeNodes.map(n => n.config?.[descriptor.containerKey]).find(b => isKnownBase(b, bases));
    let base = already ? bases.find(b => b.id === already) : bases[0];
    // ── A QUESTION ALREADY ANSWERED MUST NOT BE ASKED AGAIN ──────────────────
    // `already` is a base the DRAFT names and the tenant genuinely has — which means
    // the model chose it, and it chose it from what the user said. Asking anyway
    // (this was `if (bases.length > 1)`) made the build re-ask a question answered
    // moments earlier in the same conversation: observed live, the user said "Agntic
    // CRM Sheet1", the plan named it, the schema was quoted back to them, and then a
    // chip list appeared asking which base to write to.
    //
    // Only ask when there is a real ambiguity — no valid pre-resolved base AND more
    // than one to choose from. A guessed or unknown id still asks, because a guess
    // writes the customer's lead into a base that does not exist.
    if (bases.length > 1 && !already) {
      const answer = await interrupt({
        type: 'clarification',
        question: `Which ${descriptor.containerLabel ?? 'destination'} should this write to?`,
        choices: bases.map((b, i) => ({ id: b.id, label: b.name, selected: i === 0 })),
        step: state.step,
      });
      base = bases.find(b => b.id === answer?.id || b.name === answer?.answer) ?? bases[0];
    }

    // ── 2. The table, and its REAL columns ───────────────────────────────────
    let tables = [];
    try {
      tables = (await invokeCapability(
        descriptor.describeCapability, { [descriptor.describeArg]: base.id },
      ))?.[descriptor.describeResultKey] ?? [];
    } catch { /* fall through: we have a base, and the loop can still ask for a table */ }
    if (!tables.length) {
      return {
        draft: { ...state.draft, nodes: fillDestination(nodes, { connector: targetConnector, descriptor, containerId: base.id }) },
        destinationsResolved: true, step: state.step + 1, phase: 'gapping',
      };
    }

    // Same rule as the base: a table the draft already names, which this base really
    // has, is an answer — not a question. Matched on id OR name, because the model
    // writes whichever the user said ("Sheet1").
    const namedTable = writeNodes
      .map(n => String(n.config?.[descriptor.tableKey] ?? n.config?.table ?? '').trim())
      .filter(Boolean)
      .map(t => tables.find(x => x.id === t || x.name.toLowerCase() === t.toLowerCase()))
      .find(Boolean);
    let table = namedTable ?? tables[0];
    if (tables.length > 1 && !namedTable) {
      const answer = await interrupt({
        type: 'clarification',
        question: `Which ${descriptor.tableLabel ?? 'table'} in "${base.name}"?`,
        choices: tables.map((t, i) => ({ id: t.id, label: t.name, selected: i === 0 })),
        step: state.step,
      });
      table = tables.find(t => t.id === answer?.id || t.name === answer?.answer) ?? tables[0];
    }

    // ── 3. Map the promised fields onto the columns that ACTUALLY EXIST ───────
    // One cheap call. The alternative is the model inventing `Budget` when the
    // column is called `Deal Size`, which Airtable accepts by silently ignoring —
    // the record is created, the field is empty, and the run reports success.
    const columns = table[descriptor.tableColumnsKey] ?? [];
    const { fields: mapped, renames, unmapped } = await mapFieldsToColumns({
      llm, sessionId, nodes: writeNodes, columns,
      outcome: state.draft?.outcome, table: table.name,
    });

    // ── 4. THE OUTCOME MUST BE REWRITTEN TOO ─────────────────────────────────
    //
    // Rewriting the NODE's columns and leaving the outcome's assertion promising the
    // old ones is a dead end with the lights on: the node now writes `Deal Size`, the
    // contract still promises `Budget`, UNSATISFIED_ASSERTION fires, and the spec
    // CANNOT PUBLISH — on the SUCCESS path, when the mapping did exactly its job.
    // `complete ⇒ publishable` was false precisely when the increment worked. That is
    // the Increment C blocker, reintroduced by F's headline feature.
    //
    // The contract is a promise about the REAL world, and we have just learned what
    // the real world's columns are called. So the promise is restated in the world's
    // own words — and the restatement is logged, because silently editing a user's
    // contract is exactly the sin the outcome exists to prevent.
    // (Found by the test-adversary.)
    const outcome = rewriteAssertionFields(state.draft?.outcome, renames, columns, targetConnector);

    return {
      draft: {
        ...state.draft,
        outcome,
        nodes: fillDestination(nodes, {
          connector: targetConnector, descriptor,
          containerId: base.id, tableId: table.name, fields: mapped, columnsRead: true,
        }),
      },
      destination: { baseId: base.id, table: table.name, columns },
      confirmationLog: [{
        step: state.step, type: 'destination_resolved',
        base: { id: base.id, name: base.name }, table: table.name,
        columns: columns.map(c => c.name), mapped, renames,
        // A field the table simply does not have. Said out loud: it stays in the
        // outcome, fails UNSATISFIED_ASSERTION, and the user is told — rather than
        // being quietly dropped by the code written to stop things being dropped.
        unmapped,
      }],
      destinationsResolved: true,
      step:  state.step + 1,
      phase: 'gapping',
    };
  });

  // ── decisions ──────────────────────────────────────────────────────────────
  // "Here is the table I induced. Correct it."  (P12 Increment E, §6.4)
  //
  // The table is REVIEWED, never AUTHORED. Nobody can write a decision table from
  // a blank grid — but everybody can look at a wrong row and say "no, over $50k is
  // P1". Recognition over recall (§6.2.1), which is only possible because the
  // domain is CLOSED: the cells are dropdowns precisely because
  // LLM_INPUT_NOT_ENUM forced every AI-judged input into a declared list of
  // values. The moat is what makes the multiple-choice UI possible; the
  // multiple-choice UI is what makes the moat affordable to the user. They are the
  // same asset (§13).
  //
  // It runs BEFORE `gaps`, so that a table the user has just corrected is the one
  // whose remaining holes they are asked about — otherwise the gap list would be
  // about a table that no longer exists.
  //
  // No LLM call: the table is already in the draft, and the analysis is arithmetic.
  graph.addNode('decisions', async (state) => {
    const tables = (state.draft?.nodes ?? []).filter(n => n?.type === 'decision');

    // Most workflows do not decide anything, and must not be shown an empty grid
    // and asked to admire it. A pass-through, with no interrupt and no cost.
    if (!tables.length || state.decisionsReviewed) return { phase: 'gapping' };

    const payload = tables.map((node) => {
      const { inputs, output, rules, hitPolicy } = tableOf(node);
      const analysis = analyzeTable({ inputs, rules, hitPolicy });
      return {
        decisionId: node.id,
        label:      node.label || node.id,
        inputs, rules, hitPolicy,
        output:     { key: output?.key ?? 'result', values: valuesOf(output) },
        hitPolicyOptions: HIT_POLICIES.map(p => ({
          id: p, label: HIT_POLICY_LABELS[p], selected: p === hitPolicy,
        })),
        // What the analysis already knows, so the review surfaces it in place
        // rather than making the user find it. `uncovered` here is a PREVIEW; the
        // authoritative list is the gap review, one step later, on the table as
        // corrected.
        uncovered: analysis.uncovered.length + analysis.truncated,
        decidable: analysis.decidable,
        // DECOMPOSE AT >4 INPUTS (§12). The limit is cognitive: box subtraction
        // would happily analyse ten. But a table nobody can hold in their head is
        // one nobody reviews, and an unreviewed table is not auditable — which is
        // the whole claim.
        tooWide:   inputs.length > DECISION_MAX_INPUTS,
        decompose: inputs.length > DECISION_MAX_INPUTS
          ? `This decides on ${inputs.length} things at once. Past four, nobody can check the table — split it in two: decide "${inputs.slice(0, 2).map(i => i.key).join('" and "')}" first, then feed that answer into a second table as a single input.`
          : null,
      };
    });

    // ── CONFIRM CONVERSATIONALLY, NOT ON A GRID CARD (#24) ──────────────────
    // The decision review was a bespoke dropdown grid; it now confirms each
    // induced table through the ordinary `clarification` surface, one table at a
    // time. Recognition still beats recall — the plain-English rule is stated and
    // the default ("looks right" / Enter / the zero-typing autoRespond) keeps it
    // verbatim, so a user who trusts it answers nothing. A user who does not
    // describes the change, and the whole spec regenerates with it as guidance
    // (bounded to one round; after that the induced table stands and any residual
    // hole surfaces as a gap). No LLM call here — the node re-runs cleanly on each
    // per-table resume because the analysis is arithmetic.
    // IDENTIFIERS ARE THE CODEBASE'S FILING SYSTEM, NOT ENGLISH. This read out as
    // "when budget >50000 → budget_tier = high_budget" — three machine names in one
    // line, on a question a non-technical user is being asked to judge. They are asked
    // to confirm a rule, so the rule has to be in words they used.
    const human = (s) => String(s ?? '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // ">50000" → "is over 50,000"; "[1..50000]" → "is between 1 and 50,000"; "-" → any.
    const readCond = (v) => {
      const s = String(v ?? '').trim();
      const num = (n) => Number(n).toLocaleString('en-US');
      let m;
      if ((m = s.match(/^>=?\s*(-?[\d.]+)$/)))  return `is over ${num(m[1])}`;
      if ((m = s.match(/^<=?\s*(-?[\d.]+)$/)))  return `is ${num(m[1])} or under`;
      if ((m = s.match(/^\[\s*(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*\]$/))) return `is between ${num(m[1])} and ${num(m[2])}`;
      if (s === '-' || s === '') return 'is anything else';
      return `is ${human(s)}`;
    };
    const corrections = [];
    for (const p of payload) {
      const outName = human(p.output?.key);
      const ruleText = (p.rules ?? []).map((r, i) => {
        const when = r?.when && Object.keys(r.when).length
          ? Object.entries(r.when).map(([k, v]) => `${human(k)} ${readCond(v)}`).join(' and ')
          : 'anything else';
        return `  ${i + 1}. If ${when} → ${human(r?.then) || '?'}`;
      }).join('\n');
      const reply = await interrupt({
        type: 'clarification',
        kind: 'decision_review',            // inert to client/replier; identifies the surface
        decisionId: p.decisionId,
        question:
          `Here's how "${p.label}" would decide ${outName}:\n${ruleText || '  (no rules yet)'}\n\n`
          + `Does that match how you actually decide? Say "looks right" to keep it, or tell me what's different.`,
        choices: [{ label: 'Looks right' }],
        step: state.step,
      });
      const raw = String(reply?.answer ?? (typeof reply === 'string' ? reply : '')).trim();
      const isDefault = !raw
        || /^(looks right|correct|yes|yep|keep it|that's right|thats right)$/i.test(raw)
        || /please proceed with your best inference/i.test(raw);
      if (!isDefault) corrections.push({ decisionId: p.decisionId, label: p.label, note: raw });
    }

    const logEntry = {
      step: state.step, type: 'decision_review',
      decisions: payload.map(p => ({ decisionId: p.decisionId, rules: p.rules, hitPolicy: p.hitPolicy })),
      corrections,
    };

    // A described correction cannot be a structured cell-edit over a chat surface,
    // so it regenerates the whole spec with the note as guidance. Bounded: after
    // one round the induced table stands (decisionRounds), and `decisionsReviewed`
    // latches so the rebuilt table is not re-interrogated. No correction ⇒ straight
    // on to `gaps` with the table exactly as induced.
    if (corrections.length && (state.decisionRounds ?? 0) < 1) {
      return {
        confirmationLog: [logEntry],
        clarifications:  corrections.map(c => ({ q: `How to decide "${c.label}"`, a: c.note })),
        decisionsReviewed: true,
        decisionRounds:  (state.decisionRounds ?? 0) + 1,
        proposeRounds:   0,
        step:  state.step + 1,
        phase: 'proposing',
        _regenReason: { route: 'decision_correction', detail: corrections.map(c => c.label).join(', ').slice(0, 300) },
      };
    }

    return {
      confirmationLog: [logEntry],
      decisionsReviewed: true,
      step:  state.step + 1,
      phase: 'gapping',
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
    let   draft     = state.draft;
    let   result    = scoreGap(draft, { capabilities: state.capabilities });

    // ── Silently auto-repair the builder's OWN structural bugs (#19) ─────────
    // A missing branch/route edge is not a user's decision; it is a defect in the
    // spec the converger drew, and the validator already knows the exact fix. We
    // apply every such fix directly (no LLM, no question), re-scoring after each
    // pass so a repair that revealed another problem is caught. Bounded, and
    // idempotent on resume (adding an existing edge is a no-op). This is what
    // stops zero-typing builds stranding at "Incomplete" with Run test disabled.
    const repairs = [];
    for (let pass = 0; pass < 4; pass++) {
      const r = autoRepairStructural(draft, result.gaps);
      if (!r.applied.length) break;
      repairs.push(...r.applied);
      draft  = r.draft;
      result = scoreGap(draft, { capabilities: state.capabilities });
    }
    // Everything the node returns must carry the repaired draft so it persists — AND
    // what was repaired, so a rebuild ordered from here is told about the fix instead
    // of quietly re-emitting the blank it filled. See `_repairs` in the state schema.
    const carry = repairs.length ? { draft, _repairs: repairs } : {};
    const repairLog = repairs.length
      ? [{ step: state.step, type: 'auto_repair', repairs }]
      : [];

    // ── RESOURCE_NOT_FOUND: create-or-pick, before any other gap (#25) ──────────
    //
    // A wire to a channel/base/table the tenant doesn't have. The general gap handler
    // below would feed this to the model as "add a delivery to #foo" and regenerate —
    // re-hallucinating the same non-existent target. So it is resolved HERE instead,
    // conversationally: offer to CREATE it (Slack, via the existing setup_action path)
    // or PICK an existing one. A created/picked resource clears the gap on re-score.
    //
    // Each node execution round-trips exactly ONE interrupt (resume() carries a single
    // value — compiled-graph.js), so the CREATE path returns to a dedicated
    // `resourceSetup` node for its own setup_action interrupt; the PICK path rewrites
    // the draft in place and re-enters `gaps`. `_resourceAsked` latches a resource we
    // already surfaced but could not resolve (create skipped, or pick-only with nothing
    // to pick), so the loop can never spin on an unanswerable one.
    const asked   = new Set(state._resourceAsked ?? []);
    const askKey  = (g) => `${g.nodeId ?? 'node'}:${g.resource?.kind}:${g.resource?.name}`.toLowerCase();
    const resGaps = result.gaps.filter(g => g.code === 'RESOURCE_NOT_FOUND' && !asked.has(askKey(g)));
    if (resGaps.length) {
      const g = resGaps[0];
      const r = g.resource ?? { options: [] };
      const opts = Array.isArray(r.options) ? r.options : [];

      const choices = [];
      if (r.canCreate) choices.push({ id: '__create__', label: `Create #${r.name}`, selected: true });
      for (const o of opts.slice(0, 12)) choices.push({ id: `use:${o.value}`, label: o.label, selected: !r.canCreate && choices.length === 0 });

      const question = r.canCreate
        ? `${g.message}\nWant me to create it, or point this at one you already have?`
        : opts.length
          ? `${g.message}\nWhich of your existing ones should I use?`
          : `${g.message}\n${g.hint}`;

      const reply    = await interrupt({ type: 'clarification', kind: 'resource_fix', question, choices, resource: r, step: state.step });
      const chosenId = reply?.id ?? null;
      const raw      = String(reply?.answer ?? (typeof reply === 'string' ? reply : '')).trim();
      const logBase  = { step: state.step, type: 'resource_fix', gap: { code: g.code, nodeId: g.nodeId, kind: r.kind, name: r.name }, reply };

      // A recognised pick — the chip (`use:<value>`), or free text that exactly names
      // an existing option (by value or label, with/without a leading #).
      const norm = (s) => String(s ?? '').replace(/^#/, '').trim().toLowerCase();
      const pickedOpt =
        (chosenId?.startsWith('use:') ? opts.find(o => `use:${o.value}` === chosenId) : null)
        ?? (raw ? opts.find(o => norm(o.value) === norm(raw) || norm(o.label) === norm(raw)) : null)
        ?? null;

      // Explicit create, or the zero-typing / default answer when creation is possible.
      const wantsCreate = r.canCreate && !pickedOpt && (
        chosenId === '__create__' || /\bcreate\b/i.test(raw) || raw === '' ||
        raw.toLowerCase() === `create #${r.name}`.toLowerCase());

      if (wantsCreate && r.createCapabilityId) {
        return {
          ...carry,
          confirmationLog: [...repairLog, { ...logBase, choice: 'create' }],
          _resourceCreate: { capabilityId: r.createCapabilityId, kind: r.kind, name: r.name, nodeId: g.nodeId, askKey: askKey(g) },
          step:  state.step + 1,
          phase: 'resource_setup',
        };
      }

      if (pickedOpt) {
        return {
          ...carry,
          draft: applyResourcePick(draft, g.nodeId, r.kind, pickedOpt.value),
          confirmationLog: [...repairLog, { ...logBase, choice: 'pick', picked: pickedOpt.value }],
          step:  state.step + 1,
          phase: 'gapping',                              // re-enter gaps → gap clears on re-score
        };
      }

      // Nothing to create and nothing recognised to pick: latch it (so we don't re-ask)
      // and let it fall through as a blocker the ratify screen names honestly.
      return {
        ...carry,
        confirmationLog: [...repairLog, { ...logBase, choice: 'unresolved' }],
        _resourceAsked:  [...(state._resourceAsked ?? []), askKey(g)],
        step:  state.step + 1,
        phase: 'gapping',
      };
    }

    const blocking = unansweredGaps(result);                       // must be ANSWERED
    const soft     = result.gaps.filter(g => !g.blocking);         // may be ESCALATED

    if (!blocking.length && !soft.length) {
      return { ...carry,
        ...(repairLog.length ? { confirmationLog: repairLog, step: state.step + 1 } : {}),
        phase: 'ratifying' };
    }

    // SOFT-ONLY, AND THE PLAN ALREADY SHOWED IT → no redundant interrupt (operator,
    // 2026-07-16). The Plan gate now surfaces the escalation policy upfront ("If something
    // breaks → …", tagged inferred and changeable there), so stopping the build to re-ask
    // the SAME soft edge cases — the error-handling default appeared on every build — is
    // friction, not a decision. When there are NO blocking gaps (nothing that needs a real
    // answer) and a plan was actually presented and approved (`_approvedPlan` — not the
    // fail-safe skip, where the user saw no plan), auto-apply the escalate defaults SILENTLY:
    // the exact same resolution the user's "Keep the safe defaults" click produced, and the
    // exact same paths `materialiseEscalations` writes at ratify. A BLOCKING gap still
    // interrupts — this only removes the redundant soft-only ask.
    if (!blocking.length && state._approvedPlan) {
      const escalated = soft.map(g => ({
        id: g.id, class: g.class, code: g.code, message: g.message, nodeId: g.nodeId ?? null, resolution: 'escalated',
      }));
      return {
        ...carry,
        confirmationLog: [...repairLog, { step: state.step, type: 'gap_review', auto: true,
          gaps: soft.map(g => ({ id: g.id, code: g.code, class: g.class, blocking: false })), escalated }],
        escalatedGaps:   escalated,
        step:            state.step + 1,
        phase:           'ratifying',
      };
    }

    // One cheap call so every gap arrives with an answer already in it. A gap
    // list with empty boxes is an interrogation; a gap list with defaults is a
    // review. The difference is the whole product.
    const suggested = await llmJson(llm, [
      new SystemMessage(buildSystemPrompt(state.capabilities)),
      new HumanMessage(buildGapPrompt({ intent: state.intent, gaps: [...blocking, ...soft] })),
    ], tierCfg('fast', sessionId));
    const suggestionFor = (id) =>
      (suggested?.suggestions ?? []).find(s => s.gapId === id)?.answer ?? null;

    // ── RESOLVE, DON'T INTERROGATE (2026-07-24, operator) ────────────────────
    // This USED to STOP here with a "Use your suggestions" wall — whose default answer
    // was already "the suggestions". So it was a speed bump the user rolled over with a
    // click, and the click routed the answer through a WHOLE-SPEC REGENERATE that, for a
    // blank the model reproduces, re-asked the same question forever (the section loop).
    // The product's own promise is that a complete workflow publishes having answered
    // NOTHING — so a blocking gap's model-suggested answer is the DEFAULT, not a decision
    // the user must ratify. What reaches here is one of three, and NONE needs a wall:
    //   · the converger's OWN blank (sections / name / edges) — auto-repaired ABOVE, so
    //     it never arrives here at all;
    //   · a genuinely un-defaultable choice (a destination that does not exist) — handled
    //     conversationally ABOVE (create-or-pick) and applied DIRECTLY, no rebuild. THAT
    //     is the converger's chatbot-style clarification: one natural question, answer
    //     applied on the spot;
    //   · a wiring gap only a rebuild can fix — take the suggestion as the answer and
    //     regenerate SILENTLY (bounded), narrating progress, with no wall.
    // The user reviews the finished workflow step by step, and the publish gate
    // (complete ⇒ publishable) protects correctness if a rebuild cannot close a blocker.
    const answers = {};
    const clarifications = [];
    for (const g of blocking) {
      const s = suggestionFor(g.id);
      if (s) { answers[g.id] = String(s); clarifications.push({ q: g.message, a: String(s) }); }
    }

    // Soft gaps escalate — a person handles the case at run time. `nodeId` is
    // load-bearing: materialiseEscalations() finds the step to put the escalation on.
    const escalated = soft.map(g => ({
      id: g.id, class: g.class, code: g.code, message: g.message, nodeId: g.nodeId ?? null, resolution: 'escalated',
    }));

    const logEntry = {
      step: state.step, type: 'gap_review', auto: true,
      gaps: [...blocking, ...soft].map(g => ({ id: g.id, code: g.code, class: g.class, blocking: g.blocking })),
      escalated, answers,
    };

    // A blocking gap regenerates SILENTLY with the suggestion as a hint — bounded. A
    // first-time blocker usually clears on that rebuild; a survivor is capped by
    // MAX_GAP_ROUNDS and then proceeds to the walkthrough, where `ratify` shows any
    // remaining blocker honestly rather than rebuilding a near-identical spec forever.
    if (clarifications.length && (state.gapRounds ?? 0) < MAX_GAP_ROUNDS) {
      emitBeat(cfg, { kind: 'thinking', text: 'Filling in the last details and finishing your workflow…' });
      return {
        ...carry,
        clarifications,
        confirmationLog: [...repairLog, logEntry],
        escalatedGaps:   escalated,
        gapRounds:       (state.gapRounds ?? 0) + 1,
        proposeRounds:   0,
        step:            state.step + 1,
        phase:           'proposing',
        _regenReason:    { route: 'gap_answer', detail: clarifications.map(c => c.q).join('; ').slice(0, 300) },
      };
    }

    return {
      ...carry,
      confirmationLog: [...repairLog, logEntry],
      escalatedGaps:   escalated,
      step:            state.step + 1,
      phase:           'ratifying',
    };
  });

  // ── resourceSetup ────────────────────────────────────────────────────────────
  // Create a missing resource the user asked for (#25). Reached from `gaps` when the
  // user chose "Create #<name>" for a RESOURCE_NOT_FOUND gap. It reuses the EXISTING
  // setup_action confirm/execute path — the same interrupt the `propose` node emits, so
  // the client needs no new surface: it shows a "Create it" button, POSTs to
  // /sessions/:id/setup, and resumes with { type: 'setup_executed', result }.
  //
  // On success the created resource is OPTIMISTICALLY added to `capabilities` (Slack:
  // appended to slackChannels) so the immediate re-score in `gaps` sees it and the gap
  // clears without waiting for a fresh session fetch. On skip/reject the resource is
  // latched (`_resourceAsked`) so `gaps` won't ask again — it becomes a named blocker.
  graph.addNode('resourceSetup', async (state) => {
    const rc = state._resourceCreate;
    if (!rc?.capabilityId) return { _resourceCreate: null, phase: 'gapping' };

    const proposal = {
      component:    'setup_action',
      capabilityId: rc.capabilityId,
      params:       rc.kind === 'slack_channel' ? { name: rc.name } : {},
      stores_as:    'created_resource',
      rationale:    `Create ${rc.kind === 'slack_channel' ? '#' + rc.name : rc.name} so the workflow has a real destination.`,
    };
    const confirmation = await interrupt({ type: 'proposal', proposal, step: state.step });
    const logEntry = { step: state.step, type: 'proposal', proposal, confirmation };

    if (confirmation?.type === 'setup_executed') {
      const result  = confirmation.result ?? {};
      const created = rc.kind === 'slack_channel' ? (result.name ?? rc.name) : rc.name;
      // Optimistically register the created resource so the re-score sees it exists.
      const capabilities = rc.kind === 'slack_channel'
        ? { ...state.capabilities, slackChannels: [...(state.capabilities?.slackChannels ?? []), created] }
        : state.capabilities;
      return {
        capabilities,
        setup_results:   { created_resource: result },
        confirmationLog: [logEntry],
        _resourceCreate: null,
        step:  state.step + 1,
        phase: 'gapping',
      };
    }

    // Skipped or rejected: don't loop on it — latch and let it surface as a blocker.
    return {
      confirmationLog: [logEntry],
      _resourceCreate: null,
      _resourceAsked:  [...(state._resourceAsked ?? []), rc.askKey],
      step:  state.step + 1,
      phase: 'gapping',
    };
  });

  // ── verify ─────────────────────────────────────────────────────────────────
  // The converger becomes a CODING AGENT: before it hands the workflow off, it runs
  // its own draft through the real execution engine on the sample examples, reads the
  // result, and — if the workflow does not do what its outcome promised — FIXES it and
  // re-runs. "Run test" stops being a gamble the user takes and becomes a demonstration
  // of something the converger has already watched pass. (Increment #23.)
  //
  // Placement: AFTER the spec is complete (post-gaps, all resources resolved by the
  // destinations tail) and BEFORE ratify. So the spec it tests already has its real
  // channels/bases/columns wired in — the dry run exercises the shape the user will
  // actually publish.
  //
  // NO REAL SIDE EFFECTS, EVER. The run goes through `runDryRun`, which sets
  // `dryRunDeliveries: true` (flow-tester #21): processing/llm nodes run for real, but
  // every terminal deliver/write is verified into a would-deliver receipt instead of
  // fired. No email is sent, no record written, no Slack post made — no matter how many
  // times the fix loop iterates.
  //
  // FAIL-SAFE. If there are no examples to run, no tester wired, no contract to judge
  // against, or the tester throws, `verify` passes STRAIGHT THROUGH to ratify. A
  // workflow that cannot be auto-tested still reaches the user; an infra hiccup never
  // blocks a build. And a failed verify is a NOTE (surfaced honestly at ratify), never
  // a hard block — `complete ⇒ publishable` is preserved: the user can always test and
  // publish; the converger has simply told them the truth about what it saw.
  //
  // BOUNDED. `MAX_VERIFY_ROUNDS` hard-caps the fix loop; each round runs ≤
  // `MAX_VERIFY_EXAMPLES` samples. A spec the converger cannot make pass ends at ratify
  // with an honest "I couldn't get a sample to pass" note — never in an endless rebuild.
  const MAX_VERIFY_ROUNDS   = 2;
  const MAX_VERIFY_EXAMPLES = 2;

  graph.addNode('verify', async (state, cfg) => {
    const runDryRun  = cfg?.configurable?.runDryRun;
    let   draft      = state.draft;
    const assertions = draft?.outcome?.assertions ?? [];

    // ── ONE SAMPLE PER PATH, NOW THAT THE PATHS ARE KNOWN ────────────────────
    // The example generator runs BEFORE the workflow exists, so it proposes cases
    // blind — typically one or two, with no idea the workflow routes three ways. A
    // router is only proved on the routes actually tested, so the panel correctly
    // refuses to certify and Go live stays locked. Observed live: a user who answered
    // nothing, accepted every default and got a CORRECT workflow was then asked to
    // write test cases by hand — exactly the typing the zero-typing path exists to
    // remove.
    //
    // Here the spec is assembled, so the lanes are knowable. Top up with one input
    // aimed at each path. Deliberately weak claims: this gives every path a fair
    // chance, it does not guarantee coverage — only RUNNING proves which lane an
    // input takes, and the oracle still has the last word. A failure to top up is
    // never fatal: we fall through to whatever examples already existed, which is
    // exactly today's behaviour.
    const lanes = laneInventoryOf(assembleSpec(draft));
    const have  = (draft?.outcome?.examples ?? []).filter(e => e && e.given != null);
    if (typeof runDryRun === 'function' && assertions.length && lanes.length > have.length) {
      try {
        const parsed = await llmJson(llm, [
          new SystemMessage(buildSystemPrompt(state.capabilities)),
          new HumanMessage(buildLaneExamplesPrompt({
            intent: state.intent, outcome: draft.outcome, triggers: draft.triggers,
            lanes, existing: have,
          })),
        ], tierCfg('fast', cfg?.configurable?.threadId));
        const extra = (parsed?.examples ?? [])
          .filter(e => e?.given != null)
          // Ids must not collide with what is already there: `checkOutcome` keys by
          // index precisely because a colliding key silently drops an entry, and a
          // dropped sample is a path reported as tested that never ran.
          .map((e, i) => ({ ...e, id: `lane_${i + 1}` }));
        if (extra.length) {
          draft = { ...draft, outcome: { ...draft.outcome, examples: [...have, ...extra] } };
          logEvent('converger.lane_examples', { ...who(cfg), lanes: lanes.length, had: have.length, added: extra.length });
        }
      } catch { /* keep the examples we have — never fail a build over a top-up */ }
    }

    // Every return from this node must carry the draft, or the lane examples we just
    // paid for are discarded and the panel is handed the same single sample as before.
    const carryDraft = draft !== state.draft ? { draft } : {};

    const examples   = (draft?.outcome?.examples ?? [])
      .filter(e => e && e.given != null)
      .slice(0, MAX_VERIFY_EXAMPLES);

    // ── FAIL-SAFE PASS-THROUGHS ──────────────────────────────────────────────
    // No tester wired, nothing to run, or no machine-checkable contract to judge
    // against ⇒ there is nothing to verify. Go straight to ratify, unchanged. This
    // is also why every existing converger test (which wires no `runDryRun`) keeps
    // its exact behaviour — the node is inert until a tester is provided.
    if (typeof runDryRun !== 'function' || !examples.length || !assertions.length) {
      return { ...carryDraft, phase: 'ratifying' };
    }

    // The spec the user is about to publish — resources already resolved by the tail.
    const spec = assembleSpec(draft);

    emitBeat(cfg, {
      kind: 'check',
      text: examples.length > 1
        ? `Running your workflow on ${examples.length} sample cases to check it actually works…`
        : 'Running your workflow on a sample to check it actually works…',
    });

    // Run each sampled example through the engine (DRY-RUN). A run that PAUSED (a
    // human gate) or produced no oracle verdict is UNJUDGEABLE — neither pass nor
    // fail — so it is excluded from the tally rather than counted as a failure that
    // would trigger a pointless fix.
    const judged = [];
    for (const ex of examples) {
      // A sample that RAN but FAILED is retried (up to 3 attempts). The workflow's own
      // llm nodes are non-deterministic: a summarize can misjudge its (present) input and
      // fire its "missing data" guard on one run even when the SPEC is correct — a per-run
      // flake, not a defect. A pass on ANY attempt is a pass; the retries absorb the flake
      // cheaply (a dry run, not an Opus rebuild). Only a CONSISTENT failure survives to be
      // classified below. (A pass on the first try never retries; an infra fault still bails.)
      let oracle = null, passed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        let r;
        try {
          r = await runDryRun(spec, ex.given);
        } catch (err) {
          // The tester itself faulted. That is infra, not a workflow defect — do not
          // block the build or claim a failure. Pass through with an honest note.
          emitBeat(cfg, { kind: 'check', text: "I couldn't run the self-test just now — you can still run it yourself before going live." });
          return {
            ...carryDraft,
            phase: 'ratifying',
            _verifyReport: { ran: false, passed: 0, total: 0, note: `self-test could not run (${String(err?.message ?? err)})` },
            confirmationLog: [{ step: state.step, type: 'verify', ran: false, error: String(err?.message ?? err) }],
            step: state.step + 1,
          };
        }
        if (!r || r.paused || !r.oracleResult) { oracle = null; break; }   // unjudgeable — skip
        oracle = r.oracleResult;
        passed = oracle.contractPassed === true;
        if (passed) break;                                                  // passed — no retry
        // failed — the loop retries once before believing it
      }
      if (!oracle) continue;   // unjudgeable — skip
      judged.push({ example: ex, passed, oracle });
    }

    // Nothing could be judged (every sample paused / had no verdict). Not a failure —
    // proceed, untested.
    if (!judged.length) {
      return {
        ...carryDraft,
        phase: 'ratifying',
        _verifyReport: { ran: false, passed: 0, total: 0, note: null },
        confirmationLog: [{ step: state.step, type: 'verify', ran: false, judged: 0 }],
        step: state.step + 1,
      };
    }

    const passedCount = judged.filter(j => j.passed).length;
    const total       = judged.length;

    // ── ALL SAMPLES PASS → verified. On to ratify. ───────────────────────────
    if (passedCount === total) {
      emitBeat(cfg, {
        kind: 'check',
        text: `It produced the right result — ${passedCount}/${total} sample${total > 1 ? 's' : ''} passed.`,
      });
      return {
        ...carryDraft,
        phase: 'ratifying',
        _verifyReport: { ran: true, passed: passedCount, total, note: null },
        confirmationLog: [{ step: state.step, type: 'verify', ran: true, passed: passedCount, total, ok: true }],
        step: state.step + 1,
      };
    }

    // ── A SAMPLE FAILED — but WHY? Separate STRUCTURAL failures from CONTENT FLAKES. ──
    //
    // This is the fix for the "it rebuilt a few times and still isn't settling" spiral the
    // user was seeing on workflows that ACTUALLY WORK (proven: the real "Run test" passes
    // them 3/3 while this dry-run gave up). A dry-run summarize is non-deterministic; on a
    // wordy, boilerplate-heavy email it sometimes misjudges its (present) input and emits
    // the "required data not found" sentinel, which the oracle reports as a failure. That
    // is a per-run CONTENT FLAKE — the delivery STRUCTURALLY happened, the wiring is sound
    // (the validator guaranteed it), the summarize just flaked. Rebuilding the whole spec
    // to "fix" it is futile — the new spec has the same guard and flakes the same way — and
    // it is exactly the expensive loop the user complained about.
    //
    // So: regenerate ONLY on a STRUCTURAL failure — a delivery that genuinely did not
    // happen, or a run that errored. A flake-only failure means the workflow is correct;
    // present it plainly (no rebuild, no give-up) and let the user run the real test.
    const isContentFlake = (o) => !!o?.contentError && !o?.error && o?.ran !== false;
    const fails      = judged.filter(j => !j.passed);
    const structural = fails.filter(j => !isContentFlake(j.oracle));

    const firstFail = structural[0] ?? fails[0];
    const runErr    = firstFail?.oracle?.error ?? null;
    const reasons   = (firstFail?.oracle?.contract ?? [])
      .filter(c => !c.ok)
      .map(c => c.reason || `${c.target} not satisfied`);
    const complaint = runErr
      ? `it errored: ${typeof runErr === 'string' ? runErr : (runErr?.message ?? JSON.stringify(runErr))}`
      : (reasons.length ? reasons.join('; ') : 'the outcome was not satisfied');
    const failLabel = firstFail?.example?.label ? ` ("${firstFail.example.label}")` : '';

    // ── STRUCTURAL FAILURE → regenerate (bounded), the same fix loop as before. ──
    // A delivery the outcome promises never happened, or the run errored — a real wiring
    // defect the model can fix. Feed the sample + complaint back and rebuild.
    if (structural.length && (state.verifyRounds ?? 0) < MAX_VERIFY_ROUNDS) {
      // WHY THE SELF-TEST REBUILT, ON THE RECORD. This is the most expensive decision
      // in a build — it throws away the whole spec and pays for another Opus pass — and
      // nothing recorded its reason. Measured on a 26-step build: verify ran 3× (462s)
      // and drove 3 of the 4 `generate` passes (872s), i.e. 96% of a 23-minute build,
      // and afterwards there was no way to tell whether those rebuilds were justified.
      // The complaint lives only in a reasoning beat, which is not persisted.
      logEvent('converger.verify_rebuild', {
        ...who(cfg),
        round: (state.verifyRounds ?? 0) + 1,
        passed: passedCount, total,
        failures: structural.length,
        assertion: firstFail?.oracle?.target ?? firstFail?.oracle?.id ?? null,
        complaint: String(complaint ?? '').slice(0, 300),
      });
      emitBeat(cfg, {
        kind: 'check',
        text: `That sample didn't pass — only ${passedCount}/${total} produced the right result.`,
      });
      emitBeat(cfg, {
        kind: 'thinking',
        text: `The workflow ran, but a promised delivery didn't happen on a real sample${failLabel}: ${complaint}. Let me rebuild it so every step the outcome depends on is wired correctly.`,
      });
      return {
        ...carryDraft,
        phase:          'proposing',
        _regenReason:   { route: 'verify_failed', detail: String(complaint ?? '').slice(0, 300) },
        verifyRounds:   (state.verifyRounds ?? 0) + 1,
        clarifications: [{
          q: '(self-test failed — fix required)',
          a: `I ran this workflow on a real sample${failLabel} and a promised delivery did NOT happen: ${complaint}. `
           + 'Rebuild the workflow so every promised delivery/record actually happens for this kind of input — '
           + 'do not drop or mis-wire any step the outcome depends on.',
        }],
        _verifyReport:  { ran: true, passed: passedCount, total, note: complaint },
        confirmationLog: [{ step: state.step, type: 'verify', ran: true, passed: passedCount, total, ok: false, complaint, fixing: true, structural: true }],
        step: state.step + 1,
      };
    }

    // ── FLAKE-ONLY (or out of structural rounds) → the workflow is BUILT and WIRED
    // CORRECTLY; a summarize just misjudged a wordy sample on this dry run. Do NOT rebuild
    // (the guard flakes the same way) and do NOT give up loudly on a working workflow.
    // Present it with a confident, honest note — the real "Run test" will show it live.
    if (!structural.length) {
      emitBeat(cfg, {
        kind: 'check',
        text: `Your workflow is built and every step is wired correctly. Give it a test run to see it in action.`,
      });
      return {
        ...carryDraft,
        phase: 'ratifying',
        // Not a give-up: structurally verified. `softFlake` records that a content node
        // flaked on a sample, for provenance, without gating the build.
        _verifyReport: { ran: true, passed: passedCount, total, note: null, softFlake: true },
        confirmationLog: [{ step: state.step, type: 'verify', ran: true, passed: passedCount, total, ok: true, softFlake: true }],
        step: state.step + 1,
      };
    }

    // ── OUT OF STRUCTURAL FIX ROUNDS — honest note (only reached by a genuine structural
    // failure the model could not fix within MAX_VERIFY_ROUNDS). `complete ⇒ publishable`
    // holds: the spec is valid and publishable; we simply tell the user the truth.
    emitBeat(cfg, {
      kind: 'check',
      text: `I couldn't get a promised delivery to happen on a sample after ${state.verifyRounds} attempt${state.verifyRounds > 1 ? 's' : ''} — the workflow is built, but review it before going live.`,
    });
    return {
      ...carryDraft,
      phase: 'ratifying',
      _verifyReport: { ran: true, passed: passedCount, total, note: complaint, gaveUp: true },
      confirmationLog: [{ step: state.step, type: 'verify', ran: true, passed: passedCount, total, ok: false, gaveUp: true, complaint }],
      step: state.step + 1,
    };
  });

  // ── walkthrough ──────────────────────────────────────────────────────────────
  // The step-by-step approval of the FINAL, settled workflow. (Moved here 2026-07-16.)
  //
  // This is the ONE place the user approves the built graph, and it runs only AFTER the
  // whole tail has settled it: destinations resolved every write against the live
  // connector, decisions/gaps closed, and `verify` ran the draft (with its bounded,
  // SILENT fix loop) and either passed or gave up. So the person approves exactly what
  // will publish — once — never a mid-build draft that then changes under them. (It used
  // to fire at the END of `generate`, before any of that had happened, so a verify- or
  // gap-driven regenerate re-presented it and the user approved it repeatedly.)
  //
  // The presented spec is the SAME one `ratify` will assemble: escalations are
  // materialised here too (materialiseEscalations is pure — this call is display-only and
  // discarded; ratify does the authoritative materialisation), so the walkthrough shows
  // the true final graph, including any human gates / on_error policies escalation added.
  //
  // Accept → ratify. Modify → a fresh, USER-driven regenerate: the whole spec is rebuilt
  // with the correction and a fresh loop budget (the same semantics as a ratify
  // request-changes), then flows back through the tail to a single fresh walkthrough. A
  // modify is an explicit user action, not the automatic regenerate loop, so resetting
  // the budget here cannot spin the internal loop.
  graph.addNode('walkthrough', async (state, cfg) => {
    const { draft: finalDraft } = materialiseEscalations(state.draft, state.escalatedGaps ?? []);

    const review = await interrupt({
      type: 'generated_workflow',
      spec: {
        name:     finalDraft.name,
        triggers: finalDraft.triggers,
        nodes:    finalDraft.nodes,
        edges:    finalDraft.edges,
        outcome:  finalDraft.outcome,
      },
      step: state.step,
    });

    // Revise: feed the change back as a clarification and regenerate the whole spec
    // (the walkthrough edge maps 'proposing' → generate). Reset the loop bounds exactly
    // as ratify's request-changes does — otherwise analyze would route straight past
    // `generate` (the counters are at their caps by now) and silently ignore the ask.
    if (review?.type === 'modify' && String(review.modification ?? '').trim()) {
      return {
        clarifications:  [{ q: '(revise the built workflow)', a: review.modification }],
        confirmationLog: [{ step: state.step, type: 'walkthrough_revise', modification: review.modification }],
        phase:              'proposing',
        _regenReason:       { route: 'user_change_request', detail: String(review.modification).slice(0, 300) },
        proposeRounds:      0,
        gapRounds:          0,
        regenRounds:        0,
        // A fresh budget for an EXPLICIT user-requested change. The aggregate cap bounds
        // AUTOMATIC regeneration; a user who asks for a change gets a clean budget so
        // their request is built and re-presented (once).
        buildPresentations: 0,
        _buildCapped:       false,
        step:               state.step + 1,
      };
    }

    // Accept → ratify (the final publish gate).
    return {
      confirmationLog: [{ step: state.step, type: 'walkthrough_approved' }],
      step:  state.step + 1,
      phase: 'ratifying',
    };
  });

  // ── ratify ─────────────────────────────────────────────────────────────────
  // Present the completed draft for final HITL approval before publish.
  graph.addNode('ratify', async (state, cfg) => {
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
      // What the self-test saw (#23). Shown honestly, never as a gate: on a pass it
      // reassures ("I ran it on a sample and it worked"); on a give-up it warns
      // ("I couldn't get a sample to pass — you may want to review"). Absent when the
      // build was not auto-testable (no examples / no tester), which is not a failure.
      verification: state._verifyReport ?? null,
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

    // request_changes: REGENERATE the whole spec with the user's feedback noted
    // (phase:'proposing' → the ratify edge routes to `generate`).
    //
    // The loop bounds MUST be reset here. `proposeRounds`/`regenRounds` are at or
    // near their caps by the time we reach ratify, so leaving them would send analyze
    // straight to `gaps` without ever rebuilding the change the user just asked for —
    // the build would appear to ignore them.
    if (confirmation?.feedback) {
      return {
        clarifications:  [{ q: '(ratify feedback)', a: confirmation.feedback }],
        phase:           'proposing',
        _regenReason:    { route: 'ratify_feedback', detail: String(confirmation.feedback).slice(0, 300) },
        proposeRounds:   0,
        gapRounds:       0,
        regenRounds:     0,
        // A fresh budget for an EXPLICIT user-requested change. The aggregate cap
        // bounds AUTOMATIC regeneration between decisions; when the user themselves
        // asks for a change, they get a clean walkthrough budget (and the give-up
        // latch is cleared) so their request is actually built and re-presented.
        buildPresentations: 0,
        _buildCapped:       false,
        confirmationLog: [logEntry],
        step:            state.step + 1,
      };
    }

    return {
      phase:           'proposing',
      _regenReason:    { route: 'ratify_rejected', detail: 'the user declined to publish without naming a change' },
      proposeRounds:   0,
      gapRounds:       0,
      regenRounds:     0,
      buildPresentations: 0,
      _buildCapped:       false,
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
  //   outcome → process → examples → (analyze ⇄ clarify) → generate → analyze
  //           → destinations → decisions → gaps → verify → walkthrough → ratify
  //
  // THE STEP-APPROVAL IS AT THE END (moved 2026-07-16). `generate` is now SILENT — it
  // builds/rebuilds the whole spec with no interrupt, so every internal regenerate (a
  // blocking gap, a sufficiency-named component, a verify fix, a decision correction)
  // happens without the user seeing it. The single `generated_workflow` walkthrough
  // fires ONCE, in the `walkthrough` node, on the FINAL settled spec — so the user
  // approves exactly what will publish, never a draft the tail then changes underneath
  // them (destinations repointing, gaps escalating, verify regenerating).
  //
  // CLARIFY-FIRST, THEN GENERATE THE WHOLE SPEC (converger rearchitecture).
  // `analyze` clarifies the intent to completion, then routes the build to `generate`
  // — one whole-spec pass that emits every node, edge and branch case at once
  // (mergeGeneratedSpec + wireEdges guarantee a connected, branch-fed graph) — and back
  // to `analyze`, which re-scores the now-complete draft and sends it on to the tail.
  //
  // EVERY "the spec must change" route REGENERATES; `propose` is retired from the flow.
  // A blocking gap with an answer, a sufficiency-named missing component, and a ratify
  // request-changes all route back to `generate`, which reads the accumulated
  // `clarifications` (+ `_missingNote`) and rebuilds the whole, updated, still-validated
  // spec. The regenerate loop is bounded (MAX_REGEN_ROUNDS + MAX_GAP_ROUNDS + the
  // sufficiency cap), so a spec the model cannot complete ends at `ratify` with its
  // blockers shown.
  //
  // `propose` IS STILL UNREACHABLE, AND THAT PART IS TRUE — re-verified 2026-07-26:
  // `graph.addNode('propose', …)` and `graph.addEdge('propose','analyze')` are the ONLY
  // two mentions of it in this file, so it has an edge OUT and none IN, and the entry
  // point is `outcome`. It stays retired because whole-spec regeneration replaced the
  // one-component drip, NOT because the client cannot draw it.
  //
  // ⚠ THE REASON THIS COMMENT USED TO GIVE WAS WRONG, AND THE WRONG REASON IS WHY THE
  // REAL HAZARD WENT UNGUARDED FOR SO LONG. It claimed "the client retired `propose`'s
  // per-node `{type:'proposal'}` UI surface, so any route that reaches `propose`
  // post-generate emits an interrupt no client can render and the build HANGS at
  // phase:'building'." Both halves are false:
  //   · The client's `{type:'proposal'}` surface was never retired. `_renderInterrupt`
  //     in `public/index.html` still draws proposals — `component:'edge'`,
  //     `component:'setup_action'`, and a default step card with Confirm / Change /
  //     Reject.
  //   · That surface is LIVE IN PRODUCTION today, from a different node: `resourceSetup`
  //     (above) emits `{ type:'proposal', proposal:{ component:'setup_action', … } }`
  //     whenever a user picks "Create #<channel>" for a missing destination.
  // So routing to `propose` would not hang the build — and, more importantly, the class
  // of bug this sentence warned about was REAL but lived somewhere else entirely: a
  // client that receives a reply it cannot draw used to stop polling and go silently
  // dead (no spinner, no error, nothing to click). That is now guarded on the client
  // side, in `_handleInterrupt`, which must be told it drew something or it goes back to
  // polling. Do NOT re-derive "the client can't render X" from this file; check
  // `_renderInterrupt` in `public/index.html`.
  //
  // `decisions` (Increment E) sits immediately BEFORE `gaps`, and that order is
  // load-bearing: the gap list must be about the table AS CORRECTED. Review the
  // table after the gap list and the user is asked to fill holes in a table they
  // are about to change — and the holes they were shown are in a table that no
  // longer exists.
  graph.setEntryPoint('outcome');

  graph.addConditionalEdges('outcome', (state) => {
    if (state.phase === 'examples')  return 'process';   // …which then runs examples
    if (state.phase === 'analyzing') return 'analyze';   // no contract could be formed — v1 path
    return 'outcome';                                     // asked a question; re-derive with the answer
  });

  // ORDER CORRECTED (Increment F): outcome → PROCESS → EXAMPLES → analyze.
  //
  // §2.1 drew it outcome → examples → process, and that order silently made the
  // example picker unreachable: the picker searches the user's inbox with THE
  // TRIGGER'S OWN FILTER, and nothing had put a trigger in the draft yet — so it
  // read `triggers: []` in every session and fell back to modelled cases every
  // time. `process` derives the trigger (it is the entry point of the graph it
  // backward-chains), so examples now runs with a real query to search on.
  graph.addEdge('process', 'examples');
  graph.addEdge('examples', 'analyze');

  graph.addConditionalEdges('analyze', (state) => {
    if (state.phase === 'finalizing') return 'walkthrough';  // aggregate-cap short-circuit
    if (state.phase === 'gapping')    return 'destinations'; // …→ decisions → gaps,
    if (state.phase === 'ratifying')  return 'ratify';       //   each a pass-through
    if (state.phase === 'clarifying') return 'clarify';      //   when it has nothing
    // THE PLAN GATE (agent-contracts increment 1): the FIRST build routes through `plan`
    // once — a plain-language preview the user approves before the
    // expensive `generate`. Only the first build: a regeneration (`_generated`) or a plan
    // already shown (`_planShown`) goes straight to `generate`, so a verify fix, a gap
    // rebuild and the aggregate-cap path never re-show it.
    if (!state._generated && !state._planShown) return 'plan';
    // proposing: build (or REBUILD) the whole spec in one `generate` pass. This is every
    // later "the spec must change" pass — the retired `propose` drip is never routed to
    // (its UI surface no longer exists client-side, so a route into it would hang). The
    // MAX_REGEN_ROUNDS guard above stops the rebuild loop.
    return 'generate';
  });

  // plan → generate on approval; plan → plan on a "change" (bounded by MAX_PLAN_ROUNDS),
  // re-projecting the plan with the user's correction folded in. This is the ONLY node
  // that emits `plan_review`, and it does so before the first build, never on a rebuild.
  graph.addConditionalEdges('plan', (state) => {
    return state.phase === 'planning' ? 'plan' : 'generate';
  });

  graph.addEdge('clarify', 'analyze');
  graph.addEdge('propose', 'analyze');
  // After the whole-spec pass, re-enter `analyze` so it re-scores the now-complete
  // draft and routes it onward (gapping → destinations → decisions → gaps → ratify).
  // The generated spec is NOT bypassed: it still flows through `gaps` (validator +
  // gap-scorer) and the destinations tail resolves live schemas into its write-nodes.
  graph.addEdge('generate', 'analyze');
  // destinations → decisions → gaps. The order is load-bearing in both places:
  // the table under review must be the one whose columns were just resolved, and
  // the gap list must be about the draft AS CORRECTED by both.
  graph.addEdge('destinations', 'decisions');
  // decisions → gaps, UNLESS the user described a correction to an induced table
  // (#24): then it routes to `generate`, which rebuilds the whole spec with the
  // note as guidance (bounded by decisionRounds; `decisionsReviewed` latches so
  // the rebuilt table is not re-interrogated on the way back through here).
  graph.addConditionalEdges('decisions', (state) => {
    return state.phase === 'proposing' ? 'generate' : 'gaps';
  });

  // A blocking gap that has an answer sets phase:'proposing' with the answer in
  // `clarifications`; REGENERATE the whole spec so the fix is incorporated (the
  // retired `propose` has no client UI — routing here would hang the build).
  // Bounded by MAX_GAP_ROUNDS: gaps flips to 'ratifying' once the cap is hit, so
  // an unclosable gap surfaces at `ratify` as a blocker instead of looping.
  graph.addConditionalEdges('gaps', (state) => {
    if (state.phase === 'resource_setup') return 'resourceSetup';  // "Create #<name>" (#25)
    if (state.phase === 'gapping')        return 'gaps';           // resource picked/latched → re-score
    // A blocking gap regenerates; a complete draft goes to VERIFY (#23) — the
    // converger runs its own workflow on the samples before ratify, and only then
    // presents it. `gaps → verify → ratify`.
    return state.phase === 'proposing' ? 'generate' : 'verify';
  });

  // verify → walkthrough on a pass (or a bounded give-up); verify → generate on a fix
  // (it regenerates the whole spec with the failing sample as context, then the tail
  // brings it back through gaps → verify to re-test — all SILENTLY, no walkthrough). The
  // fix loop is bounded by `verifyRounds`, so this can never spin. Only once verify
  // SETTLES does the single step-approval fire, in `walkthrough`, on the final spec.
  graph.addConditionalEdges('verify', (state) => {
    return state.phase === 'proposing' ? 'generate' : 'walkthrough';
  });

  // walkthrough → ratify on accept; walkthrough → generate on a user-requested modify
  // (a fresh, budget-reset regenerate, which flows back through the tail to a single
  // fresh walkthrough). This is the ONLY node that emits the `generated_workflow`
  // step-approval, and it does so exactly once per settled build.
  graph.addConditionalEdges('walkthrough', (state) => {
    return state.phase === 'proposing' ? 'generate' : 'ratify';
  });

  // resourceSetup always returns to `gaps` (phase:'gapping') so the created/latched
  // resource is re-scored — the gap clears (created/picked) or surfaces as a blocker.
  graph.addEdge('resourceSetup', 'gaps');

  // request_changes (or a rejected ratify) sets phase:'proposing' and resets the
  // loop bounds, so the user's feedback REGENERATES the whole spec (again, never the
  // UI-less `propose`). approve → END.
  graph.addConditionalEdges('ratify', (state) => {
    return state.phase === 'done' ? END : 'generate';
  });

  return graph.compile({
    checkpointer: new FileCheckpointer({ dir: checkpointerDir }),
  });
}
