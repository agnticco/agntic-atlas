/**
 * SOP generator — derives a human-readable Standard Operating Procedure
 * document from a workflow's live spec. The output stays in sync with the
 * workflow automatically because it is generated on-demand from the stored spec.
 *
 * generateSopMarkdown(workflow) → string (Markdown)
 *
 * Reads specs straight from the store, so it sees v1 nodes (summarize/extract/
 * rewrite/daily_digest) as often as v2 ones. It lifts each node before
 * describing it — see ./node-types/compat-v1.js.
 */

import { liftV1Node } from './node-types/compat-v1.js';

const TYPE_LABELS = {
  email:     'Email trigger',
  schedule:  'Schedule trigger',
  manual:    'Manual trigger',
  llm:       'AI step',
  assemble:  'Assemble document',
  deliver:   'Deliver',
};

/**
 * The P12 node re-cut collapsed summarize/extract/rewrite into `llm` + `mode`.
 * An SOP is read by the customer, so a step that used to say "Summarize (LLM)"
 * must not start saying "AI step" — the mode carries the meaning now.
 */
const LLM_MODE_LABELS = {
  summarize: 'Summarize (AI)',
  extract:   'Extract (AI)',
  rewrite:   'Rewrite (AI)',
  classify:  'Classify (AI)',
  freeform:  'AI prompt',
};

const CHANNEL_LABELS = {
  slack: 'Slack',
  email: 'Email',
  in_app: 'In-app',
};

// Human label for a delivery method, so the SOP config never shows a raw action
// id like "Channel: gmail_send" on a customer-facing document (S7-5).
const DELIVERY_METHOD_LABELS = {
  gmail_send: 'Email', email: 'Email',
  slack: 'Slack', slack_dm: 'Slack direct message',
  in_app: 'Atlas inbox', inbox_deliver: 'Atlas inbox',
  webhook: 'Webhook',
  docs_create: 'Google Doc', sheets_append: 'Google Sheet',
  calendar_create_event: 'Google Calendar event', tasks_create: 'Google Task',
  airtable_create_record: 'Airtable record', airtable_update_record: 'Airtable record',
};

