/**
 * output-validator — silent-success detector.
 *
 * A workflow can complete with status='success' and still produce junk
 * output: empty bodies, unsubstituted templates, drastically smaller text
 * than expected. This module inspects the run's final output AFTER it
 * completes and returns user-facing warnings so the Inbox can flag them.
 *
 * Warnings DO NOT mark the run as failed — they're advisory. The user sees
 * the output and the warnings together so they can decide what to do.
 *
 * Returned shape per warning:
 *   { code, message, hint }
 *
 * @module src/workflows/output-validator.js
 */

const TEMPLATE_LEAK_RE = /\{\{[^}]+\}\}/g;
const MIN_BODY_CHARS_DEFAULT = 80;
const SHRINK_RATIO_THRESHOLD = 0.05;  // body < 5% of source content => suspicious

/**
 * Inspect a finished run and return zero or more output warnings.
 *
 * @param {object} run       — workflow_runs row, parsed (output may be string or object)
 * @param {object} workflow  — workflow row, with parsed nodes/edges
 * @returns {Array<{code, message, hint}>}
 */
export function validateRunOutput(run, workflow) {
  const warnings = [];
  if (!run || run.status !== 'success') return warnings;

  const out  = parseOutput(run.output);
  const body = extractBody(out);

  // ── Empty body ──────────────────────────────────────────────────────────
  if (!body || !body.trim()) {
    warnings.push({
      code: 'EMPTY_BODY',
      message: 'The workflow finished but the delivered content is empty.',
      hint: 'Check that the deliver step has a body or that the previous step produced output.',
    });
    return warnings;  // nothing else to inspect
  }

  // ── Unsubstituted templates ─────────────────────────────────────────────
  const leaks = body.match(TEMPLATE_LEAK_RE);
  if (leaks?.length) {
    const sample = [...new Set(leaks)].slice(0, 3).join(', ');
    warnings.push({
      code: 'UNSUBSTITUTED_TEMPLATE',
      message: `The output contains unfilled template references (${sample}).`,
      hint: 'A previous step probably didn\'t run, or the step id in the template is wrong. Check that every {{stepId.output}} reference points at a real upstream step.',
    });
  }

  // ── Suspiciously short body ─────────────────────────────────────────────
  if (body.trim().length < MIN_BODY_CHARS_DEFAULT) {
    warnings.push({
      code: 'BODY_TOO_SHORT',
      message: `The output is unusually short (${body.trim().length} characters).`,
      hint: 'This often means an upstream LLM step refused, returned an apology, or got an empty input.',
    });
  }

  // ── Body suspiciously smaller than scraped source content ──────────────
  // If the workflow had search_web steps with deep content, expect the
  // delivered body to reflect a meaningful fraction of that input.
  const sourceChars = estimateSourceChars(run, workflow);
  if (sourceChars > 4000 && body.length < sourceChars * SHRINK_RATIO_THRESHOLD) {
    warnings.push({
      code: 'BODY_DROPPED_CONTENT',
      message: 'The output is much shorter than the source material the workflow fetched.',
      hint: 'A transform step probably summarized too aggressively or hit a token limit. Open the LLM step and either raise its length, or add an Assemble step that preserves more of each section.',
    });
  }

  return warnings;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseOutput(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); }
    catch { return raw; }   // raw text — return as-is
  }
  return raw;
}

function extractBody(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (typeof out === 'object') {
    if (typeof out.body === 'string') return out.body;
    if (typeof out.text === 'string') return out.text;
    try { return JSON.stringify(out); } catch { return String(out); }
  }
  return String(out);
}

/**
 * Crude estimate of how much source content fed into the workflow. Used
 * only for the shrink-ratio heuristic; not exact. Walks the run's persisted
 * step records (if any) for fetch/search steps and sums their output sizes.
 */
function estimateSourceChars(run, workflow) {
  const steps = run?.steps ?? [];
  if (!Array.isArray(steps)) return 0;
  let total = 0;
  const fetchTypes = new Set(['search_web', 'fetch', 'tool']);
  const nodesById = new Map((workflow?.nodes ?? []).map(n => [n.id, n]));
  for (const step of steps) {
    if (step.type !== 'step_completed' || !step.nodeId) continue;
    const node = nodesById.get(step.nodeId);
    if (!node || !fetchTypes.has(node.type)) continue;
    if (typeof step.output === 'string') total += step.output.length;
  }
  return total;
}
