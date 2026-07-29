/**
 * gap-scorer — what does this workflow still not know about itself?
 *
 * P12 Increment C. This replaces a hardcoded five-item checklist:
 *
 *   BEFORE  scoreGap(draft) → { needsTrigger, needsProcessing, needsDelivery, … }
 *   AFTER   scoreGap(spec, { capabilities }) → { gaps: [ … ], complete }
 *
 * The old checklist demanded "a trigger, a PROCESSING node, a delivery". That
 * middle demand is defect #4: asked to move an email into a spreadsheet — a
 * genuinely two-step workflow — the converger invented a pointless LLM step
 * purely to satisfy the checklist, and charged the user for it on every run. A
 * workflow is not complete because it has one of each node family. It is
 * complete when **it does what its outcome says**, and nothing it does is
 * under-specified.
 *
 * ── Three gap classes ───────────────────────────────────────────────────────
 *
 *   outcome    an assertion in the outcome contract that no node satisfies.
 *              (defect #1 — the "Slack AND email" silent drop.)
 *   coverage   an input nobody decided what to do with: a branch with no
 *              catch-all, a decision table with a hole, a UNIQUE table whose
 *              rules overlap. (defect #5 — zero exception questions, ever.)
 *   contract   a step that is under-specified or asks the engine for something
 *              it will silently ignore. (defect #3 — the dead `"model"` key.)
 *
 * ── Where the gaps come from, and why it is not a second opinion ────────────
 *
 * The contract and outcome gaps ARE the validator's issues. This file does not
 * re-implement them, and that is deliberate rather than lazy: a converger with
 * its own private idea of "complete" will happily ratify a spec that publish
 * then rejects, and the user lands in a dead end they cannot argue their way
 * out of — the builder says it's done, the save button says it isn't. One
 * oracle, consulted by both, cannot drift.
 *
 * As of Increment E that is true of the DMN coverage analysis too: it used to be
 * re-implemented here, because `decision` was not yet a registered node type and
 * the validator therefore never ran it. Now the validator owns it
 * (`_checkDecisionTables`) and this file classifies the result — so a table with a
 * hole is found on the way OUT (publish) as well as on the way IN (converge), and
 * there is one implementation of "is this table complete?", not two.
 *
 * What this file still adds on top: the EXCEPTION questions (§2b) — the ones that
 * are gaps in a workflow's story rather than errors in its shape.
 *
 * ── resolution, and the invariant that keeps `complete` honest ──────────────
 *
 *   resolution: 'unanswered' | 'answered' | 'escalated'
 *   complete  = no gap is left 'unanswered'
 *
 * A gap DEFAULTS to 'escalated' — nobody answered it, so a human deals with it —
 * which is what makes "Accept all defaults" an honest button rather than a way
 * to hide unknowns (converger-v2 §6.2.4).
 *
 * But it can only default that way when escalating is TRUE. So:
 *
 *   > **A BLOCKING gap — one that makes the spec fail validation — always
 *   > defaults to 'unanswered'.** It cannot be escalated, because escalation is
 *   > a promise that a human will handle this case AT RUN TIME, and a spec that
 *   > cannot publish never has a run time. Calling that "escalated" would be a
 *   > lie told in the language of safety.
 *
 * This gives the property the whole loop rests on, by construction:
 *
 *   > **complete ⇒ publishable.**
 *
 * (A blanket 'escalated' default — which is what an earlier draft of
 * converger-v2 §3 specified — is not merely wrong, it is unimplementable: it
 * makes `complete` unconditionally true, so an EMPTY draft scores complete and
 * the converger ratifies a workflow with no steps in it. A default that makes a
 * check vacuous is not a safety net; it is the bug. Same class as the
 * `?? 'unscoped'` tenant fallback that leaked across tenants in Increment B.
 * §3 is corrected.)
 *
 * @module src/converger/gap-scorer.js
 */

import { WorkflowValidator }       from '../workflows/workflow-validator.js';
import { NodeTypeRegistry }        from '../workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../workflows/node-types/index.js';
import { approvalChannelView }     from '../workflows/approval-channels.js';
import { routeDomainOf, describeTarget, describeValue,
         gatingRouteFor, satisfiesAssertion } from '../workflows/outcome-oracle.js';

