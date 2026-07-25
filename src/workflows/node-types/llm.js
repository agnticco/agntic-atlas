/**
 * llm node — the single LLM primitive.
 *
 * P12 Increment A collapsed the node library: `summarize`, `extract`, `rewrite`
 * and `daily_digest` were four node types that differed only in their prompt.
 * They are now `mode` on this one node:
 *
 *   summarize · extract · rewrite · classify · freeform
 *
 * v1 specs that still say `type: 'summarize'` are lifted to `llm` + `mode` by
 * the compat shim (./compat-v1.js) at both validate time and execute time, so
 * they keep running untouched — nothing in the database had to be migrated.
 *
 * `classify` is new, and it is load-bearing for Increment C: it is the only
 * sanctioned way for an LLM to feed a decision, because it classifies into a
 * CLOSED enum (`categories`) rather than emitting free text. A decision input
 * without a closed enum has no completeness proof (converger-v2 §11.7).
 *
 * configPolicy: 'closed' — every key here is read by run() below. A key that is
 * NOT in this schema is a hallucination and the validator rejects it with
 * UNKNOWN_CONFIG_KEY. This is what stops `"model": "claude-opus-4-5"` (a model
 * that does not exist) from being silently ignored at run time and shipping to
 * production. Do not add a key here that run() does not actually consume — an
 * untrue schema turns the check into theatre.
 */

import { SystemMessage, HumanMessage } from '../../core/message.js';
import { resolveTransformInput } from './_node-input.js';
import { pickCategory } from './decision.js';
import { currentDateLine } from '../../utils/current-time.js';

export const LLM_MODES = ['summarize', 'extract', 'rewrite', 'classify', 'freeform'];

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

/**
 * `format` is the OUTPUT SHAPE the destination requires. Delivery channels are
 * unforgiving here: Slack renders mrkdwn, Gmail renders HTML, Airtable renders
 * nothing — so raw <p> tags land in the message verbatim (CLAUDE.md, Known
 * gotchas). A format not in this table is passed through as a literal
 * instruction, so a free-text format ("a haiku") still works.
 */
const FORMAT_GUIDE = {
  plain:     'Plain text only — no HTML tags, no markdown symbols. Clean prose paragraphs and line breaks.',
  mrkdwn:    'Slack mrkdwn: *bold* for headers, • for list items, blank line between sections. No HTML tags of any kind.',
  html:      'Clean inner HTML for an email body — <h2>/<h3> headers, <p> paragraphs, <ul>/<li> lists. No <html>/<body> wrappers.',
  markdown:  'Standard Markdown: # headings, **bold**, - list items, blank line between sections. No HTML tags.',
  bullets:   'A tight bullet list. One complete idea per bullet. No preamble.',
  email:     'A professional email: a clear opener, 2–4 short paragraphs, and a clear next step. No markdown headers.',
  magazine:  'A polished magazine feature — flowing prose, clear section headers, editorial voice. Keep source links inline as [source](url) and images as ![caption](url) where the input had them.',
  tweet:     'A single tweet-length post (≤280 chars). Punchy, one idea.',
  executive: 'An executive briefing — one paragraph of context, then 3 bullets: the decision needed, the key facts, the risk.',
};

