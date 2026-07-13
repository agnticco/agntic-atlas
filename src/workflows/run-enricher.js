/**
 * run-enricher — turn a raw workflow_runs row into a human-friendly
 * "recipe card" structure the UI can render directly.
 *
 * Enrichment per step:
 *   - plain-English description (from the node-type's previewTemplate)
 *   - duration + status
 *   - cost (tokens + USD) attributed via the CostTracker's per-node context tag
 *   - sources (URLs extracted from the step's output where applicable)
 *   - output preview (first 500 chars)
 *
 * Top-level:
 *   - total duration, cost, LLM calls
 *   - warnings / error explanation (already structured)
 *   - workflow metadata (slug, name, version, kind)
 *
 * @module src/workflows/run-enricher.js
 */

const MAX_OUTPUT_PREVIEW = 800;

/**
 * Build the enriched structure. Pure function — all dependencies passed in.
 *
 * @param {object} run             — row from workflowStore.getRun()
 * @param {object} workflow        — row from workflowStore.get(run.workflow_id)
 * @param {object} deps
 * @param {object} deps.nodeTypes  — NodeTypeRegistry (for descriptions/icons)
 * @param {object} [deps.costTracker] — for per-step cost attribution
 * @param {Function} [deps.previewFn]  — async/sync (typeDef, cfg) => string (optional override)
 */
export function enrichRun(run, workflow, { nodeTypes, costTracker, previewFn } = {}) {
  if (!run) return null;

  const nodesById = new Map((workflow?.nodes ?? []).map(n => [n.id, n]));
  const steps     = Array.isArray(run.steps) ? run.steps : [];

  // Consolidate step events (step_started / step_completed / step_failed) into
  // one record per node id.
  const stepsByNode = new Map();
  for (const s of steps) {
    if (!s.nodeId) continue;
    const rec = stepsByNode.get(s.nodeId) ?? { nodeId: s.nodeId };
    if (s.type === 'step_started')   { rec.startedAt  = s.at; rec.label = s.label ?? rec.label; }
    if (s.type === 'step_completed') { rec.completedAt = s.at; rec.output = s.output; rec.durationMs = s.durationMs; rec.status = 'success'; }
    if (s.type === 'step_failed')    { rec.completedAt = s.at; rec.error  = s.error;  rec.durationMs = s.durationMs; rec.status = 'error';  rec.explanation = s.explanation ?? null; }
    stepsByNode.set(s.nodeId, rec);
  }

  // Build per-node cost map from the CostTracker records (per-node tag set
  // by FlowTester when it invoked the LLM).
  const costByNode = new Map();
  if (costTracker && run.id) {
    const records = costTracker.getRecordsForSession(`flow-run-${run.id}`);
    for (const r of records) {
      const ctx = r.context ?? '';
      const nodeId = ctx.split(':').pop();
      if (!nodeId) continue;
      const cur = costByNode.get(nodeId) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
      cur.inputTokens  += r.inputTokens  ?? 0;
      cur.outputTokens += r.outputTokens ?? 0;
      cur.costUsd      += r.costUsd      ?? 0;
      cur.calls        += 1;
      costByNode.set(nodeId, cur);
    }
  }

  // Enrich each workflow node — keep order defined by the workflow so the
  // UI shows the DAG in build order, even if a node didn't execute.
  const enrichedSteps = (workflow?.nodes ?? []).map(node => {
    const typeDef = nodeTypes?.get?.(node.type) ?? null;
    const rec     = stepsByNode.get(node.id) ?? { nodeId: node.id, status: 'skipped' };
    const descrip = previewFn
      ? previewFn(typeDef, node.config ?? {})
      : _fallbackDescription(typeDef, node);
    const outputShrunk = _shrinkOutput(rec.output);
    const sources = _extractSources(rec.output, node.type);

    return {
      id:           node.id,
      label:        node.label ?? typeDef?.label ?? node.type,
      type:         node.type,
      typeLabel:    typeDef?.label ?? node.type,
      icon:         typeDef?.icon ?? 'adjust',
      family:       typeDef?.family ?? null,
      description:  descrip,
      status:       rec.status ?? 'skipped',
      startedAt:    rec.startedAt  ?? null,
      completedAt:  rec.completedAt ?? null,
      durationMs:   rec.durationMs ?? null,
      output:       outputShrunk,
      sources,
      error:        rec.error ?? null,
      errorExplanation: rec.explanation ?? null,
      cost:         costByNode.get(node.id) ?? null,
    };
  });

  return {
    run: {
      id:           run.id,
      status:       run.status,
      isTest:       !!run.is_test,
      startedAt:    run.started_at,
      completedAt:  run.completed_at,
      durationMs:   _durationMs(run.started_at, run.completed_at),
      readAt:       run.read_at ?? null,
    },
    workflow: {
      id:      workflow?.id,
      slug:    workflow?.slug,
      name:    workflow?.name || workflow?.user_intent,
      kind:    workflow?.kind,
      version: workflow?.version,
      status:  workflow?.status,
    },
    cost: {
      tokensIn:  run.tokens_in  ?? 0,
      tokensOut: run.tokens_out ?? 0,
      costUsd:   run.cost_usd   ?? 0,
      llmCalls:  run.llm_calls  ?? 0,
    },
    summary: _buildSummary(run, enrichedSteps),
    steps:   enrichedSteps,
    finalOutput: _parseFinalOutput(run.output),
    warnings:    Array.isArray(run.warnings) ? run.warnings : [],
    errorExplanation: run.error_explanation ?? null,
    errorRaw:         run.status === 'error' ? run.error : null,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _fallbackDescription(typeDef, node) {
  return typeDef?.description
    ?? `A ${node.type} step${node.label ? ` labelled "${node.label}"` : ''}.`;
}

function _shrinkOutput(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    if (v.length <= MAX_OUTPUT_PREVIEW) return v;
    return v.slice(0, MAX_OUTPUT_PREVIEW) + '\n…(truncated)';
  }
  try {
    const s = JSON.stringify(v, null, 2);
    if (s.length <= MAX_OUTPUT_PREVIEW) return s;
    return s.slice(0, MAX_OUTPUT_PREVIEW) + '\n…(truncated)';
  } catch { return String(v).slice(0, MAX_OUTPUT_PREVIEW); }
}

/**
 * Extract source URLs from a step's output for display as "cited sources".
 * Behaviour depends on the step type:
 *   - search_web:    results[].url → articles with titles
 *   - anything else: scan the body for ![](url) and [text](url) patterns
 */
function _extractSources(output, type) {
  if (output == null) return [];
  let obj = output;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { /* stay string */ }
  }

  // Structured search outputs
  if (obj && typeof obj === 'object' && Array.isArray(obj.results)) {
    // `tool` was deleted in the P12 node re-cut (it never ran — no ToolRegistry
    // exists in this build); `connector-action` is the capability path now, and
    // list/search capabilities return the same results[] shape.
    if (type === 'search_web' || type === 'connector-action') {
      return obj.results.map(r => ({
        kind: 'article',
        title: r.title || r.url || '',
        url:   r.url   || '',
        snippet: (r.snippet || r.description || '').slice(0, 200),
      }));
    }
  }

  // Body scan
  const body = _extractBody(obj);
  if (!body) return [];
  const found = [];
  const seen  = new Set();
  // ![alt](url)
  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = imgRe.exec(body)) !== null) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    found.push({ kind: 'image', title: m[1] || m[2], url: m[2] });
  }
  // [text](url) — exclude already-seen
  const lnkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  while ((m = lnkRe.exec(body)) !== null) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    found.push({ kind: 'link', title: m[1], url: m[2] });
  }
  return found.slice(0, 20);
}