/** Which class an issue belongs to. Anything unlisted is a contract gap. */
const OUTCOME_CODES  = new Set(['UNSATISFIED_ASSERTION', 'MALFORMED_ASSERTION', 'MISSING_OUTCOME']);
const COVERAGE_CODES = new Set([
  'NON_EXHAUSTIVE_BRANCH', 'LLM_INPUT_NOT_ENUM', 'BRANCH_BAD_ON', 'BRANCH_CASE_NOT_IN_ENUM',
  // The DMN analysis (P12 Increment E). These now come FROM the validator — see
  // the note where the hand-rolled copy used to be, below.
  'DECISION_TABLE_GAP', 'UNIQUE_HIT_OVERLAP', 'DECISION_UNDECIDABLE',
  'DECISION_BAD_CONDITION', 'DECISION_OUTPUT_NOT_IN_ENUM', 'DECISION_UNKNOWN_INPUT',
  'DECISION_TOO_WIDE',
]);

/**
 * A gap the system CANNOT ANSWER for the user, however hard it tries — as opposed
 * to one it merely has not answered yet. `decidable` drives the UI: a decidable
 * gap gets a pre-filled "Use the suggestion" button, and an undecidable one must
 * not, because there is no suggestion to make.
 *
 * The two DMN codes here are the honest half of the moat. A table whose domain is
 * unbounded ("subject", free text), or one carrying a condition the FEEL-A grammar
 * cannot read, is a table about which NO coverage claim can be made — not even a
 * negative one. Offering a confident answer for a case we cannot enumerate would be
 * a false proof, and a false proof is worse than no proof: the user stops looking.
 */
const UNDECIDABLE_CODES = new Set(['DECISION_UNDECIDABLE', 'DECISION_BAD_CONDITION']);

/**
 * The validator needs a node-type registry to see any config at all (without one
 * every node's `typeDef` is null and MISSING_CONFIG / UNKNOWN_CONFIG_KEY quietly
 * check nothing). Validation only reads `configSchema` and `validate()`, so no
 * services are needed and nothing is shared between calls.
 */
let _nodeTypes = null;
function nodeTypes() {
  if (!_nodeTypes) _nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
  return _nodeTypes;
}

/**
 * The converger's `capabilities.channels` IS the delivery catalog — the same
 * one the server's ChannelRegistry exposes, already narrowed to what this tenant
 * can actually run. Handing it to the validator is what keeps `complete ⇒
 * publishable` true: a delivery channel's config keys are declared by the
 * CHANNEL (an Airtable delivery needs a baseId; a Slack one does not), so a
 * scorer that cannot see the catalog would judge a valid Airtable delivery
 * against Slack's key set and call a correct spec broken — or, worse, would have
 * to stop checking, and let a hallucinated key through.
 */
function channelView(capabilities) {
  const chans = capabilities?.channels;
  if (!Array.isArray(chans) || !chans.length) return null;
  const byId = new Map(chans.filter(c => c?.id).map(c => [c.id, c]));
  return { get: (id) => byId.get(id) ?? null };
}

/**
 * The approval channels the tenant can actually be ASKED over (P12 Increment D).
 * Built by builder.js from the live catalog + the platform mailer and carried on
 * `capabilities`, for exactly the same reason as `channels`: the scorer must run
 * the checks publish runs, or `complete ⇒ publishable` is a slogan rather than a
 * property. Absent ⇒ null ⇒ the validator skips APPROVAL_CHANNEL_NOT_CONNECTED
 * and this file refuses to certify (below).
 */
function approvalView(capabilities) {
  return approvalChannelView(capabilities?.approvalChannels ?? null);
}

function validatorFor(capabilities) {
  return new WorkflowValidator({
    nodeTypes:        nodeTypes(),
    channelRegistry:  channelView(capabilities),
    approvalChannels: approvalView(capabilities),
  });
}

