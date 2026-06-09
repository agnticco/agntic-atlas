/**
 * ModelPool — tiered LLM routing with cost tracking.
 *
 * Drop-in replacement for ChatModel. Holds multiple ChatModel instances keyed
 * by tier ('fast', 'balanced', 'powerful') and routes every invoke/stream call
 * to the tier specified in config.configurable.modelTier. Callers that don't
 * set a tier get the defaultTier.
 *
 * Implements the Runnable interface so it can be passed anywhere a ChatModel
 * is accepted today — transparent to all downstream consumers.
 *
 * Usage:
 *   const pool = new ModelPool({
 *     tiers: {
 *       fast:     new ChatModel({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey }),
 *       balanced: new ChatModel({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey }),
 *       powerful: new ChatModel({ provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey }),
 *     },
 *     costTracker: new CostTracker(),
 *   });
 *
 *   // Routes to 'balanced' (default)
 *   await pool.invoke(messages);
 *
 *   // Routes to 'fast'
 *   await pool.invoke(messages, { configurable: { modelTier: 'fast' } });
 *
 * @module src/llm/model-pool.js
 */

import { Runnable } from '../core/runnable.js';
import { log } from '../utils/logger.js';

export class ModelPool extends Runnable {
  /**
   * @param {object} options
   * @param {Object<string, import('./chat-model.js').ChatModel>} options.tiers
   *   Map of tier name → ChatModel instance. At minimum, 'balanced' should exist.
   * @param {string}  [options.defaultTier='balanced'] - Fallback when no tier is specified
   * @param {import('./cost-tracker.js').CostTracker} [options.costTracker] - Injected tracker
   * @param {boolean} [options.verbose=false]
   */
  constructor({ tiers, defaultTier = 'balanced', costTracker = null, verbose = false } = {}) {
    super();

    if (!tiers || Object.keys(tiers).length === 0) {
      throw new Error('ModelPool requires at least one tier');
    }

    this.tiers        = tiers;
    this.defaultTier  = defaultTier;
    this.costTracker  = costTracker;
    this.verbose      = verbose;

    // Expose model name from the default tier for code that reads llm.model
    // (e.g. agent-graph _estimateCost, logging). This is a best-effort fallback;
    // the actual model used depends on the tier selected per-call.
    this.model    = tiers[defaultTier]?.model ?? '';
    this.provider = tiers[defaultTier]?.provider ?? '';
  }

  // ── Tier resolution ────────────────────────────────────────────────────────

  /**
   * Resolve the ChatModel for a given tier name.
   * Falls back to defaultTier, then to any available tier.
   */
  _resolve(tierName) {
    if (tierName && this.tiers[tierName]) return { tier: tierName, llm: this.tiers[tierName] };
    if (this.tiers[this.defaultTier])     return { tier: this.defaultTier, llm: this.tiers[this.defaultTier] };
    // Last resort — pick the first available tier
    const [fallbackName, fallbackLlm] = Object.entries(this.tiers)[0];
    return { tier: fallbackName, llm: fallbackLlm };
  }

  /**
   * Direct access to a specific tier's ChatModel.
   * @param {string} tierName
   * @returns {import('./chat-model.js').ChatModel}
   */
  getTier(tierName) {
    return this.tiers[tierName] ?? this.tiers[this.defaultTier];
  }

  // ── Cost tracking helper ───────────────────────────────────────────────────

  _trackUsage(response, tier, model, config) {
    if (!this.costTracker) return;
    const usage = response?.additionalKwargs?.usage;
    if (!usage) return;

    const sessionId    = config?.configurable?.sessionId ?? 'unknown';
    const costContext  = config?.configurable?.costContext ?? '';
    const inputTokens  = usage.input  ?? 0;
    const outputTokens = usage.output ?? 0;

    const costUsd = this.costTracker.record({
      sessionId,
      tier,
      model,
      inputTokens,
      outputTokens,
      context:           costContext,
      webSearchRequests: usage.web_search_requests ?? 0,
    });

    // Stamp the actually-used model name + computed cost back onto the
    // response so downstream aggregators (agent-graph._sumUsage) can read
    // them without re-pricing against ModelPool.model (which is fixed to
    // the default tier and would mis-price any non-default-tier turn —
    // root cause of the 2026-05-20 inflation finding). Skip the cost_usd
    // write when the rate table doesn't know this model.
    if (costUsd != null) usage.cost_usd = costUsd;
    usage.model = model;
  }

  // ── Runnable interface ─────────────────────────────────────────────────────

  /**
   * Route a single invoke call to the appropriate tier.
   *
   * @param {string|import('../core/message.js').BaseMessage[]} input
   * @param {object} [config]
   * @param {string} [config.configurable.modelTier]   - Tier to use
   * @param {string} [config.configurable.costContext]  - Label for cost tracking
   * @param {string} [config.configurable.sessionId]    - Session ID for cost tracking
   * @returns {Promise<import('../core/message.js').AIMessage>}
   */
  async _call(input, config = {}) {
    const requestedTier = config?.configurable?.modelTier;
    const { tier, llm } = this._resolve(requestedTier);

    const response = await llm._call(input, config);
    this._trackUsage(response, tier, llm.model, config);
    return response;
  }

  /**
   * Route a streaming call to the appropriate tier.
   * Tracks cost from the final AIMessage (tool-calling turns) emitted at end of stream.
   */
  async* stream(input, config = {}) {
    const requestedTier = config?.configurable?.modelTier;
    const { tier, llm } = this._resolve(requestedTier);

    // Snapshot counters before streaming to compute per-call delta
    const inputBefore = llm._totalInputTokens ?? 0;
    const outputBefore = llm._totalOutputTokens ?? 0;

    let lastChunk = null;
    for await (const chunk of llm.stream(input, config)) {
      lastChunk = chunk;
      yield chunk;
    }

    // Try usage from the last chunk first (tool-calling turns attach it)
    if (lastChunk?.additionalKwargs?.usage) {
      this._trackUsage(lastChunk, tier, llm.model, config);
    } else if (this.costTracker) {
      // Fallback: compute delta from ChatModel's cumulative counters
      // (updated by ChatModel.stream → finalMessage)
      const inputDelta = (llm._totalInputTokens ?? 0) - inputBefore;
      const outputDelta = (llm._totalOutputTokens ?? 0) - outputBefore;
      if (inputDelta > 0 || outputDelta > 0) {
        const sessionId   = config?.configurable?.sessionId ?? 'unknown';
        const costContext = config?.configurable?.costContext ?? '';
        this.costTracker.record({
          sessionId,
          tier,
          model:        llm.model,
          inputTokens:  inputDelta,
          outputTokens: outputDelta,
          context:      costContext,
        });
      }
    }
  }

  /**
   * Batch calls — sequential, each routed independently.
   */
  async batch(inputs, config = {}) {
    const results = [];
    for (const input of inputs) {
      results.push(await this._call(input, config));
    }
    return results;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async dispose() {
    for (const llm of Object.values(this.tiers)) {
      await llm.dispose?.();
    }
  }

  toString() {
    const tierList = Object.entries(this.tiers)
      .map(([name, llm]) => `${name}=${llm.provider}/${llm.model}`)
      .join(', ');
    return `ModelPool(${tierList})`;
  }
}

export default ModelPool;
