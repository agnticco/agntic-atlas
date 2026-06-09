/**
 * rewrite primitive — transforms input into a target tone/format.
 */

import { SystemMessage, HumanMessage } from '../../core/message.js';
import { resolveTransformInput } from './_node-input.js';

const FORMAT_GUIDE = {
  magazine:     'Polished magazine feature — flowing prose, clear section headers, editorial voice. Keep source links inline as [source](url) and images inline as ![caption](url) where the input had them.',
  email:        'Professional email with a clear subject-line-ready opener, 2–4 short paragraphs, and a clear next step. No markdown headers.',
  bullets:      'Tight bullet list. One complete idea per bullet. No preamble.',
  tweet:        'A single tweet-length post (≤280 chars). Punchy, one idea.',
  plain:        'Plain, direct prose at a 7th-grade reading level. No jargon. No markdown.',
  executive:    'Executive briefing — one paragraph of context, then 3 bullet points: the decision needed, the key facts, the risk.',
};

export const rewriteNodeType = {
  type: 'rewrite',
  label: 'Rewrite',
  description: 'Transforms the previous step\'s output into a target format (magazine article, email, bullets, tweet, plain prose, executive brief).',
  icon: 'edit_note',
  family: 'transform',
  configSchema: [
    { key: 'format', label: 'Target format', type: 'select',
      options: Object.keys(FORMAT_GUIDE),
      default: 'magazine' },
    { key: 'instructions', label: 'Extra instructions (optional)', type: 'textarea', optional: true, rows: 3,
      placeholder: 'e.g. keep every source link; emphasise hazards; avoid speculation.' },
    { key: 'input', label: 'Override input (advanced)', type: 'text', optional: true, advanced: true,
      hint: 'By default uses the previous step. Reference another with {{nodeId.output}}.' },
  ],
  previewTemplate: 'Rewrites the previous step as a {format|magazine}-style document{instructions? (custom instructions provided)}.',
  run: async (cfg, ctx, services) => {
    if (!services?.llm) throw new Error('rewrite requires LLM access');
    const input = resolveTransformInput(cfg, ctx);
    if (!input || !input.trim()) throw new Error('rewrite has no input — no upstream step produced any content');

    const format = cfg.format ?? 'magazine';
    const guide  = FORMAT_GUIDE[format] ?? FORMAT_GUIDE.magazine;
    const extra  = cfg.instructions ? `\n\nAdditional requirements:\n${cfg.instructions}` : '';

    const prompt = `Rewrite the following into ${format} format.\n\nFormat rules: ${guide}${extra}\n\nReturn ONLY the rewritten content — no preamble, no self-reference.\n\n---\n${input}`;
    const system = 'You are a skilled rewriter. You preserve every factual claim, every source link, and every embedded image from the input. You do NOT invent facts, quotes, URLs, or images that were not in the input.';

    const res = await services.llm.invoke(
      [new SystemMessage(system), new HumanMessage(prompt)],
      ctx.costConfig ?? undefined,
    );
    return res?.content ?? '';
  },
};
