/**
 * ChatModel - Remote API LLM wrapper (OpenAI / Anthropic)
 *
 * Same Runnable interface as LlamaCppLLM — swap providers by changing config,
 * not architecture.
 *
 * @module src/llm/chat-model.js
 */

import { Runnable } from '../core/runnable.js';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '../core/message.js';
import { log } from '../utils/logger.js';
import { numEnv } from '../utils/env.js';

/**
 * Cap on `pause_turn` continuations within a single ChatModel call. Anthropic
 * server-side tools (e.g. web_search_20260209) can pause mid-turn; we resume by
 * appending the partial assistant content and re-issuing. The cap prevents
 * runaway loops if the model keeps stalling.
 */
const MAX_PAUSE_CONTINUATIONS = 3;

/**
 * Anthropic prompt caching on the system prompt. On by default; set
 * PROMPT_CACHE=0 to disable at boot without a code change (the escape hatch if
 * caching is ever suspected in an incident).
 *
 * Caching does not change the prompt the model receives — identical bytes are
 * sent either way — so it cannot alter output quality. It only changes how the
 * prefix is billed.
 */
const ENABLE_PROMPT_CACHE = process.env.PROMPT_CACHE !== '0';

export class ChatModel extends Runnable {
  /**
   * @param {Object} options
   * @param {string} options.provider        - 'openai' | 'anthropic' (REQUIRED)
   * @param {string} options.model           - Model ID, e.g. 'claude-sonnet-4-6' (REQUIRED)
   * @param {string} options.apiKey          - API key (REQUIRED)
   * @param {number} [options.temperature]   - 0–1, default 0.7
   * @param {number} [options.maxTokens]     - Max output tokens, default 8192
   * @param {boolean} [options.verbose]      - Log requests, default false
   */
  constructor(options = {}) {
    super();

    if (!options.provider) {
      throw new Error('provider is required: "openai" or "anthropic"');
    }
    if (!options.model) {
      throw new Error('model is required, e.g. "claude-sonnet-4-6" or "gpt-4o"');
    }
    if (!options.apiKey) {
      throw new Error('apiKey is required');
    }

    this.provider    = options.provider;
    this.model       = options.model;
    this.apiKey      = options.apiKey;
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens   = options.maxTokens   ?? 8192;
    this.verbose     = options.verbose     ?? false;
    // Resilience: both SDKs retry transient failures (408/409/429/5xx + connection
    // errors) with exponential backoff and honor Retry-After. Defaults are only 2;
    // bump to 4 for sustained 429/529 (overloaded) during provider incidents. A
    // per-request timeout aborts a hung connection so the SDK's own retry can fire.
    // Env-overridable so ops can tune without a code change.
    this.maxRetries       = options.maxRetries       ?? numEnv('LLM_MAX_RETRIES', 4);
    this.requestTimeoutMs = options.requestTimeoutMs ?? numEnv('LLM_TIMEOUT_MS', 120000);

    this._client = null;
  }

  // ── Client init (lazy) ──────────────────────────────────────────────────────

  async _getClient() {
    if (this._client) return this._client;

    if (this.provider === 'anthropic') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this._client = new Anthropic({ apiKey: this.apiKey, maxRetries: this.maxRetries, timeout: this.requestTimeoutMs });
    } else if (this.provider === 'openai') {
      const { default: OpenAI } = await import('openai');
      this._client = new OpenAI({ apiKey: this.apiKey, maxRetries: this.maxRetries, timeout: this.requestTimeoutMs });
    } else {
      throw new Error(`Unknown provider: ${this.provider}. Use "openai" or "anthropic".`);
    }

