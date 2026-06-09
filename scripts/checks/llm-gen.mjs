/**
 * Local open-source model inference check.
 *
 * Loads a GGUF chat model via node-llama-cpp (LlamaCppLLM) and generates a
 * completion. Proves the product can run open-source models locally.
 *
 * Model path: LOCAL_MODEL_PATH env, else ./models/qwen2.5-0.5b-instruct-q4_k_m.gguf
 * Prints LLM-GEN-PASS / -FAIL and exits 0/1.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LlamaCppLLM } from '../../src/llm/index.js';

const MODEL = process.env.LOCAL_MODEL_PATH
  ?? resolve('models/qwen2.5-0.5b-instruct-q4_k_m.gguf');

if (!existsSync(MODEL)) {
  console.error(`LLM-GEN-FAIL: local chat model not found at ${MODEL}`);
  console.error('  fetch a GGUF (see docs/capabilities/local-models-rag.md) or set LOCAL_MODEL_PATH');
  process.exit(1);
}

const t0 = Date.now();
const llm = new LlamaCppLLM({ modelPath: MODEL, contextSize: 2048 });

const prompt = 'Answer in one short sentence: what is the capital of France?';
const out = await llm._call(prompt);
const text = typeof out === 'string' ? out : (out?.content ?? String(out));

console.log(`model: ${MODEL.split('/').pop()} | load+gen ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`output: ${text.trim()}`);

await llm.dispose?.();

const ok = typeof text === 'string' && text.trim().length > 0 && /paris/i.test(text);
console.log(ok ? 'LLM-GEN-PASS' : 'LLM-GEN-FAIL');
process.exit(ok ? 0 : 1);
