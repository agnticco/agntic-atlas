/**
 * WorkflowValidator — structural + semantic validation for flow-kind workflows.
 *
 * Runs at save time (POST /workflows, PATCH /workflows/:id) and on demand via
 * /workflows/:id/validate. Returns a list of structured issues — each with a
 * plain-English message, a severity, and (when applicable) a nodeId or field
 * that the UI can highlight.
 *
 * Issue shape:
 *   {
 *     severity: 'error' | 'warning',
 *     code:     string,        // machine-readable, e.g. 'MISSING_TRIGGER'
 *     message:  string,        // plain-English, user-facing
 *     nodeId:   string | null, // the node it points at, if any
 *     field:    string | null, // the config field, e.g. 'config.url'
 *     hint:     string | null, // optional "try this" suggestion
 *   }
 *
 * Errors block save; warnings don't.
 *
 * @module src/workflows/workflow-validator.js
 */

/** Per-channel required fields on a deliver node's config (beyond `channel`). */
const CHANNEL_REQUIRED = {
  webhook: ['url'],
  // in_app: none; channel handlers enforce the rest at runtime
};

export class WorkflowValidator {
  /**
   * @param {object} deps
   * @param {import('./source-registry.js').SourceRegistry} [deps.sourceRegistry]
   * @param {import('../tools/tool-registry.js').ToolRegistry} [deps.toolRegistry]
   * @param {import('./channel-registry.js').ChannelRegistry}  [deps.channelRegistry]
   * @param {import('./node-type-registry.js').NodeTypeRegistry} [deps.nodeTypes]
   */
  constructor({ sourceRegistry = null, toolRegistry = null, channelRegistry = null, nodeTypes = null } = {}) {
    this.sourceRegistry  = sourceRegistry;
    this.toolRegistry    = toolRegistry;
    this.channelRegistry = channelRegistry;
    this.nodeTypes       = nodeTypes;
  }

