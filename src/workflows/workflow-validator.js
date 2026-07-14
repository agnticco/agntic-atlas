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
import { normalizeCases, CATCH_ALL, ON_REF } from './node-types/branch.js';
import { normalizeSteps } from './node-types/foreach.js';
import { normalizeChannels, normalizeDecisions, allowedDecisions, TIMEOUT_DECISION } from './node-types/human.js';
import { isStrong, FORBIDDEN_CHANNELS } from './approval-channels.js';
import { parseDuration } from './duration.js';
import { checkOutcome, missingFields, ASSERTION_KINDS } from './outcome-oracle.js';
import { analyzeTable } from './decision-analysis.js';
import { tableOf, valuesOf } from './node-types/decision.js';

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
   * @param {{has:Function,list:Function}} [deps.approvalChannels] — which approval
   *        channels this workspace can actually ask over (approval-channels.js).
   *        Null = this caller cannot see the catalog, so the connectedness check
   *        skips here and the GAP SCORER fails closed instead. See _checkHumanNode.
   */
  constructor({ sourceRegistry = null, toolRegistry = null, channelRegistry = null, nodeTypes = null, approvalChannels = null } = {}) {
    this.sourceRegistry    = sourceRegistry;
    this.toolRegistry      = toolRegistry;
    this.channelRegistry   = channelRegistry;
    this.nodeTypes         = nodeTypes;
    this.approvalChannels  = approvalChannels;
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

      // Every config check for this node — required keys, UNKNOWN_CONFIG_KEY,
      // the capability's own params, the type-specific rules. ONE implementation,
      // because a `foreach` sub-step is a node too and must be checked identically
      // (P12 Increment F — it was not, and every check F added stopped at the
      // loop's edge).
      if (!this._checkNodeConfig(node, issues)) continue;
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
    // ── A WORKFLOW NEEDS AN EFFECT, NOT A `deliver` NODE ────────────────────
    //
    // This counted `type === 'deliver'` and nothing else, so a workflow whose whole
    // job is to MOVE DATA — inbound email → extract → create an Airtable record —
    // was rejected unless a pointless delivery was bolted onto the end. The record
    // IS the outcome. Demanding a `deliver` on top of it is the same failure as the
    // old five-item checklist that made the converger invent an LLM step for a
    // genuinely two-step workflow (defect #4, killed in Increment C): a checklist
    // shaped like one workflow, imposed on every workflow.
    //
    // A workflow is complete when it DOES something outside Atlas. `isWriteNode`
    // already answers exactly that question — a `deliver`, a create/send
    // connector-action, or a `foreach` containing one (it recurses) — and it is the
    // same predicate the approval rules use, so "what counts as an effect" has one
    // definition. (Raised by the operator: workflows take all shapes.)
    const effectNodes = nodes.filter(n => isWriteNode(n));
    const deliverCount = effectNodes.length;
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
        // The code is kept (it is machine-read by the UI and the gap scorer), but the
        // rule it names is broader than its name: what is missing is an EFFECT.
        severity: 'error', code: 'MISSING_DELIVER',
        message: 'The workflow never does anything — it reads and thinks, but nothing leaves Atlas.',
        nodeId: null, field: null,
        hint: 'End it with something real: deliver the result somewhere, or create/update a record. A workflow whose output nobody receives has no output.',
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

    // ── 10. DMN coverage — the completeness proof (P12 Increment E) ───────
    this._checkDecisionTables(nodes, issues);

    return this._finalize(issues);
  }

  /**
   * DECISION_TABLE_GAP · UNIQUE_HIT_OVERLAP — the DMN analysis, at PUBLISH.
   * (P12 Increment E, converger-v2 §5.)
   *
   * Increment C built `decision-analysis.js` and wired it into the converger's
   * gap scorer only. That left the proof on one side of the door: a table with a
   * hole could be assembled by any other path — the builder, the API, an edited
   * spec — and publish would never look at it. Now BOTH consult the same oracle,
   * for exactly the reason outcome-oracle.js exists (CLAUDE.md, Increment C): two
   * implementations of "is this table complete?" would drift, and the day they
   * drift is the day the converger ratifies a spec that publish rejects — a dead
   * end the user cannot argue their way out of. The gap scorer now CLASSIFIES
   * these issues rather than recomputing them.
   *
   * The severities are what keep `complete ⇒ publishable` true:
   *
   *   gap        WARNING — an uncovered case is escalatable, not fatal. It is
   *              honest to publish a workflow that hands an unanticipated case to
   *              a person (that is §6.2.4, and it is what makes "Accept all
   *              defaults" a real button). It would NOT be honest to publish one
   *              that silently does nothing — so `decision.run()` THROWS on an
   *              uncovered case, and the escalation materialises as an error path
   *              to a person (escalation.js). The warning is a promise the engine
   *              keeps.
   *   overlap    ERROR — under UNIQUE the table PROMISES exactly one rule ever
   *              matches. If two can, the promise is false, and which answer you
   *              get depends on rule order in a table whose author was told order
   *              does not matter.
   *   undecidable / bad condition
   *              ERROR (undecidable downgrades to a warning when a catch-all
   *              exists — a catch-all is the one honest answer to a domain we
   *              cannot enumerate). A table we cannot read gets NO coverage claim,
   *              ever. A false proof is worse than no proof.
   */
  _checkDecisionTables(nodes, issues) {
    for (const node of nodes) {
      if (node?.type !== 'decision') continue;

      const analysis = analyzeTable(tableOf(node));
      const label    = node.label || node.id;

      if (!analysis.decidable) {
        for (const u of analysis.undecidable) {
          issues.push({
            severity: analysis.hasCatchAll ? 'warning' : 'error',
            code: 'DECISION_UNDECIDABLE',
            message: `"${label}" decides on "${u.key}", but ${u.reason} — so I can't prove every case is covered.`,
            nodeId: node.id, field: 'config.inputs',
            hint: 'Give it a closed list of possible values, or add a catch-all rule (every input "-") so an unanticipated input still goes somewhere.',
          });
        }
        for (const b of analysis.badConditions) {
          issues.push({
            severity: 'error', code: 'DECISION_BAD_CONDITION',
            message: `Rule ${b.rule + 1} of "${label}" tests "${b.key}" with "${b.condition}", which isn't a condition this system can check.`,
            nodeId: node.id, field: 'config.rules',
            hint: 'Allowed: a literal, a comma list, < <= > >=, an interval like [10..50], not(...), or "-" for "don\'t care".',
          });
        }
        continue;   // no coverage claim is made about a table we cannot read
      }

      for (const box of analysis.uncovered) {
        const where = Object.entries(box).map(([k, v]) => `${k} ${v}`).join(', ');
        issues.push({
          severity: 'warning', code: 'DECISION_TABLE_GAP',
          message: `"${label}" has no rule for: ${where}. Right now the workflow would silently do nothing for those.`,
          nodeId: node.id, field: 'config.rules',
          hint: 'Answer it, or let it escalate — an unanticipated case goes to a person instead of vanishing.',
        });
      }
      if (analysis.truncated) {
        issues.push({
          severity: 'warning', code: 'DECISION_TABLE_GAP',
          message: `"${label}" has ${analysis.truncated} further uncovered combination${analysis.truncated > 1 ? 's' : ''} beyond the ones listed.`,
          nodeId: node.id, field: 'config.rules',
          hint: 'A table with this many holes is usually two decisions wearing one hat. Consider splitting it.',
        });
      }

      for (const o of analysis.overlaps) {
        const where = Object.entries(o.where).map(([k, v]) => `${k} ${v}`).join(', ');
        issues.push({
          severity: 'error', code: 'UNIQUE_HIT_OVERLAP',
          message: `"${label}" promises exactly one rule ever matches, but rules ${o.rules[0] + 1} and ${o.rules[1] + 1} both match ${where}.`,
          nodeId: node.id, field: 'config.rules',
          hint: 'Either narrow the rules so they cannot both match, or change the hit policy to "first match wins".',
        });
      }
    }
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
        // tableOf(), NOT a private re-read. The private one accepted only a real
        // ARRAY — but `listOf` deliberately parses a JSON-STRING config (the
        // textarea path), and tableOf / _checkDecisionTables / closedDomainOf all
        // honour that spelling. So a decision whose `config.inputs` was a string
        // carrying an `evaluator:'llm'` free-text input published clean: the moat's
        // build-time half silently did not run on a spelling the rest of the system
        // reads. One reader, or the checks disagree about what the table even says.
        // (Found by the independent verifier, R1.)
        const inputs = tableOf(node).inputs;
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
        // ON_REF, the SHARED grammar (branch.js), not a private copy. Increment D
        // taught BRANCH_BAD_ON the `.decision` form and left these two checks on
        // the old `/\.output?$/` — so on `{{ask.decision}}`, the one shape §7.1
        // documents and escalation.js emits, `onId` came back null and both the
        // moat (LLM_INPUT_NOT_ENUM) and the case-membership check silently did not
        // run. Three parsers of one reference is three chances to disagree; there
        // is now one. (Found by the verifier + the test-adversary, F1.)
        const onId  = ON_REF.exec(onRef)?.[1] ?? null;
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
          : src.type === 'decision' && tableOf(src).hitPolicy === 'COLLECT'
            ? 'a decision that COLLECTS every matching rule — it emits a list, not a single value'
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
      const onId  = ON_REF.exec(onRef)?.[1] ?? null;   // shared grammar — see the moat block above (F1)
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
        // The SAME reference grammar the engine resolves (branch.js ON_REF). If
        // these two ever disagree, the validator accepts a reference the engine
        // cannot read — and the engine's answer to a reference it cannot read is
        // the catch-all, on every run, silently.
        const onRef = String(node.config?.on ?? '').trim().replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
        const onMatch = ON_REF.exec(onRef);
        const onId    = onMatch?.[1] ?? null;
        const onField = onMatch?.[2]?.toLowerCase() ?? null;

        // `.decision` names a field only a `human` node has. On anything else the
        // engine throws rather than misroute — so catch it at build time, where it
        // is a sentence instead of a broken run.
        if (onId && onField === 'decision' && seenIds.has(onId)) {
          const src = nodes.find(n => n?.id === onId);
          if (src && src.type !== 'human') {
            issues.push({
              severity: 'error', code: 'BRANCH_BAD_ON',
              message: `"${node.label || node.id}" routes on "${node.config.on}", but "${onId}" is not a step that asks a person — only a human step produces a decision.`,
              nodeId: node.id, field: 'config.on',
              hint: `Route on "${onId}.output" instead, or point it at the human step whose answer you meant.`,
            });
          }
        }
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

      // ── The approval gate (P12 Increment D, converger-v2 §7.7) ────────────
      // An approval anyone can forge is not an approval, and a pause nobody can
      // answer is a hang. Both are build errors, not run-time surprises.
      if (node?.type === 'human') {
        this._checkHumanNode(node, nodes, edges, issues);
      }

      // A `foreach` sub-step is a real step: it writes, and it can be retried.
      // The checks below must see it, or the highest-risk write shape in the
      // engine (N writes per fire) is the only one nobody warns about.
      if (node?.type === 'foreach') {
        // ── EVERY CONFIG CHECK RECURSES INTO THE LOOP (P12 Increment F) ────────
        //
        // The validator's node loop walks `spec.nodes`; a loop's steps live in
        // `config.steps`, so every check written for a top-level node stopped at the
        // loop's edge. A `connector-action` INSIDE a foreach took a nonexistent
        // action id, a hallucinated param, a missing `tableId`, an unknown column and
        // the dead `model` key — and validated clean, scored complete. The identical
        // node one level up is rejected on all five.
        //
        // This is the laundering hop CLAUDE.md names four times now (BRANCH_IN_FOREACH,
        // the sub-loop's own CONTROL_SUBSTEP_TYPES, `isWriteNode`'s recursion in D4,
        // and this). It is NEWLY reachable because Increment F's own prompt teaches
        // `foreach` for the first time — with the example "create a record for every
        // row", which is precisely an `airtable_create_record` inside a loop: the exact
        // node whose params F had just started checking. F taught the model to emit the
        // one shape where none of its checks could see. (Found by the verifier + the
        // test-adversary.)
        //
        // A RULE, not a patch: a check on a node's CONFIG is a check on every node's
        // config, wherever the node lives. `_checkNodeConfig` is the one place that
        // knows how, and both call sites use it.
        for (const sub of normalizeSteps(node.config?.steps)) {
          this._checkNodeConfig(sub, issues, { inForeach: node });
        }
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
          if (sub?.type === 'connector-action' && !sub.idempotency?.key && isWritingAction(act)) {
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
        if (isWritingAction(action)) {
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

  /**
   * The `human` approval gate (converger-v2 §7.7). Needs the edge list — "does
   * this approval guard a write?" is a question about what lies DOWNSTREAM of
   * it, which a node's own validate(node) hook cannot see.
   */
  _checkHumanNode(node, nodes, edges, issues) {
    const label = node.label || node.id;
    const channels = normalizeChannels(node.config?.channels);

    // ── EMAIL_REPLY_APPROVAL (§11.8) ────────────────────────────────────────
    // The hard rule of this increment. Parsing "yes" out of a reply body
    // authenticates NOTHING: `From:` is trivially spoofable, SPF/DKIM
    // authenticate a sending DOMAIN and not a human INTENT, and a forwarded
    // thread is full of the word "yes". There is no safe configuration of it, so
    // it is not a channel with a low score — it is rejected outright.
    for (const ch of channels) {
      if (FORBIDDEN_CHANNELS.includes(String(ch?.type))) {
        issues.push({
          severity: 'error', code: 'EMAIL_REPLY_APPROVAL',
          message: `"${label}" would take its approval from an email reply. That authenticates nobody — a sender address is trivially forged, and a forwarded thread is full of the word "yes".`,
          nodeId: node.id, field: 'config.channels',
          hint: 'Use { "type": "email" } instead: the person gets a signed, single-use link that expires. Or ask in Slack or the in-app inbox, which prove who clicked.',
        });
      }
    }

    // ── APPROVAL_CHANNEL_NOT_CONNECTED ──────────────────────────────────────
    // A question asked over a channel this workspace has not connected is a
    // question nobody is ever asked — and the run waits for the answer forever.
    //
    // `approvalChannels` is null when the caller cannot see the catalog. The
    // check then SKIPS, exactly as the `deliver` channel checks already do — and
    // the gap scorer refuses to certify the spec at all (CHANNELS_UNVERIFIED),
    // so nothing can score `complete` on a check that quietly did not run. That
    // split is deliberate: skipping here and failing closed there is what keeps
    // `complete ⇒ publishable` true without making the validator unusable to
    // every caller that has no registry.
    if (this.approvalChannels) {
      for (const ch of channels) {
        const type = String(ch?.type ?? '');
        if (!type || FORBIDDEN_CHANNELS.includes(type)) continue;   // reported above
        if (!this.approvalChannels.has(type)) {
          issues.push({
            severity: 'error', code: 'APPROVAL_CHANNEL_NOT_CONNECTED',
            message: `"${label}" asks over ${type}, which isn't connected for this workspace — the question would never reach anyone, and the run would wait for an answer that cannot come.`,
            nodeId: node.id, field: 'config.channels',
            hint: `Connect ${type}, or ask somewhere available: ${this.approvalChannels.list().join(', ')}.`,
          });
        }
      }
    }

    if (!channels.length) {
      issues.push({
        severity: 'error', code: 'APPROVAL_CHANNEL_NOT_CONNECTED',
        message: `"${label}" pauses for a person but doesn't say where to ask them, so nobody would ever see the question.`,
        nodeId: node.id, field: 'config.channels',
        hint: 'Add at least one channel, e.g. { "type": "inbox" } — the in-app Approvals list.',
      });
    }

    // ── HUMAN_WITHOUT_TIMEOUT ───────────────────────────────────────────────
    // A pause with no timeout is a workflow that hangs forever. It does not fail,
    // it does not complete, and nothing ever tells anyone — the single most
    // expensive thing a durable pause can do.
    const timeout = node.config?.timeout;
    const after   = typeof timeout === 'object' && timeout ? timeout.after : null;
    if (!after || !parseDuration(after)) {
      issues.push({
        severity: 'error', code: 'HUMAN_WITHOUT_TIMEOUT',
        message: `"${label}" waits for a person but never gives up. If nobody answers, this run waits forever — no error, no output, and nobody is told.`,
        nodeId: node.id, field: 'config.timeout',
        hint: 'Add timeout: { "after": "48h", "then": "reject" } — say what should happen when nobody answers.',
      });
    } else {
      // A `then` nobody declared is the BRANCH_BAD_ON failure through another
      // door: the engine cannot honour an answer that is not in the node's own
      // closed set, so a typo ("aprove") would silently resolve as `timeout` and
      // the run would take a path the author never wrote.
      const then = timeout.then == null ? null : String(timeout.then);
      const allowed = [...allowedDecisions(node.config?.decisions), 'escalate'];
      if (then != null && !allowed.includes(then)) {
        issues.push({
          severity: 'error', code: 'HUMAN_BAD_TIMEOUT',
          message: `"${label}" says that when nobody answers it should "${then}" — but that isn't one of its possible answers, so the run would take a path you didn't write.`,
          nodeId: node.id, field: 'config.timeout',
          hint: `Use one of: ${allowed.join(', ')}.`,
        });
      } else if (then != null && then !== 'escalate' && timeoutAuthorizesWrite({ nodes, edges }, node.id, then)) {
        // SILENCE IS NOT CONSENT (§11 / F3). `then: 'approve'` passes the check
        // above — `approve` IS one of the node's answers — and then the sweeper
        // hands the engine `approve` with `by: 'system:timeout'`: nobody read the
        // draft, and the customer got it. "If nobody answers in 48h, just send it"
        // is a sentence a user says out loud and an LLM will write. A timeout may
        // say DON'T (`reject`) or escalate to a person; it may never perform the
        // very action the approval existed to gate.
        issues.push({
          severity: 'error', code: 'HUMAN_BAD_TIMEOUT',
          message: `"${label}" would go ahead and act if nobody answers ("${then}") — but the whole point of asking is that a real send or write waits for a person. Silence is not approval.`,
          nodeId: node.id, field: 'config.timeout',
          hint: 'On timeout, either stop (e.g. "then": "reject") or hand it to a person ("then": "escalate"). Don\'t let it proceed on its own.',
        });
      }

      // SILENCE IS NOT CONSENT — THROUGH THE CATCH-ALL (found by the verifier,
      // round 2). The trace above only follows `then`; with `then` UNSET (or
      // `escalate`, or a `then` the sweeper downgrades), the value actually
      // injected on silence is `timeout` — which routes through the branch's
      // `timeout` case or its MANDATORY catch-all. So an inverted gate
      // (`cases:[{when:'reject',to:'drop'},{when:'*',to:'send'}]`) with no `then`
      // validated clean and, on a silent timeout, SENT — nobody approved, money
      // moved. Mirror what the sweeper injects, and refuse if THAT writes. (A
      // safe declared `then` the sweeper keeps is checked as `then` above; here we
      // catch the timeout-floor case it does not.)
      const declaredThen = then != null && then !== 'escalate'
        && normalizeDecisions(node.config?.decisions).includes(then);
      const keepsThen = declaredThen && !timeoutAuthorizesWrite({ nodes, edges }, node.id, then);
      if (!keepsThen && timeoutAuthorizesWrite({ nodes, edges }, node.id, TIMEOUT_DECISION)) {
        issues.push({
          severity: 'error', code: 'HUMAN_BAD_TIMEOUT',
          message: `"${label}" would send or write on a silent timeout — the "if nobody answers" path leads to a real action through the catch-all. An approval that a timeout can bypass is not an approval.`,
          nodeId: node.id, field: 'config.cases',
          hint: 'Route the timeout/catch-all case to a step that does NOT send or write (e.g. one that records "not approved"). Put the real action behind the "approve" case only.',
        });
      }
    }

    // ── WEAK_APPROVAL_FOR_WRITE (§7.2) ──────────────────────────────────────
    // The channel must be at least as strong as the action is risky. `email`
    // proves only POSSESSION OF THE LINK — mailbox access, and the link is
    // forwardable. That is fine for "is this summary any good?"; it is not fine
    // for the step that sends the customer an email or creates the record.
    //
    // An error, not a warning: the whole point of the gate is that somebody
    // ACCOUNTABLE said yes, and a forwarded link cannot tell you who did.
    const guarded = [...descendantsOf(node.id, edges)]
      .map(id => nodes.find(n => n?.id === id))
      .filter(n => n && isWriteNode(n));
    if (guarded.length && channels.length && !channels.some(ch => isStrong(ch?.type))) {
      issues.push({
        severity: 'error', code: 'WEAK_APPROVAL_FOR_WRITE',
        message: `"${label}" approves "${guarded[0].label || guarded[0].id}", which writes or sends for real — but the only way to answer it is an emailed link. Anyone the mail is forwarded to could approve it, and the record would say the wrong person did.`,
        nodeId: node.id, field: 'config.channels',
        hint: 'Add { "type": "slack" } or { "type": "inbox" }: both prove who clicked. Keep the email link as well if you like — the first valid answer wins.',
      });
    }

    // ── HUMAN_ANSWER_NOT_ROUTED — a human alone is NOT a gate (§7.1) ─────────
    // A `human` node only REPORTS its decision, exactly as a `branch` only reports
    // a route. Nothing in the engine stops the next step running whatever the
    // answer was — so `draft → ask → send` DELIVERS A REJECTED DRAFT to the
    // customer. It looks precisely like an approval gate and is precisely a no-op,
    // which is worse than having none. escalation.js and prompts.js both already
    // ASSERT this is enforced ("the validator will reject it if any is missing");
    // this is the rule that makes that assertion true. (Found by the verifier +
    // the test-adversary, F2.)
    //
    // The answer is "read" iff a `branch` routes on THIS human's decision, and the
    // human flows into it. A terminal human (no successors) is fine — nothing runs
    // after it, so there is nothing to gate. The engine enforces the same thing
    // for DB specs that predate this rule (flow-tester propagate()).
    const successors = edges.filter(e => e?.from === node.id).map(e => e.to);
    if (successors.length) {
      const routesOnThis = (n) => n?.type === 'branch' && onRefId(n.config?.on) === node.id;
      const ungated = successors.filter(sid => !routesOnThis(nodes.find(n => n?.id === sid)));
      if (ungated.length) {
        issues.push({
          severity: 'error', code: 'HUMAN_ANSWER_NOT_ROUTED',
          message: `"${label}" asks a person to decide, but its answer isn't used to route anything — "${ungated[0]}" runs whether they approve or reject. An approval nothing acts on is not an approval.`,
          nodeId: node.id, field: 'edges',
          hint: `Send "${label}" into a branch that routes on {{${node.id}.decision}}, and put "${ungated[0]}" behind the "approve" case. Then a rejection actually stops it.`,
        });
      }
    }
  }

  /**
   * EVERY CONFIG CHECK FOR ONE NODE, wherever that node lives.
   *
   * Extracted from validate()'s node loop (P12 Increment F) because a `foreach`'s
   * sub-steps are real nodes — they run, they write, they take connector params —
   * and the loop only ever walked `spec.nodes`. So a `connector-action` inside a
   * loop took a nonexistent action id, a hallucinated param and the dead `model`
   * key, and validated CLEAN, while the identical node one level up was rejected on
   * all three. Every check written for a node must be a check on every node.
   *
   * @returns {boolean} false when the node is so broken that later checks would be
   *          noise (unknown type) — the caller skips it, exactly as the loop did.
   */
  _checkNodeConfig(node, issues, { inForeach = null } = {}) {
    // known type (consult registry if available)
    const typeDef = this.nodeTypes?.get?.(node.type) ?? null;
    if (this.nodeTypes && !typeDef) {
      issues.push({
        severity: 'error', code: 'UNKNOWN_NODE_TYPE',
        message: `Step "${node.id}" uses an unsupported type "${node.type}".`,
        nodeId: node.id, field: 'type',
        hint: `Allowed: ${this.nodeTypes.typeIds().join(', ')}.`,
      });
      return false;
    }

    const cfg = node.config ?? {};

    // required config — inferred from the type's configSchema (fields
    // without `optional: true` are required).
    //
    // For a `connector-action` and a `deliver`, "required" also includes the
    // SELECTED CAPABILITY's own required params (P12 Increment F). An
    // `airtable_create_record` with no `baseId` is not a workflow with a small
    // omission — it is one that cannot possibly run, and it used to publish
    // clean and fail at 3am against a real customer's trigger.
    const capSchema = this._capabilitySchemaFor(node, cfg);
    const schema    = [...(typeDef?.configSchema ?? []), ...capSchema];
    const required  = schema.filter(f => !f.optional).map(f => f.key);
    for (const key of [...new Set(required)]) {
      const v = cfg[key];
      if (v == null || (typeof v === 'string' && !v.trim())) {
        issues.push({
          severity: 'error', code: 'MISSING_CONFIG',
          message: `"${node.label || node.id}" is a ${typeDef?.label || node.type} step but is missing its ${key}.`,
          nodeId: node.id, field: `config.${key}`,
          hint: schema.find(f => f.key === key)?.hint ?? this._requiredFieldHint(node.type, key),
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
    // NOTHING IS 'open' ANY MORE (P12 Increment F). `connector-action` was the
    // last one, on the reasoning that its params are per-capability and this
    // schema cannot enumerate them. True — and beside the point: every
    // CAPABILITY declares its own `configSchema`, so the key set is simply
    // "the node's own keys ∪ the selected capability's", exactly as `deliver`
    // has resolved its channel's keys since Increment C. The schema was there
    // all along and was never consulted. `configPolicy` is kept because a
    // future type may genuinely need it, and because a check that cannot be
    // scoped is a check that gets deleted the first time it is inconvenient.
    //
    // ── AND IT ONLY RUNS WHEN THE CAPABILITY CAN BE RESOLVED ──────────────
    //
    // A `deliver` / `connector-action` whose capability we cannot look up has an
    // UNKNOWABLE key set — and an unknowable key set is not a wrong one. Judging
    // it anyway rejects `baseId` on an Airtable action purely because the caller
    // had no registry, which is a false rejection produced by the checker's own
    // configuration rather than by anything in the spec.
    //
    // That is safe to skip precisely because it never happens in production:
    // publish always wires the registry (server.js), and the GAP SCORER REFUSES
    // TO CERTIFY a spec it could not check (CHANNELS_UNVERIFIED). Skipping here
    // and failing closed there is the split that keeps `complete ⇒ publishable`
    // true without making the validator unusable to every caller that has no
    // catalog. (P12 Increment F — the same rule `_checkHumanNode` already applies
    // to approval channels.)
    // Ask the REGISTRY whether it knows the capability — do not infer it from
    // `capSchema.length`, because a capability that genuinely takes no params has
    // an empty schema and is perfectly well resolved. Inferring "resolved" from
    // "has keys" would silently stop checking exactly the capabilities whose key
    // set is `{}` — i.e. the ones where ANY key is a hallucination.
    const capBearing  = node.type === 'deliver' ? cfg.channel
                      : node.type === 'connector-action' ? cfg.action
                      : null;
    const capResolved = !capBearing || !!this._resolveCapability(capBearing);

    if (typeDef && typeDef.configPolicy !== 'open' && capResolved) {
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
      // …and a `connector-action`'s config is ITS own keys plus the SELECTED
      // CAPABILITY's, for exactly the same reason. Same resolver, keyed on
      // `action` instead of `channel` (P12 Increment F).
      for (const f of capSchema) declared.add(f.key);

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
    return true;
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
  /** The capability behind a `deliver`'s channel or a `connector-action`'s action. */
  _resolveCapability(id) {
    if (!id || !this.channelRegistry) return null;
    try { return this.channelRegistry.get?.(id) ?? null; } catch { return null; }
  }

  _channelConfigSchema(channelId) {
    const ch = this._resolveCapability(channelId);
    return Array.isArray(ch?.configSchema) ? ch.configSchema : [];
  }

  /**
   * The params the CAPABILITY this node selected declares for itself.
   *
   * A `deliver` selects one with `config.channel`; a `connector-action` selects one
   * with `config.action`. They are the same catalog and the same question — "what
   * settings does this capability take?" — so they get the same answer from the
   * same place. Two resolvers would be two chances to disagree about whether
   * `baseId` is a real key, and a disagreement there means one of them rejects a
   * spec the other accepts.
   *
   * Empty when the capability cannot be resolved (no registry wired): an
   * unknowable key set is not a wrong one, and `UNKNOWN_CHANNEL` /
   * `UNKNOWN_CONNECTOR_ACTION` already report a capability that does not exist.
   * The gap scorer FAILS CLOSED in that state rather than certifying a spec whose
   * params nobody checked (CHANNELS_UNVERIFIED) — the split that keeps
   * `complete ⇒ publishable` true. (P12 Increment F.)
   */
  _capabilitySchemaFor(node, cfg) {
    if (node?.type === 'deliver')          return this._channelConfigSchema(cfg.channel);
    if (node?.type === 'connector-action') return this._channelConfigSchema(cfg.action);
    return [];
  }

  /**
   * The `fetch` / `tool` / `mcp_tool` branches that used to live here went away
   * with the node types themselves (P12 Increment A) — they resolved ids against
   * a `sourceRegistry` / `toolRegistry` that this build never instantiates. Those
   * types are now rejected up front as REMOVED_NODE_TYPE.
   */
  _checkTypeSpecific(node, issues) {
    const cfg = node.config ?? {};

    // ── UNCHECKABLE_WRITE_FIELDS (P12 Increment F) ─────────────────────────
    //
    // THE COLUMN NAMES OF A WRITE MUST BE KNOWN AT BUILD TIME. Airtable SILENTLY
    // IGNORES a field name that is not a column: the record is created, the column
    // is empty, `run_completed` fires, and the workflow reports success forever.
    // The user finds out when a quarter of their leads have no budgets.
    //
    // Everything else in this increment — reading the real columns, mapping onto
    // them, checking them against the outcome — rests on being able to SEE the
    // column names in the spec. A `fields` that is a TEMPLATE string
    // (`fields: "{{extract.output}}"`) hands that decision to a model at RUN time,
    // where nothing can check it and nothing will ever be told. It is the same
    // unbounded-domain argument as §11.7, applied to columns instead of to a
    // decision input.
    //
    // It was also, until now, the ONLY way to write correct per-column values —
    // the template grammar could not express `{{extract.budget}}`, so the object
    // form could only put the whole JSON blob into every column. That is fixed in
    // the same commit; the correct shape now exists, so the uncheckable one can be
    // refused. (Found by the independent verifier.)
    if (node.type === 'connector-action' || node.type === 'deliver') {
      const f = cfg.fields;
      // A STRING `fields` — templated OR plain JSON — is refused. (P12 Increment F,
      // round 3.)
      //
      // The templated form was already refused: its column names are chosen by a model
      // at RUN time, where nothing can check them. The PLAIN JSON string looked
      // harmless and was worse, because it defeated every column guard while looking
      // checked: the converger's harvest, its rewrite and its re-check each asked
      // `typeof fields === 'object'` in a separate hand-copied line, and all three
      // failed open on a string. So the destination was resolved, the base id written
      // in — and the columns were never looked at. It published; Airtable silently
      // discarded the invented column; the record was created with it empty.
      //
      // And the outcome oracle could not save it: it parses a string `fields` now, so
      // the assertion is CHECKED against the node — but the node's invented column
      // names and the assertion's invented column names HAVE THE SAME AUTHOR, so the
      // check is trivially self-satisfied. Fail-open-and-silent became
      // fail-open-and-confident. (Found by the independent verifier.)
      //
      // This check's own reasoning already settles it: the correct shape now EXISTS
      // ({{step.field}} landed this increment), so the uncheckable one can be refused.
      // An object is the only shape whose columns anything in this system can see.
      if (typeof f === 'string' && !/\{\{/.test(f)) {
        issues.push({
          severity: 'error', code: 'UNCHECKABLE_WRITE_FIELDS',
          message: `"${node.label || node.id}" writes its record as a block of JSON text, so its column names can't be checked against the table — a column that doesn't exist is silently ignored, leaving it empty with no error.`,
          nodeId: node.id, field: 'config.fields',
          hint: 'Write it as an object: { "Name": "{{extract.name}}", "Deal Size": "{{extract.budget}}" }. One template per column.',
        });
      }
      if (typeof f === 'string' && /\{\{/.test(f)) {
        issues.push({
          severity: 'error', code: 'UNCHECKABLE_WRITE_FIELDS',
          message: `"${node.label || node.id}" builds its record's COLUMN NAMES from a template, so nobody can check them until it runs — and a column that doesn't exist is silently ignored, leaving it empty with no error.`,
          nodeId: node.id, field: 'config.fields',
          hint: 'Write the columns out: { "Name": "{{extract.name}}", "Deal Size": "{{extract.budget}}" }. One template per column, not one template for the whole record.',
        });
      }
    }

    // A connector-action naming a capability that does not exist threw at RUN time
    // ("Connector action X is not available in this build") — i.e. at 6am, against
    // a real customer's trigger, in a log nobody reads. The catalog is right here
    // at build time; ask it then. Mirrors UNKNOWN_CHANNEL exactly. (Increment F.)
    if (node.type === 'connector-action' && cfg.action && this.channelRegistry) {
      const cap = this.channelRegistry.get?.(cfg.action);
      // A TRIGGER capability is not an action. `gmail_new_message` exists in the
      // catalog and has NO `handle` — it is the thing that STARTS a workflow, not a
      // step inside one — so it resolved here, published clean, and threw "has no
      // handler" at run time. It was also a converger/publish divergence: the
      // scorer's catalog is `getAll()` (step + delivery only) and rejected it, while
      // publish accepted it. Existing ≠ runnable. (Found by the test-adversary.)
      const runnable = !cap ? false
        : (Array.isArray(cap.positions) ? cap.positions.some(p => p === 'step' || p === 'delivery') : true);
      if (!cap || !runnable) {
        issues.push({
          severity: 'error', code: 'UNKNOWN_CONNECTOR_ACTION',
          message: cap
            ? `"${node.label || node.id}" runs "${cfg.action}", but that is a TRIGGER — it starts a workflow, it isn't a step you can run inside one.`
            : `"${node.label || node.id}" runs the connector action "${cfg.action}", which isn't a capability this workspace has.`,
          nodeId: node.id, field: 'config.action',
          hint: 'Pick a connector action from the catalog — or connect the connector that provides it.',
        });
      } else if (cap.available === false) {
        issues.push({
          severity: 'error', code: 'CHANNEL_UNAVAILABLE',
          message: `Connector action "${cfg.action}" is registered but not ready: ${cap.unavailableReason || 'dependency missing'}.`,
          nodeId: node.id, field: 'config.action',
        });
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
    const byId = new Map(nodes.filter(n => n?.id).map(n => [n.id, n]));
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

    // {{stepId}} · {{stepId.output}} · {{stepId.field}} — the last is P12 Increment F.
    // Without a sub-field form, an Airtable record (a MAP of column → value, each
    // value from a different part of the upstream extract) has NO correct spelling:
    // the only expressible spec puts the whole JSON blob into every column.
    const refRe = /\{\{\s*([a-z0-9_-]+)(?:\.([a-z0-9_-]+))?\s*\}\}/gi;

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
      const strings = this._collectStrings(templateScannable(node));
      for (const s of strings) {
        let m;
        while ((m = refRe.exec(s)) !== null) {
          const ref   = m[1];
          const field = m[2] ?? null;
          if (vars.has(ref.toLowerCase())) continue;

          // ── BAD_TEMPLATE_FIELD (P12 Increment F) ─────────────────────────
          //
          // The sub-field grammar F added ({{extract.budget}}) is what makes a
          // correct Airtable record expressible at all — and it WIDENED the silent
          // -failure surface it was meant to close: a typo'd `{{extract.budgett}}`
          // resolves to an EMPTY STRING at run time, so the column is written blank,
          // the run reports success, and nobody is told. That is precisely the defect
          // this increment exists to kill, re-created by its own fix.
          //
          // An `llm` in `extract` mode DECLARES its field names (`config.fields`), so
          // the typo is knowable at build time. Where the source declares nothing (a
          // connector read, a freeform llm), its output shape is genuinely unknown and
          // NO claim is made — an unknowable field name is not a wrong one.
          const src = field && field.toLowerCase() !== 'output' ? byId.get(ref) : null;
          const declared = declaredFieldsOf(src);
          if (declared && !declared.some(f => f.toLowerCase() === field.toLowerCase())) {
            issues.push({
              severity: 'error', code: 'BAD_TEMPLATE_FIELD',
              message: `"${node.label || node.id}" reads {{${ref}.${field}}}, but "${src.label || src.id}" doesn't produce a "${field}" — it would come out blank, and nothing would say so.`,
              nodeId: node.id, field: null,
              hint: `"${src.label || src.id}" produces: ${declared.join(', ')}.`,
            });
            continue;
          }

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
    // A SINGLE dotted sub-field is now supported ({{extract.budget}}); array indexing,
    // wildcards and deeper paths ({{node.results[*].id}}, {{a.b.c}}) are still NOT —
    // the engine resolves one level and would pass anything else through literally.
    const okRe  = /^[a-z0-9_-]+(\.[a-z0-9_-]+)?$/i;
    for (const node of nodes) {
      const strings = this._collectStrings(templateScannable(node));
      for (const s of strings) {
        let m;
        while ((m = anyRe.exec(s)) !== null) {
          const inner = m[1].trim();
          if (STATIC_VARS.has(inner.toLowerCase())) continue;
          if (okRe.test(inner)) continue; // {{id}} / {{id.output}} — validated above
          issues.push({
            severity: 'error', code: 'BAD_TEMPLATE_REF',
            message: `"${node.label || node.id}" uses an unsupported reference {{${inner}}}. The engine resolves {{prev}}, {{<stepId>.output}} and ONE named field ({{<stepId>.<field>}}) — deeper paths and array indexing (e.g. [*], [0], a.b.c) are not supported and break at runtime.`,
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
/**
 * The config a node's TEMPLATE checks may look at.
 *
 * A `branch`'s `on` is excluded, because it is not a template — it is a
 * REFERENCE, with its own grammar (branch.js ON_REF), its own resolver, and its
 * own error code (BRANCH_BAD_ON). The engine never substitutes it: doing so would
 * replace the reference with the VALUE, which is indistinguishable from a step id
 * (CLAUDE.md — the `"urgent"` crash).
 *
 * Scanning it as a template made the one shape converger-v2 §7.1 documents —
 * `on: "{{approve_send.decision}}"`, the natural way to route on an approval —
 * fail publish with BAD_TEMPLATE_REF ("dotted sub-fields are not supported"),
 * which is a true sentence about templates and a false one about this key.
 */
function templateScannable(node) {
  if (node?.type !== 'branch') return node?.config;
  const { on, ...rest } = node.config ?? {};
  return rest;
}

/**
 * An action that CREATES something in someone else's system. The regex is the
 * one WRITE_WITHOUT_IDEMPOTENCY has always used; it is named here so the approval
 * rules and the idempotency rule cannot drift apart about what "a write" is.
 */
export function isWritingAction(action) {
  return /(^|_)(create|append|send|post|add|insert)(_|$)/i.test(String(action ?? ''));
}

/**
 * A node whose effect leaves this system and cannot be taken back: a connector
 * action that creates/sends, or ANY `deliver` (a delivery is a send — that is
 * what it is for).
 *
 * Deliberately WIDER than the predicate WRITE_WITHOUT_IDEMPOTENCY uses, and the
 * difference is not an oversight. Idempotency is about writing the same record
 * TWICE, so it only concerns systems of record. Approval strength is about
 * whether the person who said yes can be identified at all — and an email sent
 * to a customer on a forwarded link's say-so is exactly as unrecallable as a row
 * in their CRM.
 */
export function isWriteNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'deliver') return true;
  if (node.type === 'connector-action') return isWritingAction(node.config?.action);
  // A `foreach` is a write iff any of its per-item steps is (P12 Increment D —
  // found by the verifier + the test-adversary, F4). This is the load-bearing
  // case, not an edge case: a loop is N writes per fire — CLAUDE.md's own "highest
  // -risk write shape the engine has, and the whole reason `foreach` exists" — so
  // it is the LAST place WEAK_APPROVAL_FOR_WRITE may be blind. `descendantsOf`
  // walks top-level edges only and never enters `config.steps`, so without this a
  // forwardable emailed link could authorise a hundred irreversible writes while
  // the identical single write is correctly refused.
  if (node.type === 'foreach') {
    return normalizeSteps(node.config?.steps).some(isWriteNode);
  }
  return false;
}

/** Every node reachable from `startId` by following edges forward. */
export function descendantsOf(startId, edges = []) {
  const next = new Map();
  for (const e of edges) {
    if (!e?.from || !e?.to) continue;
    if (!next.has(e.from)) next.set(e.from, []);
    next.get(e.from).push(e.to);
  }
  const seen = new Set();
  const stack = [...(next.get(startId) ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const n of (next.get(id) ?? [])) stack.push(n);
  }
  return seen;
}

/**
 * The field names a step DECLARES it will produce, or `null` if it declares none.
 *
 * Only `llm` mode `extract` declares them today (`config.fields`, one "name: what it
 * means" per line). Everything else — a connector read, a freeform llm — has an output
 * shape nobody wrote down, so no claim can be made about a field of it, and none is.
 */
function declaredFieldsOf(node) {
  if (node?.type !== 'llm' || String(node.config?.mode ?? '') !== 'extract') return null;
  const raw = node.config?.fields;
  const list = Array.isArray(raw)
    ? raw.map(f => (typeof f === 'string' ? f : f?.name ?? f?.key))
    : String(raw ?? '').split(/\n|,/).map(l => l.split(':')[0]);
  const names = list.map(x => String(x ?? '').trim()).filter(Boolean);
  return names.length ? names : null;
}

/** The step id a branch's `on` reference points at, via the SHARED grammar. */
export function onRefId(on) {
  const ref = String(on ?? '').trim().replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
  return ON_REF.exec(ref)?.[1] ?? null;
}

/**
 * Would a `human` node timing out to `then` cause a real, irreversible action —
 * a send or a write — with NOBODY having approved it? (P12 Increment D, F3.)
 *
 * Silence is not consent. The declared timeout answer is legitimate for saying
 * "give up and DON'T do it" (`then: reject`), but a timeout that routes to a
 * `deliver` or a create/send is the system approving on the person's behalf. This
 * traces what the ENGINE would actually do — find the branch that reads this
 * human, follow the case matching `then` (or the catch-all), and ask whether that
 * subtree writes — so it is exact for any decision vocabulary, not a guess that
 * "approve" is the dangerous word.
 *
 * Returns false when it cannot trace (no gating branch): the ungated shape is
 * HUMAN_ANSWER_NOT_ROUTED's problem, not this one.
 */
export function timeoutAuthorizesWrite({ nodes = [], edges = [] }, humanId, then) {
  const branch = nodes.find(n => n?.type === 'branch' && onRefId(n.config?.on) === humanId);
  if (!branch) return false;
  const cases = normalizeCases(branch.config?.cases);
  const norm  = String(then).trim().toLowerCase();
  const target = cases.find(c => String(c?.when).trim().toLowerCase() === norm)?.to
              ?? cases.find(c => String(c?.when).trim() === CATCH_ALL)?.to;
  if (!target) return false;
  const reach = new Set([target, ...descendantsOf(target, edges)]);
  return [...reach].some(id => isWriteNode(nodes.find(n => n?.id === id)));
}

function closedDomainOf(node) {
  if (!node || typeof node !== 'object') return null;

  if (node.type === 'llm') {
    const mode = String(node.config?.mode ?? 'freeform').toLowerCase();
    if (mode !== 'classify') return null;
    const cats = parseEnumList(node.config?.categories);
    return cats.length >= 2 ? cats : null;
  }

  // decision (Increment E) — the output enum.
  //
  // EXCEPT under COLLECT, whose output is a LIST of every rule that matched, not
  // a member of the enum. A branch matches by exact value, so routing on a
  // COLLECT table matches no case and the mandatory catch-all swallows 100% of
  // traffic — silently, with `run_completed`. That is the BRANCH_BAD_ON failure
  // arriving through the hit policy. `values` describes what a rule can DECIDE;
  // under COLLECT it does not describe what the node EMITS, and the domain a
  // branch routes on is the one the node emits. (A COLLECT table is still a
  // perfectly good decision — it just cannot be the thing a branch routes on.)
  if (node.type === 'decision') {
    const { output, hitPolicy } = tableOf(node);
    if (hitPolicy === 'COLLECT') return null;
    const vals = valuesOf(output);
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
