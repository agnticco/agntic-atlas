/**
 * LlamaCppLLM - node-llama-cpp wrapper as a Runnable
 *
 * @module llm/llama-cpp-llm
 */

import { Runnable } from '../core/runnable.js';
import { AIMessage, HumanMessage } from '../core/message.js';
/**
 * `node-llama-cpp` is an OPTIONAL dependency and is loaded on demand.
 *
 * It is a native module: installing it means a compiler toolchain and a ~34MB
 * download, and it is the single most likely step to fail on someone's first
 * `npm install`. It is also needed by almost nobody — running Atlas against
 * Anthropic or OpenAI never touches it, and that is the setup nearly everyone uses.
 * A STATIC import here meant server.js could not even start without it, so the
 * common case paid the whole cost of the rare one.
 *
 * Loading it lazily follows the pattern `src/rag/embedding-model.js` already uses
 * for the same package. The failure is caught and re-thrown in words that name the
 * choice a person actually has, because "Cannot find module 'node-llama-cpp'" tells
 * someone who never asked for a local model nothing about what to do.
 */
let _llamaCpp = null;
async function loadLlamaCpp() {
  if (_llamaCpp) return _llamaCpp;
  try {
    _llamaCpp = await import('node-llama-cpp');
  } catch {
    throw new Error(
      'Running a local model needs the optional package `node-llama-cpp`, which is not installed. '
      + 'Either install it with `npm install node-llama-cpp` (it needs a build toolchain), '
      + 'or — much simpler — use a hosted model by setting ANTHROPIC_API_KEY or OPENAI_API_KEY '
      + 'in your .env file and restarting Atlas.',
    );
  }
  return _llamaCpp;
}
import { log } from '../utils/logger.js';

/**
 * LlamaCppLLM - A Runnable wrapper for node-llama-cpp
 *
 * Wraps your LLM calls from agent fundamentals into a reusable,
 * composable Runnable component.
 *
 * Key benefits over raw node-llama-cpp:
 * - Composable with other Runnables via .pipe()
 * - Supports batch processing multiple inputs
 * - Built-in streaming support
 * - Consistent interface across all LLMs
 * - Easy to swap with other LLM providers
 */
export class LlamaCppLLM extends Runnable {
  /**
   * Create a new LlamaCppLLM instance
   *
   * @param {Object} options - Configuration options
   * @param {string} options.modelPath - Path to your GGUF model file (REQUIRED)
   * @param {number} [options.temperature=0.7] - Sampling temperature (0-1)
   *   - Lower (0.1): More focused, deterministic
   *   - Higher (0.9): More creative, random
   * @param {number} [options.topP=0.9] - Nucleus sampling threshold
   * @param {number} [options.topK=40] - Top-K sampling parameter
   * @param {number} [options.maxTokens=2048] - Maximum tokens to generate
   * @param {number} [options.repeatPenalty=1.1] - Penalty for repeating tokens
   * @param {number} [options.contextSize=4096] - Context window size
   * @param {number} [options.batchSize=512] - Batch processing size
   * @param {boolean} [options.verbose=false] - Enable debug logging
   * @param {string[]} [options.stopStrings] - Strings that stop generation
   * @param {Object} [options.chatWrapper] - Custom chat wrapper instance (e.g., QwenChatWrapper)
   *   - If not provided, the library will automatically select the best wrapper for your model
   *
   * @example Basic Setup
   * ```javascript
   * const llm = new LlamaCppLLM({
   *   modelPath: './models/Meta-Llama-3.1-8B-Instruct-Q5_K_S.gguf',
   *   temperature: 0.7
   * });
   * ```
   *
   * @example With Qwen Chat Wrapper (Discourage Thoughts)
   * ```javascript
   * import { QwenChatWrapper } from 'node-llama-cpp';
   *
   * const llm = new LlamaCppLLM({
   *   modelPath: './models/Qwen3-1.7B-Q6_K.gguf',
   *   temperature: 0.7,
   *   chatWrapper: new QwenChatWrapper({
   *     thoughts: 'discourage'
   *   })
   * });
   * ```
   *
   * @example Different Configurations for Different Tasks
   * ```javascript
   * // Creative writing (higher temperature)
   * const creative = new LlamaCppLLM({
   *   modelPath: './model.gguf',
   *   temperature: 0.9,
   *   maxTokens: 1000
   * });
   *
   * // Factual responses (lower temperature)
   * const factual = new LlamaCppLLM({
   *   modelPath: './model.gguf',
   *   temperature: 0.1,
   *   maxTokens: 500
   * });
   * ```
   */
  constructor(options = {}) {
    super();

    // Validate required options
    this.modelPath = options.modelPath;
    if (!this.modelPath) {
      throw new Error(
          'modelPath is required. Example: new LlamaCppLLM({ modelPath: "./model.gguf" })'
      );
    }
    this.modelName = this.modelPath.split('/').pop().replace('.gguf', '');

    // Generation parameters
    // These control how the LLM generates text - same as in your fundamentals!
    this.temperature = options.temperature ?? 0.7;
    this.topP = options.topP ?? 0.9;
    this.topK = options.topK ?? 40;
    this.maxTokens = options.maxTokens ?? 2048;
    this.repeatPenalty = options.repeatPenalty ?? 1.1;

    // Context configuration
    this.contextSize = options.contextSize ?? 4096;
    this.batchSize = options.batchSize ?? 512;
    this.flashAttention = options.flashAttention ?? true;

    // Behavior
    this.verbose = options.verbose ?? false;

    // Chat wrapper configuration
    // If not provided, LlamaChatSession will auto-select the best wrapper
    this.chatWrapper = options.chatWrapper ?? 'auto';

    // Stop strings - when the model sees these, it stops generating
    // Default includes common chat separators
    this.stopStrings = options.stopStrings ?? [
      'Human:',
      'User:',
      '\n\nHuman:',
      '\n\nUser:'
    ];

    // Internal state (lazy initialized)
    this._llama = null;
    this._model = null;
    this._context = null;
    this._chatSession = null;
    this._initialized = false;
    this._lock = Promise.resolve();  // serializes access to _chatSession
  }