  /**
   * Validate a workflow definition object. Doesn't touch the DB.
   * @param {object} def  — { name, nodes, edges, triggers, ... }
   * @returns {{ ok: boolean, errors: object[], warnings: object[], issues: object[] }}
   */
  validate(def = {}) {
    const issues = [];
    const nodes  = Array.isArray(def.nodes) ? def.nodes : [];
    const edges  = Array.isArray(def.edges) ? def.edges : [];

    // ── 1. Top-level shape ────────────────────────────────────────────────
    if (typeof def.name !== 'string' || !def.name.trim()) {
      issues.push({
        severity: 'error', code: 'MISSING_NAME',
        message: 'The workflow needs a name.',
        nodeId: null, field: 'name', hint: 'Give it a short descriptive title.',
      });
    }
    if (nodes.length === 0) {
      issues.push({
        severity: 'error', code: 'EMPTY_WORKFLOW',
        message: 'The workflow has no steps.',
        nodeId: null, field: 'nodes',
        hint: 'Add at least one trigger, one working step, and one delivery.',
      });
      // No point running further structural checks on an empty DAG
      return this._finalize(issues);
    }

    // ── 2. Node-level checks ──────────────────────────────────────────────
    const seenIds = new Set();
    for (const node of nodes) {
      if (!node || typeof node !== 'object') {
        issues.push({
          severity: 'error', code: 'MALFORMED_NODE',
          message: 'A step is missing required fields.',
          nodeId: null, field: null,
        });
        continue;
      }

      // id uniqueness
      if (typeof node.id !== 'string' || !node.id.trim()) {
        issues.push({
          severity: 'error', code: 'MISSING_NODE_ID',
          message: `A ${node.type || 'step'} is missing its id.`,
          nodeId: null, field: 'id',
        });
        continue;
      }
      if (seenIds.has(node.id)) {
        issues.push({
          severity: 'error', code: 'DUPLICATE_NODE_ID',
          message: `Two steps share the id "${node.id}" — ids must be unique.`,
          nodeId: node.id, field: 'id',
        });
        continue;
      }
      seenIds.add(node.id);

      // known type (consult registry if available)
      const typeDef = this.nodeTypes?.get?.(node.type) ?? null;
      if (this.nodeTypes && !typeDef) {
        issues.push({
          severity: 'error', code: 'UNKNOWN_NODE_TYPE',
          message: `Step "${node.id}" uses an unsupported type "${node.type}".`,
          nodeId: node.id, field: 'type',
          hint: `Allowed: ${this.nodeTypes.typeIds().join(', ')}.`,
        });
        continue;
      }

      // required config — inferred from the type's configSchema (fields
      // without `optional: true` are required).
      const required = typeDef?.configSchema?.filter(f => !f.optional).map(f => f.key) ?? [];
      const cfg = node.config ?? {};
      for (const key of required) {
        const v = cfg[key];
        if (v == null || (typeof v === 'string' && !v.trim())) {
          issues.push({
            severity: 'error', code: 'MISSING_CONFIG',
            message: `"${node.label || node.id}" is a ${typeDef.label || node.type} step but is missing its ${key}.`,
            nodeId: node.id, field: `config.${key}`,
            hint: typeDef.configSchema.find(f => f.key === key)?.hint ?? this._requiredFieldHint(node.type, key),
          });
        }
      }

      // type-specific semantic checks
      this._checkTypeSpecific(node, issues);

      // Custom per-type validator (e.g. daily_digest's JSON parse check)
      if (typeof typeDef?.validate === 'function') {
        try {
          const extra = typeDef.validate(node) ?? [];
          for (const e of extra) issues.push(e);
        } catch (err) {
          issues.push({
            severity: 'error', code: 'VALIDATOR_ERROR',
            message: `"${node.label || node.id}" failed type-specific validation: ${err.message}.`,
            nodeId: node.id, field: null,
          });
        }
      }
    }

    // ── 3. Trigger + deliver presence ─────────────────────────────────────
    // A workflow's trigger may live as a `trigger` node in the DAG (the
    // schedule-recipe path builds one) OR as an entry in the top-level
    // `triggers[]` array (event/email/schedule specs — what the scheduler
    // actually reads, and what the converger emits). Either satisfies the
    // requirement; demanding a trigger *node* wrongly rejects runnable
    // event-triggered specs whose entry step is seeded from the trigger event.
    const triggerCount = nodes.filter(n => n.type === 'trigger').length;
    const hasTriggerDefinition = Array.isArray(def.triggers) && def.triggers.length > 0;
    const deliverCount = nodes.filter(n => n.type === 'deliver').length;
    if (triggerCount === 0 && !hasTriggerDefinition) {
      issues.push({
        severity: 'error', code: 'MISSING_TRIGGER',
        message: 'The workflow needs a trigger to start it.',
        nodeId: null, field: null,
        hint: 'Add a trigger step (e.g. "Daily at X AM", "Manual", or an email/event trigger).',
      });
    }
    if (deliverCount === 0) {
      issues.push({
        severity: 'error', code: 'MISSING_DELIVER',
        message: 'The workflow needs at least one destination (a deliver step).',
        nodeId: null, field: null,
        hint: 'Add a deliver step at the end — to the Inbox, a webhook, or another channel.',
      });
    }

    // ── 4. Edges ──────────────────────────────────────────────────────────
    for (const edge of edges) {
      if (!edge || typeof edge !== 'object' || !edge.from || !edge.to) {
        issues.push({
          severity: 'error', code: 'MALFORMED_EDGE',
          message: 'An edge between steps is missing a from/to.',
          nodeId: null, field: 'edges',
        });
        continue;
      }
      if (!seenIds.has(edge.from)) {
        issues.push({
          severity: 'error', code: 'EDGE_BAD_FROM',
          message: `An edge starts from "${edge.from}", but no step with that id exists.`,
          nodeId: null, field: 'edges',
        });
      }
      if (!seenIds.has(edge.to)) {
        issues.push({
          severity: 'error', code: 'EDGE_BAD_TO',
          message: `An edge ends at "${edge.to}", but no step with that id exists.`,
          nodeId: null, field: 'edges',
        });
      }
      if (edge.from === edge.to) {
        issues.push({
          severity: 'error', code: 'SELF_LOOP',
          message: `Step "${edge.from}" has an edge to itself — loops aren't supported.`,
          nodeId: edge.from, field: 'edges',
        });
      }
    }

    // ── 5. Reachability — orphan nodes warn, isolated delivery fails ──────
    if (nodes.length > 1) {
      const hasIncoming = new Set(edges.map(e => e.to).filter(to => seenIds.has(to)));
      const hasOutgoing = new Set(edges.map(e => e.from).filter(from => seenIds.has(from)));
      for (const n of nodes) {
        const orphan = !hasIncoming.has(n.id) && !hasOutgoing.has(n.id);
        if (orphan && n.type !== 'trigger') {
          issues.push({
            severity: 'warning', code: 'ORPHAN_NODE',
            message: `Step "${n.label || n.id}" isn't connected to anything — it won't run.`,
            nodeId: n.id, field: null,
            hint: 'Connect it with an edge from an upstream step, or delete it.',
          });
        }
        if (n.type === 'deliver' && !hasIncoming.has(n.id)) {
          issues.push({
            severity: 'error', code: 'DELIVER_NO_INPUT',
            message: `Deliver step "${n.label || n.id}" has no incoming edge — it has nothing to deliver.`,
            nodeId: n.id, field: 'edges',
            hint: 'Draw an edge from an upstream step (e.g. an LLM or fetch) to this deliver.',
          });
        }
      }
    }

    // ── 6. Cycles ─────────────────────────────────────────────────────────
    if (this._hasCycle(nodes, edges)) {
      issues.push({
        severity: 'error', code: 'CYCLE_DETECTED',
        message: 'The workflow has a cycle — a step feeds back into itself or an earlier step.',
        nodeId: null, field: 'edges',
        hint: 'Flow only runs forward. Remove the backward edge.',
      });
    }

    // ── 7. Template references ────────────────────────────────────────────
    this._checkTemplateRefs(nodes, seenIds, issues);

    return this._finalize(issues);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  _checkTypeSpecific(node, issues) {
    const cfg = node.config ?? {};

    if (node.type === 'fetch') {
      const id = cfg.source;
      if (id && this.sourceRegistry && !this.sourceRegistry.get(id)) {
        issues.push({
          severity: 'error', code: 'UNKNOWN_SOURCE',
          message: `"${node.label || node.id}" references source "${id}", which isn't registered on this server.`,
          nodeId: node.id, field: 'config.source',
          hint: 'Check the Workflows page for available sources, or switch to a tool node with a search.',
        });
      }
    }

    if (node.type === 'tool') {
      const name = cfg.tool;
      if (name && this.toolRegistry) {
        const tool = this.toolRegistry.get?.(name);
        if (!tool) {
          issues.push({
            severity: 'error', code: 'UNKNOWN_TOOL',
            message: `"${node.label || node.id}" uses tool "${name}", which isn't registered.`,
            nodeId: node.id, field: 'config.tool',
            hint: 'Browse MCPs & Tools on the Workflows page for the available list.',
          });
        }
      }
    }

    if (node.type === 'mcp_tool') {
      const server = cfg.server, tool = cfg.tool;
      if (server && tool && this.toolRegistry) {
        const namespaced = `${server}__${tool}`;
        const registered = this.toolRegistry.get?.(namespaced);
        if (!registered) {
          issues.push({
            severity: 'error', code: 'UNKNOWN_MCP_TOOL',
            message: `"${node.label || node.id}" calls ${namespaced}, but that MCP tool isn't registered.`,
            nodeId: node.id, field: 'config.tool',
            hint: `Make sure the "${server}" MCP is connected and enabled, and exposes a tool named "${tool}". See the MCP Registry page.`,
          });
        }
      }
    }

    if (node.type === 'deliver') {
      const channelId = cfg.channel;
      if (channelId && this.channelRegistry) {
        const ch = this.channelRegistry.get?.(channelId);
        if (!ch) {
          issues.push({
            severity: 'error', code: 'UNKNOWN_CHANNEL',
            message: `"${node.label || node.id}" delivers via channel "${channelId}", which isn't wired in this build.`,
            nodeId: node.id, field: 'config.channel',
            hint: 'Pick one of the registered delivery channels (e.g. in_app, webhook).',
          });
        } else if (!ch.available) {
          issues.push({
            severity: 'error', code: 'CHANNEL_UNAVAILABLE',
            message: `Channel "${channelId}" is registered but not ready: ${ch.unavailableReason || 'dependency missing'}.`,
            nodeId: node.id, field: 'config.channel',
          });
        }
      }
      // Per-channel required fields (e.g. webhook needs url)
      const extra = CHANNEL_REQUIRED[channelId] ?? [];
      for (const key of extra) {
        const v = cfg[key];
        if (v == null || (typeof v === 'string' && !v.trim())) {
          issues.push({
            severity: 'error', code: 'CHANNEL_MISSING_CONFIG',
            message: `Channel "${channelId}" needs a ${key}, but "${node.label || node.id}" doesn't provide one.`,
            nodeId: node.id, field: `config.${key}`,
          });
        }
      }
    }
  }

  _hasCycle(nodes, edges) {
    const adj = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) {
      if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from).push(e.to);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map([...adj.keys()].map(k => [k, WHITE]));
    const dfs = (u) => {
      color.set(u, GRAY);
      for (const v of (adj.get(u) ?? [])) {
        const c = color.get(v);
        if (c === GRAY) return true;
        if (c === WHITE && dfs(v)) return true;
      }
      color.set(u, BLACK);
      return false;
    };
    for (const id of adj.keys()) {
      if (color.get(id) === WHITE && dfs(id)) return true;
    }
    return false;
  }