// ── RESOURCE_NOT_FOUND — a wire to a resource that does not exist (Increment #25) ──
//
// The validator proves a delivery's channel is a REAL capability (`slack`, `gmail_send`)
// and that its config KEYS are legal. It does NOT prove the destination that channel
// points AT actually exists in the tenant's account: a `deliver → #does-not-exist` or a
// write to an Airtable base the tenant never connected passes every publish check and
// then 404s at run time — silently, on the customer's first real event.
//
// So this file checks each resource REFERENCE against the LIVE lists builder.js already
// fetched onto `capabilities` (slackChannels, airtableSchema). It is a converger-only
// gap (publish has no live-account view), which only ever makes the converger STRICTER —
// it can never make `complete ⇒ publishable` false, because a spec the converger calls
// complete passes strictly more checks than publish runs.
//
// VERIFICATION IS OPT-IN, on purpose. It runs only when `capabilities.connectors` is
// present — the signal that this is a real builder session (builder.js:1274), not a bare
// unit-test catalog. The 200+ specs in the suite hand a `channels` catalog but no
// `connectors`/`slackChannels`, and must keep behaving exactly as before. Inside an
// active session it is FAIL-CLOSED: a connected connector whose live list is missing (the
// fetch failed) yields RESOURCE_UNVERIFIED (blocking), never a silent pass — the same
// discipline as CHANNELS_UNVERIFIED above.

/** Slack delivery channels that post to a NAMED channel (slack_dm targets a user). */
const SLACK_DM_CHANNELS = new Set(['slack_dm']);

/**
 * The Slack channel NAME a node posts to, or null if this node makes no such reference
 * (not Slack, a DM, a template resolved at run time, or a raw channel ID we can't name).
 */
