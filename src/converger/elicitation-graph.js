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

import { StateGraph, END }   from '../graph/index.js';
import { FileCheckpointer }  from '../graph/checkpointer/index.js';
import { interrupt }         from '../graph/interrupt.js';
import { SystemMessage, HumanMessage } from '../core/message.js';
import { scoreGap, unansweredGaps } from './gap-scorer.js';
import { applyProposal, assembleSpec, wireEdges } from './spec-assembler.js';
import { materialiseEscalations } from './escalation.js';
import { nodeForAssertion, assertableConnectors, splitTarget } from '../workflows/outcome-oracle.js';
import { analyzeTable } from '../workflows/decision-analysis.js';
import { tableOf, valuesOf, HIT_POLICIES, HIT_POLICY_LABELS, DECISION_MAX_INPUTS } from '../workflows/node-types/decision.js';
import {
  buildSystemPrompt,
  buildAnalyzePrompt,
  buildProposePrompt,
  buildModifyPrompt,
  buildOutcomePrompt,
  buildExamplesPrompt,
  buildGapPrompt,
  buildSufficiencyPrompt,
  buildGeneratePrompt,
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
export function autoRepairStructural(draft, gaps) {
  const applied = [];
  let d = draft;
  for (const g of (gaps ?? [])) {
    const fix = g?.fix;
    if (!fix) continue;
    try {
      if (fix.op === 'add_edge' && fix.from && fix.to) {
        d = applyProposal(d, { component: 'edge', spec: { from: fix.from, to: fix.to } });
        applied.push({ gapId: g.id, code: g.code, op: 'add_edge', from: fix.from, to: fix.to });
      } else if (fix.op === 'remove_edges' && Array.isArray(fix.edges)) {
        for (const e of fix.edges) {
          if (!e?.from || !e?.to) continue;
          d = applyProposal(d, { component: 'remove_edge', spec: { from: e.from, to: e.to } });
          applied.push({ gapId: g.id, code: g.code, op: 'remove_edge', from: e.from, to: e.to });
        }
      }
    } catch { /* leave as a gap — the re-score will re-surface it */ }
  }
  return { draft: d, applied };
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
export async function llmJsonStreaming(llm, messages, config = {}, { onThinking } = {}) {
  let text = null;
  if (typeof llm.stream === 'function') {
    try {
      let acc = '';
      const streamCfg = { ...config, thinking: DEFAULT_THINKING_BUDGET };
      if (typeof onThinking === 'function') streamCfg.onThinking = onThinking;
      for await (const chunk of llm.stream(messages, streamCfg)) {
        const c = typeof chunk === 'string' ? chunk : (chunk?.content ?? '');
        if (c) acc += c;
      }
      if (acc.trim()) text = acc;
    } catch {
      text = null; // streaming/thinking failed → fall through to the blocking path
    }
  }
  if (text == null) return llmJson(llm, messages, config); // no-stream-support OR stream failed
  try { return JSON.parse(extractJson(text)); }
  catch { return null; }
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
  const triggers = existingTriggers.length ? existingTriggers : genTriggers;

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
  // slack channels carry a channel-in-the-locator target; airtable/base assertions key
  // on kind, not the id, so they need no rewrite here.
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
function rewriteAssertionFields(outcome, renames, columns) {
  if (!outcome || !renames || !Object.keys(renames).length) return outcome ?? null;
  const real = new Set(columns.map(c => String(c.name).toLowerCase()));

  const assertions = (outcome.assertions ?? []).map((a) => {
    if (!/airtable/i.test(String(a?.target ?? '')) || !Array.isArray(a?.fields)) return a;
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
function fillDestination(nodes, { baseId, tableId, fields, columnsRead = false }) {
  return nodes.map((n) => {
    if (!usesConnector(n, 'airtable')) return n;
    const config = { ...(n.config ?? {}), baseId };
    if (tableId) config.tableId = tableId;
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
export function buildElicitationGraph({ llm, checkpointerDir = './memory/converger', invokeCapability = null }) {
  // Which generate executions have already STREAMED their thinking. A node that
  // calls interrupt() re-executes from the top on resume (compiled-graph.js), so
  // `generate` would re-stream (and re-narrate) its thinking every time the user
  // answers the workflow-approval interrupt. This closure persists for the life of
  // the converger instance (one per session, reused across every /respond), so a
  // given generation streams its thinking EXACTLY ONCE. Keyed by `state.step`, which
  // is stable across a pass and its resume yet advances for a later (revise) rebuild.
  const streamedThinking = new Set();

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
      _missingNote:      null,
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
          'What starts this workflow? Return {"trigger":{"type":"email"|"schedule"|"manual"|"connector_event","filter":"<a Gmail search query, for an email trigger — e.g. to:leads@acme.com>","cron":"<for a schedule>"}}. ' +
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

    // A RESOURCE gap is not something REGENERATING can fix (#25): the model cannot
    // invent a Slack channel / Airtable base that exists in the tenant's account —
    // only create-or-pick can. So when the ONLY thing blocking the spec is a missing
    // resource, skip the (bounded, but wasteful) regenerate loop and go straight to
    // `gaps`, where it is resolved conversationally. If there are OTHER blockers too,
    // regenerate as usual — those may close, leaving the resource gap to be handled
    // on the next pass.
    const blockers = unansweredGaps(gap);
    if (blockers.length && blockers.every(g => g.code === 'RESOURCE_NOT_FOUND' || g.code === 'RESOURCE_UNVERIFIED')) {
      return { phase: 'gapping' };
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
      return { phase: 'gapping' };
    }

    // The last accepted proposal changed NOTHING (the model re-proposed an edge the
    // draft already had; applyProposal dedupes, so the draft came back identical).
    // The model has nothing left to add — asking it again just produces the same
    // proposal, and asking the USER again makes them click the same card twice.
    if (state._noProgress) return { phase: 'gapping', _noProgress: false };

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
      };
    }

    // A regenerate driven by the sufficiency check names a concrete MISSING
    // component (`_missingNote`, set by `analyze`). Fold it into the clarifications
    // so the rebuild actually adds it — otherwise generate re-runs on identical
    // input, produces the same still-incomplete spec, and the sufficiency "name the
    // missing piece" step (P12 Increment C) becomes a no-op that just burns Opus
    // calls. The blocking-gap route already arrives via `clarifications`.
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

    const generated = await llmJsonStreaming(llm, [
      new SystemMessage(buildSystemPrompt(state.capabilities)),
      new HumanMessage(buildGeneratePrompt({
        intent:         state.intent,
        clarifications,
        outcome:        draft.outcome,
        draft,
        capabilities:   state.capabilities,
        setupResults:   state.setup_results,
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
    ], tierCfg('architect', sessionId), { onThinking });

    // DEFENSIVE: the model returned nothing usable (no nodes). Do NOT crash and do
    // NOT ship an empty spec — fall back to a clarification interrupt, the same honest
    // move `propose` makes on unparseable output.
    if (!generated || !Array.isArray(generated.nodes) || !generated.nodes.length) {
      const q = 'I couldn\'t assemble the workflow from that. Could you describe, step by step, what it should do?';
      const answer = await interrupt({ type: 'clarification', question: q, step: state.step });
      return {
        clarifications:  [{ q, a: answer?.answer ?? String(answer) }],
        confirmationLog: [{ step: state.step, type: 'clarification', question: q, answer }],
        step:            state.step + 1,
        phase:           'analyzing',
      };
    }

    const merged = mergeGeneratedSpec(draft, generated);

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
  const AIRTABLE_ID_KEYS = { baseId: 'airtable', spreadsheetId: 'sheets' };

  graph.addNode('destinations', async (state, cfg) => {
    const sessionId = cfg?.configurable?.threadId;
    const nodes = state.draft?.nodes ?? [];

    // Which steps write to Airtable? ALL of them are candidates — we do NOT ask
    // whether the model's base id "looks real" first, because a plausible-looking
    // hallucination (`appABCDEFGHIJKLMN`) passes any shape test, and gating the whole
    // node on that test let one guess skip the base lookup, the table lookup and the
    // column mapping. Ask the connector; it knows. (Found by the test-adversary.)
    const airtableNodes = nodes.filter(n => usesConnector(n, 'airtable'));
    if (!airtableNodes.length || !invokeCapability) return { phase: 'gapping' };

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
      const drifted = airtableNodes.some((n) => {
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
        llm, sessionId, nodes: airtableNodes, columns: cached.columns,
        outcome: state.draft?.outcome, table: cached.table,
      });
      return {
        draft: {
          ...state.draft,
          outcome: rewriteAssertionFields(state.draft?.outcome, renames, cached.columns),
          nodes: fillDestination(nodes, {
            baseId: cached.baseId, tableId: cached.table, fields: mapped, columnsRead: true,
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
      bases = (await invokeCapability('airtable_list_bases'))?.bases ?? [];
    } catch (err) {
      // A connector that cannot be read is not a connector that can be guessed at.
      // Fall through to the ordinary loop, which ASKS.
      return { phase: 'gapping', confirmationLog: [{ step: state.step, type: 'destination_lookup_failed', error: String(err?.message ?? err) }] };
    }
    if (!bases.length) return { phase: 'gapping' };

    // A base id the model already put in the draft is honoured ONLY if the tenant
    // actually has it. Anything else is a guess, and a guess writes the customer's
    // lead into a base that does not exist.
    const already = airtableNodes.map(n => n.config?.baseId).find(b => isKnownBase(b, bases));
    let base = already ? bases.find(b => b.id === already) : bases[0];
    if (bases.length > 1) {
      const answer = await interrupt({
        type: 'clarification',
        question: 'Which Airtable base should this write to?',
        choices: bases.map((b, i) => ({ id: b.id, label: b.name, selected: i === 0 })),
        step: state.step,
      });
      base = bases.find(b => b.id === answer?.id || b.name === answer?.answer) ?? bases[0];
    }

    // ── 2. The table, and its REAL columns ───────────────────────────────────
    let tables = [];
    try {
      tables = (await invokeCapability('airtable_describe_base', { baseId: base.id }))?.tables ?? [];
    } catch { /* fall through: we have a base, and the loop can still ask for a table */ }
    if (!tables.length) {
      return {
        draft: { ...state.draft, nodes: fillDestination(nodes, { baseId: base.id }) },
        destinationsResolved: true, step: state.step + 1, phase: 'gapping',
      };
    }

    let table = tables[0];
    if (tables.length > 1) {
      const answer = await interrupt({
        type: 'clarification',
        question: `Which table in "${base.name}"?`,
        choices: tables.map((t, i) => ({ id: t.id, label: t.name, selected: i === 0 })),
        step: state.step,
      });
      table = tables.find(t => t.id === answer?.id || t.name === answer?.answer) ?? tables[0];
    }

    // ── 3. Map the promised fields onto the columns that ACTUALLY EXIST ───────
    // One cheap call. The alternative is the model inventing `Budget` when the
    // column is called `Deal Size`, which Airtable accepts by silently ignoring —
    // the record is created, the field is empty, and the run reports success.
    const columns = table.fields ?? [];
    const { fields: mapped, renames, unmapped } = await mapFieldsToColumns({
      llm, sessionId, nodes: airtableNodes, columns,
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
    const outcome = rewriteAssertionFields(state.draft?.outcome, renames, columns);

    return {
      draft: {
        ...state.draft,
        outcome,
        nodes: fillDestination(nodes, { baseId: base.id, tableId: table.name, fields: mapped, columnsRead: true }),
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
    const corrections = [];
    for (const p of payload) {
      const ruleText = (p.rules ?? []).map((r, i) => {
        const when = r?.when && Object.keys(r.when).length
          ? Object.entries(r.when).map(([k, v]) => `${k} ${v}`).join(', ')
          : 'otherwise';
        return `  ${i + 1}. when ${when} → ${p.output.key} = ${r?.then ?? '?'}`;
      }).join('\n');
      const reply = await interrupt({
        type: 'clarification',
        kind: 'decision_review',            // inert to client/replier; identifies the surface
        decisionId: p.decisionId,
        question:
          `Here's how I'd decide ${p.output.key} for "${p.label}":\n${ruleText || '  (no rules yet)'}\n\n`
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
    // Everything the node returns must carry the repaired draft so it persists.
    const carry = repairs.length ? { draft } : {};
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

    // One cheap call so every gap arrives with an answer already in it. A gap
    // list with empty boxes is an interrogation; a gap list with defaults is a
    // review. The difference is the whole product.
    const suggested = await llmJson(llm, [
      new SystemMessage(buildSystemPrompt(state.capabilities)),
      new HumanMessage(buildGapPrompt({ intent: state.intent, gaps: [...blocking, ...soft] })),
    ], tierCfg('fast', sessionId));
    const suggestionFor = (id) =>
      (suggested?.suggestions ?? []).find(s => s.gapId === id)?.answer ?? null;

    // ── ASK CONVERSATIONALLY, NOT ON A CARD (#24) ───────────────────────────
    // The gap review used to be a bespoke `gap_review` card the client rendered;
    // an empty or awkward payload froze the walkthrough→gaps transition with
    // nothing to click. It is now the ordinary `clarification` surface — which
    // always shows a composer, so the build can never strand here. The REASONING
    // is unchanged (scoreGap + auto-repair + the suggestions above); only the
    // presentation moved.
    //
    // The default is still "keep the safe defaults": every blocking gap takes the
    // model's suggested answer (fed back through regenerate), every soft gap
    // escalates to a person. ANY unrecognised answer — an empty reply, the chip,
    // or the zero-typing autoRespond string — resolves to those defaults, so a
    // provably-complete workflow still publishes having answered NOTHING (§11.9).
    const lines = [];
    for (const g of blocking) {
      const s = suggestionFor(g.id);
      lines.push(`• ${g.message}${s ? ` — I'd go with: ${s}` : ''}`);
    }
    for (const g of soft) lines.push(`• ${g.message} — otherwise a person handles it`);

    const acceptLabel = blocking.length ? 'Use your suggestions' : 'Keep the safe defaults';
    const question =
      (blocking.length
        ? `Before I finalize, ${blocking.length === 1 ? 'one thing I want' : 'a few things I want'} to lock down:`
        : `Your workflow's ready. ${soft.length === 1 ? 'One optional edge case' : `${soft.length} optional edge cases`} you can weigh in on:`)
      + `\n${lines.join('\n')}\n\n`
      + `${acceptLabel}, or tell me how you'd rather handle any of these.`;

    const reply = await interrupt({
      type: 'clarification',
      // `kind` is inert to the client and the headless replier (both key on `type`)
      // but lets provenance and tests tell a gap clarification from an ordinary one.
      kind: 'gap_review',
      question,
      choices: [{ label: acceptLabel }],
      step: state.step,
    });

    const raw = String(reply?.answer ?? (typeof reply === 'string' ? reply : '')).trim();
    const isDefault = !raw
      || raw.toLowerCase() === acceptLabel.toLowerCase()
      || /please proceed with your best inference/i.test(raw);

    // Blocking gaps always resolve — to the suggestion by default — so the spec
    // can regenerate and clear them. Only a BLOCKING gap regenerates the spec (as
    // before): a soft-only review escalates and proceeds, never triggering a
    // rebuild, so a resolved destination cannot be clobbered by a spurious pass.
    const answers = {};
    const clarifications = [];
    for (const g of blocking) {
      const s = suggestionFor(g.id);
      if (s) { answers[g.id] = String(s); clarifications.push({ q: g.message, a: String(s) }); }
    }
    // Free-text guidance rides along on the regenerate ONLY when there is a
    // blocking gap to regenerate for — matching the old card, where a soft-gap
    // answer changed nothing (soft gaps escalate; they do not rebuild the spec).
    if (!isDefault && clarifications.length) {
      clarifications.push({ q: 'How I should handle the remaining questions', a: raw });
    }

    // Soft gaps escalate — a person handles the case at run time. `nodeId` is
    // load-bearing, not decoration: materialiseEscalations() has to find the step
    // the gap is ABOUT to put a real escalation path on it (P12 Increment E — a
    // DECISION_TABLE_GAP escalates by routing the uncovered case to a person).
    // Dropped here, the gap arrives at the materialiser as an anonymous sentence
    // and can only be reported unmaterialised — "escalated" would mean nothing.
    const escalated = soft.map(g => ({
      id: g.id, class: g.class, code: g.code, message: g.message, nodeId: g.nodeId ?? null, resolution: 'escalated',
    }));

    const logEntry = {
      step: state.step, type: 'gap_review',
      gaps: [...blocking, ...soft].map(g => ({ id: g.id, code: g.code, class: g.class, blocking: g.blocking })),
      escalated, answers, confirmation: reply,
    };

    // Answers to BLOCKING gaps go back through the propose loop, which is the
    // only thing that can actually change the spec. Bounded, so a gap the model
    // cannot close ends in a question rather than a spin.
    if (clarifications.length && (state.gapRounds ?? 0) < MAX_GAP_ROUNDS) {
      return {
        ...carry,
        clarifications,
        confirmationLog: [...repairLog, logEntry],
        escalatedGaps:   escalated,
        gapRounds:       (state.gapRounds ?? 0) + 1,
        proposeRounds:   0,
        step:            state.step + 1,
        phase:           'proposing',
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
    const draft      = state.draft;
    const assertions = draft?.outcome?.assertions ?? [];
    const examples   = (draft?.outcome?.examples ?? [])
      .filter(e => e && e.given != null)
      .slice(0, MAX_VERIFY_EXAMPLES);

    // ── FAIL-SAFE PASS-THROUGHS ──────────────────────────────────────────────
    // No tester wired, nothing to run, or no machine-checkable contract to judge
    // against ⇒ there is nothing to verify. Go straight to ratify, unchanged. This
    // is also why every existing converger test (which wires no `runDryRun`) keeps
    // its exact behaviour — the node is inert until a tester is provided.
    if (typeof runDryRun !== 'function' || !examples.length || !assertions.length) {
      return { phase: 'ratifying' };
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
      // A sample that RAN but FAILED gets ONE retry. The workflow's own llm nodes are
      // non-deterministic: a summarize can misfire its "missing data" guard or produce
      // off-output on a single run even when the SPEC is correct. A single flaky run must
      // not condemn a working workflow — only a CONSISTENT failure (fails twice) is a real
      // defect. (A pass on the first try never retries; an infra fault still bails.)
      let oracle = null, passed = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        let r;
        try {
          r = await runDryRun(spec, ex.given);
        } catch (err) {
          // The tester itself faulted. That is infra, not a workflow defect — do not
          // block the build or claim a failure. Pass through with an honest note.
          emitBeat(cfg, { kind: 'check', text: "I couldn't run the self-test just now — you can still run it yourself before going live." });
          return {
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
        phase: 'ratifying',
        _verifyReport: { ran: true, passed: passedCount, total, note: null },
        confirmationLog: [{ step: state.step, type: 'verify', ran: true, passed: passedCount, total, ok: true }],
        step: state.step + 1,
      };
    }

    // ── A SAMPLE FAILED — read the oracle's complaint. ───────────────────────
    const firstFail = judged.find(j => !j.passed);
    const runErr    = firstFail?.oracle?.error ?? null;
    const reasons   = (firstFail?.oracle?.contract ?? [])
      .filter(c => !c.ok)
      .map(c => c.reason || `${c.target} not satisfied`);
    const complaint = runErr
      ? `it errored: ${typeof runErr === 'string' ? runErr : (runErr?.message ?? JSON.stringify(runErr))}`
      : (reasons.length ? reasons.join('; ') : 'the outcome was not satisfied');
    const failLabel = firstFail?.example?.label ? ` ("${firstFail.example.label}")` : '';

    emitBeat(cfg, {
      kind: 'check',
      text: `That sample didn't pass — only ${passedCount}/${total} produced the right result.`,
    });

    // ── FIX (bounded) → regenerate the whole spec with the failure as context. ──
    // Reuse the generate path: feed the failing sample + the oracle's complaint back
    // as a clarification so the whole-spec pass rebuilds a corrected workflow, then
    // re-verify. The narrate `thinking` beat explains WHY it's rebuilding; the
    // generate node then streams its own reasoning as it does the rebuild.
    if ((state.verifyRounds ?? 0) < MAX_VERIFY_ROUNDS) {
      emitBeat(cfg, {
        kind: 'thinking',
        text: `The workflow ran, but it didn't keep its promise on a real sample${failLabel}: ${complaint}. Let me rebuild it so every promised delivery actually happens for this input.`,
      });
      return {
        // Route to `generate` (verify's own edge maps 'proposing' → generate),
        // rebuilding the whole spec from the accumulated clarifications + this fix note.
        phase:          'proposing',
        verifyRounds:   (state.verifyRounds ?? 0) + 1,
        clarifications: [{
          q: '(self-test failed — fix required)',
          a: `I ran this workflow on a real sample${failLabel} and it did NOT satisfy the outcome: ${complaint}. `
           + 'Rebuild the workflow so every promised delivery/record actually happens for this kind of input — '
           + 'do not drop or mis-wire any step the outcome depends on.',
        }],
        _verifyReport:  { ran: true, passed: passedCount, total, note: complaint },
        confirmationLog: [{ step: state.step, type: 'verify', ran: true, passed: passedCount, total, ok: false, complaint, fixing: true }],
        step: state.step + 1,
      };
    }

    // ── OUT OF FIX ROUNDS — do NOT loop, do NOT claim success. ────────────────
    // Route to ratify carrying an honest note. `complete ⇒ publishable` holds: the
    // spec is still valid and publishable; the converger simply tells the user it
    // could not get a sample to pass, so they can review before going live.
    emitBeat(cfg, {
      kind: 'check',
      text: `I couldn't get a sample to fully pass after ${state.verifyRounds} attempt${state.verifyRounds > 1 ? 's' : ''} — the workflow is built, but you may want to review it before going live.`,
    });
    return {
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
  // The client retired `propose`'s per-node `{type:'proposal'}` UI surface, so any route
  // that reaches `propose` post-generate emits an interrupt no client can render and the
  // build HANGS at phase:'building'. So a blocking gap with an answer, a sufficiency-named
  // missing component, and a ratify request-changes all route back to `generate`, which
  // reads the accumulated `clarifications` (+ `_missingNote`) and rebuilds the whole,
  // updated, still-validated spec. `propose` and its guards remain in the source but are
  // no longer routed to from anywhere — it is deliberately unreachable in production.
  // The regenerate loop is bounded (MAX_REGEN_ROUNDS + MAX_GAP_ROUNDS + the sufficiency
  // cap), so a spec the model cannot complete ends at `ratify` with its blockers shown.
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
    // proposing: build (or REBUILD) the whole spec in one `generate` pass. This is the
    // first build AND every later "the spec must change" pass — the retired `propose`
    // drip is never routed to (its UI surface no longer exists client-side, so a route
    // into it would hang). The MAX_REGEN_ROUNDS guard above stops the rebuild loop.
    return 'generate';
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