function typeLabel(type) {
  return TYPE_LABELS[type] ?? type;
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Connector-action nodes carry their capability in config.action (e.g.
// `airtable_create_record`, `web_search`, `drive_list_files`). Derive the
// connector + a human capability phrase generically from the action prefix —
// no per-workflow special-casing.
const CONNECTOR_BY_PREFIX = [
  ['airtable_',   'Airtable'],
  ['web_',        'Web'],
  ['slack_',      'Slack'],
  ['gmail_',      'Gmail'],
  ['drive_',      'Google Drive'],
  ['docs_',       'Google Docs'],
  ['sheets_',     'Google Sheets'],
  ['calendar_',   'Google Calendar'],
  ['filesystem_', 'Filesystem'],
];

function connectorAction(node) {
  const action = node.config?.action ?? '';
  const entry = CONNECTOR_BY_PREFIX.find(([p]) => action.startsWith(p));
  const connector = entry ? entry[1] : null;
  const capability = (entry ? action.slice(entry[0].length) : action).replace(/_/g, ' ').trim();
  return { action, connector, capability };
}

// Friendly "Type:" label for a step. Connector-action steps become
// "Airtable — Create Record" instead of the raw `connector-action` slug.
function stepTypeLabel(rawNode) {
  const node = liftV1Node(rawNode);
  if (node.type === 'connector-action') {
    const { connector, capability, action } = connectorAction(node);
    const cap = capability ? capability.replace(/\b\w/g, c => c.toUpperCase()) : '';
    if (connector && cap) return `${connector} — ${cap}`;
    return connector || action || 'Connector action';
  }
  if (node.type === 'llm') {
    return LLM_MODE_LABELS[node.config?.mode ?? 'freeform'] ?? LLM_MODE_LABELS.freeform;
  }
  return typeLabel(node.type);
}

function triggerDescription(trigger) {
  if (trigger.type === 'email') {
    const filter = trigger.filter ? ` matching \`${trigger.filter}\`` : '';
    return `Watches Gmail for incoming messages${filter} and fires once per matching email.`;
  }
  if (trigger.type === 'schedule') {
    const sched = trigger.cron ?? trigger.schedule ?? 'on a schedule';
    return `Runs on a schedule: \`${sched}\`.`;
  }
  if (trigger.type === 'manual') {
    return 'Fires when triggered manually from the console or via API.';
  }
  return `Triggers on \`${trigger.type}\`.`;
}

function triggerConfig(trigger) {
  const lines = [];
  if (trigger.filter)     lines.push(`- **Filter:** \`${trigger.filter}\``);
  if (trigger.maxResults) lines.push(`- **Max results per tick:** ${trigger.maxResults}`);
  if (trigger.cron)       lines.push(`- **Cron:** \`${trigger.cron}\``);
  if (trigger.schedule)   lines.push(`- **Schedule:** \`${trigger.schedule}\``);
  return lines.join('\n');
}

function nodeDescription(rawNode) {
  const node = liftV1Node(rawNode);
  const cfg = node.config ?? {};
  switch (node.type) {
    case 'llm':
      switch (cfg.mode ?? 'freeform') {
        case 'summarize':
          return cfg.instructions
            ? `Passes the upstream content to the language model with custom instructions: "${cfg.instructions}"`
            : 'Passes the upstream content to the language model and produces a concise summary.';
        case 'extract':
          return 'Extracts structured fields from the upstream content using the language model.';
        case 'rewrite':
          return cfg.instructions
            ? `Rewrites the upstream content: "${cfg.instructions}"`
            : 'Rewrites the upstream content using the language model.';
        case 'classify':
          return `Sorts the upstream content into exactly one of: ${
            String(cfg.categories ?? '').split(/[\n,]/).map(s => s.trim()).filter(Boolean).join(', ') || 'the listed categories'
          }.`;
        default:
          return cfg.prompt
            ? `Runs a language-model prompt: "${cfg.prompt.slice(0, 120)}${cfg.prompt.length > 120 ? '…' : ''}"`
            : 'Runs a language-model prompt against the upstream content.';
      }
    case 'assemble':
      return 'Stitches the upstream sections into a single document. No AI call — layout only.';
    case 'deliver': {
      // Method-aware — don't render every delivery as a generic "channel".
      const chan = cfg.channel ?? '';
      if (chan === 'gmail_send' || chan === 'email') return `Emails the result to ${cfg.to ?? 'the configured address'}.`;
      if (chan === 'slack_dm')             return `Sends the result as a Slack direct message${cfg.user ? ` to ${cfg.user}` : ''}.`;
      if (chan === 'in_app' || chan === 'inbox_deliver') return 'Delivers the result to the Atlas inbox.';
      if (chan === 'webhook')              return 'Sends the result to a web address.';
      if (chan === 'airtable_create_record') return 'Creates a new Airtable record.';
      if (chan === 'airtable_update_record') return 'Updates an Airtable record.';
      if (chan === 'docs_create')          return 'Saves the result as a Google Doc.';
      if (chan === 'sheets_append')        return 'Appends the result to a Google Sheet.';
      if (chan === 'calendar_create_event') return 'Creates a Google Calendar event.';
      if (chan === 'tasks_create')         return 'Creates a Google Task.';
      if (chan === 'slack' || chan.charAt(0) === '#' || /^slack:/.test(chan) || cfg.target) {
        const t = cfg.target ?? cfg.channel; return `Posts the result to ${t} in Slack.`;
      }
      const ch = CHANNEL_LABELS[chan] ?? chan ?? 'the configured destination';
      return `Delivers the result to ${ch}.`;
    }
    case 'connector-action': {
      const { action, connector, capability } = connectorAction(node);
      const who = connector ? `the ${connector}` : 'a connected';
      const verb = capability || action || 'connector action';
      let detail = '';
      if (cfg.query)       detail = ` Query: "${clip(cfg.query, 100)}".`;
      else if (cfg.target) detail = ` Target: ${cfg.target}.`;
      return `Runs ${who} “${verb}” action.${detail}`;
    }
    default:
      return node.label ?? `Executes a \`${node.type}\` step.`;
  }
}

function nodeConfig(node) {
  const cfg = node.config ?? {};
  const lines = [];
  if (node.type === 'connector-action') {
    const { action } = connectorAction(node);
    if (action)              lines.push(`- **Action:** \`${action}\``);
    if (cfg.baseId)          lines.push(`- **Airtable base:** \`${cfg.baseId}\``);
    if (cfg.tableId)         lines.push(`- **Airtable table:** \`${cfg.tableId}\``);
    if (cfg.query)           lines.push(`- **Query:** ${clip(cfg.query, 160)}`);
    if (cfg.filterByFormula) lines.push(`- **Filter:** \`${cfg.filterByFormula}\``);
    if (cfg.channel)         lines.push(`- **Channel:** ${CHANNEL_LABELS[cfg.channel] ?? cfg.channel}`);
    if (cfg.target)          lines.push(`- **Target:** ${cfg.target}`);
    if (cfg.fields && typeof cfg.fields === 'object')
      lines.push(`- **Writes fields:** ${Object.keys(cfg.fields).map(k => `\`${k}\``).join(', ')}`);
    const max = cfg.max_results ?? cfg.maxResults ?? cfg.maxRecords;
    if (max != null)         lines.push(`- **Max results:** ${max}`);
    if (cfg.depth)           lines.push(`- **Depth:** ${cfg.depth}`);
    return lines.join('\n');
  }
  // Deliver nodes: render a clean method + destination, never "Channel: gmail_send" (S7-5).
  if (node.type === 'deliver') {
    const chan = cfg.channel ?? '';
    const method = DELIVERY_METHOD_LABELS[chan] ?? CHANNEL_LABELS[chan];
    if (method)          lines.push(`- **Delivery:** ${method}`);
    if (cfg.to)          lines.push(`- **To:** ${cfg.to}`);
    else if (cfg.user)   lines.push(`- **To:** ${cfg.user}`);
    else if (cfg.target) lines.push(`- **Channel:** ${cfg.target}`);
    if (cfg.title)       lines.push(`- **Title:** ${cfg.title}`);
    return lines.join('\n');
  }
  if (cfg.length)       lines.push(`- **Length:** ${cfg.length}`);
  if (cfg.style)        lines.push(`- **Style:** ${cfg.style}`);
  if (cfg.format)       lines.push(`- **Format:** ${cfg.format}`);
  if (cfg.channel)      lines.push(`- **Channel:** ${CHANNEL_LABELS[cfg.channel] ?? cfg.channel}`);
  if (cfg.target)       lines.push(`- **Target:** ${cfg.target}`);
  if (cfg.title)        lines.push(`- **Title:** ${cfg.title}`);
  if (cfg.instructions) lines.push(`- **Instructions:** ${cfg.instructions}`);
  return lines.join('\n');
}

// Build a dependency map: nodeId → [upstream nodeIds]
function buildDeps(edges) {
  const deps = {};
  for (const e of (edges ?? [])) {
    if (!deps[e.to]) deps[e.to] = [];
    deps[e.to].push(e.from);
  }
  return deps;
}

export function generateSopMarkdown(wf) {
  const nodes    = wf.nodes    ?? [];
  const edges    = wf.edges    ?? [];
  const triggers = wf.triggers ?? [];
  const deps     = buildDeps(edges);

  const now = new Date().toISOString().slice(0, 10);
  const lines = [];

  lines.push(`# Standard Operating Procedure`);
  lines.push(`## ${wf.name || wf.user_intent || 'Untitled workflow'}`);
  lines.push('');

  // Metadata table
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| **Status** | ${wf.status ?? 'unknown'} |`);
  lines.push(`| **Version** | v${wf.version ?? 1} |`);
  lines.push(`| **Created** | ${(wf.created_at ?? '').slice(0, 10) || 'unknown'} |`);
  lines.push(`| **Last updated** | ${(wf.updated_at ?? '').slice(0, 10) || 'unknown'} |`);
  lines.push(`| **Generated** | ${now} (from live spec — auto-updates on workflow edit) |`);
  lines.push('');

  if (wf.description) {
    lines.push(wf.description);
    lines.push('');
  }

  // Triggers
  if (triggers.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Trigger');
    lines.push('');
    for (const t of triggers) {
      lines.push(`**${typeLabel(t.type)}**`);
      lines.push('');
      lines.push(triggerDescription(t));
      const cfg = triggerConfig(t);
      if (cfg) { lines.push(''); lines.push(cfg); }
      lines.push('');
    }
  }

  // Steps
  if (nodes.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Steps');
    lines.push('');
    nodes.forEach((node, i) => {
      const upstreams = (deps[node.id] ?? []);
      const depStr = upstreams.length > 0
        ? `  *(depends on: ${upstreams.map(d => `\`${d}\``).join(', ')})*`
        : '';

      lines.push(`### Step ${i + 1} — ${node.label || stepTypeLabel(node)}`);
      lines.push('');
      lines.push(`**Type:** ${stepTypeLabel(node)}${depStr}`);
      lines.push('');
      lines.push(nodeDescription(node));
      const cfg = nodeConfig(node);
      if (cfg) { lines.push(''); lines.push(cfg); }
      lines.push('');
    });
  }

  // Data flow
  if (edges.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Data flow');
    lines.push('');
    // Build a readable chain: Trigger → node1 → node2 …
    const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
    const inDegree = {};
    for (const e of edges) { inDegree[e.to] = (inDegree[e.to] ?? 0) + 1; }
    const roots = nodes.filter(n => !inDegree[n.id]);
    const visited = new Set();

    function walk(nodeId, prefix) {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const n = nodeMap[nodeId];
      const label = n ? (n.label || stepTypeLabel(n)) : nodeId;
      lines.push(`${prefix}→ **${label}** (\`${nodeId}\`)`);
      for (const e of edges.filter(e2 => e2.from === nodeId)) {
        walk(e.to, prefix + '  ');
      }
    }

    if (triggers.length > 0) {
      lines.push('```');
      lines.push(`[Trigger: ${typeLabel(triggers[0].type)}]`);
      for (const root of roots) walk(root.id, '  ');
      lines.push('```');
    } else {
      lines.push('```');
      for (const root of roots) walk(root.id, '');
      lines.push('```');
    }
    lines.push('');
  }

  return lines.join('\n');
}