function _extractBody(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (typeof v.body === 'string') return v.body;
    if (typeof v.text === 'string') return v.text;
  }
  return '';
}

function _parseFinalOutput(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

function _durationMs(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const d = new Date(endIso).getTime() - new Date(startIso).getTime();
  return d >= 0 ? d : null;
}

/**
 * One-sentence summary of the run. Readable without opening any step —
 * "At 7:00 AM the workflow ran for 4 minutes across 8 steps, spent $0.04,
 * and produced a 4,200-character briefing with 6 images."
 */
function _buildSummary(run, enrichedSteps) {
  const status   = run.status;
  const when     = run.started_at ? new Date(run.started_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '?';
  const durMs    = _durationMs(run.started_at, run.completed_at);
  const dur      = durMs != null ? _formatDuration(durMs) : '?';
  const stepsOk  = enrichedSteps.filter(s => s.status === 'success').length;
  const stepsErr = enrichedSteps.filter(s => s.status === 'error').length;
  const cost     = Number(run.cost_usd ?? 0);
  const body     = _extractBody(_parseFinalOutput(run.output));
  const chars    = body.length;
  const images   = (body.match(/!\[[^\]]*\]\(([^)\s]+)\)/g) ?? []).length;

  const parts = [`At ${when}, the workflow`];
  if (status === 'success') {
    parts.push(`ran for ${dur} across ${stepsOk} steps`);
  } else if (status === 'error') {
    parts.push(`failed after ${dur} (${stepsOk} steps completed, ${stepsErr} failed)`);
  } else {
    parts.push(`is still ${status}`);
  }
  if (cost > 0) parts.push(`spent $${cost < 0.01 ? cost.toFixed(5) : cost.toFixed(4)}`);
  if (chars > 0 && status === 'success') {
    const words = Math.round(body.split(/\s+/).filter(Boolean).length);
    parts.push(`and produced a ${words.toLocaleString()}-word result${images > 0 ? ` with ${images} image${images === 1 ? '' : 's'}` : ''}`);
  }
  return parts.join(' ').replace(/ and /, ', and ') + '.';
}

function _formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${m} min` : `${m} min ${s}s`;
}
