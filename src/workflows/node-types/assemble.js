/**
 * assemble primitive — stitch a polished markdown document from a title, intro
 * paragraph, and a list of sections. No LLM call: pure template assembly, so it
 * is instant, free, and deterministic.
 *
 * Each section's `content` is meant to be a template reference to an upstream
 * transform (usually an `llm` node producing that section's prose).
 *
 * Was `daily_digest` before P12 Increment A. It is the one node type in the
 * re-cut that did NOT collapse into `llm`, because it is not an LLM node — its
 * run() never touched `services.llm`. Folding it into `llm` would have turned a
 * zero-cost string operation into a paid model call. The run() and config below
 * are unchanged from `daily-digest.js`; only the name is honest now. v1 specs
 * saying `daily_digest` are lifted to `assemble` by ./compat-v1.js.
 */

export const assembleNodeType = {
  type: 'assemble',
  label: 'Assemble document',
  description: 'Stitches a title, intro, and multiple sections into one markdown document. No AI cost — just layout.',
  icon: 'dashboard',
  family: 'assemble',
  configPolicy: 'closed',
  configSchema: [
    { key: 'title', label: 'Title', type: 'text',
      placeholder: 'e.g. 🗞️ Daily Tech Briefing — {{date}}' },
    { key: 'intro', label: 'Intro paragraph', type: 'textarea', optional: true, rows: 2,
      placeholder: 'e.g. Your morning digest of the stories that moved the space.' },
    { key: 'sections', label: 'Sections (JSON list)', type: 'textarea', rows: 8,
      hint: 'JSON array of { heading, content }. Use {{nodeId.output}} in content to pull from upstream steps.',
      placeholder: '[\n  { "heading": "🤖 Agentic AI", "content": "{{l2.output}}" },\n  { "heading": "🧠 Anthropic", "content": "{{l3.output}}" }\n]' },
    { key: 'outro', label: 'Outro / footer', type: 'textarea', optional: true, advanced: true, rows: 2,
      placeholder: 'e.g. *Delivered by Agntic Flow · {{date}}*' },
  ],
  previewTemplate: 'Stitches the upstream sections into a single markdown document titled "{title}". No LLM — pure layout.',
  validate: (node) => {
    const issues = [];
    const raw = node?.config?.sections;
    if (typeof raw !== 'string' || !raw.trim()) {
      issues.push({ severity: 'error', code: 'DIGEST_MISSING_SECTIONS',
        message: `"${node.label || node.id}" needs a sections list.`,
        nodeId: node.id, field: 'config.sections',
        hint: 'Provide a JSON array with heading + content entries.' });
      return issues;
    }
    // Defer template substitution check — fields substitute at run time.
    // Here we just check it's array-shaped JSON.
    try {
      // The raw value at validate time still contains unsubstituted {{...}} —
      // replace each with a bare token. When the template is inside a quoted
      // JSON string ("...{{x}}..."), the result is still a valid string. When
      // outside, JSON.parse fails — which correctly flags malformed input.
      const probe = raw.replace(/\{\{[^}]+\}\}/g, '__TEMPLATE_VAR__');
      const parsed = JSON.parse(probe);
      if (!Array.isArray(parsed)) {
        issues.push({ severity: 'error', code: 'DIGEST_SECTIONS_NOT_ARRAY',
          message: `"${node.label || node.id}" sections must be a JSON array.`,
          nodeId: node.id, field: 'config.sections' });
      }
    } catch (e) {
      issues.push({ severity: 'error', code: 'DIGEST_SECTIONS_INVALID_JSON',
        message: `"${node.label || node.id}" sections isn't valid JSON: ${e.message}.`,
        nodeId: node.id, field: 'config.sections',
        hint: 'Check brackets, quotes, and commas.' });
    }
    return issues;
  },
  run: async (cfg, _ctx, _services) => {
    const title = cfg.title ?? 'Digest';
    const intro = cfg.intro ? `\n\n${cfg.intro}\n\n---` : '';
    let sections;
    try {
      sections = JSON.parse(cfg.sections || '[]');
    } catch (e) {
      throw new Error(`assemble sections is invalid JSON: ${e.message}`);
    }
    if (!Array.isArray(sections)) {
      throw new Error('assemble sections must be a JSON array');
    }
    const outro = cfg.outro ? `\n\n---\n\n${cfg.outro}` : '';

    let md = `# ${title}${intro}\n\n`;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const heading = s?.heading ?? `Section ${i + 1}`;
      const content = s?.content ?? '';
      md += `## ${heading}\n\n${content}\n\n`;
      if (i < sections.length - 1) md += '---\n\n';
    }
    md += outro;
    return md.trim();
  },
};
