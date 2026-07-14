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
import { checkOutcome, missingFields, ASSERTION_KINDS } from './outcome-oracle.js';

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
    //
    // A MALFORMED NODE IS REPORTED AND THEN REMOVED, before any other check runs.
    //
    // It used to be reported and left in the list, so `nodes.filter(n => n.type
    // === 'trigger')` further down threw `Cannot read properties of null`. And
    // because WorkflowService.create() calls validate() with no try/catch
    // (workflow-service.js:90), a spec with a `null` in `nodes[]` made PUBLISH
    // RETURN A 500 — instead of the clean, user-facing MALFORMED_NODE error the
    // validator had already generated one line earlier. Turning bad input into a
    // message is this class's entire job; crashing on bad input is the one thing
    // it must never do. Filtering here means every check below sees an object by
    // construction, rather than by each one remembering to guard.
    // (Pre-existing on `main`; found by the test-adversary.)
    const lifted = liftV1Nodes(Array.isArray(def.nodes) ? def.nodes : []);
    const nodes  = [];
    for (const n of lifted) {
      if (!n || typeof n !== 'object' || Array.isArray(n)) {
        issues.push({
          severity: 'error', code: 'MALFORMED_NODE',
          message: 'A step is missing required fields.',
          nodeId: null, field: null,
        });
        continue;
      }
      nodes.push(n);
    }
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

        // A `deliver` node's config is deliver's OWN keys plus the SELECTED
        // CHANNEL's — because a delivery channel is a capability with its own
        // parameters, and the channel is the only place they can be declared.
        //
        // Increment A missed this and it was a live defect: `sheets_append`'s
        // handler reads `config.spreadsheetId` and `config.range`
        // (src/connectors/google/index.js:694) and `airtable_create_record`
        // reads baseId/tableId/fields — none of which `deliver` declares, so
        // EVERY delivery to a Sheet or an Airtable base was rejected at publish
        // with UNKNOWN_CONFIG_KEY. The converger's own system prompt renders
        // those exact shapes from the channel catalog and tells the model to
        // emit them, so the builder was instructing users to build workflows it
        // would then refuse to save. (slack/gmail escaped only because their
        // keys happen to overlap deliver's own.)
        //
        // This is a narrowing of the schema's LIE, not a widening of the check:
        // an undeclared key is still an error, `model` is still rejected, and
        // `message` is still rejected. The keys now checked against are simply
        // the true ones. Where the channel cannot be resolved (no registry
        // wired), its params are unknowable — so they are not judged, exactly as
        // connector-action's are not.
        if (node.type === 'deliver') {
          for (const f of this._channelConfigSchema(cfg.channel)) declared.add(f.key);
        }

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

    // ── 9. The outcome contract + the moat (P12 Increment C) ──────────────
    this._checkOutcome(def, nodes, issues);
    this._checkDecisionInputs(nodes, issues);

    return this._finalize(issues);
  }

  /**
   * UNSATISFIED_ASSERTION — every `outcome.assertions[]` must map to at least one
   * node that satisfies it.
   *
   * This is the check that makes defect #1 impossible. The converger was asked
   * for Slack AND Gmail, confirmed both, and emitted a spec containing only
   * Slack; the user found out when the emails never arrived. Nothing in the
   * system had declared what the finished workflow was supposed to PRODUCE, so
   * nothing could notice that it didn't. Now the outcome declares it, and a spec
   * that doesn't deliver on its own contract does not publish.
   *
   * Satisfaction is decided by ./outcome-oracle.js — the SAME implementation the
   * converger's gap scorer uses. Deliberately: two copies of this rule would
   * drift, and the day they drift is the day the converger ratifies a spec that
   * publish then rejects, which is a dead end the user cannot get out of.
   */
  _checkOutcome(def, nodes, issues) {
    const outcome = def?.outcome;

    // v1 specs have no outcome and never will. Only a spec that declares itself
    // v2 is held to the contract — otherwise every workflow in the database
    // becomes unpublishable overnight (§8: absent version ⇒ 1).
    if (!outcome) {
      if (Number(def?.version) === 2) {
        issues.push({
          severity: 'error', code: 'MISSING_OUTCOME',
          message: 'This workflow declares no outcome, so there is no way to tell whether it works.',
          nodeId: null, field: 'outcome',
          hint: 'Add outcome.statement and at least one assertion describing what must be true after a run.',
        });
      }
      return;
    }

    const assertions = Array.isArray(outcome.assertions) ? outcome.assertions : [];
    if (!assertions.length) {
      issues.push({
        severity: 'error', code: 'MISSING_OUTCOME',
        message: 'The outcome states what should happen but lists no checkable assertions.',
        nodeId: null, field: 'outcome.assertions',
        hint: `Each assertion is { id, kind, target } — kind is one of: ${ASSERTION_KINDS.join(', ')}.`,
      });
      return;
    }

    const { unsatisfied, malformed, satisfied } = checkOutcome(outcome, nodes);

    // An assertion we cannot CHECK must never pass quietly. Silently ignoring an
    // unknown kind is the same failure as dropping the delivery it asked for —
    // the user is told the contract is met when nobody ever tested it.
    for (const { assertion, reason } of malformed) {
      issues.push({
        severity: 'error', code: 'MALFORMED_ASSERTION',
        message: `The outcome promises "${assertion?.id ?? assertion?.target ?? 'something'}", but ${reason} — so nothing can verify it.`,
        nodeId: null, field: 'outcome.assertions',
        hint: `An assertion is { id, kind, target }, where kind is one of: ${ASSERTION_KINDS.join(', ')}, and target is "<connector>:<destination>" (e.g. "slack:#ops").`,
      });
    }

    for (const a of unsatisfied) {
      issues.push({
        severity: 'error', code: 'UNSATISFIED_ASSERTION',
        message: `The outcome promises "${a.target}" (${a.kind}), but no step in this workflow does that — the request would be silently dropped.`,
        nodeId: null, field: 'outcome.assertions',
        hint: `Add a step that delivers to ${a.target}, or remove the promise from the outcome. Do not publish a workflow that quietly does less than it says.`,
      });
    }

    // Assertion ids must be UNIQUE. They are the handle everything else uses to
    // refer to a promise — the gap list, the provenance record, the SOP. Two
    // assertions wearing one id is an ambiguity that resolves, silently, in
    // favour of whichever came first. An LLM generates these ids, so this is not
    // a theoretical concern.
    const seenAssertionIds = new Set();
    for (const a of assertions) {
      const id = a?.id;
      if (!id) continue;
      if (seenAssertionIds.has(id)) {
        issues.push({
          severity: 'error', code: 'DUPLICATE_ASSERTION_ID',
          message: `Two of the outcome's promises share the id "${id}" — one of them would be quietly ignored.`,
          nodeId: null, field: 'outcome.assertions',
          hint: 'Give every assertion its own id (a1, a2, …).',
        });
      }
      seenAssertionIds.add(id);
    }

    // A satisfied assertion that named FIELDS is only really satisfied if the
    // node sets them. Reported only when the node's field names are readable —
    // we never accuse a spec of dropping a field we merely could not see.
    //
    // Keyed by INDEX, not id — see checkOutcome(). Looking the assertion back up
    // by id took `.find()`'s first hit, so a duplicate id checked the wrong
    // assertion's fields.
    for (const [idx, hits] of satisfied) {
      const a = assertions[idx];
      if (!a?.fields?.length) continue;
      const anyComplete = hits.some(n => missingFields(a, n).length === 0);
      if (anyComplete) continue;
      const gapsByNode = hits.map(n => ({ n, miss: missingFields(a, n) })).filter(x => x.miss.length);
      if (!gapsByNode.length) continue;
      const { n, miss } = gapsByNode[0];
      issues.push({
        severity: 'error', code: 'UNSATISFIED_ASSERTION',
        message: `The outcome promises ${a.target} will carry ${miss.join(', ')}, but "${n.label || n.id}" never sets ${miss.length > 1 ? 'those fields' : 'that field'}.`,
        nodeId: n.id, field: 'config.fields',
        hint: `Set ${miss.join(', ')} on that step, or drop ${miss.length > 1 ? 'them' : 'it'} from the outcome.`,
      });
    }
  }

  /**
   * LLM_INPUT_NOT_ENUM — §11.7. THE MOAT. Never weaken this.
   *
   * An LLM-evaluated decision input MUST classify into a CLOSED ENUM. Not
   * because free text is untidy, but because a free-text input has an INFINITE
   * domain — and coverage over an infinite domain is not provable. One such
   * input makes the whole table undecidable, which deletes the completeness
   * proof, which is the entire product (see decision-analysis.js).
   *
   * Atlas's claim is "I can tell you what I don't know about your process". A
   * system that cannot enumerate the cases cannot know which ones are missing,
   * and would be reduced to *asserting* completeness it never established. A
   * false proof is worse than no proof: the user stops looking.
   *
   * Two shapes, one rule — because an LLM feeding a decision is an LLM feeding a
   * decision, whichever node type spells it:
   *
   *   1. a `decision` input with evaluator:'llm' that is not a closed enum
   *      (Increment E runs these; the rule is enforced from C so no such spec
   *      can be built in the meantime);
   *   2. a `branch` routing on an `llm` node that is not in `classify` mode —
   *      routing on free prose is the same undecidable input wearing a different
   *      hat, and `classify` exists precisely to be the sanctioned way through
   *      (it throws on an off-enum answer instead of passing it downstream).
   *
   * Runs OUTSIDE the node-type loop on purpose: `decision` is not a registered
   * type until Increment E, so it exits that loop early as UNKNOWN_NODE_TYPE.
   * The moat must not depend on the node being runnable yet.
   */
  _checkDecisionInputs(nodes, issues) {
    const byId = new Map(nodes.filter(n => n?.id).map(n => [n.id, n]));

    for (const node of nodes) {
      if (node?.type === 'decision') {
        const inputs = Array.isArray(node.inputs) ? node.inputs
                     : Array.isArray(node.config?.inputs) ? node.config.inputs
                     : [];
        for (const input of inputs) {
          if (String(input?.evaluator ?? '').toLowerCase() !== 'llm') continue;
          const isEnum  = String(input?.type ?? '').toLowerCase() === 'enum';
          const values  = Array.isArray(input?.values) ? input.values.filter(v => v != null) : [];
          if (isEnum && values.length >= 2) continue;
          issues.push({
            severity: 'error', code: 'LLM_INPUT_NOT_ENUM',
            message: `"${node.label || node.id}" asks the AI to judge "${input?.key ?? 'an input'}" but doesn't give it a closed list of answers — so there is no way to prove the table covers every case.`,
            nodeId: node.id, field: 'inputs',
            hint: 'An AI-judged input must be { "type": "enum", "values": ["…", "…"] } with every possible answer listed. Free text has an unbounded domain, so coverage cannot be checked and the workflow could silently do nothing on an input nobody anticipated.',
          });
        }
      }

      if (node?.type === 'branch') {
        const onRef = String(node.config?.on ?? '').trim().replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
        const onId  = /^([a-z0-9_-]+)(?:\.output)?$/i.exec(onRef)?.[1] ?? null;
        const src   = onId ? byId.get(onId) : null;
        if (!src) continue;   // no such step — BRANCH_BAD_ON already reports it

        // ── The rule is an ALLOWLIST, and it has to be ────────────────────
        //
        // The first version of this check asked "is the branch's source an `llm`
        // node that isn't classifying?" — a DENYLIST, and it was bypassed by a
        // single laundering hop: put an `assemble` between a freeform `llm` and
        // the branch (`content: "{{think.output}}"`, a shape the converger is
        // explicitly taught to emit) and the moat never fires. The branch then
        // routes on free prose, nothing matches, and the MANDATORY CATCH-ALL
        // SWALLOWS 100% OF TRAFFIC — silently, with `run_completed`. The same
        // hole existed through `search_web` and `connector-action`. (Found by the
        // test-adversary.)
        //
        // The property §11.7 actually requires is "the value being routed on has
        // a CLOSED, DECLARED domain" — not "its immediate parent isn't an LLM".
        // Laundering a value through another node does not bound its domain; it
        // only hides who produced it. So we ask the question the moat actually
        // asks, and a node type earns its way ONTO this list by declaring the set
        // of values it can emit:
        //
        //   llm + mode:'classify'  → `categories` — a closed enum, and run() throws off-enum
        //   decision               → `output.values` — a closed enum (Increment E)
        //   human                  → `decisions` — approve|reject|timeout (Increment D)
        //
        // Anything else is an open domain. Adding a new source means declaring
        // its value set, which is exactly the discipline that keeps the
        // completeness proof true.
        const mode = String(src.config?.mode ?? 'freeform').toLowerCase();
        if (closedDomainOf(src)) continue;

        const what = src.type === 'llm'
          ? `an AI step in ${mode} mode — it emits free text`
          : `a ${src.type} step, whose output is not a closed set of values`;
        issues.push({
          severity: 'error', code: 'LLM_INPUT_NOT_ENUM',
          message: `"${node.label || node.id}" routes on "${src.label || src.id}", ${what}, so the cases can never be proven to cover every value it might produce — an unanticipated one would fall through to the catch-all and the workflow would silently do nothing.`,
          nodeId: node.id, field: 'config.on',
          hint: `A branch may only route on a value with a closed, declared set of possibilities: an AI step in "classify" mode (list its categories), a decision table, or a human approval. Put a classify step in front of "${src.id}" and route on that.`,
        });
      }
    }

    // ── BRANCH_CASE_NOT_IN_ENUM ───────────────────────────────────────────
    //
    // We forced the routed-on value into a CLOSED ENUM (that is the moat) — and
    // then never checked the cases against it. A branch whose cases name values
    // the classifier CANNOT PRODUCE ("HIGH" when the categories are
    // urgent|normal) matches nothing, so the mandatory catch-all swallows 100% of
    // traffic — forever, silently, with `run_completed` — while the converger
    // told the user the workflow was finished. That is verbatim the failure
    // BRANCH_BAD_ON exists to prevent, reached through the case VALUES instead of
    // the `on` reference.
    //
    // Making the domain closed is only half the job: the point of a closed domain
    // is that membership becomes DECIDABLE. Not deciding it is a completeness
    // claim we did not check. (Found by the independent verifier.)
    for (const node of nodes) {
      if (node?.type !== 'branch') continue;
      const onRef = String(node.config?.on ?? '').trim().replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
      const onId  = /^([a-z0-9_-]+)(?:\.output)?$/i.exec(onRef)?.[1] ?? null;
      const src   = onId ? byId.get(onId) : null;
      if (!src) continue;

      const domain = closedDomainOf(src);
      if (!domain) continue;   // not a closed-domain source — LLM_INPUT_NOT_ENUM already fired

      const known = new Set(domain.map(v => String(v).trim().toLowerCase()));
      for (const c of normalizeCases(node.config?.cases)) {
        const when = String(c?.when ?? '').trim();
        if (!when || when === CATCH_ALL) continue;
        if (known.has(when.toLowerCase())) continue;
        issues.push({
          severity: 'error', code: 'BRANCH_CASE_NOT_IN_ENUM',
          message: `"${node.label || node.id}" has a case for "${when}", but "${src.label || src.id}" can only ever produce: ${domain.join(', ')}. That case can never match, so everything would fall through to the catch-all.`,
          nodeId: node.id, field: 'config.cases',
          hint: `Use one of: ${domain.join(', ')} — or add "${when}" to "${src.id}"'s list of possible answers.`,
        });
      }
    }
  }

  /**
   * `branch` / `foreach` / `human` rules that need the EDGE LIST, so they can't
   * live in a node type's own validate(node) hook.
   */
  _checkControlFlow(nodes, edges, seenIds, issues) {
    // One key function for every edge lookup below. This used to be built with a
    // literal NUL separator — invisible in an editor, invisible in a diff, and it
    // silently did not match the one site that used a space, so ON_ERROR_ROUTE_NO_EDGE
    // fired on every route_to even when the edge was there. Never use an
    // unprintable character as a separator (CLAUDE.md, `server.js` encoding).
    const edgeKey = (from, to) => `${from}->${to}`;
    const edgeSet = new Set(edges.filter(e => e?.from && e?.to).map(e => edgeKey(e.from, e.to)));

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

        // ── BRANCH_BAD_ON ─────────────────────────────────────────────────
        // The value a branch routes on is the ONE thing the node exists to read,
        // and it was the one thing never checked. A single-letter typo
        // ("clasify.output") is not a template, so BAD_TEMPLATE_REF never fires;
        // the engine treats it as a literal, it matches no case, and the
        // MANDATORY catch-all then swallows 100% of traffic — forever, silently,
        // with run_completed and no warning. The catch-all that exists to prevent
        // a silent misroute ends up MASKING one.
        const onRef = String(node.config?.on ?? '').trim().replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
        const onId  = /^([a-z0-9_-]+)(?:\.output)?$/i.exec(onRef)?.[1] ?? null;
        if (!onRef) {
          issues.push({
            severity: 'error', code: 'MISSING_CONFIG',
            message: `"${node.label || node.id}" is a branch but doesn't say what to route on.`,
            nodeId: node.id, field: 'config.on',
            hint: 'Point it at an earlier step, e.g. "classify.output".',
          });
        } else if (!onId || !seenIds.has(onId)) {
          issues.push({
            severity: 'error', code: 'BRANCH_BAD_ON',
            message: `"${node.label || node.id}" routes on "${node.config.on}", which is not a step in this workflow — so nothing would ever match and every run would fall through to the catch-all.`,
            nodeId: node.id, field: 'config.on',
            hint: `Use "<stepId>.output" — one of: ${[...seenIds].join(', ')}.`,
          });
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
          if (!edgeSet.has(edgeKey(node.id, to))) {
            issues.push({
              severity: 'error', code: 'BRANCH_CASE_NO_EDGE',
              message: `"${node.label || node.id}" routes to "${to}", but there is no connection drawn from it to "${to}" — so "${to}" would run no matter which case matched.`,
              nodeId: node.id, field: 'edges',
              hint: `Add an edge { "from": "${node.id}", "to": "${to}" } for every case.`,
            });
          }

          // A case target must be reached ONLY through the branch. If something
          // else also feeds it, that other edge is live whichever way the branch
          // went — so the step runs even when the branch ruled it out, and the
          // branch decides nothing. The graph is genuinely ambiguous, so make it
          // a build error rather than a runtime coin-flip. To use another step's
          // data, reference it with {{stepId.output}} — a template needs no edge.
          const otherParents = edges
            .filter(e => e?.to === to && e.from !== node.id)
            .map(e => e.from);
          if (otherParents.length) {
            issues.push({
              severity: 'error', code: 'BRANCH_TARGET_EXTRA_PARENT',
              message: `"${to}" is a destination of "${node.label || node.id}", but ${otherParents.map(p => `"${p}"`).join(', ')} also connects to it — so it would run even when the branch routes the other way, and the branch would decide nothing.`,
              nodeId: to, field: 'edges',
              hint: `Remove the connection${otherParents.length > 1 ? 's' : ''} from ${otherParents.map(p => `"${p}"`).join(', ')} to "${to}". To use that step's data, reference it as {{${otherParents[0]}.output}} — a template needs no connection.`,
            });
          }
        }
      }

      // on_error: route_to must point somewhere the run can still GO. An edge
      // from the failing node guarantees the target sorts AFTER it in
      // topological order. Without one, the target has usually already run (or
      // will be skipped), so the failure path silently never executes — and the
      // run reports success while the error was never handled.
      const errThen = node?.on_error?.then;
      if (typeof errThen === 'string' && errThen.startsWith('route_to:')) {
        const target = errThen.slice('route_to:'.length).trim();
        if (!seenIds.has(target)) {
          issues.push({
            severity: 'error', code: 'ON_ERROR_BAD_TARGET',
            message: `"${node.label || node.id}" sends failures to "${target}", but there's no step with that id.`,
            nodeId: node.id, field: 'on_error',
          });
        } else if (!edgeSet.has(edgeKey(node.id, target))) {
          issues.push({
            severity: 'error', code: 'ON_ERROR_ROUTE_NO_EDGE',
            message: `"${node.label || node.id}" sends failures to "${target}", but there is no connection drawn from it to "${target}" — the failure path would never run, and the workflow would report success anyway.`,
            nodeId: node.id, field: 'edges',
            hint: `Add an edge { "from": "${node.id}", "to": "${target}" }.`,
          });
        }
      }

      // A `foreach` sub-step is a real step: it writes, and it can be retried.
      // The checks below must see it, or the highest-risk write shape in the
      // engine (N writes per fire) is the only one nobody warns about.
      if (node?.type === 'foreach') {
        for (const sub of normalizeSteps(node.config?.steps)) {
          if (sub?.on_error?.then) {
            issues.push({
              severity: 'error', code: 'ON_ERROR_IN_FOREACH',
              message: `"${sub.id || 'a step'}" inside "${node.label || node.id}" declares an error route, but there are no connections inside a loop for it to follow.`,
              nodeId: node.id, field: 'config.steps',
              hint: 'Inside a loop only `retry` is meaningful. Handle the failure after the loop.',
            });
          }
          const act = String(sub?.config?.action ?? '');
          if (sub?.type === 'connector-action' && !sub.idempotency?.key
              && /(^|_)(create|append|send|post|add|insert)(_|$)/i.test(act)) {
            issues.push({
              severity: 'warning', code: 'WRITE_WITHOUT_IDEMPOTENCY',
              message: `"${sub.id || act}" writes ("${act}") inside a loop and has no idempotency key — if the trigger fires twice it writes every row twice.`,
              nodeId: node.id, field: 'config.steps',
              hint: 'Add idempotency: { "key": "{{item}}", "on_conflict": "skip" } to the step inside the loop.',
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
   * The config keys a delivery CHANNEL declares for itself. Empty when the
   * channel cannot be resolved — an unknowable key set is not a wrong one, and
   * `UNKNOWN_CHANNEL` already reports a channel that does not exist.
   *
   * The registry may be a real ChannelRegistry or the plain catalog view the
   * converger holds (`capabilities.channels`) — both expose `get(id).configSchema`.
   */
  _channelConfigSchema(channelId) {
    if (!channelId || !this.channelRegistry) return [];
    try {
      const ch = this.channelRegistry.get?.(channelId);
      return Array.isArray(ch?.configSchema) ? ch.configSchema : [];
    } catch {
      return [];
    }
  }

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

/**
 * The CLOSED SET OF VALUES a node can emit — or `null` if its domain is open.
 *
 * ONE definition, used by both branch rules: the allowlist that decides whether a
 * branch may route on this node at all (LLM_INPUT_NOT_ENUM), and the check that
 * its cases name values the node can actually produce (BRANCH_CASE_NOT_IN_ENUM).
 * Two copies of "what can this node emit?" would drift, and a drift here means
 * one rule believes the domain is closed while the other does not — which is how
 * a branch ends up validated against an enum nobody enforced.
 *
 * A node type earns its place here by DECLARING its possible values. That is the
 * whole discipline behind the completeness proof (converger-v2 §11.7): if you add
 * a source whose values are not declarable, you have not extended the moat — you
 * have deleted it.
 */
function closedDomainOf(node) {
  if (!node || typeof node !== 'object') return null;

  if (node.type === 'llm') {
    const mode = String(node.config?.mode ?? 'freeform').toLowerCase();
    if (mode !== 'classify') return null;
    const cats = parseEnumList(node.config?.categories);
    return cats.length >= 2 ? cats : null;
  }

  // decision (Increment E) — the output enum.
  if (node.type === 'decision') {
    const out = node.output ?? node.config?.output;
    const vals = Array.isArray(out?.values) ? out.values.filter(v => v != null).map(String) : [];
    return vals.length >= 2 ? vals : null;
  }

  // human (Increment D) — approve / reject, plus the timeout the engine can inject.
  if (node.type === 'human') {
    const declared = parseEnumList(node.config?.decisions);
    const base = declared.length ? declared : ['approve', 'reject'];
    return [...new Set([...base, 'timeout'])];
  }

  return null;
}

/** A declared value list may arrive newline-separated, comma-separated, or as an array. */
function parseEnumList(v) {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v !== 'string') return [];
  return v.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}