    return this._client;
  }

  // ── Input normalisation ─────────────────────────────────────────────────────

  /**
   * Coerce a single message-like value into a BaseMessage instance.
   *
   * Accepts:
   *  - BaseMessage instances (returned as-is)
   *  - Plain objects with `{role, content}` — `system` | `user` | `human` |
   *    `assistant` | `ai` | `tool` are recognized.
   *
   * Returns null when the value can't be coerced — caller filters those out.
   *
   * Why this exists: callers that build prompts with plain `{role, content}`
   * arrays (a common pattern when porting from the OpenAI SDK) used to be
   * silently dropped by the type-aware filters below, producing 400 errors
   * with "messages: at least one message is required". Auto-coercing here
   * fixes the entire bug class at the adapter boundary.
   */
  _toBaseMessage(m) {
    if (!m || typeof m !== 'object') return null;
    // Already a BaseMessage — has the type getter wired up.
    if (typeof m.type === 'string' && (m._type || m.constructor?.name?.endsWith('Message'))) {
      return m;
    }
    // Plain object — try to coerce by role.
    const role = m.role;
    if (typeof role !== 'string') return null;
    const content = m.content ?? '';
    switch (role) {
      case 'system':                return new SystemMessage(content);
      case 'user':
      case 'human':                 return new HumanMessage(content);
      case 'assistant':
      case 'ai':                    return new AIMessage(content);
      case 'tool':
      case 'tool_result':           return new ToolMessage(content, m.tool_call_id ?? m.toolCallId ?? null);
      default:                      return null;
    }
  }

  /**
   * Normalise input to a BaseMessage[] and extract the system prompt.
   * Tolerant to plain `{role, content}` objects — see `_toBaseMessage`.
   */
  _normaliseInput(input) {
    let raw;
    if (typeof input === 'string') {
      raw = [new HumanMessage(input)];
    } else if (Array.isArray(input)) {
      raw = input;
    } else {
      throw new Error('Input must be a string or BaseMessage[]');
    }

    const messages = raw.map(m => this._toBaseMessage(m)).filter(Boolean);
    if (messages.length === 0) {
      throw new Error('No valid messages after normalisation — input contained only unrecognised shapes');
    }

    const systemMsg = messages.find(m => m.type === 'system');
    const system    = systemMsg ? systemMsg.content : '';
    const rest      = messages.filter(m => m.type !== 'system');

    return { system, rest };
  }

  /**
   * Build the Anthropic messages array from a BaseMessage[] (no system messages).
   *
   * Handles:
   *   - HumanMessage   → {role:'user', content: string}
   *   - AIMessage      → {role:'assistant', content: string | content_block[]}
   *                      (preserves raw Anthropic content array when tool_use blocks present)
   *   - ToolMessage[]  → consecutive ToolMessages are batched into a single
   *                      {role:'user', content:[{type:'tool_result',...},...]}
   *                      (Anthropic requires all tool_results in one user turn)
   */
  _prepareAnthropicMessages(messages) {
    const result = [];
    let i = 0;

    while (i < messages.length) {
      const m = messages[i];

      if (m.type === 'tool') {
        // Batch all consecutive ToolMessages into one user turn
        const toolResults = [];
        while (i < messages.length && messages[i].type === 'tool') {
          const content = messages[i].content;
          toolResults.push({
            type:        'tool_result',
            tool_use_id: messages[i].toolCallId,
            content:     typeof content === 'string' ? content : JSON.stringify(content),
          });
          i++;
        }
        result.push({ role: 'user', content: toolResults });
        continue;
      }

      if (m.type === 'ai') {
        // If this AIMessage carries a raw Anthropic content array (from a previous
        // tool_use response), use it verbatim so tool_use blocks are preserved.
        const rawContent = m.additionalKwargs?._anthropicContent;
        result.push({
          role:    'assistant',
          content: rawContent ?? m.content,
        });
        i++;
        continue;
      }

      if (m.type === 'human') {
        result.push({ role: 'user', content: m.content });
        i++;
        continue;
      }

      // Unknown type — skip
      i++;
    }

    return result;
  }

  /**
   * Build the OpenAI messages array (including system) from BaseMessage[].
   *
   * Handles:
   *   - SystemMessage  → {role:'system', content}
   *   - HumanMessage   → {role:'user', content}
   *   - AIMessage      → {role:'assistant', content} or with tool_calls
   *   - ToolMessage    → {role:'tool', content, tool_call_id}
   */
  _prepareOpenAIMessages(messages) {
    const result = [];

    for (const m of messages) {
      if (m.type === 'system') {
        result.push({ role: 'system', content: m.content });
        continue;
      }
      if (m.type === 'human') {
        result.push({ role: 'user', content: m.content });
        continue;
      }
      if (m.type === 'ai') {
        if (m.hasToolCalls()) {
          result.push({
            role:       'assistant',
            content:    m.content || null,
            tool_calls: m.toolCalls.map(tc => ({
              id:       tc.id,
              type:     'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          });
        } else {
          result.push({ role: 'assistant', content: m.content });
        }
        continue;
      }
      if (m.type === 'tool') {
        const content = m.content;
        result.push({
          role:         'tool',
          content:      typeof content === 'string' ? content : JSON.stringify(content),
          tool_call_id: m.toolCallId,
        });
        continue;
      }
      // Unknown — treat as user
      result.push({ role: 'user', content: m.content });
    }

    return result;
  }

  // ── Core call ───────────────────────────────────────────────────────────────

  /**
   * @param {string|BaseMessage[]} input
   * @param {object} [config]
   * @param {ToolRegistry} [config.tools]  - ToolRegistry instance; enables tool calling
   * @returns {Promise<AIMessage>}
   */
  async _call(input, config = {}) {
    const client              = await this._getClient();
    const { system, rest }    = this._normaliseInput(input);
    const temperature         = config.temperature ?? this.temperature;
    const maxTokens           = config.maxTokens   ?? this.maxTokens;
    const toolRegistry        = config.tools ?? null;

    if (this.verbose) {
      log.info(`[ChatModel] ${this.provider}/${this.model} — ${rest.length} message(s)${toolRegistry ? ` + ${toolRegistry.size} tools` : ''}`);
    }

    if (this.provider === 'anthropic') {
      const baseParams = {
        model:      this.model,
        max_tokens: maxTokens,
        temperature,
      };
      // Prompt caching: the system prompt is a large, byte-stable prefix that is
      // re-sent on every call (the converger re-sends ~3.9k tokens of catalog on
      // each of its ~22 proposal turns). Marking it cacheable bills the prefix at
      // 0.1x on reads instead of 1x. The prompt bytes are unchanged — the model
      // sees exactly what it saw before, so output is unaffected.
      //
      // 1h TTL, not the 5m default: users pause to think between confirmations,
      // and a 5m window goes cold mid-build. The extra write cost (2x vs 1.25x)
      // is amortised to nothing across a build's many reads.
      //
      // Cache minimums are per-model (sonnet 2048 / haiku 4096 tokens). A prefix
      // below the minimum silently doesn't cache — it does not error.
      if (system) {
        baseParams.system = ENABLE_PROMPT_CACHE
          ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }]
          : system;
      }
      if (toolRegistry) {
        const tools = Array.isArray(toolRegistry)
          ? toolRegistry
          : (toolRegistry.isEmpty ? null : toolRegistry.toAnthropicSchemas());
        if (tools && tools.length > 0) baseParams.tools = tools;
      }
      if (config.tool_choice) baseParams.tool_choice = config.tool_choice;

      // pause_turn loop — server-side tools (e.g. web_search_20260209) may pause
      // mid-turn while Anthropic fetches/processes; we resume by appending the
      // partial assistant content (which carries encrypted_content) and re-issuing.
      const baseMessages = this._prepareAnthropicMessages(rest);
      const allContent   = [];
      let totalInput     = 0;
      let totalOutput    = 0;
      let totalWebSearch = 0;
      let totalWebFetch  = 0;
      let totalCacheWrite = 0;   // cache_creation_input_tokens (billed 1.25x / 2x @1h)
      let totalCacheRead  = 0;   // cache_read_input_tokens     (billed 0.1x)
      let pauseCount     = 0;
      let messages       = baseMessages;

      while (true) {
        const message = await client.messages.create({ ...baseParams, messages });

        if (message.usage) {
          // NOTE: with prompt caching on, `input_tokens` is the UNCACHED REMAINDER
          // only. The full prompt is input_tokens + cache_creation + cache_read.
          // Tracking the cache counts separately is not optional — without them the
          // cost log would silently under-report spend and we'd read a billing
          // artifact as a real saving.
          totalInput     += message.usage.input_tokens  ?? 0;
          totalOutput    += message.usage.output_tokens ?? 0;
          totalCacheWrite += message.usage.cache_creation_input_tokens ?? 0;
          totalCacheRead  += message.usage.cache_read_input_tokens     ?? 0;
          totalWebSearch += message.usage.server_tool_use?.web_search_requests ?? 0;
          totalWebFetch  += message.usage.server_tool_use?.web_fetch_requests  ?? 0;
        }
        if (Array.isArray(message.content)) allContent.push(...message.content);

        if (message.stop_reason === 'pause_turn' && pauseCount < MAX_PAUSE_CONTINUATIONS) {
          pauseCount++;
          messages = [...messages, { role: 'assistant', content: message.content }];
          if (this.verbose) log.info(`[ChatModel] pause_turn — continuing (${pauseCount}/${MAX_PAUSE_CONTINUATIONS})`);
          continue;
        }
        if (message.stop_reason === 'pause_turn') {
          log.warn(`[ChatModel] hit pause_turn cap (${MAX_PAUSE_CONTINUATIONS}); returning partial response`);
        }
        break;
      }

      this._totalInputTokens  = (this._totalInputTokens  ?? 0) + totalInput;
      this._totalOutputTokens = (this._totalOutputTokens ?? 0) + totalOutput;
      if (this.verbose) {
        log.info(`[ChatModel] tokens: in=${totalInput} out=${totalOutput} (session total: in=${this._totalInputTokens} out=${this._totalOutputTokens})`);
      }

      // Categorize content blocks across the full pause_turn round-trip.
      const toolUseBlocks    = allContent.filter(b => b.type === 'tool_use');
      const serverToolBlocks = allContent.filter(b =>
        b.type === 'web_search_tool_result' ||
        b.type === 'web_fetch_tool_result'  ||
        b.type === 'server_tool_use'
      );
      const textBlocks       = allContent.filter(b => b.type === 'text');
      const textContent      = textBlocks.map(b => b.text ?? '').join('');
      const citations        = textBlocks.flatMap(b => Array.isArray(b.citations) ? b.citations : []);

      const usage = { input: totalInput, output: totalOutput };
      if (totalWebSearch > 0) usage.web_search_requests = totalWebSearch;
      if (totalWebFetch  > 0) usage.web_fetch_requests  = totalWebFetch;
      if (totalCacheWrite > 0) usage.cache_write = totalCacheWrite;
      if (totalCacheRead  > 0) usage.cache_read  = totalCacheRead;
      const usageKwargs = (totalInput || totalOutput || totalCacheRead) ? { usage } : {};

      const hasMetadata = toolUseBlocks.length > 0 || serverToolBlocks.length > 0 || citations.length > 0;
      if (hasMetadata) {
        const additionalKwargs = {
          // Preserve the full Anthropic content array so it can be re-submitted
          // verbatim in the assistant turn (tool_use and server-side blocks must echo).
          _anthropicContent: allContent,
          ...usageKwargs,
        };
        if (toolUseBlocks.length > 0) {
          additionalKwargs.toolCalls = toolUseBlocks.map(b => ({ id: b.id, name: b.name, args: b.input }));
        }
        if (serverToolBlocks.length > 0) additionalKwargs._serverToolBlocks = serverToolBlocks;
        if (citations.length > 0)        additionalKwargs._citations        = citations;
        return new AIMessage(textContent, additionalKwargs);
      }

      return new AIMessage(textContent, usageKwargs);

    } else {
      // OpenAI
      const allMessages = this._prepareOpenAIMessages([
        ...(system ? [{ type: 'system', content: system }] : []),
        ...rest,
      ]);

      const params = {
        model:       this.model,
        messages:    allMessages,
        temperature,
        max_tokens:  maxTokens,
      };
      if (toolRegistry) {
        const tools = Array.isArray(toolRegistry)
          ? toolRegistry
          : (toolRegistry.isEmpty ? null : toolRegistry.toOpenAISchemas());
        if (tools && tools.length > 0) params.tools = tools;
      }
      if (config.tool_choice) params.tool_choice = config.tool_choice;

      const response = await client.chat.completions.create(params);
      const choice   = response.choices[0];

      const usageKwargs = response.usage
        ? { usage: { input: response.usage.prompt_tokens, output: response.usage.completion_tokens } }
        : {};

      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
        const toolCalls = choice.message.tool_calls.map(tc => {
          let args;
          try { args = JSON.parse(tc.function.arguments); }
          catch { args = { _raw: tc.function.arguments, _parseError: true }; }
          return { id: tc.id, name: tc.function.name, args };
        });
        return new AIMessage(choice.message.content ?? '', { toolCalls, ...usageKwargs });
      }

      return new AIMessage(choice.message.content, usageKwargs);
    }
  }

  // ── Streaming ───────────────────────────────────────────────────────────────

  /**
   * Stream tokens from the LLM.
   *
   * When tools are passed and the model responds with tool_use blocks (Anthropic)
   * or tool_calls (OpenAI), streaming is not possible for tool-calling turns.
   * In that case the generator yields a single AIMessage with toolCalls populated
   * (no streaming), allowing the caller to detect and execute tools.
   *
   * Text-only responses stream normally.
   *
   * @param {string|BaseMessage[]} input
   * @param {object} [config]
   * @param {ToolRegistry} [config.tools]
   */
  async* stream(input, config = {}) {
    const client           = await this._getClient();
    const { system, rest } = this._normaliseInput(input);
    const temperature      = config.temperature ?? this.temperature;
    const maxTokens        = config.maxTokens   ?? this.maxTokens;
    const toolRegistry     = config.tools ?? null;
    const isRawTools       = Array.isArray(toolRegistry);
    const hasTools         = toolRegistry && (isRawTools ? toolRegistry.length > 0 : !toolRegistry.isEmpty);

    if (this.provider === 'anthropic') {
      const baseParams = {
        model:      this.model,
        max_tokens: maxTokens,
        temperature,
      };
      if (system) baseParams.system = system;
      if (hasTools) baseParams.tools = isRawTools ? toolRegistry : toolRegistry.toAnthropicSchemas();
      if (config.tool_choice) baseParams.tool_choice = config.tool_choice;

      const safeParse = (s) => { try { return JSON.parse(s || '{}'); } catch { return { _raw: s, _parseError: true }; } };

      // Collect content blocks across the full pause_turn round-trip.
      const contentBlocks   = [];   // { type, id?, name?, text?, citations?, inputJson? }
      let   currentBlock    = null;
      let   totalInput      = 0;
      let   totalOutput     = 0;
      let   totalWebSearch  = 0;
      let   totalWebFetch   = 0;
      let   pauseCount      = 0;
      const baseMessages    = this._prepareAnthropicMessages(rest);
      const continuationTurns = [];

      while (true) {
        const messages = continuationTurns.length > 0
          ? [...baseMessages, ...continuationTurns]
          : baseMessages;
        const streamObj = client.messages.stream({ ...baseParams, messages });

        for await (const event of streamObj) {
          if (event.type === 'content_block_start') {
            // WS-2: only attach the synthetic `inputJson` accumulator to
            // tool_use blocks. server_tool_use blocks carry their full
            // input as a structured `input` field from the initial
            // content_block payload; web_*_tool_result blocks have no
            // input at all. Adding `inputJson: ''` to those produced the
            // "messages.N.content.M.server_tool_use.inputJson: Extra
            // inputs are not permitted" 400 when the assistant content
            // got re-submitted on the next turn (parallel-tool composition
            // path, WS-2 reproducer).
            currentBlock = { ...event.content_block };
            if (event.content_block.type === 'tool_use') currentBlock.inputJson = '';
            contentBlocks.push(currentBlock);
          }
          if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta' && currentBlock?.type === 'text') {
              currentBlock.text = (currentBlock.text ?? '') + event.delta.text;
              yield new AIMessage(event.delta.text);
            } else if (event.delta?.type === 'input_json_delta' && currentBlock?.type === 'tool_use') {
              currentBlock.inputJson += event.delta.partial_json;
            } else if (event.delta?.type === 'citations_delta' && currentBlock?.type === 'text') {
              // Native web_search citations attach to text blocks one-by-one.
              (currentBlock.citations ??= []).push(event.delta.citation);
            }
          }
        }

        let final;
        try { final = await streamObj.finalMessage(); } catch { /* may not be available */ }
        if (final?.usage) {
          totalInput     += final.usage.input_tokens  ?? 0;
          totalOutput    += final.usage.output_tokens ?? 0;
          totalWebSearch += final.usage.server_tool_use?.web_search_requests ?? 0;
          totalWebFetch  += final.usage.server_tool_use?.web_fetch_requests  ?? 0;
        }

        if (final?.stop_reason === 'pause_turn' && pauseCount < MAX_PAUSE_CONTINUATIONS) {
          pauseCount++;
          // Round-trip the partial assistant content (carrying encrypted_content)
          // so Anthropic can resume the search.
          continuationTurns.push({ role: 'assistant', content: final.content });
          if (this.verbose) log.info(`[ChatModel] pause_turn — continuing (${pauseCount}/${MAX_PAUSE_CONTINUATIONS})`);
          continue;
        }
        if (final?.stop_reason === 'pause_turn') {
          log.warn(`[ChatModel] hit pause_turn cap (${MAX_PAUSE_CONTINUATIONS}); ending stream`);
        }
        break;
      }

      this._totalInputTokens  = (this._totalInputTokens  ?? 0) + totalInput;
      this._totalOutputTokens = (this._totalOutputTokens ?? 0) + totalOutput;

      // After all rounds: classify blocks and build the final AIMessage with metadata.
      const toolUseBlocks    = contentBlocks.filter(b => b.type === 'tool_use');
      const serverToolBlocks = contentBlocks.filter(b =>
        b.type === 'web_search_tool_result' ||
        b.type === 'web_fetch_tool_result'  ||
        b.type === 'server_tool_use'
      );
      const textBlocks       = contentBlocks.filter(b => b.type === 'text');
      const textContent      = textBlocks.map(b => b.text ?? '').join('');
      const citations        = textBlocks.flatMap(b => Array.isArray(b.citations) ? b.citations : []);

      const hasMetadata = toolUseBlocks.length > 0 || serverToolBlocks.length > 0 || citations.length > 0;
      if (hasMetadata) {
        const toolCalls = toolUseBlocks.map(b => ({ id: b.id, name: b.name, args: safeParse(b.inputJson) }));

        // Rebuild the Anthropic content array for re-submission. Text/tool_use are
        // reconstructed; server-side blocks pass through verbatim (encrypted_content
        // and encrypted_index must round-trip unchanged).
        // WS-2 defense: also strip any `inputJson` field from server-side blocks
        // before re-submission. The streaming path no longer adds it to those
        // blocks (see content_block_start handler above), but if a future code
        // path attaches one, this strip keeps the API payload clean.
        const rawContent = contentBlocks.map(b => {
          if (b.type === 'text') {
            const block = { type: 'text', text: b.text ?? '' };
            if (Array.isArray(b.citations) && b.citations.length > 0) block.citations = b.citations;
            return block;
          }
          if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: safeParse(b.inputJson) };
          if (b.inputJson !== undefined) {
            const { inputJson, ...rest } = b;
            return rest;
          }
          return b;
        });

        const usage = { input: totalInput, output: totalOutput };
        if (totalWebSearch > 0) usage.web_search_requests = totalWebSearch;
        if (totalWebFetch  > 0) usage.web_fetch_requests  = totalWebFetch;
        const additionalKwargs = { _anthropicContent: rawContent, usage };
        if (toolCalls.length > 0)        additionalKwargs.toolCalls         = toolCalls;
        if (serverToolBlocks.length > 0) additionalKwargs._serverToolBlocks = serverToolBlocks;
        if (citations.length > 0)        additionalKwargs._citations        = citations;

        yield new AIMessage(textContent, additionalKwargs);
      }

    } else {
      // OpenAI — fall back to non-streaming when tools are present and response
      // indicates tool_calls (we don't know until the stream ends)
      const allMessages = this._prepareOpenAIMessages([
        ...(system ? [{ type: 'system', content: system }] : []),
        ...rest,
      ]);

      const params = {
        model:       this.model,
        messages:    allMessages,
        temperature,
        max_tokens:  maxTokens,
        stream:      true,
      };
      if (hasTools) params.tools = isRawTools ? toolRegistry : toolRegistry.toOpenAISchemas();
      if (config.tool_choice) params.tool_choice = config.tool_choice;

      const streamObj   = await client.chat.completions.create(params);
      let   textContent = '';
      const toolCallMap = {};   // index → accumulated tool_call

      for await (const chunk of streamObj) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          textContent += delta.content;
          yield new AIMessage(delta.content);
        }

        // Accumulate tool_calls deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallMap[tc.index]) {
              toolCallMap[tc.index] = { id: '', name: '', argsJson: '' };
            }
            const acc = toolCallMap[tc.index];
            if (tc.id)                   acc.id       += tc.id;
            if (tc.function?.name)       acc.name     += tc.function.name;
            if (tc.function?.arguments)  acc.argsJson += tc.function.arguments;
          }
        }
      }

      // After stream: emit final AIMessage with toolCalls if any
      const indices = Object.keys(toolCallMap);
      if (indices.length > 0) {
        const toolCalls = indices.map(idx => {
          const acc = toolCallMap[idx];
          let args;
          try { args = JSON.parse(acc.argsJson || '{}'); }
          catch { args = { _raw: acc.argsJson, _parseError: true }; }
          return { id: acc.id, name: acc.name, args };
        });
        yield new AIMessage(textContent, { toolCalls });
      }
    }
  }

  // ── Batch ───────────────────────────────────────────────────────────────────

  async batch(inputs, config = {}) {
    const results = [];
    for (const input of inputs) {
      results.push(await this._call(input, config));
    }
    return results;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async dispose() {
    this._client = null;
  }

  toString() {
    return `ChatModel(${this.provider}/${this.model})`;
  }
}

export default ChatModel;
