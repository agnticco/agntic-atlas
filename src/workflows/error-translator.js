/**
 * error-translator — turns raw runtime errors from FlowTester into
 * plain-English explanations users can act on.
 *
 * Single source of truth: every place that surfaces a workflow error
 * (test SSE stream, /runs API, scheduler logs) calls translateError() so
 * the user sees the same friendly message everywhere.
 *
 * Returns:
 *   {
 *     title:       string,    // short headline ("The Summarize step took too long")
 *     explanation: string,    // 1–2 sentences of context
 *     suggestions: string[],  // concrete next steps the user can try
 *     code:        string,    // stable id ("LLM_TIMEOUT"), useful for telemetry
 *     raw:         string,    // the original error verbatim, for power users
 *   }
 *
 * @module src/workflows/error-translator.js
 */

/**
 * Pattern table — first match wins. Each entry has:
 *   match:   regex applied to the raw error message
 *   render:  function (matchGroups, ctx) returning {title, explanation, suggestions, code}
 *
 * ctx = { nodeId, nodeLabel, nodeType, workflow }
 */
const PATTERNS = [
  // ── LLM ─────────────────────────────────────────────────────────────────
  {
    code: 'LLM_TIMEOUT',
    match: /LLM call timed out after (\d+)s/i,
    render: ([_, secs], ctx) => ({
      title:       `${niceStep(ctx)} took longer than ${secs} seconds and was stopped.`,
      explanation: 'LLM calls have a hard timeout so a stuck request can\'t leave the workflow hanging. The step itself was sent to the LLM — it just didn\'t finish in time.',
      suggestions: [
        'Shorten the input — for example, lower the article count on upstream search steps, or summarize each source separately first instead of one big assembly.',
        'Switch to a faster model tier if you have one configured.',
        'For very large generations, raise the timeout (Advanced settings → Timeout).',
      ],
    }),
  },
  {
    code: 'LLM_RATE_LIMIT',
    match: /HTTP 429/,
    render: (_m, ctx) => ({
      title:       `${niceStep(ctx)} hit the API rate limit.`,
      explanation: 'The LLM provider rejected the request because too many calls happened recently.',
      suggestions: [
        'Wait a minute and run the workflow again.',
        'If this keeps happening, reduce the number of LLM steps in the workflow or run it less often.',
      ],
    }),
  },
  {
    code: 'LLM_AUTH',
    match: /HTTP 401|HTTP 403|invalid api key/i,
    render: (_m, ctx) => ({
      title:       `${niceStep(ctx)} couldn't authenticate with the LLM provider.`,
      explanation: 'The provider rejected the API key. This is a server-side configuration issue.',
      suggestions: [
        'Check the LLM API key is set in the server\'s .env file (e.g. ANTHROPIC_API_KEY).',
        'Restart the server after any .env change.',
      ],
    }),
  },

  // ── Search providers ──────────────────────────────────────────────────
  {
    code: 'BRAVE_RATE_LIMIT',
    match: /Brave HTTP 429/i,
    render: (_m, ctx) => ({
      title:       'Brave Search hit its rate limit.',
      explanation: 'You\'ve used your free quota for this minute. The free tier is 1 query per second, 2,000 per month.',
      suggestions: [
        'Wait a minute and retry.',
        'Reduce the number of search steps that run together.',
        'Upgrade your Brave Search plan if you need higher throughput.',
      ],
    }),
  },
  {
    code: 'BRAVE_AUTH',
    match: /Brave HTTP 401|Brave HTTP 403/i,
    render: () => ({
      title:       'Brave Search rejected the API key.',
      explanation: 'The BRAVE_SEARCH_API_KEY in the server\'s .env file is missing, expired, or wrong.',
      suggestions: [
        'Get a fresh key at https://api.search.brave.com/app/keys',
        'Add it as BRAVE_SEARCH_API_KEY=… in the server\'s .env file.',
        'Restart the server.',
      ],
    }),
  },
  {
    code: 'DDG_BLOCKED',
    match: /DuckDuckGo blocked this request/i,
    render: () => ({
      title:       'Web search was blocked.',
      explanation: 'DuckDuckGo\'s HTML scraper rate-limits us aggressively. The fix is to use the Brave Search backend, which is reliable and free.',
      suggestions: [
        'Get a free Brave Search API key at https://api.search.brave.com/app/keys',
        'Add it to .env as BRAVE_SEARCH_API_KEY=… and restart the server.',
      ],
    }),
  },
  {
    code: 'BRAVE_KEY_MISSING',
    match: /requires BRAVE_SEARCH_API_KEY/i,
    render: () => ({
      title:       'Image and video search need a Brave Search API key.',
      explanation: 'You\'re using a step that calls Brave\'s image or video search, but BRAVE_SEARCH_API_KEY isn\'t set on the server.',
      suggestions: [
        'Get a free key at https://api.search.brave.com/app/keys',
        'Add it to .env as BRAVE_SEARCH_API_KEY=… and restart.',
      ],
    }),
  },

  // ── Channels / delivery ─────────────────────────────────────────────────
  {
    code: 'CHANNEL_NOT_WIRED',
    match: /Channel "([^"]+)" is not wired/i,
    render: ([_, ch], ctx) => ({
      title:       `The "${ch}" delivery channel isn't wired in this build.`,
      explanation: 'You\'re trying to send the workflow output to a channel that doesn\'t have a working handler installed.',
      suggestions: [
        'Switch the deliver step to "in_app" (Inbox) or "webhook" — both are always available.',
        'If you need the original channel, ask whoever maintains the build to wire its handler.',
      ],
    }),
  },
  {
    code: 'CHANNEL_NOT_READY',
    match: /Channel "([^"]+)" is registered but not ready \(([^)]+)\)/i,
    render: ([_, ch, why], ctx) => ({
      title:       `The "${ch}" delivery channel isn't ready yet.`,
      explanation: `It's registered, but its dependency reports: ${why}.`,
      suggestions: [
        `Set up the dependency this channel needs (often an MCP connection like Gmail, Slack, etc.).`,
        'Switch to a different channel (in_app or webhook) if you need the workflow to run now.',
      ],
    }),
  },
  {
    code: 'WEBHOOK_FAILED',
    match: /webhook POST failed: (.+)/i,
    render: ([_, why], ctx) => ({
      title:       'The webhook URL didn\'t accept the post.',
      explanation: `${why}.`,
      suggestions: [
        'Check that the URL is correct and currently reachable.',
        'If the endpoint requires authentication, add a header in the deliver step\'s Advanced settings.',
        'Test the URL with curl or Postman to confirm it accepts POST with JSON.',
      ],
    }),
  },

  // ── Tools / sources ─────────────────────────────────────────────────────
  {
    code: 'TOOL_MISSING_QUERY',
    match: /web_search requires a non-empty `query`|search_(web|images|videos) requires a topic/i,
    render: (_m, ctx) => ({
      title:       `${niceStep(ctx)} is missing its search topic.`,
      explanation: 'Search steps need a topic to look for. The field was empty when the workflow ran.',
      suggestions: [
        'Open this step and fill in the Topic field.',
        'If the topic should come from a previous step, use a template like {{prev}} in the topic.',
      ],
    }),
  },
  {
    code: 'TOOL_NOT_FOUND',
    match: /Tool "([^"]+)" not found/i,
    render: ([_, name], ctx) => ({
      title:       `The "${name}" tool isn't available.`,
      explanation: 'The workflow references a tool by name that isn\'t registered on the server.',
      suggestions: [
        'Check Browse MCPs and Tools on the Workflows page for the available list.',
        'Replace this step with one of the higher-level primitives (Search the web, Summarize, etc.).',
      ],
    }),
  },
  {
    code: 'NODE_TYPE_UNKNOWN',
    match: /Node type "([^"]+)" is not registered/i,
    render: ([_, t], _ctx) => ({
      title:       `The "${t}" step type isn't supported in this build.`,
      explanation: 'The workflow uses a step type that isn\'t wired in the executor.',
      suggestions: [
        'Delete the step and pick a supported type from the picker (+ between chips).',
      ],
    }),
  },
  {
    code: 'EXTRACT_BAD_JSON',
    match: /extract.*requires a fields specification/i,
    render: (_m, ctx) => ({
      title:       `${niceStep(ctx)} doesn't have any fields to extract.`,
      explanation: 'Extract steps need a list of field names + descriptions to pull out of the input.',
      suggestions: [
        'Open this step and add lines like:\n  headline: the main headline\n  source_url: the article URL',
      ],
    }),
  },
  {
    code: 'DIGEST_BAD_JSON',
    match: /(?:assemble|daily_digest) sections is invalid JSON: (.+)/i,
    render: ([_, why], ctx) => ({
      title:       `${niceStep(ctx)} has malformed sections.`,
      explanation: `Sections must be a valid JSON array of {heading, content} entries. The parser said: ${why}.`,
      suggestions: [
        'Open this step and check brackets, quotes, and commas in the Sections field.',
        'Or rebuild the workflow with the Wizard — it generates valid sections automatically.',
      ],
    }),
  },

  // ── Server / runtime ────────────────────────────────────────────────────
  {
    code: 'NETWORK',
    match: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i,
    render: (_m, ctx) => ({
      title:       `${niceStep(ctx)} couldn't reach the network.`,
      explanation: 'The step tried to call an external service but the network was unreachable or refused.',
      suggestions: [
        'Check the server\'s internet connection.',
        'If the service was reachable before, wait a minute and retry.',
      ],
    }),
  },
];