  /**
   * Initialize model (lazy loading)
   *
   * This loads the model only when first needed, not at construction.
   * This pattern is useful because model loading is slow - we only
   * want to do it once and only when we actually need it.
   *
   * @private
   * @throws {Error} If model loading fails
   */
  async _initialize() {
    // Skip if already initialized
    if (this._initialized) return;

    const modelName = this.modelPath.split('/').pop();
    const loadStart = Date.now();
    log.info(`[llm] Loading ${modelName}...`);

    try {
      const { getLlama, LlamaChatSession } = await loadLlamaCpp();
      this._llama = await getLlama({ logLevel: 'error' });

      this._model = await this._llama.loadModel({
        modelPath: this.modelPath
      });

      this._context = await this._model.createContext({
        contextSize: this.contextSize,
        batchSize: this.batchSize,
        flashAttention: this.flashAttention,
      });

      const contextSequence = this._context.getSequence();
      const sessionConfig = { contextSequence };

      if (this.chatWrapper !== 'auto') {
        sessionConfig.chatWrapper = this.chatWrapper;
      }

      this._chatSession = new LlamaChatSession(sessionConfig);
      this._initialized = true;

      const elapsed = ((Date.now() - loadStart) / 1000).toFixed(1);
      log.info(`[llm] ${modelName} loaded in ${elapsed}s | ctx=${this.contextSize} | ${this.chatWrapper !== 'auto' ? this.chatWrapper.constructor.name : 'auto wrapper'}`);
    } catch (error) {
      throw new Error(
          `Failed to initialize model at ${this.modelPath}: ${error.message}`
      );
    }
  }

