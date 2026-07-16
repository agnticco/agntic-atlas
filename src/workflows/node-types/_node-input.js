/**
 * Shared upstream-input resolution for transform primitives
 * (summarize / rewrite / extract) and a stringifier used everywhere.
 *
 * THE BUG THIS FIXES
 * ──────────────────
 * Transform nodes used to take their input from `ctx.lastOutput` — the
 * single immediately-preceding node's output. In a workflow like
 *
 *   trigger → search_web → search_web → search_web → search_web → summarize
 *
 * (a *linear* chain of four independent searches feeding one summarize),
 * `ctx.lastOutput` at the summarize step is ONLY the fourth search's
 * result. s1–s3 are silently discarded, so the "weekly briefing" covers
 * one of its four intended sections and the LLM hallucinates the rest.
 *
 * `resolveTransformInput` instead aggregates EVERY upstream
 * content-producing ancestor (provided by FlowTester as
 * `ctx.ancestorOutputs`, in topological order). This is correct for:
 *   - linear chains   (all prior producers are transitive ancestors)
 *   - fan-in DAGs     (all branch producers are ancestors)
 *   - single-search   (one ancestor → behaves exactly as before, no regression)
 *
 * An explicit `cfg.input` always wins (author opted into a specific source).
 *
 * @module src/workflows/node-types/_node-input.js
 */

/**
 * Node types that don't produce deliverable content — never fed to a transform
 * or delivered as a body.
 *
 * `branch` and `human` (P12 Increment B) are CONTROL nodes: a branch's output is
 * `{value, matched, to}` and a human's is `{decision, by, at, channel}`. Those
 * are routing and audit metadata, not the work product. Left in, the immediate
 * upstream of a delivery after an approval is the `human` node — so the customer
 * would receive the literal string {"decision":"approve","by":"user:1",…} instead
 * of the reply that was approved. The content is the draft ABOVE the approval.
 *
 * `decision` (P12 Increment E) is the same: {value, text, rule, inputs} is the
 * answer plus the row that produced it. An `llm` step downstream of a decision
 * must summarise the EMAIL, not the audit record of how the email was classified.
 */
const NON_CONTENT_TYPES = new Set(['trigger', 'deliver', 'branch', 'human', 'decision', 'stop']);

/**
 * Stringify a node output for use as text input / delivered body.
 * Mirrors the per-file `_stringify` the node types used to each define.
 */
export function stringifyOutput(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'text' in v) return v.text;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * True when an output is real, deliverable content (not a trigger sentinel
 * and not empty). Trigger nodes emit `{ trigger: true, at: <iso> }` — that
 * must not count as content a transform should summarize or deliver.
 */
export function isMeaningfulOutput(v) {
  if (v == null) return false;
  if (typeof v === 'object' && v.trigger === true && 'at' in v) {
    // Pure trigger sentinel (allow for the 2 known keys only).
    const keys = Object.keys(v);
    if (keys.length <= 2) return false;
  }
  return !!stringifyOutput(v).trim();
}

/**
 * Resolve the text input for a transform node.
 *
 * Priority:
 *   1. Explicit `cfg.input` (author override) — used verbatim.
 *   2. Aggregate of ALL upstream content-producing ancestor outputs,
 *      labeled by node when there is more than one.
 *   3. Fall back to `ctx.lastOutput` (defensive — pre-ancestor-aware
 *      callers, or a flow with no resolvable edges).
 *
 * @param {object} cfg  — substituted node config
 * @param {object} ctx  — { lastOutput, ancestorOutputs?: [{id,label,type,output}] }
 * @returns {string}
 */
export function resolveTransformInput(cfg, ctx) {
  if (cfg?.input != null && String(cfg.input).trim().length) {
    return String(cfg.input);
  }

  const ancestors = Array.isArray(ctx?.ancestorOutputs) ? ctx.ancestorOutputs : [];
  const content = [];
  for (const a of ancestors) {
    if (NON_CONTENT_TYPES.has(a?.type)) continue;
    if (!isMeaningfulOutput(a?.output)) continue;
    content.push({ label: a.label ?? a.id ?? 'step', text: stringifyOutput(a.output) });
  }

  if (content.length === 0) {
    // No ancestor content surfaced (e.g. ancestorOutputs not provided, or
    // every ancestor produced nothing) — fall back to the prior behavior.
    return stringifyOutput(ctx?.lastOutput);
  }
  if (content.length === 1) {
    // Single producer (e.g. trigger → search → summarize). Identical to the
    // old lastOutput path — guarantees no regression on simple workflows.
    return content[0].text;
  }
  // Multiple producers — label each section so the LLM can attribute and
  // organize. The node labels are user-authored and descriptive
  // ("Port of Savannah & Gulf port congestion...", etc.).
  return content
    .map(c => `## ${c.label}\n\n${c.text}`)
    .join('\n\n---\n\n');
}