export const llmNodeType = {
  type: 'llm',
  label: 'AI step',
  description: 'Runs the AI on the previous step\'s output. Pick a mode: summarize, extract, rewrite, classify, or a freeform prompt.',
  icon: 'psychology',
  family: 'transform',
  configPolicy: 'closed',
  configSchema: [
    { key: 'mode', label: 'Mode', type: 'select', options: LLM_MODES, optional: true, default: 'freeform',
      hint: 'summarize = condense · extract = pull fields as JSON · rewrite = change format/tone · classify = sort into a closed set of categories · freeform = your own prompt.' },

    // freeform
    { key: 'prompt', label: 'Prompt', type: 'textarea', rows: 8, optional: true,
      hint: 'freeform mode. Supports {{prev}}, {{nodeId.output}}, {{date}}, {{time}}. If you use no templates, the previous step\'s output is appended automatically.' },

    // summarize · rewrite · classify
    { key: 'instructions', label: 'Instructions', type: 'textarea', rows: 4, optional: true,
      hint: 'What this step should do, in plain English. Used by summarize, rewrite and classify.' },

    // extract
    { key: 'fields', label: 'Fields to extract', type: 'textarea', rows: 6, optional: true,
      placeholder: 'One per line, name: description\nheadline: the main headline\nsentiment: positive, negative, or neutral',
      hint: 'extract mode. The AI returns a JSON object with exactly these keys.' },

    // classify — the closed enum. See converger-v2 §11.7.
    { key: 'categories', label: 'Categories', type: 'textarea', rows: 4, optional: true,
      placeholder: 'urgent\nroutine\nspam',
      hint: 'classify mode. One category per line (or comma-separated). The AI must return EXACTLY one of these — this closed enum is what makes the result decidable.' },

    // output shaping
    { key: 'format', label: 'Output format', type: 'text', optional: true,
      hint: 'The shape the destination needs: plain · mrkdwn (Slack) · html (email) · markdown (Docs) · bullets · email · magazine · tweet · executive.' },
    { key: 'length', label: 'Length', type: 'select', options: ['short', 'medium', 'long'], optional: true,
      hint: 'summarize mode. Default: medium.' },
    { key: 'style', label: 'Style', type: 'select', options: ['neutral', 'editorial', 'bullets', 'plain'], optional: true,
      hint: 'summarize mode. Default: neutral.' },
    { key: 'tone', label: 'Tone', type: 'text', optional: true,
      placeholder: 'e.g. warm, formal, urgent',
      hint: 'rewrite mode. The voice to write in.' },
    { key: 'focus', label: 'What to emphasise', type: 'text', optional: true,
      placeholder: 'e.g. business implications, user impact',
      hint: 'summarize mode. What the output should highlight.' },

    // plumbing
    { key: 'input', label: 'Override input', type: 'text', optional: true, advanced: true,
      hint: 'By default this step reads every upstream step. Reference one explicitly with {{nodeId.output}}.' },
    { key: 'system', label: 'System message', type: 'textarea', optional: true, advanced: true, rows: 3,
      hint: 'Overrides the default framing for this step.' },
    { key: 'maxTokens', label: 'Max output tokens', type: 'number', optional: true, advanced: true,
      hint: 'Default 8192. Raise for very long outputs.' },
    { key: 'timeoutMs', label: 'Timeout (ms)', type: 'number', optional: true, advanced: true,
      hint: 'Default 120000 (2 min).' },
  ],

  previewTemplate: '{mode=summarize?Summarizes the previous step.|mode=extract?Extracts the requested fields as JSON.|mode=rewrite?Rewrites the previous step.|mode=classify?Sorts the input into one of the listed categories.|Sends a custom prompt to the AI.}',

  /**
   * Mode-specific requirements. The generic MISSING_CONFIG check can't express
   * "required only in extract mode", so it lives here.
   */
  validate: (node) => {
    const issues = [];
    const cfg  = node?.config ?? {};
    const mode = cfg.mode ?? 'freeform';

    if (!LLM_MODES.includes(mode)) {
      issues.push({
        severity: 'error', code: 'UNKNOWN_LLM_MODE',
        message: `"${node.label || node.id}" uses AI mode "${mode}", which doesn't exist.`,
        nodeId: node.id, field: 'config.mode',
        hint: `Allowed modes: ${LLM_MODES.join(', ')}.`,
      });
      return issues;
    }

    const blank = (v) => v == null || (typeof v === 'string' && !v.trim());

    if (mode === 'freeform' && blank(cfg.prompt)) {
      issues.push({
        severity: 'error', code: 'MISSING_CONFIG',
        message: `"${node.label || node.id}" is a freeform AI step but has no prompt.`,
        nodeId: node.id, field: 'config.prompt',
        hint: 'Describe what the step should do, or pick a mode (summarize / extract / rewrite / classify).',
      });
    }
    if (mode === 'extract' && blank(cfg.fields)) {
      issues.push({
        severity: 'error', code: 'MISSING_CONFIG',
        message: `"${node.label || node.id}" extracts data but lists no fields.`,
        nodeId: node.id, field: 'config.fields',
        hint: 'One field per line, as "name: what it means".',
      });
    }
    if (mode === 'classify' && parseCategories(cfg.categories).length < 2) {
      // §11.7 — the moat. A classifier without a closed enum of at least two
      // categories decides nothing, and there is no completeness proof to make.
      issues.push({
        severity: 'error', code: 'MISSING_CONFIG',
        message: `"${node.label || node.id}" classifies but lists fewer than two categories.`,
        nodeId: node.id, field: 'config.categories',
        hint: 'List every category the input could fall into, one per line. The set must be closed — an input that matches none of them cannot be decided on.',
      });
    }
    return issues;
  },

  run: async (cfg, ctx, services) => {
    if (!services?.llm) throw new Error('LLM unavailable for llm nodes');
    const mode = cfg.mode ?? 'freeform';

    const { system, prompt } = buildMessages(mode, cfg, ctx);
    // THE MODEL HAS NO CLOCK. Without this it answers "what is today's date?" from
    // training data — see currentDateLine below. Prepended to the SYSTEM message so
    // it applies to every mode and cannot be displaced by a user's own prompt text.
    const datedSystem = `${currentDateLine(ctx?.now)}\n\n${system}`;

    const timeoutMs = cfg.timeoutMs ?? 120_000;
    const invokeConfig = cfg.maxTokens
      ? { ...(ctx.costConfig ?? {}), maxTokens: cfg.maxTokens }
      : (ctx.costConfig ?? undefined);

    let timeoutHandle;
    let raw;
    try {
      const res = await Promise.race([
        services.llm.invoke([new SystemMessage(datedSystem), new HumanMessage(prompt)], invokeConfig),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`LLM call timed out after ${Math.round(timeoutMs / 1000)}s`)),
            timeoutMs,
          );
        }),
      ]);
      raw = res?.content ?? '';
    } catch (err) {
      throw new Error(`LLM step failed: ${err.message ?? String(err)}`);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    // extract returns a JSON object; classify returns one of the categories.
    // Every other mode returns prose.
    if (mode === 'extract') {
      try {
        return JSON.parse(raw);
      } catch {
        return { _raw: raw, _warning: 'LLM did not return valid JSON' };
      }
    }
    if (mode === 'classify') {
      const categories = parseCategories(cfg.categories);
      // pickCategory: exact answer, else the answer must contain EXACTLY ONE
      // category, on word boundaries. The old fallback took the first category
      // appearing ANYWHERE in the answer, in declaration order — so
      // "I would reject this — do not approve" classified as `approve`, and a
      // category that is a PREFIX of another ("ship" vs "ship_hold") made the
      // longer one unreachable. It never returned free text; it returned the WRONG
      // MEMBER OF THE SET, which a branch then routed on with full confidence.
      // This node is the sanctioned way an LLM feeds a decision (§11.7), so a
      // silent misclassification here is a silent misroute everywhere.
      // (Found by the test-adversary in decision.js; the same bug lived here.)
      const picked = pickCategory(raw, categories);
      // Fail loudly rather than pass an off-enum value downstream — an
      // unclassifiable input is exactly the case a decision must escalate on.
      if (!picked) {
        throw new Error(
          `classify returned "${String(raw).trim().slice(0, 80)}", which is not one of the declared categories ` +
          `(${categories.join(', ')}).`,
        );
      }
      return picked;
    }
    return raw;
  },
};