  /**
   * Convert our Message objects to node-llama-cpp chat history format
   *
   * This bridges between our standardized Message types and what
   * node-llama-cpp expects. Think of it as a translator.
   *
   * @private
   * @param {Array<Message>} messages - Array of Message objects
   * @returns {Array<Object>} Chat history in llama.cpp format
   *
   * @example
   * ```javascript
   * // Input: Our messages
   * [
   *   new SystemMessage("You are helpful"),
   *   new HumanMessage("Hi"),
   *   new AIMessage("Hello!")
   * ]
   *
   * // Output: llama.cpp format
   * [
   *   { type: 'system', text: 'You are helpful' },
   *   { type: 'user', text: 'Hi' },
   *   { type: 'model', response: 'Hello!' }
   * ]
   * ```
   */
  _messagesToChatHistory(messages) {
    return messages.map(msg => {
      // System messages: instructions for the AI
      if (msg._type === 'system') {
        return { type: 'system', text: msg.content };
      }
      // Human messages: user input
      else if (msg._type === 'human') {
        return { type: 'user', text: msg.content };
      }
      // AI messages: previous AI responses
      else if (msg._type === 'ai') {
        return { type: 'model', response: [msg.content] };
      }
      // Tool messages: results from tool execution
      else if (msg._type === 'tool') {
        // Convert tool results to system messages
        return { type: 'system', text: `Tool Result: ${msg.content}` };
      }

      // Fallback: treat unknown types as user messages
      return { type: 'user', text: msg.content };
    });
  }

