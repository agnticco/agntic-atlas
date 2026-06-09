/**
 * extract primitive — pulls structured data out of text.
 *
 * User defines a list of fields (name + description); the LLM returns a
 * JSON object keyed by those field names.
 */

import { SystemMessage, HumanMessage } from '../../core/message.js';
import { resolveTransformInput } from './_node-input.js';

export const extractNodeType = {
  type: 'extract',
  label: 'Extract structured data',
  description: 'Reads input and pulls out specific fields as a JSON object. Useful for feeding downstream webhooks or deliver templates.',
  icon: 'data_object',
  family: 'transform',
  configSchema: [
    { key: 'fields', label: 'Fields to extract', type: 'textarea', rows: 6,
      placeholder: 'One per line, name: description\nheadline: the main headline of the story\nsource: the URL of the source article\nsentiment: positive, negative, or neutral',
      hint: 'Plain-English descriptions the LLM uses to pull the right value.' },
    { key: 'input', label: 'Override input (advanced)', type: 'text', optional: true, advanced: true,
      hint: 'By default uses the previous step.' },
  ],
  previewTemplate: 'Reads the previous step and extracts the requested fields as a JSON object.',
  run: async (cfg, ctx, services) => {
    if (!services?.llm) throw new Error('extract requires LLM access');
    const input = resolveTransformInput(cfg, ctx);
    if (!input || !input.trim()) throw new Error('extract has no input — no upstream step produced any content');
    if (!cfg.fields || !String(cfg.fields).trim()) {
      throw new Error('extract requires a fields specification (name: description per line)');
    }

    const schemaLines = String(cfg.fields).trim();
    const prompt = `Extract the requested fields from the source text. Return ONLY a valid JSON object with those exact keys — no preamble, no markdown code fence.\n\nFields:\n${schemaLines}\n\nSource text:\n${input}`;
    const system = 'You extract structured data. You return exactly one JSON object with the requested keys, with values sourced verbatim from the input where possible. If a field cannot be found, its value is null. Never wrap the JSON in a code fence or add commentary.';

    const res = await services.llm.invoke(
      [new SystemMessage(system), new HumanMessage(prompt)],
      ctx.costConfig ?? undefined,
    );
    const raw = res?.content ?? '';
    // Best-effort parse; fall back to the raw string if the LLM disobeyed.
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw, _warning: 'LLM did not return valid JSON' };
    }
  },
};
