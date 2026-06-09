/**
 * Middleware — intercepting hooks for agent lifecycle events.
 *
 * AgentMiddleware: base class. Subclass and override any hooks.
 * MiddlewareRunner: chains an array of middleware, threading transforms.
 *
 * Hook execution order per agent turn:
 *
 *   beforeAgent(state, runtime)         — once, before the graph starts
 *   beforeModel(messages, runtime)      — once, after history is built (returns messages[])
 *   onRouting(sources, runtime)         — once, after classify fires (routing decisions)
 *   wrapToolCall(name, args, handler)   — per tool call inside direct_pipeline
 *   afterModel(response, runtime)       — per LLM response inside pipeline nodes
 *   afterAgent(result, runtime)         — once, after the graph completes
 *
 * Runtime object shape (threaded through all hooks):
 *   { sessionId: string, writer: fn|null, inference: string }
 *
 * @module src/utils/middleware.js
 */

import { countMessagesTokens, countMessageTokens } from './token-counter.js';
import { appendFileSync } from 'fs';
import { log } from './logger.js';

// ── Base class ───────────────────────────────────────────────────────────────

export class AgentMiddleware {
  /** Called once before the agent graph starts. */
  async beforeAgent(state, runtime) {}

  /**
   * Called once after the message history is assembled, before the graph runs.
   * Return the (possibly modified) messages array.
   * @param {object[]} messages
   * @param {object} runtime
   * @returns {Promise<object[]>}
   */
  async beforeModel(messages, runtime) { return messages; }

  /**
   * Called after the classify node resolves routing decisions.
   * @param {Array<{source: string, query: string}>} sources
   * @param {object} runtime
   */
  async onRouting(sources, runtime) {}

  /**
   * Wraps a single tool call. Call handler(name, args) to execute it.
   * @param {string} name
   * @param {object} args
   * @param {function} handler  - (name, args) => result
   * @returns {Promise<object>}
   */
  async wrapToolCall(name, args, handler) { return handler(name, args); }

  /**
   * Called after each LLM response inside a pipeline node.
   * Return the (possibly modified) response.
   * @param {object} response - AIMessage
   * @param {object} runtime
   * @returns {Promise<object>}
   */
  async afterModel(response, runtime) { return response; }

  /** Called once after the graph completes and result is ready. */
  async afterAgent(result, runtime) {}
}

// ── Runner ───────────────────────────────────────────────────────────────────

export class MiddlewareRunner {
  /** @param {AgentMiddleware[]} middleware */
  constructor(middleware = []) {
    this._middleware = middleware;
  }

  get isEmpty() { return this._middleware.length === 0; }

  async runBeforeAgent(state, runtime) {
    for (const mw of this._middleware) {
      await mw.beforeAgent(state, runtime);
    }
  }

  /** Returns the transformed messages array. */
  async runBeforeModel(messages, runtime) {
    let msgs = messages;
    for (const mw of this._middleware) {
      msgs = (await mw.beforeModel(msgs, runtime)) ?? msgs;
    }
    return msgs;
  }

  async runOnRouting(sources, runtime) {
    for (const mw of this._middleware) {
      await mw.onRouting(sources, runtime);
    }
  }

  /** Wraps tool execution through all middleware, innermost-first. */
  async runWrapToolCall(name, args, coreHandler) {
    const chain = this._middleware.reduceRight(
      (next, mw) => (n, a) => mw.wrapToolCall(n, a, next),
      coreHandler
    );
    return chain(name, args);
  }

  /** Returns the (possibly transformed) response. */
  async runAfterModel(response, runtime) {
    let resp = response;
    for (const mw of this._middleware) {
      resp = (await mw.afterModel(resp, runtime)) ?? resp;
    }
    return resp;
  }

  async runAfterAgent(result, runtime) {
    for (const mw of this._middleware) {
      await mw.afterAgent(result, runtime);
    }
  }
}

// ── LoggingMiddleware ────────────────────────────────────────────────────────

