/**
 * deliver node — routes the workflow's output to a delivery channel.
 */

import { stringifyOutput, isMeaningfulOutput } from './_node-input.js';

export const deliverNodeType = {
  type: 'deliver',
  label: 'Deliver',
  description: 'Sends the result to a destination — Inbox, webhook, or any other registered channel.',
  icon: 'send',
  family: 'deliver',
  configSchema: [
    { key: 'channel', label: 'Channel', type: 'select', options: ['in_app', 'webhook'],
      hint: 'Where to deliver. "in_app" = Agntic inbox; "webhook" = HTTP POST to a URL you provide.' },
    { key: 'title', label: 'Title', type: 'text', optional: true,
      placeholder: 'e.g. Morning Briefing — {{date}}',
      hint: 'Shown as the Inbox item header. Supports {{date}}, {{time}}, etc.' },
    { key: 'body', label: 'Body (optional template)', type: 'textarea', optional: true, advanced: true, rows: 8,
      hint: 'If set, this is used as the delivered content. Omit to use the previous step\'s output. Supports templates like {{l1.output}}.' },
    { key: 'url', label: 'URL (for webhook channel)', type: 'text', optional: true,
      hint: 'Required only if channel = webhook.' },
    { key: 'headers', label: 'Headers (object, for webhook)', type: 'object', optional: true, advanced: true },

    // ── Per-channel routing fields ────────────────────────────────────────
    // These were read by the channel handlers long before they were declared
    // here, which made this schema untrue: a spec using `target` looked like it
    // carried an unknown key when the key was in fact load-bearing. P12
    // Increment A turned the config check into a hard error (UNKNOWN_CONFIG_KEY),
    // so every key a handler actually consumes has to be declared or the very
    // workflows running in production would fail to validate.
    //
    // EVERY key below is read by real code, and the file:line is on the line.
    // Verify before you add one — a key nothing consumes makes this schema a lie
    // and turns UNKNOWN_CONFIG_KEY into theatre, which is the exact state that
    // let `"model": "claude-opus-4-5"` ship. `message` was briefly declared here
    // on a misread (`config.messageId`, a gmail_get_message param, prefix-matched
    // a grep for `config.message`); nothing reads `config.message`, so it is NOT
    // a deliver key and a spec carrying it is correctly rejected. The body comes
    // from the previous step, or from `body` — never from `message`.
    { key: 'target', label: 'Channel / recipient', type: 'text', optional: true,
      placeholder: 'e.g. #social',
      hint: 'Slack: the channel to post to.' },   // consumed at src/connectors/slack/index.js:256 (config.target)
    { key: 'user', label: 'Direct-message recipient', type: 'text', optional: true,
      placeholder: 'e.g. someone@company.com or @handle',
      hint: 'Slack DM: who to send it to.' },     // consumed at src/connectors/slack/index.js:278 (config.user)
    { key: 'to', label: 'Email recipient', type: 'text', optional: true,
      hint: 'Email: the address it goes to.' },   // consumed at src/connectors/google/index.js:591 (config.to)
    { key: 'subject', label: 'Subject', type: 'text', optional: true,
      hint: 'Email: the subject line. Also used as the title if none is set.' },   // consumed at src/connectors/google/index.js:591 (config.subject)
    { key: 'username', label: 'Post as (bot name)', type: 'text', optional: true, advanced: true,
      hint: 'Slack: overrides the bot display name.' },   // consumed at src/connectors/slack/index.js:259 (config.username)
    { key: 'icon_emoji', label: 'Post as (bot icon)', type: 'text', optional: true, advanced: true,
      placeholder: 'e.g. :package:',
      hint: 'Slack: overrides the bot avatar.' },   // consumed at src/connectors/slack/index.js:260 (config.icon_emoji)
  ],
  previewTemplate: 'Sends the result to {channel}{title? with title "{title}"}.',
  run: async (cfg, ctx, services) => {
    if (!services?.channelRegistry) {
      throw new Error('Deliver node needs a channel registry');
    }
    const channelId = cfg.channel ?? 'in_app';
    const ch = services.channelRegistry.get(channelId);
    if (!ch) throw new Error(`Channel "${channelId}" is not wired in this build.`);
    if (!ch.available) throw new Error(`Channel "${channelId}" is registered but not ready (${ch.unavailableReason}).`);

    const handler = services.channelRegistry.getHandler(channelId);
    if (!handler) throw new Error(`Channel "${channelId}" has no handler`);

    // Action channels (lookup, search, reaction, reminder, etc.) don't deliver
    // body content — their parameters come entirely from config. Skip body
    // validation so they can run without an upstream content-producing step.
    if (ch.actionOnly) return handler({ config: cfg, body: cfg.body ?? '', title: null, lastOutput: ctx.lastOutput });

    // ── Body resolution (delivery-threading fix) ──────────────────────────
    //
    // History: `body` originally meant "if set, deliver this verbatim;
    // else deliver the previous step's output." An agent that wrote a
    // STATIC description into `body` (no {{template}} tokens) would have
    // the real upstream content silently discarded and a one-line
    // boilerplate delivered — while the run still reported success. That
    // is the worst failure mode: a workflow that looks like it worked but
    // produced nothing usable.
    //
    // New contract:
    //   • Real upstream content always wins. If an upstream content step
    //     produced output, THAT is delivered — for any DAG shape.
    //   • A configured `body` is only honoured when it is a genuine
    //     {{template}} wrapper (the author explicitly composed the
    //     delivered text and flow-tester already inlined the upstream
    //     output into it), OR when the workflow has no content-producing
    //     step at all (a pure scheduled reminder, trigger → deliver).
    //   • Otherwise — a content step was supposed to run but produced
    //     nothing — fail LOUDLY. Never emit plausible boilerplate the
    //     user would trust as a real result.
    //
    // We distinguish a template body from a static one via ctx.rawConfig
    // (pre-substitution config FlowTester now exposes for exactly this):
    // a raw body containing a {{...}} token is an intentional wrapper; a
    // raw body with no tokens is a static description that must not shadow
    // real upstream output.
    const upstreamStr     = stringifyOutput(ctx.lastOutput);
    const hasUpstream     = isMeaningfulOutput(ctx.lastOutput);
    const bodyConfigured  = typeof cfg.body === 'string' && cfg.body.trim().length > 0;
    const rawBody         = ctx?.rawConfig?.body;
    const isTemplateBody  = typeof rawBody === 'string' && /\{\{\s*[\w.\-]+\s*\}\}/.test(rawBody);
    const upstreamNodeIds = [...(ctx?.outputs?.keys?.() ?? [])];
    // Any non-trigger node that ran means a content step was intended.
    const hadContentNode  = upstreamNodeIds.some(id => id !== 'trigger');

    let body;
    if (bodyConfigured && isTemplateBody) {
      // Intentional template wrapper — flow-tester substituted the upstream
      // output into the author's body (e.g. "## Briefing {{date}}\n\n{{prev}}").
      // Keep their formatting/headers.
      body = cfg.body;
    } else if (hasUpstream) {
      // Upstream produced real content. Deliver it. A static (non-template)
      // `body` is an authoring description, not the deliverable — ignore it
      // rather than silently shipping boilerplate.
      body = upstreamStr;
    } else if (bodyConfigured && !hadContentNode) {
      // Pure reminder workflow: no content-producing step, the fixed
      // `body` IS the intended deliverable.
      body = cfg.body;
    } else {
      // A content step was supposed to run but produced nothing. Surface
      // a real failure instead of delivering coherent-looking boilerplate.
      throw new Error(
        'Deliver step has no content to send: the upstream content step ' +
        'produced no output. The workflow ran but generated nothing ' +
        'deliverable — check the search / summarize steps.'
      );
    }

    const title = cfg.title ?? cfg.subject ?? null;
    return handler({ config: cfg, body, title, lastOutput: ctx.lastOutput });
  },
};