function slackChannelRef(node) {
  const id = node?.type === 'deliver'          ? node.config?.channel
           : node?.type === 'connector-action' ? node.config?.action
           : null;
  if (typeof id !== 'string' || !id.startsWith('slack') || SLACK_DM_CHANNELS.has(id)) return null;
  const target = node.config?.target;
  if (typeof target !== 'string') return null;
  const name = target.replace(/^#/, '').trim();
  if (!name || name.includes('{{')) return null;      // template — resolved at run time
  if (/^C[A-Z0-9]{6,}$/.test(name)) return null;       // a raw Slack channel ID, not a name
  return name;
}

/**
 * The { baseId, tableId } an Airtable node references, or null. Airtable writes appear
 * BOTH as a `connector-action` (config.action) and as a `deliver` (config.channel =
 * 'airtable_create_record') — same capability, two node shapes — so we read the id the
 * way `usesConnector` does, off whichever field this node type carries it in.
 */
function airtableRef(node) {
  const id = node?.type === 'connector-action' ? node.config?.action
           : node?.type === 'deliver'          ? node.config?.channel
           : null;
  if (typeof id !== 'string' || !id.startsWith('airtable_')) return null;
  const baseId = node.config?.baseId;
  if (typeof baseId !== 'string' || !baseId.trim() || baseId.includes('{{')) return null;
  const tRaw   = node.config?.tableId;
  const tableId = (typeof tRaw === 'string' && tRaw.trim() && !tRaw.includes('{{')) ? tRaw.trim() : null;
  return { baseId: baseId.trim(), tableId };
}

/** Every node in the spec, INCLUDING the steps inside a foreach (they write too). */
function* walkNodes(nodes) {
  for (const n of (nodes ?? [])) {
    yield n;
    if (n?.type === 'foreach' && Array.isArray(n.config?.steps)) {
      for (const s of n.config.steps) yield s;
    }
  }
}

/** A blocking RESOURCE_NOT_FOUND gap carrying everything the resolver UI needs. */
function resourceNotFoundGap({ node, kind, name, options, canCreate, baseId }) {
  const hash = String(name).replace(/[^a-z0-9]+/gi, '_');
  const label =
    kind === 'slack_channel' ? `Slack channel #${name}`
    : kind === 'airtable_base' ? `Airtable base "${name}"`
    : `Airtable table "${name}"`;
  const optLabels = options.map(o => o.label);
  const hint = optLabels.length
    ? `Pick one you already have: ${optLabels.slice(0, 12).join(', ')}${canCreate ? ` — or create #${name}.` : '.'}`
    : (canCreate
        ? `I can create #${name} for you.`
        : `Nothing connected has it — create it in the connector, then come back.`);
  return {
    id:       `gap_resource_not_found_${(node.id ?? 'node')}_${hash}`.toLowerCase(),
    class:    'contract',
    nodeId:   node.id ?? null,
    code:     'RESOURCE_NOT_FOUND',
    severity: 'error',
    message:  `${label} doesn't exist in your connected account yet.`,
    hint,
    // Blocking ⇒ must be ANSWERED (create or pick); cannot be silently escalated.
    resolution: 'unanswered',
    decidable:  canCreate || options.length > 0,
    blocking:   true,
    // Load-bearing for the conversational resolver (elicitation-graph.js `gaps` node):
    // the KIND, the missing NAME, whether it can be created, and the existing options.
    resource: {
      kind, name, canCreate,
      baseId: baseId ?? null,
      options,                                     // [{ value, label }]
      createCapabilityId: kind === 'slack_channel' ? 'slack_create_channel' : null,
    },
  };
}

/** Fail-closed: a connected connector whose live resource list could not be read. */
function resourceUnverifiedGap(what, nodeId) {
  return {
    id: `gap_resource_unverified_${what.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    class: 'contract', nodeId: nodeId ?? null,
    code: 'RESOURCE_UNVERIFIED', severity: 'error',
    message: `I can't confirm the ${what} this workflow uses actually exist — that list didn't load, so I won't claim the workflow is finished.`,
    hint: 'Reconnect the connector (or reload the page) and try again.',
    resolution: 'unanswered', decidable: false, blocking: true,
  };
}

/**
 * Walk the spec's resource references and return RESOURCE_NOT_FOUND / RESOURCE_UNVERIFIED
 * gaps. See the block comment above for the opt-in + fail-closed contract.
 */
function resourceGaps(spec, capabilities) {
  const connectors = capabilities?.connectors;
  if (!connectors) return [];                       // not a live session — opt out (non-breaking)

  const gaps = [];
  const slackConnected    = !!connectors.slack?.connected;
  const airtableConnected = !!connectors.airtable?.connected;
  const slackList     = capabilities.slackChannels;      // string[] of names, or undefined
  const airtableSchema = capabilities.airtableSchema;    // [{id,name,tables:[…]}], or undefined

  let sawSlack = false, sawAirtable = false;
  let slackNode = null, airtableNode = null;

  for (const n of walkNodes(spec?.nodes)) {
    const chan = slackChannelRef(n);
    if (chan && slackConnected) {
      sawSlack = true; slackNode = slackNode ?? (n.id ?? null);
      if (Array.isArray(slackList)) {
        const exists = slackList.some(c => String(c).toLowerCase() === chan.toLowerCase());
        if (!exists) {
          gaps.push(resourceNotFoundGap({
            node: n, kind: 'slack_channel', name: chan, canCreate: true,
            options: slackList.map(c => ({ value: c, label: `#${c}` })),
          }));
        }
      }
    }

    const at = airtableRef(n);
    if (at && airtableConnected) {
      sawAirtable = true; airtableNode = airtableNode ?? (n.id ?? null);
      if (Array.isArray(airtableSchema)) {
        const base = airtableSchema.find(b => b.id === at.baseId || b.name === at.baseId);
        if (!base) {
          gaps.push(resourceNotFoundGap({
            node: n, kind: 'airtable_base', name: at.baseId, canCreate: false,
            options: airtableSchema.map(b => ({ value: b.id, label: b.name })),
          }));
        } else if (at.tableId) {
          const t = (base.tables ?? []).find(tb => tb.id === at.tableId || tb.name === at.tableId);
          if (!t) {
            gaps.push(resourceNotFoundGap({
              node: n, kind: 'airtable_table', name: at.tableId, canCreate: false, baseId: base.id,
              options: (base.tables ?? []).map(tb => ({ value: tb.name, label: tb.name })),
            }));
          }
        }
      }
    }
  }

  // FAIL CLOSED — connected + referenced, but the list itself never loaded.
  if (sawSlack    && !Array.isArray(slackList))     gaps.push(resourceUnverifiedGap('Slack channels', slackNode));
  if (sawAirtable && !Array.isArray(airtableSchema)) gaps.push(resourceUnverifiedGap('Airtable bases', airtableNode));

  return gaps;
}

function classOf(code) {
  if (OUTCOME_CODES.has(code))  return 'outcome';
  if (COVERAGE_CODES.has(code)) return 'coverage';
  return 'contract';
}

/**
 * @param {object} spec  — a draft or a finished spec: { name, outcome?, triggers, nodes, edges }
 * @param {{ capabilities?: object, validator?: WorkflowValidator }} [opts]
 * @returns {{ gaps: object[], complete: boolean }}
 */
export function scoreGap(spec = {}, { capabilities = {}, validator = null } = {}) {
  const v      = validator ?? validatorFor(capabilities);
  const nodes  = Array.isArray(spec.nodes) ? spec.nodes : [];
  const gaps   = [];

  // ── 1 & 2. Outcome + contract gaps: the validator's issues, classified ────
  let issues = [];
  try {
    issues = v.validate(spec).issues ?? [];
  } catch (err) {
    // A validator that throws on a half-built draft must not take the whole
    // elicitation down with it — but it must not be silently ignored either, or
    // the converger would think a broken draft was complete.
    gaps.push({
      id: 'gap_validator_error', class: 'contract', nodeId: null,
      code: 'VALIDATOR_ERROR', severity: 'error',
      message: `The workflow couldn't be checked: ${err.message ?? String(err)}`,
      hint: null, resolution: 'unanswered', decidable: false, blocking: true,
    });
    return { gaps, complete: false };
  }

  issues.forEach((issue, i) => {
    const blocking = issue.severity === 'error';
    gaps.push({
      id:       `gap_${issue.code}_${issue.nodeId ?? 'spec'}_${i}`.toLowerCase(),
      class:    classOf(issue.code),
      nodeId:   issue.nodeId ?? null,
      code:     issue.code,
      severity: issue.severity,
      message:  issue.message,
      hint:     issue.hint ?? null,
      // WHICH PART OF THE NODE IS WRONG. Carried through because one code can mean
      // two different KINDS of problem, and they need opposite treatment: an
      // UNSATISFIED_ASSERTION on `config.fields` is a fact about the user's real
      // table (a column that does not exist), which no rebuild can change, while the
      // same code elsewhere means a step is genuinely missing, which a rebuild CAN
      // fix. Without this the two were indistinguishable and both bought an Opus pass.
      field:    issue.field ?? null,
      // WHICH PROMISE this gap is about, when it is about one. Carried for the same
      // reason as `field`: it lets the rebuild routes recognise that two differently
      // worded complaints concern the same assertion, instead of buying a whole-spec
      // Opus pass for each. Null on gaps that concern no promise.
      target:   issue.target ?? null,
      // A deterministic, machine-applicable repair the validator computed for a
      // STRUCTURAL defect (a missing branch/route edge to add, an ambiguous extra
      // edge to remove). Present only on codes whose fix is unambiguous. The gaps
      // node applies it directly — no LLM guess, no question — because a missing
      // edge is a bug in the builder's own output, not a decision a user can make.
      fix:      issue.fix ?? null,
      // A blocking gap cannot be escalated — see the header. It must be ANSWERED.
      resolution: blocking ? 'unanswered' : 'escalated',
      decidable:  !UNDECIDABLE_CODES.has(issue.code),
      blocking,
    });
  });

  // ── 2a. FAIL CLOSED when we cannot check what publish will check ─────────
  //
  // `complete ⇒ publishable` is the property this whole loop rests on. It is
  // FALSE the moment the scorer performs fewer checks than publish does — and
  // that is exactly what happened without a channel catalog: `channelView()`
  // returns null, the validator's `if (channelId && this.channelRegistry)` guard
  // (workflow-validator.js, _checkTypeSpecific) silently skips UNKNOWN_CHANNEL and
  // CHANNEL_UNAVAILABLE, and a spec delivering to a hallucinated `channel:
  // 'discord'` scores COMPLETE — then publish rejects it. A dead end the user
  // cannot argue their way out of.
  //
  // Worse, it disables itself precisely when it is most needed: `builder.js`
  // builds the catalog after three network-bound connector lookups inside a
  // "non-fatal" catch, so an expired refresh token drops the catalog — and in
  // that same state the model has no catalog in its prompt either, making it MOST
  // likely to invent a channel id.
  //
  // A silent degradation of a check is not a safety net; it IS the bug (CLAUDE.md
  // — the `?? 'unscoped'` tenant fallback). So: if a spec delivers somewhere and
  // we cannot see the catalog, we refuse to call it complete. Refusing to certify
  // is always available; certifying without checking is not.
  // (Found by the independent verifier.)
  const hasCatalog = Array.isArray(capabilities?.channels) && capabilities.channels.length > 0;
  // …and a `connector-action` is checked against the SAME catalog as of Increment F
  // (its params are the capability's own). Publish always has the registry, so a
  // scorer without one performs FEWER checks than publish does — which is precisely
  // how a spec scores `complete` and is then rejected at save. Same hole, one node
  // type along. (CLAUDE.md, Increment C: refusing to certify is always available;
  // certifying without checking is not.)
  const routed = nodes.filter(n =>
    (n?.type === 'deliver' && n.config?.channel) ||
    (n?.type === 'connector-action' && n.config?.action));
  if (!hasCatalog && routed.length) {
    gaps.push({
      id: 'gap_channels_unverified', class: 'contract', nodeId: null,
      code: 'CHANNELS_UNVERIFIED', severity: 'error',
      message: 'I can\'t confirm the delivery destinations are real and connected — the connector catalog isn\'t loaded, so I won\'t claim this workflow is finished.',
      hint: 'Reconnect the connectors (or reload the page) and try again.',
      resolution: 'unanswered', decidable: false, blocking: true,
    });
  }

  // The SAME hole, one door along (P12 Increment D). A `human` node's channels
  // are checked by APPROVAL_CHANNEL_NOT_CONNECTED — but only when the validator
  // was handed an approval-channel view. Without one that check silently does not
  // run, so a pause asking over a Slack workspace nobody connected would score
  // COMPLETE here and be rejected at publish (which always has the view). That is
  // the C blocker exactly, and the lesson it taught is that the fix belongs on
  // BOTH sides: the validator skips what it cannot see, and the scorer refuses to
  // certify what it could not check.
  //
  // It is not merely a publish/score divergence, either: an approval nobody can
  // reach is a run that waits forever for an answer that cannot come.
  const asks = nodes.filter(n => n?.type === 'human');
  if (!Array.isArray(capabilities?.approvalChannels) && asks.length) {
    gaps.push({
      id: 'gap_approval_channels_unverified', class: 'contract', nodeId: asks[0].id,
      code: 'CHANNELS_UNVERIFIED', severity: 'error',
      message: 'This workflow stops to ask a person, but I can\'t confirm where that question can actually be delivered — so I won\'t claim it\'s finished.',
      hint: 'Reconnect the connectors (or reload the page) and try again.',
      resolution: 'unanswered', decidable: false, blocking: true,
    });
  }

  // ── 2c. RESOURCE_NOT_FOUND — the destination must actually EXIST ─────────────
  //
  // A wire to a Slack channel / Airtable base / table the tenant's connected account
  // does not contain. Blocking, so `complete` is false until it is created or repointed
  // — resolved conversationally (create-or-pick) in the `gaps` node. Opt-in + fail-closed;
  // see the block comment on `resourceGaps` above. (Increment #25.)
  for (const g of resourceGaps(spec, capabilities)) gaps.push(g);

  // ── 2b. The exception questions (defect #5: the converger asked ZERO, ever) ──

  // Nothing says what happens when a step FAILS. Today the run stops and the
  // failure lands in a log nobody reads. This is the one exception question that
  // applies to every workflow ever built, which is why defect #5 could go
  // unnoticed for so long: the converger had no shape to interrogate, so it
  // never asked the most basic question there is.
  if (nodes.length && !nodes.some(n => n?.on_error)) {
    gaps.push({
      id: 'gap_no_error_path', class: 'contract', nodeId: null,
      code: 'NO_ERROR_PATH', severity: 'warning',
      message: 'Nothing here says what should happen if a step fails — right now the run just stops, and only a log knows.',
      hint: 'The default is to retry twice and then tell a person. That is usually what you want.',
      resolution: 'escalated', decidable: true, blocking: false,
    });
  }

  // A CONDITIONAL promise ("…and over $50k also pings #sales-urgent") is only a
  // gap when nothing in the workflow actually GATES it. When a classify → branch
  // routes on the very value the `when` names — proven now by the self-test /
  // runtime oracle, which enforces the assertion only on the lane it names and
  // skips the others (outcome-oracle.js `assertionApplicability`) — the condition
  // IS checked, and raising CONDITIONAL_UNPROVEN would be a stale warning claiming
  // "it would happen on every run" when it demonstrably does not.
  //
  // So we reconcile against the SAME closed route domain the runtime oracle uses
  // (`routeDomainOf`, built from `closedDomainOf`): a `when` inside it is gated and
  // provable → no gap; a `when` outside it (nothing routes on that value) is
  // genuinely ungated → keep the gap, because treating an ungated conditional as
  // satisfied would be a FALSE PROOF — the workflow would pass its own contract
  // while pinging #sales-urgent for every lead, not just the big ones. Never imply
  // a completeness proof you cannot make (converger-v2 §3).
  const routeDomain = routeDomainOf(spec);
  const specNodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  for (const [i, a] of (Array.isArray(spec.outcome?.assertions) ? spec.outcome.assertions : []).entries()) {
    if (!a?.when) continue;
    const whenNorm = String(a.when).trim().toLowerCase();
    const gated = routeDomain.has(whenNorm);

    const owner     = specNodes.find(n => satisfiesAssertion(a, n));
    const gate      = owner ? gatingRouteFor(spec, owner.id) : null;
    const gateOne   = (gate && gate.values.length === 1) ? String(gate.values[0]).trim().toLowerCase() : null;
    const gateNames = (gate?.values ?? []).map(v => String(v).trim().toLowerCase());

    // ── A REAL ROUTE VALUE, BUT NOT THE ONE THAT GATES THIS STEP ──────────────
    // Asking "does SOME branch route on this value?" is the laundering hop from
    // CLAUDE.md's trap list: it answers a question about the VOCABULARY when the
    // question is about THIS STEP. On the canonical classify→approve→route shape the
    // contract said the channel post happens `when: "urgent_complaint"` — a real
    // route value, so this check passed it — but the post sits behind the APPROVAL
    // gate, two branches down. `gatingRouteFor`'s own comment already names the
    // consequence: enforcing the outer gate "would enforce the promise on runs that
    // went urgent and were REJECTED, i.e. a false failure on a workflow behaving
    // exactly as designed."
    //
    // That is not hypothetical. Witnessed 2026-07-28 on a build whose test panel then
    // read "Contract not met · 4 of 9 promises fell short": three of those four were
    // the deliberate REJECT passes, each marked broken for not posting the message
    // that rejecting exists to withhold. Go live was locked on a correct workflow.
    //
    // The deepest gate implies every gate above it (the approval branch is reachable
    // only from the urgent lane), so restating it is exact, not a narrowing. It is a
    // mechanical rewrite of the machine-checkable `when` only — the user's own words
    // in `statement` are untouched — and it is applied by `autoRepairStructural`
    // without a question, a model call or a rebuild.
    if (gated) {
      if (!gateOne) continue;                    // nothing, or nothing single, gates it
      if (gateNames.includes(whenNorm)) continue; // already names its own gate — correct
      gaps.push({
        id: `gap_conditional_misstated_${a.id ?? a.target}`.toLowerCase(),
        class: 'coverage', nodeId: owner?.id ?? null,
        code: 'CONDITIONAL_MISSTATED', severity: 'warning',
        message: `You said this should only reach ${describeTarget(a.target)} when the email is ${describeValue(a.when)}, but the step that does it only runs after the "${gate.values[0]}" decision — so that is what really decides whether it happens.`,
        hint: `Checking it against "${gate.values[0]}" instead, so a run that took the other answer isn't marked as breaking the promise.`,
        resolution: 'escalated', decidable: false, blocking: false,
        fix: { op: 'set_assertion_when', index: i, when: gate.values[0] },
      });
      continue;
    }

    // A `when` outside the route vocabulary is USUALLY a conjunction the field
    // cannot hold — "urgent AND approved" written as the invented word
    // `urgent_approved`. The workflow really does gate that delivery; the contract
    // just names the gate in a language no node speaks, and the result is a promise
    // that can never be checked while the panel shows it as the contract.
    //
    // So before calling it unproven, ASK THE GRAPH what actually gates the step this
    // assertion is about. When exactly one route value does, that value is the same
    // condition said in the workflow's own words, and it is a mechanical rewrite —
    // no model call, no question, no rebuild. (Rewriting to the DEEPEST gate is what
    // makes it exact; see `gatingRouteFor`.)
    //
    // Everything else still raises the gap honestly: guessing between two candidate
    // gates would silently narrow a promise the user made, which is worse than
    // saying we cannot prove it.
    const fix = (gateOne && routeDomain.has(gateOne))
      ? { op: 'set_assertion_when', index: i, when: gate.values[0] }
      : null;

    gaps.push({
      id: `gap_conditional_${a.id ?? a.target}`.toLowerCase(),
      class: 'coverage', nodeId: null,
      code: 'CONDITIONAL_UNPROVEN', severity: 'warning',
      message: `You said this should only reach ${describeTarget(a.target)} when the email is ${describeValue(a.when)} — but nothing in the workflow checks that yet, so it would happen on every run.`,
      hint: 'Add a step that classifies the input, and route on it — or accept that it fires every time.',
      resolution: 'escalated', decidable: false, blocking: false,
      fix,
    });
  }

  // ── 3. The DMN coverage analysis ─────────────────────────────────────────
  //
  // It used to be RE-IMPLEMENTED here, because Increment C's validator did not
  // run it: `decision` was not a registered node type, so a table could only be
  // reasoned about on the way IN (converge), never on the way OUT (publish).
  //
  // Increment E makes `decision` runnable, and moves the analysis into the
  // validator (`_checkDecisionTables`) — where publish, the builder, the API and
  // this scorer all reach it through ONE oracle. That is not tidying: two copies
  // of "is this table complete?" drift, and the day they drift is the day the
  // converger ratifies a spec that publish rejects. It is the same rule
  // outcome-oracle.js exists to enforce, and it is what keeps `complete ⇒
  // publishable` a property rather than a slogan.
  //
  // So the DMN gaps arrive above, with everything else, as validator issues —
  // classified as `coverage` by COVERAGE_CODES, and given a resolution by the one
  // severity rule that governs every gap: an error must be ANSWERED; a warning may
  // be ESCALATED. Which is exactly the resolution the hand-written block assigned.

  return { gaps, complete: gaps.every(g => g.resolution !== 'unanswered') };
}

/** The gaps still blocking a publish. `complete` is exactly "this list is empty". */
export function unansweredGaps(result) {
  return (result?.gaps ?? []).filter(g => g.resolution === 'unanswered');
}

/**
 * The next gap for the converger to work on. Outcome first (what must this
 * workflow produce), then contract (can each step actually run), then coverage
 * (what did nobody think about) — the order the elicitation asks in.
 */
export function nextGap(result) {
  const open = unansweredGaps(result);
  const rank = { outcome: 0, contract: 1, coverage: 2 };
  return [...open].sort((a, b) => (rank[a.class] ?? 9) - (rank[b.class] ?? 9))[0] ?? null;
}

/**
 * A one-line description of what the workflow still needs — fed to the propose
 * prompt. It now carries the validator's own message and hint, so the model is
 * told exactly what is wrong and exactly how to fix it, rather than being handed
 * a vague checklist item and left to guess (which is how the dead `"model"` key
 * survived: nothing ever told the model it was wrong).
 */
export function gapLabel(result) {
  // Tolerate being handed a single gap as well as a whole result.
  const gap = result?.gaps ? nextGap(result) : result;
  if (!gap) return 'nothing — the workflow does everything its outcome promises';
  return gap.hint ? `${gap.message}  → ${gap.hint}` : gap.message;
}