  /**
   * Build node-llama-cpp function definitions from a ToolRegistry.
   * Each handler: optionally awaits approval, then executes the tool.
   *
   * @private
   * @param {import('../tools/tool-registry.js').ToolRegistry} toolRegistry
   * @param {Function|null} onApprovalRequired - supervised mode callback
   * @param {string} sessionId
   * @returns {Object} functions map for promptWithMeta / prompt
   */
  _buildFunctions(toolRegistry, onApprovalRequired, sessionId) {
    // Safe to read the cached module synchronously: every caller sits behind an
    // `await this._initialize()`, which is what loaded it.
    const { defineChatSessionFunction } = _llamaCpp ?? {};
    if (!defineChatSessionFunction) throw new Error('local model not initialized — call _initialize() first');
    const functions = {};
    for (const tool of toolRegistry.list()) {
      const name = tool.toolName;
      functions[name] = defineChatSessionFunction({
        description: tool.description,
        params:      tool.inputSchema || {},
        handler: async (args) => {
          if (this.verbose) log.info(`[LlamaCppLLM] tool call: ${name} ${JSON.stringify(args)}`);

          // Supervised mode — ask for approval before executing
          if (onApprovalRequired) {
            const displayName = name
              .replace(/_/g, ' ')
              .replace(/\b\w/g, c => c.toUpperCase());
            const approval = await onApprovalRequired({
              tool: { name, displayName, args },
              reasoning: '',
              sessionId,
            });
            if (!approval.approved) {
              return approval.userContext
                ? `Tool denied. User note: "${approval.userContext}"`
                : 'Tool call denied by user.';
            }
          }

          const result = await toolRegistry.execute(name, args);
          if (result.error) return `Error: ${result.error}`;

          let output;

          // web_search: capture sources for card rendering and return a URL-free summary
          // so the model doesn't paste raw URLs into its response text.
          if (name === 'web_search' && result.output?.results?.length) {
            this._lastWebSources = (this._lastWebSources || []).concat(result.output.results);
            const lines = result.output.results.map((r, i) =>
              `[${i + 1}] ${r.title}\n${r.snippet}${r.content ? '\n' + r.content.slice(0, 2000) : ''}`
            );
            output = `Search results for "${result.output.query}":\n\n` +
              lines.join('\n\n') +
              '\n\nUse these results to answer the question. Extract specific facts, numbers, and names directly from the content above. Do not include raw URLs.';
          } else {
            output = typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output);
          }

          // ── Inline grading for local inference ─────────────────────────
          // node-llama-cpp executes tools inline during generation, so the
          // graph-level check_tools grader never fires. Grade here and retry
          // if results are insufficient.
          const graderQuery = this._currentQuery ?? args?.query ?? '';
          if (graderQuery && (name === 'vault_search' || name === 'web_search')) {
            try {
              const { gradeRAG, gradeWebSearch } = await import('../agents/grader.js');
              const grade = name === 'vault_search'
                ? gradeRAG(graderQuery, output)
                : gradeWebSearch(graderQuery, output);

              log.info(`[LlamaCppLLM] grade_${name === 'vault_search' ? 'rag' : 'web'}: ${grade.reason} (query="${graderQuery.slice(0, 50)}")`);

              if (!grade.pass && grade.refinedQuery) {
                log.info(`[LlamaCppLLM] grade retry: ${name} → "${grade.refinedQuery}"`);
                const retry = await toolRegistry.execute(name, {
                  ...args,
                  query: grade.refinedQuery,
                });
                const retryOutput = name === 'web_search' && retry.output?.results?.length
                  ? retry.output.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}${r.content ? '\n' + r.content.slice(0, 2000) : ''}`).join('\n\n')
                  : (typeof retry.output === 'string' ? retry.output : JSON.stringify(retry.output));

                if (retryOutput.length > output.length) {
                  output = output + '\n\n[Refined search results]:\n' + retryOutput;
                }
              }
            } catch { /* grader import or execution failed — non-fatal */ }
          }

          return output;
        },
      });
    }
    return functions;
  }

  /**
   * Clean up model response
   *
   * Sometimes models include extra prefixes or suffixes.
   * This cleans them up for a better user experience.
   *
   * @private
   * @param {string} response - Raw model response
   * @returns {string} Cleaned response
   *
   * @example
   * ```javascript
   * // Before: "Assistant: The answer is 42\n\nHuman: "
   * // After:  "The answer is 42"
   * ```
   */
  _cleanResponse(response) {
    let cleaned = response.trim();

    // Remove "Assistant:" or "AI:" prefixes
    cleaned = cleaned.replace(/^(Assistant|AI):\s*/i, '');

    // Remove any conversation continuations
    cleaned = cleaned.replace(/\n\n(Human|User):.*$/s, '');

    return cleaned.trim();
  }

  /**
   * Main generation method - this is where your LLM calls happen!
   *
   * This is the same as calling `llm.chat(messages)` in your fundamentals,
   * but wrapped to work with the Runnable interface.
   *
   * @async
   * @param {string|Array<Message>} input - User input or message array
   * @param {Object} [config={}] - Runtime configuration
   * @param {number} [config.temperature] - Override temperature for this call
   * @param {number} [config.maxTokens] - Override max tokens for this call
   * @param {boolean} [config.clearHistory=false] - Clear chat history before this call
   * @returns {Promise<AIMessage>} Generated response as AIMessage
   *
   * @example String Input (Simplest)
   * ```javascript
   * const response = await llm.invoke("What is AI?");
   * console.log(response.content); // "AI is..."
   * ```
   *
   * @example Message Array Input (Full Control)
   * ```javascript
   * const messages = [
   *   new SystemMessage("You are a helpful assistant"),
   *   new HumanMessage("What is AI?")
   * ];
   * const response = await llm.invoke(messages);
   * ```
   *
   * @example Runtime Configuration
   * ```javascript
   * // Override temperature for this specific call
   * const response = await llm.invoke(
   *   "Write a creative story",
   *   { temperature: 0.9, maxTokens: 500 }
   * );
   * ```
   *
   * @example Clear History Before Call
   * ```javascript
   * // Ensure fresh context with no prior conversation
   * const response = await llm.invoke(
   *   "What is AI?",
   *   { clearHistory: true }
   * );
   * ```
   *
   * @example In a Pipeline (Composition)
   * ```javascript
   * const pipeline = promptFormatter
   *   .pipe(llm)
   *   .pipe(outputParser);
   *
   * const result = await pipeline.invoke("user input");
   * ```
   */
  async _call(input, config = {}) {
    // Serialize access — only one generation at a time (LlamaChatSession is not concurrent-safe)
    let releaseLock;
    this._lock = this._lock
      .catch(() => {})  // don't let a prior abort reject the chain
      .then(() => new Promise(r => { releaseLock = r; }));

    try {
      return await this._callInner(input, config);
    } finally {
      releaseLock();
    }
  }

  async _callInner(input, config = {}) {
    // Ensure model is loaded (only happens once)
    await this._initialize();

    // Clear history if requested (important for batch processing)
    if (config.clearHistory) {
      this._chatSession.setChatHistory([]);
    }

    // Handle different input types
    let messages;
    if (typeof input === 'string') {
      messages = [new HumanMessage(input)];
    } else if (Array.isArray(input)) {
      messages = input;
    } else {
      throw new Error(
          'Input must be a string or array of messages. ' +
          'Example: "Hello" or [new HumanMessage("Hello")]'
      );
    }

    // Extract system message if present
    const systemMessages = messages.filter(msg => msg._type === 'system');
    const systemPrompt = systemMessages.length > 0
        ? systemMessages[0].content
        : '';

    // Convert our Message objects to llama.cpp format and set history.
    // setChatHistory resets the KV cache evaluation state, so every call
    // reprocesses the full prompt. This is unavoidable with node-llama-cpp's
    // current API — the session doesn't support incremental appends.
    const chatHistory = this._messagesToChatHistory(messages);
    this._chatSession.setChatHistory(chatHistory);
    this._chatSession.systemPrompt = systemPrompt;

    try {
      // Build prompt options
      const promptOptions = {
        temperature: config.temperature ?? this.temperature,
        topP: config.topP ?? this.topP,
        topK: config.topK ?? this.topK,
        maxTokens: config.maxTokens ?? this.maxTokens,
        repeatPenalty: config.repeatPenalty ?? this.repeatPenalty,
        customStopTriggers: config.stopStrings ?? this.stopStrings
      };

      // Add random seed if temperature > 0 and no seed specified
      // This ensures randomness works properly
      if (promptOptions.temperature > 0 && config.seed === undefined) {
        promptOptions.seed = Math.floor(Math.random() * 1000000);
      } else if (config.seed !== undefined) {
        promptOptions.seed = config.seed;
      }

      // Tool calling — convert ToolRegistry to node-llama-cpp function definitions
      if (config.tools && !config.tools.isEmpty) {
        promptOptions.functions = this._buildFunctions(
          config.tools,
          config.onApprovalRequired ?? null,
          config.sessionId ?? 'local'
        );
      }

      // Thread abort signal so generation stops when the client disconnects
      if (config.signal) {
        promptOptions.signal = config.signal;
        promptOptions.stopOnAbortSignal = true;
      }

      // Stream tokens to server console AND to the onToken callback (for SSE streaming)
      const _onToken = config.onToken ?? null;
      let _inThink = false, _streamStarted = false;
      promptOptions.onTextChunk = (chunk) => {
        if (!_streamStarted) { process.stdout.write(`\x1b[90m[gen:${this.modelName}] \x1b[0m`); _streamStarted = true; }
        if (chunk.includes('<think>'))  { _inThink = true;  process.stdout.write('\x1b[33m⟨think⟩ '); }
        if (_inThink) {
          process.stdout.write(chunk.replace(/<\/?think>/g, ''));
        } else {
          process.stdout.write(chunk);
          if (_onToken) _onToken(chunk);  // push to SSE stream
        }
        if (chunk.includes('</think>')) { _inThink = false; process.stdout.write(' \x1b[33m⟨/think⟩\x1b[0m\n\x1b[90m[gen] \x1b[0m'); }
      };

      // Generate response with external timing (node-llama-cpp doesn't expose metadata)
      const genStart = Date.now();
      const result   = await this._chatSession.promptWithMeta('', promptOptions);
      process.stdout.write('\n'); // newline after streamed output
      const duration = Date.now() - genStart;

      // responseText is the full string; response is an array of chunks
      let responseText = result.responseText ?? (Array.isArray(result.response) ? result.response.join('') : result.response ?? '');

      // Extract and log thinking blocks — keep them out of the response text
      const thinkMatch = responseText.match(/<think>([\s\S]*?)<\/think>/);
      if (thinkMatch) {
        const thinking = thinkMatch[1].trim();
        if (thinking) {
          log.info(`[LlamaCppLLM] thinking: ${thinking.slice(0, 200)}${thinking.length > 200 ? '…' : ''}`);
        }
        responseText = responseText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }

      // Clear accumulated web sources — AgentGraph handles source emission
      // via finalState.web_sources, not via LLM response text.
      this._lastWebSources = null;

      // Token counts via model tokenizer (synchronous)
      const inputTokens  = this._model.tokenize(messages.map(m => m.content).join(' ')).length;
      const outputTokens = this._model.tokenize(responseText).length;
      const tokensPerSec = duration > 0 ? Math.round((outputTokens / duration) * 1000) : 0;

      log.info(
        `[llm:${this.modelName}] ${outputTokens} tokens in ${duration}ms` +
        ` (${tokensPerSec} tok/s) | prompt: ${inputTokens} tokens`
      );

      // Fire metrics through callback system if available
      if (config.callbacks) {
        for (const cb of config.callbacks) {
          if (typeof cb.onLLMEnd === 'function') {
            await cb.onLLMEnd({ duration, inputTokens, outputTokens, tokensPerSec });
          }
        }
      }

      // Return AIMessage — duration and outputTokens available to API layer via additionalKwargs
      return new AIMessage(responseText, { duration, inputTokens, outputTokens, tokensPerSec, usage: { input: inputTokens, output: outputTokens } });
    } catch (error) {
      throw new Error(`Generation failed: ${error.message}`);
    }
  }

  /**
   * Batch processing with history isolation
   *
   * Processes multiple inputs sequentially, ensuring each gets a clean chat history.
   * Note: Local models process requests sequentially, so there's no performance
   * benefit compared to calling invoke() multiple times.
   *
   * @async
   * @param {Array<string|Array<Message>>} inputs - Array of inputs to process
   * @param {Object} [config={}] - Runtime configuration
   * @returns {Promise<Array<AIMessage>>} Array of generated responses
   *
   * @example
   * ```javascript
   * const questions = ["What is AI?", "What is ML?", "What is DL?"];
   * const answers = await llm.batch(questions);
   * ```
   */
  async batch(inputs, config = {}) {
    const results = [];
    for (const input of inputs) {
      // Clear history before each batch item to prevent contamination
      const result = await this._call(input, { ...config, clearHistory: true });
      results.push(result);
    }
    return results;
  }

  /**
   * Streaming generation - show results as they're generated!
   *
   * This is the same as _call() but yields chunks as they arrive,
   * like the typing effect you see in ChatGPT.
   *
   * @async
   * @generator
   * @param {string|Array<Message>} input - User input or message array
   * @param {Object} [config={}] - Runtime configuration
   * @yields {AIMessage} Chunks of generated text
   *
   * @example Basic Streaming
   * ```javascript
   * console.log("Response: ");
   * for await (const chunk of llm.stream("Tell me a story")) {
   *   process.stdout.write(chunk.content); // Print without newline
   * }
   * console.log("\nDone!");
   * ```
   *
   * @example Streaming in a Pipeline
   * ```javascript
   * const pipeline = promptFormatter
   *   .pipe(llm)
   *   .pipe(parser);
   *
   * // Only the last step (parser) gets streamed chunks
   * for await (const chunk of pipeline.stream(input)) {
   *   console.log(chunk);
   * }
   * ```
   *
   * @example Building a Chat UI
   * ```javascript
   * async function streamToUI(input) {
   *   let fullResponse = '';
   *
   *   for await (const chunk of llm.stream(input)) {
   *     fullResponse += chunk.content;
   *     updateUI(fullResponse); // Update your UI in real-time
   *   }
   * }
   * ```
   */
  async* stream(input, config = {}) {
    await this._initialize();

    // Clear history if requested
    if (config.clearHistory) {
      this._chatSession.setChatHistory([]);
    }

    // Handle different input types (same as _call)
    let messages;
    if (typeof input === 'string') {
      messages = [new HumanMessage(input)];
    } else if (Array.isArray(input)) {
      messages = input;
    } else {
      throw new Error(
          'Input must be a string or array of messages for streaming'
      );
    }

    // Extract system message if present
    const systemMessages = messages.filter(msg => msg._type === 'system');
    const systemPrompt = systemMessages.length > 0
        ? systemMessages[0].content
        : '';

    // Set up chat history
    const chatHistory = this._messagesToChatHistory(messages);
    this._chatSession.setChatHistory(chatHistory);

    // ALWAYS set system prompt (either new value or empty string to clear)
    this._chatSession.systemPrompt = systemPrompt;

    try {
      // Build prompt options
      const promptOptions = {
        temperature: config.temperature ?? this.temperature,
        topP: config.topP ?? this.topP,
        topK: config.topK ?? this.topK,
        maxTokens: config.maxTokens ?? this.maxTokens,
        repeatPenalty: config.repeatPenalty ?? this.repeatPenalty,
        customStopTriggers: config.stopStrings ?? this.stopStrings
      };

      // Add random seed if temperature > 0 and no seed specified
      if (promptOptions.temperature > 0 && config.seed === undefined) {
        promptOptions.seed = Math.floor(Math.random() * 1000000);
      } else if (config.seed !== undefined) {
        promptOptions.seed = config.seed;
      }

      // Tool calling — same as _call(), handlers run between streamed chunks
      if (config.tools && !config.tools.isEmpty) {
        this._lastWebSources = null; // reset before generation
        promptOptions.functions = this._buildFunctions(
          config.tools,
          config.onApprovalRequired ?? null,
          config.sessionId ?? 'local'
        );
      }

      // Use onTextChunk callback to stream chunks as they arrive
      const self = this;
      promptOptions.onTextChunk = (chunk) => {
        // This callback is synchronous, so we can't yield directly
        // We'll collect chunks and yield them after
        self._currentStreamChunks = self._currentStreamChunks || [];
        self._currentStreamChunks.push(chunk);
      };

      // Initialize chunk collection
      this._currentStreamChunks = [];

      // Start generation (this will call onTextChunk as it generates)
      const responsePromise = this._chatSession.prompt('', promptOptions);

      // Yield chunks as they become available
      let lastYieldedIndex = 0;

      // Poll for new chunks
      while (true) {
        // Yield any new chunks
        while (lastYieldedIndex < this._currentStreamChunks.length) {
          yield new AIMessage(this._currentStreamChunks[lastYieldedIndex], {
            additionalKwargs: { chunk: true }
          });
          lastYieldedIndex++;
        }

        // Check if generation is complete
        const isDone = await Promise.race([
          responsePromise.then(() => true),
          new Promise(resolve => setTimeout(() => resolve(false), 10))
        ]);

        if (isDone) {
          // Yield any remaining chunks
          while (lastYieldedIndex < this._currentStreamChunks.length) {
            yield new AIMessage(this._currentStreamChunks[lastYieldedIndex], {
              additionalKwargs: { chunk: true }
            });
            lastYieldedIndex++;
          }
          break;
        }
      }

      // Wait for the full response
      await responsePromise;

      // Clear accumulated web sources — AgentGraph handles source emission
      this._lastWebSources = null;

      // Clean up
      delete this._currentStreamChunks;

    } catch (error) {
      throw new Error(`Streaming failed: ${error.message}`);
    }
  }

  /**
   * Cleanup resources
   *
   * LLMs hold resources in memory. Call this when you're done
   * to free them up properly.
   *
   * @async
   * @returns {Promise<void>}
   *
   * @example
   * ```javascript
   * const llm = new LlamaCppLLM({ modelPath: './model.gguf' });
   *
   * try {
   *   const response = await llm.invoke("Hello");
   *   console.log(response.content);
   * } finally {
   *   await llm.dispose(); // Always clean up!
   * }
   * ```
   *
   * @example With Multiple Uses
   * ```javascript
   * const llm = new LlamaCppLLM({ modelPath: './model.gguf' });
   *
   * // Use it many times
   * await llm.invoke("Question 1");
   * await llm.invoke("Question 2");
   * await llm.batch(["Q3", "Q4", "Q5"]);
   *
   * // Clean up when completely done
   * await llm.dispose();
   * ```
   */
  async dispose() {
    if (this._context) {
      await this._context.dispose();
      this._context = null;
    }
    if (this._model) {
      await this._model.dispose();
      this._model = null;
    }
    this._chatSession = null;
    this._initialized = false;

    if (this.verbose) {
      log.info('Model resources disposed');
    }
  }

  /**
   * String representation for debugging
   *
   * @returns {string} Human-readable representation
   *
   * @example
   * ```javascript
   * const llm = new LlamaCppLLM({ modelPath: './llama-2-7b.gguf' });
   * console.log(llm.toString());
   * // "LlamaCppLLM(model=./llama-2-7b.gguf)"
   *
   * // Useful in pipelines
   * const pipeline = formatter.pipe(llm).pipe(parser);
   * console.log(pipeline.toString());
   * // "PromptFormatter() | LlamaCppLLM(model=./llama-2-7b.gguf) | OutputParser()"
   * ```
   */
  toString() {
    return `LlamaCppLLM(model=${this.modelPath})`;
  }
}

export default LlamaCppLLM;