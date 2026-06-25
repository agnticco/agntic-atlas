/**
 * summarize primitive — concise restatement of prior output.
 *
 * Baked-in prompts (length × style) so users don't write raw prompts.
 */

import { SystemMessage, HumanMessage } from '../../core/message.js';
import { resolveTransformInput } from './_node-input.js';

const LENGTH_GUIDE = {
  short:  '2–3 sentences',
  medium: '4–6 sentences or a compact paragraph',
  long:   '2–3 paragraphs with room for detail',
};

const STYLE_GUIDE = {
  neutral:   'factual, professional tone',
  editorial: 'magazine-style prose with a clear narrative voice',
  bullets:   'bullet points — each bullet one complete idea',
  plain:     'plain conversational language, no jargon',
};

function _deliveryFormatSuffix(channel) {
  if (channel === 'email') return ` Your output will be delivered as an HTML email. Write well-designed HTML with inline styles for visual hierarchy. Use semantic structure: <h2 style="font-size:20px;font-weight:600;color:#0d0d0d;margin:0 0 10px"> for section headers, <p style="color:#333;line-height:1.7"> for body text, <ul style="color:#333;line-height:1.7"> for lists. For callout sections or highlight cards use <div class="card"> or <div class="callout"> (these CSS classes are provided by the email shell). Use <hr> to separate major sections. Do NOT include <!DOCTYPE>, <html>, <head>, or <body> wrappers — only the inner content. Aim for something that looks like a well-designed newsletter, not a plain document.`;
  if (channel === 'slack') return ' Your output will be posted to Slack — format it as Slack mrkdwn: use *bold*, _italic_, `code`, and • bullet points. No HTML tags.';
  return '';
}

export const summarizeNodeType = {
  type: 'summarize',
  label: 'Summarize',
  description: 'Reads the previous step and writes a summary at the length and style you choose.',
  icon: 'summarize',
  family: 'transform',
  configSchema: [
    { key: 'length', label: 'Length', type: 'select',
      options: ['short','medium','long'],
      default: 'medium' },
    { key: 'style', label: 'Style', type: 'select',
      options: ['neutral','editorial','bullets','plain'],
      default: 'neutral' },
    { key: 'focus', label: 'What to emphasise (optional)', type: 'text', optional: true,
      placeholder: 'e.g. business implications, user impact',
      hint: 'One or two words telling the summary what to highlight.' },
    { key: 'input', label: 'Override input (advanced)', type: 'text', optional: true, advanced: true,
      hint: 'By default uses the previous step. Reference another with {{nodeId.output}}.' },
  ],
  previewTemplate: 'Reads the previous step and writes a {length|medium}-length, {style|neutral}-style summary{focus?, emphasising {focus}}.',
  run: async (cfg, ctx, services) => {
    if (!services?.llm) throw new Error('summarize requires LLM access');
    // Aggregate ALL upstream content producers (handles linear chains AND
    // fan-in), not just the immediately-preceding node. See _node-input.js.
    const input = resolveTransformInput(cfg, ctx);
    if (!input || !input.trim()) {
      throw new Error('summarize has no input — no upstream step produced any content');
    }

    const length = LENGTH_GUIDE[cfg.length] ?? LENGTH_GUIDE.medium;
    const style  = STYLE_GUIDE[cfg.style]  ?? STYLE_GUIDE.neutral;
    const focus  = cfg.focus ? `\n\nEmphasise: ${cfg.focus}.` : '';

    const prompt = `Summarize the following content.\n\nTarget length: ${length}.\nTarget style: ${style}.${focus}\n\nReturn ONLY the summary — no preamble, no commentary on your choices.\n\n---\n${input}`;
    const formatSuffix = _deliveryFormatSuffix(ctx.deliveryChannel);
    const system = `You are a careful writer producing a workflow-stage summary. Keep every factual detail that matters; do not invent or infer. Preserve inline links [text](url) and embedded images ![alt](url) that were in the source if they are relevant to your summary.${formatSuffix}`;

    const res = await services.llm.invoke(
      [new SystemMessage(system), new HumanMessage(prompt)],
      ctx.costConfig ?? undefined,
    );
    return res?.content ?? '';
  },
};