/** Categories may be newline- or comma-separated. Blank entries are dropped. */
function parseCategories(v) {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v !== 'string') return [];
  return v.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

/** A `format` we know gets a full instruction; anything else passes through literally. */
function formatRule(format) {
  if (!format || !String(format).trim()) return '';
  const key = String(format).trim().toLowerCase();
  return FORMAT_GUIDE[key] ?? `Format the output as: ${String(format).trim()}.`;
}

/**
 * Build the (system, prompt) pair for a mode. The summarize / extract / rewrite
 * prompts are carried over from the v1 node types they replace, so a lifted v1
 * spec produces the same kind of output it did before the collapse.
 */
function buildMessages(mode, cfg, ctx) {
  const fmt = formatRule(cfg.format);

  if (mode === 'freeform') {
    const rawPrompt = cfg.prompt ?? 'Summarize the prior output.';
    // Auto-inject prior output if the prompt references no templates.
    const referencesInput = /\{\{\s*(prev|[a-z0-9_-]+\.output)\s*\}\}/i.test(rawPrompt);
    // ── `input` IS HONOURED HERE TOO (2026-07-22) ──────────────────────────
    // Every other mode resolves its input through `resolveTransformInput`, which
    // respects an explicit `input` override. `freeform` ignored it and always
    // injected `lastOutput` — so the key was declared on the node, accepted by
    // the validator, set by the converger, and silently dropped at run time.
    //
    // Found by running a real workflow: a 3-way triage whose urgent lane was
    // `classify → branch → freeform llm`. `input` said `{{extract_email.output}}`
    // (the email), but freeform injected `lastOutput`, which after a classifier is
    // the single word "urgent". With no subject and no body the node hit the guard
    // the converger writes into it and emitted `ERROR: required data not found` —
    // and that was DELIVERED, as a real Slack DM. The routine lane, identical but
    // in `summarize` mode, worked. A key one mode reads and another ignores is the
    // "schema that lies" failure this codebase keeps paying for.
    const priorOutput = (cfg.input != null && String(cfg.input).trim().length)
      ? String(cfg.input)
      : stringify(ctx.lastOutput);
    let prompt = rawPrompt;
    if (!referencesInput && priorOutput) prompt = `${prompt}\n\n---\nInput:\n${priorOutput}`;
    if (fmt) prompt = `${prompt}\n\nOutput format: ${fmt}`;
    return {
      system: cfg.system ?? 'You are a helpful assistant running inside a workflow. Transform the input as instructed. Be concise. Do not ask clarifying questions — work with what you have.',
      prompt,
    };
  }

  // Every other mode reads the upstream steps. Aggregate ALL upstream content
  // producers (handles linear chains AND fan-in) — see ./_node-input.js.
  const input = resolveTransformInput(cfg, ctx);
  if (!input || !input.trim()) {
    throw new Error(`${mode} has no input — no upstream step produced any content`);
  }

  if (mode === 'summarize') {
    const length = LENGTH_GUIDE[cfg.length] ?? LENGTH_GUIDE.medium;
    const style  = STYLE_GUIDE[cfg.style]  ?? STYLE_GUIDE.neutral;
    const extra  = cfg.instructions ? `\n\nInstructions: ${cfg.instructions}` : '';
    const focus  = cfg.focus ? `\n\nEmphasise: ${cfg.focus}.` : '';
    return {
      system: cfg.system ?? 'You are a careful writer producing a workflow-stage summary. Keep every factual detail that matters; do not invent or infer. Preserve inline links [text](url) and embedded images ![alt](url) from the source where they are relevant.',
      prompt: `Summarize the following content.\n\nTarget length: ${length}.\nTarget style: ${style}.${extra}${focus}${fmt ? `\n\nOutput format: ${fmt}` : ''}\n\nReturn ONLY the summary — no preamble, no commentary on your choices.\n\n---\n${input}`,
    };
  }

  if (mode === 'extract') {
    return {
      system: cfg.system ?? 'You extract structured data. You return exactly one JSON object with the requested keys, with values sourced verbatim from the input where possible. If a field cannot be found, its value is null. Never wrap the JSON in a code fence or add commentary.',
      prompt: `Extract the requested fields from the source text. Return ONLY a valid JSON object with those exact keys — no preamble, no markdown code fence.\n\nFields:\n${String(cfg.fields).trim()}\n\nSource text:\n${input}`,
    };
  }

  if (mode === 'rewrite') {
    const target = cfg.format ? String(cfg.format).trim() : 'a cleaner version';
    const tone   = cfg.tone ? `\n\nTone: ${cfg.tone}.` : '';
    const extra  = cfg.instructions ? `\n\nAdditional requirements:\n${cfg.instructions}` : '';
    return {
      system: cfg.system ?? 'You are a skilled rewriter. You preserve every factual claim, every source link, and every embedded image from the input. You do NOT invent facts, quotes, URLs, or images that were not in the input.',
      prompt: `Rewrite the following into ${target}.${fmt ? `\n\nFormat rules: ${fmt}` : ''}${tone}${extra}\n\nReturn ONLY the rewritten content — no preamble, no self-reference.\n\n---\n${input}`,
    };
  }

  // classify — the closed-enum classifier (§11.7).
  const categories = parseCategories(cfg.categories);
  const extra = cfg.instructions ? `\n\nHow to decide:\n${cfg.instructions}` : '';
  return {
    system: cfg.system ?? 'You are a classifier inside an automated workflow. You reply with EXACTLY ONE of the allowed categories, verbatim — no punctuation, no explanation, no preamble. Never invent a category.',
    prompt: `Classify the input into exactly one of these categories:\n${categories.map(c => `- ${c}`).join('\n')}${extra}\n\nReply with the category name and nothing else.\n\n---\n${input}`,
  };
}

function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'text' in v) return v.text;
  try { return JSON.stringify(v); } catch { return String(v); }
}