/**
 * "WE COULD NOT RUN THE TEST" IS NOT "THE WORKFLOW IS WRONG" (2026-08-01).
 *
 * WITNESSED ON PROD, `build-zz-firstrun-test-1785616455964`, watched live by Charles: a
 * correct Gmail→Sheets workflow spent **881 seconds and THREE paid Opus passes**, of which
 * two were `verify_failed` rebuilds ordered by the same sentence both times —
 * `extract_email: LLM step failed: LLM call timed out after 120s`. The self-test ran for
 * 385s, then 373s. **No rebuild can make a model answer faster**, so the second and third
 * passes were unwinnable before they started, and the finished workflow was identical in
 * substance to the first draft.
 *
 * The verify node already draws exactly this distinction for CONTENT flakes, and its
 * comment makes the argument in full: *"Rebuilding the whole spec to 'fix' it is futile —
 * the new spec has the same guard and flakes the same way."* That reasoning applies word
 * for word to a timeout, and the code did not cover it: `isContentFlake` requires
 * `!o.error`, so ANY run error — including one that says nothing about the spec — counted
 * as a structural wiring defect.
 *
 * This is the same shape as the file's oldest rule, one door further along: **an
 * unexercised promise is a verdict distinct from pass and from fail.** A test that could
 * not be run has not shown the workflow to be wrong.
 *
 * Derived from the SAME pattern table the user-facing message comes from, deliberately —
 * a second regex list here is the one-rule-in-two-places defect this repo has paid for
 * more than any other, and it would drift the moment anyone added a provider.
 */
