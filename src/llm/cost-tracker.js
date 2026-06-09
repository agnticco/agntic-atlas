/**
 * CostTracker — centralized token cost accounting for all LLM calls.
 *
 * Records every call with tier, model, token counts, and estimated USD.
 * Maintains per-session running totals so cumulative cost can be appended
 * to every response.
 *
 * @module src/llm/cost-tracker.js
 */

import { log } from '../utils/logger.js';

// ── Rate table ───────────────────────────────────────────────────────────────
// Per 1M tokens (USD). First prefix match wins.
// Keep this in sync with provider pricing pages.
const RATES = [
  ['claude-opus',   { in: 15,   out: 75   }],
  ['claude-sonnet', { in: 3,    out: 15   }],
  ['claude-haiku',  { in: 0.80, out: 4    }],
  ['gpt-4.1',       { in: 2,    out: 8    }],
  ['gpt-4o-mini',   { in: 0.15, out: 0.60 }],
  ['gpt-4o',        { in: 2.50, out: 10   }],
  ['gpt-4.1-mini',  { in: 0.40, out: 1.60 }],
  ['gpt-4.1-nano',  { in: 0.10, out: 0.40 }],
];

/**
 * Anthropic server-side web_search tool fee (USD per 1,000 search requests).
 * Charged in addition to token usage. Citation `cited_text`/`title`/`url` do
 * NOT count toward token usage.
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 */
const WEB_SEARCH_RATE_PER_1K = 10;

export class CostTracker {
  constructor() {
    /** @type {Array<{timestamp:string, sessionId:string, tier:string, model:string, context:string, inputTokens:number, outputTokens:number, costUsd:number|null}>} */
    this._records = [];

    /** @type {Map<string, {inputTokens:number, outputTokens:number, costUsd:number, calls:number}>} */
    this._sessions = new Map();

    /** @type {Array<{timestamp:string, sessionId:string, tokensBefore:number, tokensAfter:number, ratio:number, savedUsd:number}>} */
    this._compressionEvents = [];

    /** Optional MetricsStore — when set, every record is written through for persistence. */
    this._store = null;

    /**
     * sessionId → userId map. Populated by request handlers so we can attribute
     * downstream LLM calls back to the authenticated user without threading
     * userId through every call site.
     */
    this._sessionUsers = new Map();
  }

  /**
   * Associate a sessionId with a userId for the rest of this session's lifetime.
   * Request handlers call this once at request start; CostTracker auto-fills
   * userId on every subsequent record() for that session.
   */
  setSessionUser(sessionId, userId) {
    if (sessionId && userId) this._sessionUsers.set(sessionId, userId);
  }

  /** Look up the userId previously registered for a session (or null). */
  getSessionUser(sessionId) {
    return this._sessionUsers.get(sessionId) ?? null;
  }

  /**
   * Attach a persistence store. All subsequent record() / recordCompression()
   * calls will write through to the store in addition to the in-memory tally.
   * @param {{recordCost:Function, recordCompression:Function}|null} store
   */
  setStore(store) {
    this._store = store ?? null;
  }

  // ── Record a call ─────────────────────────────────────────────────────────

  /**
   * Record a single LLM call.
   *
   * @param {object} opts
   * @param {string} opts.sessionId  - Session that triggered the call
   * @param {string} opts.tier       - 'fast' | 'balanced' | 'powerful'
   * @param {string} opts.model      - Model ID, e.g. 'claude-sonnet-4-6'
   * @param {number} opts.inputTokens
   * @param {number} opts.outputTokens
   * @param {string} [opts.context]  - What the call was for ('rewrite', 'agent', 'planning', etc.)
   * @param {number} [opts.webSearchRequests] - Anthropic server-side web_search invocations on this call.
   *   Billed at $10 per 1,000 in addition to token usage. Sourced from
   *   `additionalKwargs.usage.web_search_requests` on the AIMessage.
   */
  record({ sessionId = 'unknown', userId = null, tier, model, inputTokens = 0, outputTokens = 0, context = '', webSearchRequests = 0 }) {
    // Auto-fill userId from the session→user map when the caller doesn't have it.
    userId = userId ?? this.getSessionUser(sessionId);

    const tokenCostUsd     = CostTracker.estimateCost(model, inputTokens, outputTokens);
    const webSearchCostUsd = CostTracker.estimateServerToolCost(webSearchRequests);
    // Total cost includes both token spend and server-tool fees. Stays null only
    // when token cost is unknown AND no web searches happened.
    const costUsd = tokenCostUsd !== null
      ? +(tokenCostUsd + webSearchCostUsd).toFixed(6)
      : (webSearchCostUsd > 0 ? webSearchCostUsd : null);

    log.llmCall(tier, model, context, inputTokens, outputTokens, costUsd);