/**
 * Structured per-turn logging.
 *
 * Captures: query, sessionId, routing decisions, total elapsed time,
 * model call count, estimated tokens, web source count.
 *
 * Writes to console and optionally to a JSON-lines file.
 *
 * @example
 * new LoggingMiddleware({ logPath: './logs/server.log', verbose: true })
 */
export class LoggingMiddleware extends AgentMiddleware {
  /**
   * @param {object} [options]
   * @param {boolean} [options.verbose=true]   - Log to console
   * @param {string}  [options.logPath]        - JSON-lines file path (optional)
   */
  constructor(options = {}) {
    super();
    this._verbose = options.verbose ?? true;
    this._logPath = options.logPath ?? null;
    this._turns   = [];
    this._current = null;
  }

  async beforeAgent(state, runtime) {
    const lastHuman = [...(state.messages ?? [])].reverse()
      .find(m => m._type === 'human');

    this._current = {
      sessionId:   runtime?.sessionId ?? 'unknown',
      query:       lastHuman?.content?.slice(0, 200) ?? '',
      startTime:   Date.now(),
      modelCalls:  0,
      routing:     null,
    };
  }

  async beforeModel(messages, runtime) {
    if (this._current) this._current.modelCalls++;
    return messages;
  }

  async onRouting(sources, runtime) {
    if (this._current) {
      this._current.routing = sources.map(s => s.source);
    }
  }

  async afterAgent(result, runtime) {
    if (!this._current) return;

    const elapsed = Date.now() - this._current.startTime;
    const record = {
      time:       new Date().toISOString(),
      sessionId:  this._current.sessionId.slice(0, 8),
      query:      this._current.query,
      routing:    this._current.routing ?? ['direct'],
      modelCalls: this._current.modelCalls,
      webSources: result?.sources?.length ?? 0,
      elapsed:    `${elapsed}ms`,
    };

    this._turns.push(record);
    this._current = null;

    const line = `[log] ${record.elapsed} | ${record.routing.join('+')} | ` +
      `${record.modelCalls} calls | ${record.webSources} sources | ` +
      `"${record.query.slice(0, 80)}"`;

    if (this._verbose) log.info(line);

    if (this._logPath) {
      try {
        appendFileSync(this._logPath, JSON.stringify(record) + '\n');
      } catch { /* best-effort */ }
    }
  }

  /** Returns all recorded turn logs. */
  getTurns() { return [...this._turns]; }
}

// ── SummarizationMiddleware ──────────────────────────────────────────────────

/**
 * Compresses conversation history when it exceeds a threshold.
 *
 * Unlike WindowMemory (which hard-drops old messages), this makes a secondary
 * LLM call to summarize the oldest messages into a single SystemMessage block.
 * The summary rolls forward — each new compression incorporates the prior one.
 *
 * Fires in the `beforeModel` hook, transforming the messages array before
 * the graph receives it.
 *
 * @example
 * new SummarizationMiddleware({
 *   llm,
 *   trigger: { messages: 8 },  // compress when > 8 non-system messages
 *   keep:    { messages: 4 },  // keep the 4 most recent after compression
 * })
 */
export class SummarizationMiddleware extends AgentMiddleware {
  /**
   * @param {object} options
   * @param {object} options.llm                    - LLM instance (REQUIRED)
   * @param {object} [options.trigger]              - When to compress
   * @param {number} [options.trigger.messages=8]   -   by message count
   * @param {number} [options.trigger.tokens]       -   by token count (overrides messages)
   * @param {object} [options.keep]                 - How much to keep after compression
   * @param {number} [options.keep.messages=4]      -   recent message count to preserve
   * @param {number} [options.keep.tokens]          -   recent token budget to preserve
   * @param {boolean}[options.verbose=false]
   */
  constructor(options = {}) {
    super();
    if (!options.llm) throw new Error('SummarizationMiddleware requires an llm option');
    this._llm     = options.llm;
    this._trigger = options.trigger ?? { messages: 8 };
    this._keep    = options.keep    ?? { messages: 4 };
    this._verbose = options.verbose ?? false;
    // Per-session rolling summaries: sessionId → string
    this._summaries = new Map();
  }

