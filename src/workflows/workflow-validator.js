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

import { liftV1Nodes, isRemovedType, REMOVED_TYPES } from './node-types/compat-v1.js';
import { normalizeCases, CATCH_ALL } from './node-types/branch.js';
import { normalizeSteps } from './node-types/foreach.js';

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
    // Lift v1 nodes (summarize/extract/rewrite → llm+mode, daily_digest →
    // assemble) BEFORE anything else looks at them, so every check below sees a
    // v2 node and there is exactly one shape to reason about. Types that were
    // REMOVED rather than collapsed pass through unlifted and are rejected by
    // name below. See ./node-types/compat-v1.js.
    const nodes  = liftV1Nodes(Array.isArray(def.nodes) ? def.nodes : []);
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

      // Types deleted in the P12 node re-cut. These never ran — `tool`/`mcp_tool`
      // threw "Tool registry unavailable" and `fetch` needed a registered source
      // — so rejecting them here converts a 6am production failure into a
      // build-time one. Reported by name, with what to use instead.
      if (isRemovedType(node.type)) {
        issues.push({
          severity: 'error', code: 'REMOVED_NODE_TYPE',
          message: `Step "${node.label || node.id}" uses "${node.type}", which is not a step type any more.`,
          nodeId: node.id, field: 'type',
          hint: REMOVED_TYPES[node.type],
        });
        continue;
      }

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

      const cfg = node.config ?? {};

      // required config — inferred from the type's configSchema (fields
      // without `optional: true` are required).
      const required = typeDef?.configSchema?.filter(f => !f.optional).map(f => f.key) ?? [];
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

      // ── UNKNOWN_CONFIG_KEY ────────────────────────────────────────────
      // A node's config keys must be a SUBSET of its type's configSchema.
      //
      // Without this, a converger that hallucinates a config field ships it:
      // a real emitted spec carried `"model": "claude-opus-4-5"` on an llm
      // node — a model that does not exist and a key in no schema — and the
      // executor silently ignored it and ran the default model. Nobody found
      // out. An unknown key is not a shrug; it means the spec asked for
      // something the engine will not do, and the user will never be told.
      //
      // Scoped by configPolicy: 'open' types (connector-action) take params
      // this schema cannot enumerate, because they are per-capability and the
      // catalog is built at run time from the tenant's authorised connectors.
      // Increment F validates those against each capability's own schema.
      if (typeDef && typeDef.configPolicy !== 'open') {
        const declared = new Set((typeDef.configSchema ?? []).map(f => f.key));
        for (const key of Object.keys(cfg)) {
          if (declared.has(key)) continue;
          issues.push({
            severity: 'error', code: 'UNKNOWN_CONFIG_KEY',
            message: `"${node.label || node.id}" sets "${key}", which a ${typeDef.label || node.type} step has no such setting for — it would be silently ignored at run time.`,
            nodeId: node.id, field: `config.${key}`,
            hint: declared.size
              ? `A ${typeDef.label || node.type} step accepts: ${[...declared].join(', ')}.`
              : `A ${typeDef.label || node.type} step takes no configuration.`,
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

    // ── 8. Control flow (P12 Increment B) ─────────────────────────────────
    this._checkControlFlow(nodes, edges, seenIds, issues);

    return this._finalize(issues);
  }

  /**
   * `branch` / `foreach` / `human` rules that need the EDGE LIST, so they can't
   * live in a node type's own validate(node) hook.
   */
  _checkControlFlow(nodes, edges, seenIds, issues) {
    const edgeSet = new Set(edges.filter(e => e?.from && e?.to).map(e => `${e.from} ${e.to}`));

    for (const node of nodes) {
      if (node?.type === 'branch') {
        const cases = normalizeCases(node.config?.cases);

        if (!cases.length) {
          issues.push({
            severity: 'error', code: 'MISSING_CONFIG',
            message: `"${node.label || node.id}" is a branch but has no cases.`,
            nodeId: node.id, field: 'config.cases',
            hint: 'Add at least one { when, to }, plus a { when: "*" } catch-all.',
          });
          continue;
        }

        // ── NON_EXHAUSTIVE_BRANCH ─────────────────────────────────────────
        // Every branch needs a `*` catch-all. Without one, a value nobody
        // anticipated matches no case, the run falls off the end of the branch,
        // and the workflow SILENTLY DOES NOTHING — no error, no delivery, no
        // trace. That is the single most expensive failure mode a router has,
        // and it is invisible precisely when it matters (an unusual input).
        // If there is genuinely nothing to do for the leftovers, the catch-all
        // routes to a `human` step, so a person is told. Silence is never the
        // right answer to "I didn't expect this".
        if (!cases.some(c => String(c?.when).trim() === CATCH_ALL)) {
          issues.push({
            severity: 'error', code: 'NON_EXHAUSTIVE_BRANCH',
            message: `"${node.label || node.id}" has no catch-all case. An unexpected value would match nothing and the workflow would silently stop, with no error and no output.`,
            nodeId: node.id, field: 'config.cases',
            hint: 'Add a final case { "when": "*", "to": "<stepId>" }. If there is nothing to do for those, send them to a person — so somebody is told, instead of nobody.',
          });
        }

        for (const c of cases) {
          const to = typeof c?.to === 'string' ? c.to.trim() : '';
          if (!to) {
            issues.push({
              severity: 'error', code: 'BRANCH_CASE_NO_TARGET',
              message: `A case on "${node.label || node.id}" (when: ${JSON.stringify(c?.when)}) doesn't say which step to go to.`,
              nodeId: node.id, field: 'config.cases',
              hint: 'Every case needs a `to` naming the step that runs when it matches.',
            });
            continue;
          }
          if (!seenIds.has(to)) {
            issues.push({
              severity: 'error', code: 'BRANCH_CASE_BAD_TARGET',
              message: `"${node.label || node.id}" routes to "${to}", but there's no step with that id.`,
              nodeId: node.id, field: 'config.cases',
            });
            continue;
          }
          // The engine lights the edge branch→to. If that edge doesn't exist,
          // the target sorts BEFORE the branch in topological order and would
          // run unconditionally — the routing would silently do nothing.
          if (!edgeSet.has(`${node.id} ${to}`)) {
            issues.push({
              severity: 'error', code: 'BRANCH_CASE_NO_EDGE',
              message: `"${node.label || node.id}" routes to "${to}", but there is no connection drawn from it to "${to}" — so "${to}" would run no matter which case matched.`,
              nodeId: node.id, field: 'edges',
              hint: `Add an edge { "from": "${node.id}", "to": "${to}" } for every case.`,
            });
          }
        }
      }

      // A write that can run twice creates the record twice. This is a WARNING,
      // not an error: plenty of writes are naturally idempotent (updating a row
      // to a fixed value), and blocking publish on it would be paternalistic.
      // But the converger should be told, because a re-fired trigger duplicating
      // a customer record is a support ticket, not a theory.
      if (node?.type === 'connector-action' && !node.idempotency?.key) {
        const action = String(node.config?.action ?? '');
        if (/(^|_)(create|append|send|post|add|insert)(_|$)/i.test(action)) {
          issues.push({
            severity: 'warning', code: 'WRITE_WITHOUT_IDEMPOTENCY',
            message: `"${node.label || node.id}" writes ("${action}") but has no idempotency key, so if the trigger fires twice it will write twice.`,
            nodeId: node.id, field: 'idempotency',
            hint: 'Add idempotency: { "key": "{{<stepId>.<uniqueField>}}", "on_conflict": "skip" } — e.g. the sender\'s email, or an invoice id.',
          });
        }
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * The `fetch` / `tool` / `mcp_tool` branches that used to live here went away
   * with the node types themselves (P12 Increment A) — they resolved ids against
   * a `sourceRegistry` / `toolRegistry` that this build never instantiates. Those
   * types are now rejected up front as REMOVED_NODE_TYPE.
   */
  _checkTypeSpecific(node, issues) {
    const cfg = node.config ?? {};

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
    // {{item}} / {{index}} are bound ONLY inside a `foreach`'s per-item steps.
    // Outside a loop they resolve to nothing, so allowing them everywhere would
    // turn a real bug (a template referencing a loop variable that isn't in
    // scope) into a silently empty string. Scoped per node instead.
    const LOOP_VARS = new Set(['item', 'index']);
    const varsFor = (node) =>
      node?.type === 'foreach' ? new Set([...STATIC_VARS, ...LOOP_VARS]) : STATIC_VARS;
    const incomingByNode = new Map();
    for (const n of nodes) incomingByNode.set(n.id, 0);
    // We don't have edges here but _checkTemplateRefs is called from validate()
    // where edges are available — caller will recompute. For simplicity,
    // check each node's config strings against STATIC_VARS ∪ seenIds.

    const refRe = /\{\{\s*([a-z0-9_-]+)(?:\.output)?\s*\}\}/gi;

    // A foreach's per-item steps may reference each other by id. Those ids are
    // nested inside config, so they never reach the top-level `seenIds`.
    const idsFor = (node) => {
      if (node?.type !== 'foreach') return seenIds;
      const sub = normalizeSteps(node.config?.steps).map(s => s?.id).filter(Boolean);
      return new Set([...seenIds, ...sub]);
    };

    for (const node of nodes) {
      const vars = varsFor(node);
      const ids  = idsFor(node);
      const strings = this._collectStrings(node.config);
      for (const s of strings) {
        let m;
        while ((m = refRe.exec(s)) !== null) {
          const ref = m[1];
          if (vars.has(ref.toLowerCase())) continue;
          if (!ids.has(ref)) {
            issues.push({
              severity: 'error', code: 'BAD_TEMPLATE_REF',
              message: `"${node.label || node.id}" references {{${ref}.output}}, but there's no step with id "${ref}".`,
              nodeId: node.id, field: null,
              hint: `Check step ids — allowed: ${[...ids].join(', ')}, plus {{prev}}, {{date}}, {{time}}, etc.`,
            });
          }
        }
        refRe.lastIndex = 0;
      }
    }

    // S7-9: flag templates that use UNSUPPORTED syntax (field paths, array
    // indexing, wildcards). The engine resolves ONLY {{prev}}, {{<id>.output}} and
    // date tokens; anything else (e.g. {{node.results[*].id}}) is passed through
    // literally and fails at runtime. Catch it at build time instead.
    const anyRe = /\{\{\s*([^}]+?)\s*\}\}/g;
    const okRe  = /^[a-z0-9_-]+(\.output)?$/i;
    for (const node of nodes) {
      const strings = this._collectStrings(node.config);
      for (const s of strings) {
        let m;
        while ((m = anyRe.exec(s)) !== null) {
          const inner = m[1].trim();
          if (STATIC_VARS.has(inner.toLowerCase())) continue;
          if (okRe.test(inner)) continue; // {{id}} / {{id.output}} — validated above
          issues.push({
            severity: 'error', code: 'BAD_TEMPLATE_REF',
            message: `"${node.label || node.id}" uses an unsupported reference {{${inner}}}. The engine only resolves {{prev}} and {{<stepId>.output}} — field paths, array indexing (e.g. [*], [0]) and dotted sub-fields are not supported and break at runtime.`,
            nodeId: node.id, field: null,
            hint: `Pass the previous step's full output ({{prev}} or {{<stepId>.output}}) to the next step instead of extracting a sub-field.`,
          });
        }
        anyRe.lastIndex = 0;
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