    const record = {
      timestamp: new Date().toISOString(),
      sessionId,
      userId,
      tier,
      model,
      context,
      inputTokens,
      outputTokens,
      costUsd,
      webSearchRequests,
      webSearchCostUsd,
    };
    this._records.push(record);
    this._store?.recordCost(record);

    // Update session running total
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, {
        inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0,
        webSearchRequests: 0, webSearchCostUsd: 0,
      });
    }
    const s = this._sessions.get(sessionId);
    s.inputTokens        += inputTokens;
    s.outputTokens       += outputTokens;
    s.costUsd            += costUsd ?? 0;
    s.calls              += 1;
    s.webSearchRequests  += webSearchRequests;
    s.webSearchCostUsd   += webSearchCostUsd;
    // Return the computed cost so callers (e.g., model-pool's input-breakdown
    // patch) can attribute it to the right turn without recomputing.
    return costUsd;
  }

  // ── Session cost ──────────────────────────────────────────────────────────

  /**
   * Get the cumulative cost for a session.
   *
   * @param {string} sessionId
   * @returns {{ inputTokens: number, outputTokens: number, costUsd: number, calls: number }}
   */
  getSessionCost(sessionId) {
    return this._sessions.get(sessionId) ?? {
      inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0,
      webSearchRequests: 0, webSearchCostUsd: 0,
    };
  }

  /**
   * Raw call records for a session, optionally filtered by context prefix.
   * The run-detail view uses this to break down cost per workflow step —
   * context is tagged `workflow:<slug>:<nodeId>` by FlowTester.
   */
  getRecordsForSession(sessionId, { contextPrefix = '' } = {}) {
    return this._records.filter(r =>
      r.sessionId === sessionId &&
      (!contextPrefix || (r.context ?? '').startsWith(contextPrefix))
    );
  }

  // ── Summaries ─────────────────────────────────────────────────────────────

  /**
   * Aggregate summary across all sessions.
   */
  getSummary() {
    const byTier    = {};
    const byContext = {};
    const byModel   = {};
    let totalCostUsd          = 0;
    let totalInput            = 0;
    let totalOutput           = 0;
    let totalWebSearches      = 0;
    let totalWebSearchCostUsd = 0;

    const bucket = () => ({
      calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
      webSearchRequests: 0, webSearchCostUsd: 0,
    });

    for (const r of this._records) {
      totalCostUsd          += r.costUsd ?? 0;
      totalInput            += r.inputTokens;
      totalOutput           += r.outputTokens;
      totalWebSearches      += r.webSearchRequests ?? 0;
      totalWebSearchCostUsd += r.webSearchCostUsd  ?? 0;

      // By tier
      if (!byTier[r.tier]) byTier[r.tier] = bucket();
      byTier[r.tier].calls              += 1;
      byTier[r.tier].inputTokens        += r.inputTokens;
      byTier[r.tier].outputTokens       += r.outputTokens;
      byTier[r.tier].costUsd            += r.costUsd ?? 0;
      byTier[r.tier].webSearchRequests  += r.webSearchRequests ?? 0;
      byTier[r.tier].webSearchCostUsd   += r.webSearchCostUsd  ?? 0;

      // By context
      const ctx = r.context || 'unspecified';
      if (!byContext[ctx]) byContext[ctx] = bucket();
      byContext[ctx].calls              += 1;
      byContext[ctx].inputTokens        += r.inputTokens;
      byContext[ctx].outputTokens       += r.outputTokens;
      byContext[ctx].costUsd            += r.costUsd ?? 0;
      byContext[ctx].webSearchRequests  += r.webSearchRequests ?? 0;
      byContext[ctx].webSearchCostUsd   += r.webSearchCostUsd  ?? 0;

      // By model
      if (!byModel[r.model]) byModel[r.model] = bucket();
      byModel[r.model].calls              += 1;
      byModel[r.model].inputTokens        += r.inputTokens;
      byModel[r.model].outputTokens       += r.outputTokens;
      byModel[r.model].costUsd            += r.costUsd ?? 0;
      byModel[r.model].webSearchRequests  += r.webSearchRequests ?? 0;
      byModel[r.model].webSearchCostUsd   += r.webSearchCostUsd  ?? 0;
    }

    return {
      totalCalls: this._records.length,
      totalInput,
      totalOutput,
      totalCostUsd:          +totalCostUsd.toFixed(6),
      totalWebSearches,
      totalWebSearchCostUsd: +totalWebSearchCostUsd.toFixed(6),
      byTier,
      byContext,
      byModel,
      sessions: Object.fromEntries(this._sessions),
    };
  }

  /** Raw log of every call. */
  getRecords() {
    return this._records;
  }

  /** Clear session data (e.g. when a session is deleted). */
  clearSession(sessionId) {
    this._sessions.delete(sessionId);
  }

  /** Full reset — useful for tests. */
  reset() {
    this._records = [];
    this._sessions.clear();
    this._compressionEvents = [];
  }

  // ── Compression tracking ──────────────────────────────────────────────────

  /**
   * Record a compression event.
   *
   * Estimates savings as the token difference priced at the balanced tier
   * (Claude Sonnet) input rate — since these tokens would have been sent
   * to the expensive model without compression.
   *
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {number} opts.tokensBefore - Total history tokens before compression
   * @param {number} opts.tokensAfter  - Total history tokens after compression
   */
  recordCompression({ sessionId = 'unknown', userId = null, tokensBefore = 0, tokensAfter = 0 }) {
    userId = userId ?? this.getSessionUser(sessionId);
    const tokensSaved = Math.max(0, tokensBefore - tokensAfter);
    const ratio       = tokensBefore > 0 ? +(tokensAfter / tokensBefore).toFixed(3) : 1;
    // Price savings at Claude Sonnet input rate ($3 / 1M tokens)
    const savedUsd    = +((tokensSaved * 3) / 1_000_000).toFixed(6);

    const event = {
      timestamp: new Date().toISOString(),
      sessionId,
      userId,
      tokensBefore,
      tokensAfter,
      ratio,
      savedUsd,
    };
    this._compressionEvents.push(event);
    this._store?.recordCompression(event);
  }

  /**
   * Aggregate compression metrics across all sessions.
   *
   * @returns {{ totalCompressions:number, totalTokensSaved:number, averageRatio:number,
   *             estimatedSavingsUsd:number, compressionCostUsd:number, netSavingsUsd:number,
   *             sessions:object }}
   */
  getCompressionSummary() {
    let totalTokensBefore = 0;
    let totalTokensAfter  = 0;
    let totalSavedUsd     = 0;
    const sessions        = {};

    for (const evt of this._compressionEvents) {
      totalTokensBefore += evt.tokensBefore;
      totalTokensAfter  += evt.tokensAfter;
      totalSavedUsd     += evt.savedUsd;

      if (!sessions[evt.sessionId]) {
        sessions[evt.sessionId] = { compressions: 0, tokensSaved: 0, avgRatio: 0, _sumRatio: 0 };
      }
      const s = sessions[evt.sessionId];
      s.compressions += 1;
      s.tokensSaved  += evt.tokensBefore - evt.tokensAfter;
      s._sumRatio    += evt.ratio;
    }

    // Finalize per-session averages
    for (const s of Object.values(sessions)) {
      s.avgRatio = s.compressions > 0 ? +(s._sumRatio / s.compressions).toFixed(3) : 1;
      delete s._sumRatio;
    }

    // Estimate compression compute cost: sum of all "compression" context calls
    let compressionCostUsd = 0;
    for (const r of this._records) {
      if (r.context === 'compression') compressionCostUsd += r.costUsd ?? 0;
    }

    const totalTokensSaved = totalTokensBefore - totalTokensAfter;

    return {
      totalCompressions:   this._compressionEvents.length,
      totalTokensSaved,
      averageRatio:        totalTokensBefore > 0
        ? +(totalTokensAfter / totalTokensBefore).toFixed(3)
        : null,
      estimatedSavingsUsd: +totalSavedUsd.toFixed(6),
      compressionCostUsd:  +compressionCostUsd.toFixed(6),
      netSavingsUsd:       +(totalSavedUsd - compressionCostUsd).toFixed(6),
      sessions,
    };
  }

  // ── Static cost estimation ────────────────────────────────────────────────

  /**
   * Estimate cost in USD for a single call. Returns null for unknown models.
   *
   * @param {string} model  - Model ID (e.g. 'claude-sonnet-4-6')
   * @param {number} input  - Input tokens
   * @param {number} output - Output tokens
   * @returns {number|null}
   */
  static estimateCost(model, input, output) {
    const m = (model ?? '').toLowerCase();
    for (const [key, rate] of RATES) {
      if (m.includes(key)) {
        return +((input * rate.in + output * rate.out) / 1_000_000).toFixed(6);
      }
    }
    return null;
  }

  /**
   * Estimate the server-side tool surcharge in USD for a turn. Web_search is
   * billed at $10 / 1,000 invocations; web_fetch is currently free per
   * Anthropic but plumbed through symmetrically so a future fee lands in one
   * place. Single source of truth — both `record()` and `_buildMetricRecord`
   * call this so Audit and Prompt Breakdown can't drift.
   *
   * @param {number} webSearchRequests
   * @param {number} [webFetchRequests=0]
   * @returns {number}  USD, rounded to 6dp
   */
  static estimateServerToolCost(webSearchRequests = 0, webFetchRequests = 0) {
    return +((webSearchRequests * WEB_SEARCH_RATE_PER_1K) / 1000).toFixed(6);
  }
}

export default CostTracker;