  async beforeModel(messages, runtime) {
    const sessionId  = runtime?.sessionId ?? 'default';
    const nonSystem  = messages.filter(m => m._type !== 'system');
    const systemMsgs = messages.filter(m => m._type === 'system');

    if (!this._shouldTrigger(nonSystem)) return messages;

    const keepCount = this._keepCount(nonSystem);
    const toCompress = nonSystem.slice(0, -keepCount);
    const toKeep     = nonSystem.slice(-keepCount);

    if (!toCompress.length) return messages;

    const existingSummary = this._summaries.get(sessionId) ?? '';
    const historyText = toCompress
      .map(m => `${m._type === 'human' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    const prompt = existingSummary
      ? `Prior summary:\n${existingSummary}\n\nNew exchanges to incorporate:\n${historyText}\n\nWrite an updated summary in one concise paragraph (third person). Preserve key facts, decisions, and names.`
      : `Summarize this conversation in one concise paragraph (third person). Preserve key facts, decisions, and names.\n\n${historyText}\n\nSummary:`;

    try {
      const result     = await this._llm.invoke(prompt);
      const newSummary = result.content?.trim() ?? '';
      this._summaries.set(sessionId, newSummary);

      if (this._verbose) {
        log.info(
          `[middleware:summarize] ${toCompress.length} messages → summary ` +
          `(${sessionId.slice(0, 8)}, kept ${toKeep.length})`
        );
      }

      // Import dynamically to avoid circular dependency risk
      const { SystemMessage } = await import('../core/message.js');
      const summaryMsg = new SystemMessage(`Earlier in this conversation:\n${newSummary}`);
      return [...systemMsgs, summaryMsg, ...toKeep];
    } catch (err) {
      if (this._verbose) {
        log.warn(`[middleware:summarize] compression failed: ${err.message}`);
      }
      return messages; // safe fallback — proceed with uncompressed history
    }
  }

  /** Clear cached summary for a session (e.g. on session reset). */
  clearSession(sessionId = 'default') {
    this._summaries.delete(sessionId);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _shouldTrigger(nonSystem) {
    if (this._trigger.tokens) {
      return countMessagesTokens(nonSystem) > this._trigger.tokens;
    }
    return nonSystem.length > (this._trigger.messages ?? 8);
  }

  _keepCount(nonSystem) {
    if (this._keep.tokens) {
      // Walk backwards, accumulate tokens until budget exceeded
      let count  = 0;
      let tokens = 0;
      for (let i = nonSystem.length - 1; i >= 0; i--) {
        tokens += countMessageTokens(nonSystem[i]);
        if (tokens > this._keep.tokens) break;
        count++;
      }
      return Math.max(count, 1);
    }
    return Math.min(this._keep.messages ?? 4, nonSystem.length - 1);
  }
}

// ── RoutingMiddleware ────────────────────────────────────────────────────────

/**
 * Emits routing decisions as status events so the frontend can show which
 * pipelines are active before any response arrives.
 *
 * Fires in the `onRouting` hook (called from the classify node).
 *
 * Status message format: "Routing: vault + web"
 * Source labels: vault → "knowledge base", web → "web", direct → "reasoning"
 *
 * @example
 * new RoutingMiddleware()
 * new RoutingMiddleware({ labels: { vault: 'notes', web: 'internet' } })
 */
export class RoutingMiddleware extends AgentMiddleware {
  /**
   * @param {object} [options]
   * @param {object} [options.labels]  - Custom display names for source keys
   * @param {boolean}[options.verbose=false]
   */
  constructor(options = {}) {
    super();
    this._labels = {
      vault:  'knowledge base',
      web:    'web',
      direct: 'reasoning',
      ...(options.labels ?? {}),
    };
    this._verbose = options.verbose ?? false;
  }

  async onRouting(sources, runtime) {
    const writer = runtime?.writer;
    if (!writer || !sources?.length) return;

    const parts  = sources.map(s => this._labels[s.source] ?? s.source);
    const unique = [...new Set(parts)]; // dedup if multiple same-source entries
    const msg    = `Routing: ${unique.join(' + ')}`;

    writer(msg);

    if (this._verbose) log.info(`[middleware:routing] ${msg}`);
  }
}
