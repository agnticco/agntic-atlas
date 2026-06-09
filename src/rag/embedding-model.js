/**
 * EmbeddingModel — convert text to float vectors
 *
 * Supports three providers, selected via constructor option or EMBEDDING_PROVIDER env var:
 *
 *   'voyage'  — Voyage AI (Anthropic's recommended embedding partner)
 *               Best quality for use alongside Claude. No extra npm package —
 *               reuses the openai package with Voyage's OpenAI-compatible API.
 *               Requires VOYAGE_API_KEY. Sign up at voyageai.com.
 *               Models: voyage-3 (default) | voyage-3-large | voyage-3-lite
 *                       voyage-code-3 | voyage-finance-2 | voyage-law-2
 *
 *   'openai'  — OpenAI text-embedding-3-small (or any OpenAI embedding model)
 *               Uses the openai package already in dependencies.
 *               Requires OPENAI_API_KEY.
 *
 *   'local'   — Local GGUF embedding model via node-llama-cpp LlamaEmbeddingContext
 *               Uses node-llama-cpp already in dependencies.
 *               Requires EMBEDDING_MODEL_PATH pointing to a GGUF embedding model.
 *               (NOT the same as a chat model — needs a dedicated embedding GGUF)
 *
 * All providers return identical number[] output.
 * Retriever, VectorStore, and VectorMemory are unaware of which is active.
 *
 * @module src/rag/embedding-model.js
 */

import { Runnable } from '../core/runnable.js';
import { log } from '../utils/logger.js';

const VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';

export class EmbeddingModel extends Runnable {
  /**
   * @param {object} [options]
   * @param {string} [options.provider]      'voyage' | 'openai' | 'local'
   *                                         Default: EMBEDDING_PROVIDER env var or 'voyage'
   * @param {string} [options.model]         Model ID or local GGUF path
   * @param {string} [options.apiKey]        API key (remote providers)
   * @param {number} [options.batchSize=100] Max texts per API call (remote only)
   * @param {number} [options.dimensions]    Override output dimensions (OpenAI only)
   */
  constructor(options = {}) {
    super();
    this.provider   = options.provider  ?? process.env.EMBEDDING_PROVIDER ?? 'voyage';
    this.batchSize  = options.batchSize ?? 100;
    this.dimensions = options.dimensions ?? null;

    if (this.provider === 'voyage') {
      this.model  = options.model  ?? process.env.EMBEDDING_MODEL ?? 'voyage-3';
      this.apiKey = options.apiKey ?? process.env.VOYAGE_API_KEY;
      if (!this.apiKey) {
        throw new Error('EmbeddingModel (voyage): VOYAGE_API_KEY is required. Get one at voyageai.com');
      }
    } else if (this.provider === 'openai') {
      this.model  = options.model  ?? process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
      this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (!this.apiKey) {
        throw new Error('EmbeddingModel (openai): OPENAI_API_KEY is required');
      }
    } else if (this.provider === 'local') {
      this.modelPath = options.model ?? process.env.EMBEDDING_MODEL_PATH;
      if (!this.modelPath) {
        throw new Error('EmbeddingModel (local): model path is required (options.model or EMBEDDING_MODEL_PATH)');
      }
      // GPU backend for the local embedding context. Default 'auto' so the
      // shipped prebuilt (e.g. Metal on Apple Silicon) is used; set LLAMA_GPU=false
      // to force CPU (requires a CPU-only build). Hardcoding false broke portability
      // on Metal-only installs. (Atlas decision 2026-06-08 — see capability ledger.)
      this.gpu = options.gpu ?? (process.env.LLAMA_GPU === 'false' ? false : process.env.LLAMA_GPU ?? 'auto');
    } else {
      throw new Error(`EmbeddingModel: unknown provider "${this.provider}". Use 'voyage', 'openai', or 'local'`);
    }

    // Lazy-loaded clients
    this._remoteClient  = null;
    this._llamaContext  = null;
    this._llamaModel    = null;
    this._llamaInstance = null;
  }

  /**
   * Embed one or more texts.
   * @param {string|string[]} input
   * @returns {Promise<number[]|number[][]>}
   *   Single string → number[] (one vector)
   *   String array  → number[][] (one vector per input)
   */
  async _call(input) {
    const isSingle = typeof input === 'string';
    const texts    = isSingle ? [input] : input;

    let embeddings;
    if (this.provider === 'local') {
      embeddings = await this._embedLocal(texts);
    } else {
      embeddings = await this._embedRemote(texts);
    }

    return isSingle ? embeddings[0] : embeddings;
  }

  /**
   * Free resources held by a local embedding context.
   * No-op for remote providers.
   */
  async dispose() {
    if (this._llamaContext) {
      await this._llamaContext.dispose();
      this._llamaContext = null;
    }
    if (this._llamaModel) {
      await this._llamaModel.dispose();
      this._llamaModel = null;
    }
    this._llamaInstance = null;
  }

  // ── Remote (Voyage AI + OpenAI — both use OpenAI-compatible API) ────────────

  async _getRemoteClient() {
    if (!this._remoteClient) {
      const { default: OpenAI } = await import('openai');
      this._remoteClient = new OpenAI({
        apiKey:  this.apiKey,
        baseURL: this.provider === 'voyage' ? VOYAGE_BASE_URL : undefined,
      });
    }
    return this._remoteClient;
  }

  async _embedRemote(texts) {
    const client  = await this._getRemoteClient();
    const results = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch  = texts.slice(i, i + this.batchSize);
      const params = { model: this.model, input: batch };
      if (this.dimensions && this.provider === 'openai') params.dimensions = this.dimensions;

      const res    = await this._withRetry(() => client.embeddings.create(params));
      const sorted = res.data.sort((a, b) => a.index - b.index);
      results.push(...sorted.map(d => d.embedding));
    }

    return results;
  }

  /**
   * Retry a remote call with exponential backoff on 429 rate limit errors.
   * @param {Function} fn  - Async function to retry
   * @param {number} maxRetries - Max attempts (default 4)
   */
  async _withRetry(fn, maxRetries = 4) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (err?.status !== 429) throw err; // only retry on rate limit

        const delayMs = Math.min(1000 * 2 ** attempt, 30000); // 1s, 2s, 4s, 8s … cap 30s
        log.warn(`[EmbeddingModel] Rate limited — retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  }

  // ── Local (node-llama-cpp) ─────────────────────────────────────────────────

  async _getLocalContext() {
    if (!this._llamaContext) {
      const { getLlama } = await import('node-llama-cpp');
      this._llamaInstance = await getLlama({ logLevel: 'error', gpu: this.gpu, build: 'never' });
      this._llamaModel    = await this._llamaInstance.loadModel({ modelPath: this.modelPath });
      this._llamaContext  = await this._llamaModel.createEmbeddingContext();
    }
    return this._llamaContext;
  }

  async _embedLocal(texts) {
    const ctx     = await this._getLocalContext();
    const results = [];
    for (const text of texts) {
      const result = await ctx.getEmbeddingFor(text);
      const vector = result?.vector ?? result;
      results.push(Array.from(vector));
    }
    return results;
  }
}

export default EmbeddingModel;