const TRANSIENT_CODES = new Set([
  'LLM_TIMEOUT',       // the model did not answer in time — says nothing about the spec
  'LLM_RATE_LIMIT',    // 429: too many calls recently
  'BRAVE_RATE_LIMIT',
  'DDG_BLOCKED',       // the provider refused us, not the workflow
  'NETWORK',           // the box could not reach the service at all
]);

/**
 * Did this run fail because of the WORKFLOW, or because we could not run it?
 *
 * Deliberately NARROW. Anything unrecognised is treated as a real failure, because
 * excusing a genuine wiring defect ships a broken workflow, while excusing nothing costs
 * a rebuild. `LLM_AUTH`, a bad JSON extraction and an unwired channel are all REAL — they
 * are facts about this deployment or this spec and they do not go away on a retry.
 */
export function isTransientFailure(rawError, ctx = {}) {
  const msg = typeof rawError === 'string' ? rawError : (rawError?.message ?? '');
  if (!msg) return false;
  return TRANSIENT_CODES.has(translateError(msg, ctx).code);
}

/**
 * Translate a raw error message into a structured, user-friendly explanation.
 *
 * @param {string} rawError
 * @param {object} [ctx]  - { nodeId, nodeLabel, nodeType, workflow }
 * @returns {{ title, explanation, suggestions, code, raw }}
 */
export function translateError(rawError, ctx = {}) {
  const raw = String(rawError ?? '').trim();
  if (!raw) {
    return _build({ title: 'The workflow failed.', explanation: 'No error details were captured.', suggestions: [], code: 'UNKNOWN' }, raw);
  }

  for (const p of PATTERNS) {
    const m = raw.match(p.match);
    if (m) {
      return _build(p.render(m, ctx), raw, p.code);
    }
  }

  // Generic fallback — surface the step that failed and the last line of the
  // error in a softer wrapper.
  const stepLabel = ctx.nodeLabel || ctx.nodeId || 'A workflow step';
  return _build({
    title:       `${stepLabel} failed.`,
    explanation: 'Something went wrong while running this step. The raw error is shown below — share it with whoever maintains the workflow if it isn\'t obvious.',
    suggestions: [
      'Open the step and check its configuration.',
      'Try running the workflow once more — transient errors often resolve on retry.',
    ],
    code: 'GENERIC',
  }, raw);
}

function _build(out, raw, code = null) {
  return {
    title:       out.title       ?? 'Workflow step failed.',
    explanation: out.explanation ?? '',
    suggestions: out.suggestions ?? [],
    code:        code ?? out.code ?? 'GENERIC',
    raw,
  };
}

function niceStep(ctx) {
  return `The ${ctx.nodeLabel || ctx.nodeType || 'step'}`;
}
