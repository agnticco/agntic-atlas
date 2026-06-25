/**
 * llm node — low-level direct LLM call.
 *
 * Prefer higher-level primitives (Summarize, Rewrite, Extract, etc.) when
 * they fit — they bake in known-good prompts and produce more predictable
 * output. Use llm only for truly custom prompts not covered by a primitive.
 */

import { SystemMessage, HumanMessage } from '../../core/message.js';

export const llmNodeType = {
  type: 'llm',
  label: 'LLM (advanced)',
  description: 'Low-level: send a custom prompt to the agent LLM. Prefer a primitive (Summarize, Rewrite, etc.) when one fits.',
  icon: 'psychology',
  family: 'low_level',
  configSchema: [
    { key: 'prompt', label: 'Prompt', type: 'textarea', rows: 8,
      hint: 'Instructions for the LLM. Supports {{prev}}, {{nodeId.output}}, {{date}}, {{time}}. If you omit all templates, the previous step\'s output is auto-appended.' },
    { key: 'system', label: 'System message', type: 'textarea', optional: true, advanced: true, rows: 3,
      hint: 'Optional. Overrides the default "you are a helpful assistant running inside a workflow" framing.' },
    { key: 'maxTokens', label: 'Max output tokens', type: 'number', optional: true, advanced: true,
      hint: 'Default 8192. Raise for very long outputs (max varies by model).' },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', optional: true, advanced: true,
      hint: 'Default 120000 (2 min). Raise for very long generations.' },
  ],
  previewTemplate: 'Sends a custom prompt to the LLM and returns its reply.',
  run: async (cfg, ctx, services) => {
    if (!services?.llm) throw new Error('LLM unavailable for llm nodes');
    const rawPrompt = cfg.prompt ?? 'Summarize the prior output.';
    let prompt = rawPrompt;

    // Auto-inject prior output if the prompt has no template references.
    const referencesInput = /\{\{\s*(prev|[a-z0-9_-]+\.output)\s*\}\}/i.test(rawPrompt);
    const priorOutput = _stringify(ctx.lastOutput);
    if (!referencesInput && priorOutput) {
      prompt = `${prompt}\n\n---\nInput:\n${priorOutput}`;
    }

    const system = cfg.system ?? 'You are a helpful assistant running inside a workflow. Transform the input as instructed. Be concise. Do not ask clarifying questions — work with what you have.';
    const timeoutMs = cfg.timeoutMs ?? 120_000;
    const invokeConfig = cfg.maxTokens
      ? { ...(ctx.costConfig ?? {}), maxTokens: cfg.maxTokens }
      : (ctx.costConfig ?? undefined);
    let timeoutHandle;
    try {
      const res = await Promise.race([
        services.llm.invoke([new SystemMessage(system), new HumanMessage(prompt)], invokeConfig),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`LLM call timed out after ${Math.round(timeoutMs/1000)}s`)),
            timeoutMs,
          );
        }),
      ]);
      return res?.content ?? '';
    } catch (err) {
      throw new Error(`LLM step failed: ${err.message ?? String(err)}`);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  },
};

function _stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'text' in v) return v.text;
  try { return JSON.stringify(v); } catch { return String(v); }
}