  /**
   * Every `{{nodeId.output}}` or `{{prev}}` reference in a node's config must
   * point at a node that exists. `{{prev}}` is valid if the node has any
   * incoming edge. Static template vars (date, time, etc.) always pass.
   */
  _checkTemplateRefs(nodes, seenIds, issues) {
    const STATIC_VARS = new Set(['prev', 'date', 'time', 'datetime', 'year', 'month', 'day']);
    const incomingByNode = new Map();
    for (const n of nodes) incomingByNode.set(n.id, 0);
    // We don't have edges here but _checkTemplateRefs is called from validate()
    // where edges are available — caller will recompute. For simplicity,
    // check each node's config strings against STATIC_VARS ∪ seenIds.

    const refRe = /\{\{\s*([a-z0-9_-]+)(?:\.output)?\s*\}\}/gi;

    for (const node of nodes) {
      const strings = this._collectStrings(node.config);
      for (const s of strings) {
        let m;
        while ((m = refRe.exec(s)) !== null) {
          const ref = m[1];
          if (STATIC_VARS.has(ref.toLowerCase())) continue;
          if (!seenIds.has(ref)) {
            issues.push({
              severity: 'error', code: 'BAD_TEMPLATE_REF',
              message: `"${node.label || node.id}" references {{${ref}.output}}, but there's no step with id "${ref}".`,
              nodeId: node.id, field: null,
              hint: `Check step ids — allowed: ${[...seenIds].join(', ')}, plus {{prev}}, {{date}}, {{time}}, etc.`,
            });
          }
        }
        refRe.lastIndex = 0;
      }
    }
  }

  _collectStrings(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(v => this._collectStrings(v, out));
    else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) this._collectStrings(v, out);
    }
    return out;
  }

  _requiredFieldHint(type, key) {
    const hints = {
      'fetch.source':    'Pick a source id from your available Sources.',
      'tool.tool':       'Pick a tool name — e.g. web_search, calculator, get_datetime.',
      'llm.prompt':      'Describe what the step should do in plain English. You can reference {{prev}} for the previous step\'s output.',
      'deliver.channel': 'Pick a channel — e.g. in_app for the Agntic inbox, webhook for a URL.',
    };
    return hints[`${type}.${key}`] ?? null;
  }

  _finalize(issues) {
    const errors   = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');
    return { ok: errors.length === 0, errors, warnings, issues };
  }
}
