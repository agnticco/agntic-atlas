/**
 * outcome-oracle — does this workflow actually DO what its outcome promises?
 *
 * P12 Increment C. This is the file that kills defect #1: the converger was
 * asked for Slack **and** Gmail, confirmed both, and shipped a spec with only
 * Slack. Nothing in the system declared what the finished workflow had to
 * produce, so nothing could notice it hadn't.
 *
 * A spec v2 carries an `outcome.assertions[]` — machine-checkable statements of
 * what must be true after a run. This module answers ONE question, and the
 * validator (UNSATISFIED_ASSERTION) and the gap scorer both ask it through this
 * single implementation on purpose: two copies of a satisfaction rule drift, and
 * the day they drift is the day the converger ratifies a spec that publish then
 * rejects.
 *
 *     satisfiesAssertion(assertion, node) → boolean
 *
 * ── The assertion vocabulary is CLOSED ──────────────────────────────────────
 *
 * Three kinds, covering every effect the current connector set can have:
 *
 *   message_sent    a message reached a person / channel / endpoint
 *   record_exists   a row or record was created in a data store
 *   document_exists a document or file was created
 *
 * An assertion whose `kind` is not one of these is MALFORMED — it is not
 * ignored. That distinction is the whole point: an unknown kind we cannot check
 * is exactly how an assertion gets silently dropped, which is the defect. If a
 * new kind is needed, add it here AND give it a satisfier below. Never widen the
 * check by making an unknown kind pass.
 *
 * ── Targets ─────────────────────────────────────────────────────────────────
 *
 *   target: "<connector>:<locator>"     e.g. "slack:#sales-urgent"
 *                                            "gmail:ops@acme.com"
 *                                            "airtable:Leads"
 *                                            "slack"          (no locator)
 *
 * The locator is optional. Where it is absent, the assertion asserts only that
 * *some* message reached Slack — which is a weaker claim, and is treated as one.
 * We never infer a locator the user did not give us.
 *
 * ── What this module deliberately does NOT prove ────────────────────────────
 *
 * `assertion.when` (e.g. "priority = 'P1'") is a RUN-TIME condition. This oracle
 * proves a node exists that CAN produce the effect; it does not prove the node
 * runs on exactly the inputs the condition names — that needs the examples as a
 * test suite, and it is Increment G's outcome oracle. Claiming otherwise would
 * be a completeness proof we cannot make, which is worse than no proof at all
 * (converger-v2 §3). `when` is carried, recorded, and reported as unproven.
 *
 * @module src/workflows/outcome-oracle.js
 */

import { normalizeSteps } from './node-types/foreach.js';
// closedDomainOf / onRefId are the SHARED definitions of "what values can this node
// EMIT" and "which step does a branch route on" — the same two the validator's moat
// (BRANCH_CASE_NOT_IN_ENUM, LLM_INPUT_NOT_ENUM) is built on. The runtime oracle must
// judge an assertion's `when` against the EXACT domain the branch routes on, or the
// two drift and a conditional promise is "checked" against a vocabulary nobody routes
// on. This is a circular import (the validator imports checkOutcome from here), and it
// is SAFE: every cross-module reference on both sides is inside a function body, never
// at module-init, so the live bindings are resolved only when first called.
import { closedDomainOf, onRefId } from './workflow-validator.js';
// The SAME case parser the engine, the validator and the SOP use. Lane coverage
// must not re-derive "what lanes does this branch have" — `decision-analysis.js`
// held one rule in two functions and they disagreed twice (case-sensitivity, then
// undeclared enum literals), each time producing a proof about a program nobody
// was running. One parser, one answer.
import { normalizeCases, CATCH_ALL } from './node-types/branch.js';
// A `human` node's ask IS a message, and `normalizeChannels` is the one parser of
// where it goes — the same one `buildAsk()` hands to the approval service. Reading
// `config.channels` by hand here would be a second definition of "where the question
// is sent", and the day the two disagree the oracle certifies a question that never
// reaches anybody.
import { normalizeChannels } from './node-types/human.js';

/** The closed set. An assertion outside it is MALFORMED, never "assumed fine". */
export const ASSERTION_KINDS = ['message_sent', 'record_exists', 'document_exists'];

/**
 * Connector aliases. A node writing via `gmail_send` satisfies an assertion
 * targeting "gmail", "google" or "email" — the user says "email me", the
 * converger writes "gmail", and both mean the same connector. Aliasing is how
 * that stays true without special-casing any one workflow.
 */
const CONNECTOR_ALIASES = {
  slack:     ['slack'],
  gmail:     ['gmail', 'google', 'email', 'mail'],
  docs:      ['docs', 'google', 'drive', 'gdocs'],
  drive:     ['drive', 'google', 'docs'],
  sheets:    ['sheets', 'google', 'drive', 'spreadsheet'],
  calendar:  ['calendar', 'google', 'gcal'],
  // GOOGLE TASKS WAS NEVER IN THIS TABLE, and its absence did not read as "unknown"
  // — it read as GMAIL. `canonicalConnector('google_tasks')` finds no `tasks` key,
  // falls back to the parts, and `google` appears in gmail's alias list first, so a
  // promise about someone's task list resolved to their mail. Witnessed on prod
  // 2026-07-29: `google_tasks:My Tasks` (the model writes what a person would say)
  // could not be satisfied by the one step that satisfied it.
  //
  // Every other Google sub-service has been here since the table was written; this
  // one was simply forgotten when the capability was added. The lesson is in the
  // ordering hazard, not the omission: any `google_<x>` for an `<x>` missing from
  // this table silently becomes gmail rather than failing loudly.
  tasks:     ['tasks', 'google', 'gtasks', 'google_tasks'],
  airtable:  ['airtable'],
  inbox:     ['inbox', 'atlas', 'in_app', 'app'],
  webhook:   ['webhook', 'http', 'https'],
  filesystem:['filesystem', 'file', 'disk'],
};

function aliasesFor(connector) {
  const key = String(connector ?? '').toLowerCase();
  return new Set(CONNECTOR_ALIASES[key] ?? (key ? [key] : []));
}

/**
 * Connectors whose "locator" is a DESCRIPTION, not an ADDRESS.
 *
 * The Atlas inbox is a single per-user destination — there is no second inbox to
 * mis-route to. An `inbox:Daily CRM Summary` assertion names a *title*, and a title
 * is a label chosen by the model, not an address the delivery is sent to. Matching
 * an inbox delivery's actual title against the assertion's title is therefore a
 * comparison of two free-text strings that legitimately differ — and when they did
 * (the converger titled the item `[Name] — [Company]` while the assertion said
 * `Daily CRM Summary`), the oracle reported "nothing reached inbox:…" on a genuine
 * delivery, stranding fan-out and foreach builds that could never satisfy their own
 * contract. For these connectors the locator is informational: ANY delivery to the
 * connector satisfies the assertion. This does NOT weaken the moat — a spec that
 * promises the inbox and delivers nothing to it still fails; we only stop treating a
 * label as an address it never was.
 */
const LOCATOR_FREE_CONNECTORS = new Set(['inbox']);
function isLocatorFree(connector) {
  for (const alias of aliasesFor(connector)) if (LOCATOR_FREE_CONNECTORS.has(alias)) return true;
  return LOCATOR_FREE_CONNECTORS.has(String(connector ?? '').toLowerCase());
}

/**
 * An in-app inbox item is BOTH a message (it notifies the user) and a record (it
 * persists in a list). The converger describes it either way — `message_sent →
 * inbox:…` and `record_exists → inbox:…` are both natural and both appear in the
 * outcome candidates it renders. `CHANNEL_EFFECTS.inbox_deliver` can only carry one
 * `kind`, so a `record_exists → inbox` assertion failed the kind check against an
 * inbox delivery and produced an UNSATISFIED_ASSERTION that no amount of "Accept all
 * defaults" could clear (the derived node kept producing `message_sent`). Treating
 * the inbox as dual-kind recognises what it actually is. This is NOT widening the
 * closed assertion set — both kinds remain checkable; one connector's effect is
 * genuinely both.
 */
const INBOX_DUAL_KINDS = new Set(['message_sent', 'record_exists']);
function kindSatisfies(effKind, wantKind, connectors) {
  if (effKind === wantKind) return true;
  const inbox = connectors instanceof Set
    ? [...connectors].some(c => LOCATOR_FREE_CONNECTORS.has(c))
    : isLocatorFree(connectors);
  return inbox && INBOX_DUAL_KINDS.has(effKind) && INBOX_DUAL_KINDS.has(wantKind);
}

/**
 * Deliver channels → (connector, effect). The `deliver` node's `channel` is the
 * only place the destination is named, so this table is how a deliver node gets
 * an effect at all.
 */
/**
 * Did this capability actually SAY what it does, or is it merely registered?
 *
 * The difference decides whether it outranks `CHANNEL_EFFECTS`. P13-0 established
 * that silence from something delivery-capable counts as a WRITE — a useful default,
 * but it is an INFERENCE, and the kind it produces comes from a verb regex that knows
 * nothing about (say) Slack. The table is hand-written knowledge about a specific
 * channel, so it beats that inference; it must not beat a capability that states its
 * own effect, kind or destination.
 *
 * Order of confidence, which is what the two call sites below implement:
 *   explicit declaration  >  CHANNEL_EFFECTS  >  inference from the id.
 */
function declaresExplicitly(cap) {
  if (!cap || typeof cap !== 'object') return false;
  return cap.effect === 'read' || cap.effect === 'write'
      || typeof cap.assertionKind === 'string'
      || Array.isArray(cap.locatorKeys);
}

/**
 * CHANNELS THAT DECLARE NOTHING — THE FALLBACK, NOT THE AUTHORITY.
 *
 * This table predates capabilities declaring `effect` / `assertionKind` /
 * `locatorKeys`, and until 2026-07-30 it was consulted FIRST. For every capability
 * appearing in both, the declaration was therefore DEAD CODE — the ninth instance of
 * one rule living in two places in this repo, and the best-hidden: the declaration
 * audit asks "is everything declared?" and the agreement sweep asks "do the two
 * consumers agree?", and BOTH passed, because neither asks whether the declaration is
 * REACHED. `calendar_create_event` even carried a `locatorKeys: ['title']` declaration
 * written to match this table; they agreed, and were wrong together.
 *
 * The order is now inverted: a registered capability's DECLARATION decides, and this
 * answers only for channels no capability declares — today `slack`, `slack_dm`,
 * `slack_file`, `inbox_deliver`, `in_app` and `webhook`, none of which is a registered
 * capability. Measured before the change: of the six ids that were in both, FOUR were
 * byte-identical, and the two that differed (`docs_create`, `calendar_create_event`)
 * differed only by a `subject` key that neither capability accepts.
 *
 * The entries are KEPT rather than deleted so the oracle still answers sensibly when
 * it is used without a catalog (which many checks do). `declaration-is-reachable.test.js`
 * holds the invariant that matters: where both exist, the DECLARATION is what is used,
 * and the two never disagree about the connector or the kind.
 *
 * Do not add an entry here for a capability that declares. Put it in the declaration,
 * where one reader can find it.
 */
const CHANNEL_EFFECTS = {
  slack:                  { connector: 'slack',    kind: 'message_sent',    locatorKeys: ['target'] },
  slack_dm:               { connector: 'slack',    kind: 'message_sent',    locatorKeys: ['user'] },
  slack_file:             { connector: 'slack',    kind: 'document_exists', locatorKeys: ['target'] },
  gmail_send:             { connector: 'gmail',    kind: 'message_sent',    locatorKeys: ['to'] },
  docs_create:            { connector: 'docs',     kind: 'document_exists', locatorKeys: ['title', 'subject'] },
  sheets_append:          { connector: 'sheets',   kind: 'record_exists',   locatorKeys: ['spreadsheetId', 'range'] },
  calendar_create_event:  { connector: 'calendar', kind: 'record_exists',   locatorKeys: ['title', 'subject'] },
  airtable_create_record: { connector: 'airtable', kind: 'record_exists',   locatorKeys: ['table', 'tableId', 'baseId'] },
  airtable_update_record: { connector: 'airtable', kind: 'record_exists',   locatorKeys: ['table', 'tableId', 'baseId'] },
  inbox_deliver:          { connector: 'inbox',    kind: 'message_sent',    locatorKeys: ['subject', 'title'] },
  in_app:                 { connector: 'inbox',    kind: 'message_sent',    locatorKeys: ['title', 'subject'] },
  webhook:                { connector: 'webhook',  kind: 'message_sent',    locatorKeys: ['url'] },
};

/**
 * A connector-action's capability id → its effect, derived from the VERB, not
 * from a hardcoded list of ids. New capabilities get an effect for free; a
 * capability that only READS gets none, and correctly satisfies nothing.
 *
 * The connector is the id's prefix (`airtable_create_record` → `airtable`), so
 * this stays workflow-agnostic (CLAUDE.md, closed decisions): no branch anywhere
 * knows about any particular workflow shape.
 */
const WRITE_VERBS = {
  message_sent:    /(^|_)(send|post|message|dm|reply|notify|share)(_|$)/i,
  record_exists:   /(^|_)(create_record|update_record|append|insert|add_row|create_event|add)(_|$)/i,
  document_exists: /(^|_)(create_folder|create_file|upload|file)(_|$)/i,
};
/** docs_create / drive_create_folder are documents; airtable_create_record is a record. */
const DOC_CONNECTORS = new Set(['docs', 'drive']);

/* ── P13-0 seam #1 + #2: effect from DECLARED STRUCTURE, not from the id ──────
 *
 * The tables above only know the connectors we happened to hand-build. A capability
 * from any other source — an imported server, a generated connector — hits
 * `WRITE_VERBS` with an id containing no token it recognises (`notion_create_page`:
 * "page" is not in the set) and is classified as a READ. It then silently skips
 * idempotency and the approval gate, and the run reports success. That is the
 * failure class this whole phase exists to kill, and it is invisible in production.
 *
 * So: a capability DECLARES its effect in the catalog, and that declaration wins.
 * The id-regex survives only as the legacy path for native capabilities that
 * declare nothing (they are all in the tables above and behave as before).
 *
 * The catalog is injected rather than imported: `outcome-oracle.js` is a pure module
 * used by the validator, the gap scorer, the test panel and the converger, several
 * of which construct it without a running server. A missing catalog therefore must
 * NOT be an error — it degrades to exactly today's behaviour.
 */
let _catalog = null;

/**
 * Give the oracle the live capability catalog. Called once at boot, beside the
 * registry construction. Passing `null` restores the pre-P13 id-regex behaviour.
 *
 * @param {{ get: (id: string) => object|undefined }|null} catalog
 */
export function setCapabilityCatalog(catalog) {
  _catalog = (catalog && typeof catalog.get === 'function') ? catalog : null;
}

/** The catalog entry for a capability id, or `undefined` when unknown/uninjected. */
function capabilityOf(id) {
  if (!_catalog || !id) return undefined;
  try { return _catalog.get(id) ?? undefined; } catch { return undefined; }
}

/**
 * Does this capability DECLARE that it writes? (P13-0, closing the gap the verifier
 * found.)
 *
 * Exported because `workflow-validator.js` needs the same answer and must not grow a
 * third copy of "what is a write". There were already two — `WRITE_VERBS` here and
 * `isWritingAction` there, whose own docstring says it exists "so the approval rules
 * and the idempotency rule cannot drift apart about what a write is". Making the
 * oracle declaration-aware and leaving the validator on the regex drifted them
 * exactly as that comment feared: the oracle knew a step wrote while the two guards
 * that protect the customer — the duplicate check and the approval-strength check —
 * still guessed from its name. So `notion_update_page` escaped both.
 *
 * ONE catalog, ONE declaration, read from both places.
 *
 * @returns {boolean} true only when the capability explicitly declared a write, or
 *   declared nothing while being able to occupy a delivery position (fail closed).
 */
export function declaresWrite(capabilityId) {
  return declaredEffectOf(String(capabilityId ?? '').trim()) === 'write';
}

/**
 * Does this capability CONFIGURE A RESOURCE ONCE, rather than doing per-run work?
 *
 * "Add a column", "create a channel" — things a workflow needs to EXIST. They belong
 * on the setup path, which runs once while the workflow is being built; as a workflow
 * STEP they repeat on every fire.
 *
 * Read from the same catalog as `declaresWrite`, and DECLARED rather than guessed
 * from the id. A regex over capability names is the shape this repo has been bitten
 * by three times (`isWritingAction`, the trigger captions, the step-type tables), and
 * `airtable_create_field` / `slack_create_channel` would both be indistinguishable
 * from `airtable_create_record` — which genuinely is per-run work — to any name test.
 *
 * Unknown capability ⇒ false. This gate REFUSES a workflow, so silence must not be
 * able to block a build; the only thing that can is an explicit declaration.
 */
export function declaresOneTimeSetup(capabilityId) {
  const cap = capabilityOf(String(capabilityId ?? '').trim());
  return cap?.oneTimeSetup === true;
}

/**
 * Does this capability write, according to what it DECLARED?
 *
 *   'write'     — declared a write, or declared nothing while being able to occupy a
 *                 delivery position (fail closed — see the register() note).
 *   'read'      — declared a read. Satisfies nothing, and must not appear to.
 *   undefined   — we have no catalog entry at all; the caller falls back to the
 *                 legacy id-regex so native behaviour is unchanged.
 */
function declaredEffectOf(id) {
  const cap = capabilityOf(id);
  if (!cap) return undefined;
  if (cap.effect === 'write' || cap.effect === 'read') return cap.effect;
  // Declared nothing. A capability that can be a DELIVERY is a writer by definition
  // — that is what delivering is. Fail closed rather than guessing from the name.
  if (Array.isArray(cap.positions) && cap.positions.includes('delivery')) return 'write';
  return undefined;   // step-only and silent → legacy path decides.
}

/**
 * Build the effect record for a capability that declared a write.
 * `assertionKind` is honoured when declared; otherwise the verb regex is consulted
 * as a hint, and `record_exists` is the last resort — the most generic statement of
 * "something now exists that did not before".
 */
function declaredWriteEffect(id, cap, config) {
  const connector = String(cap?.connector ?? id.split('_')[0] ?? '').toLowerCase();
  let kind = cap?.assertionKind;
  if (!ASSERTION_KINDS.includes(kind)) {
    kind = ASSERTION_KINDS.find(k => WRITE_VERBS[k].test(id)) ?? 'record_exists';
    if (kind === 'record_exists' && DOC_CONNECTORS.has(connector)) kind = 'document_exists';
  }
  // DECLARING NO KEYS IS A DECLARATION — it is not the absence of one.
  //
  // This read `Array.isArray(…) && length ? … : null`, collapsing the two into one
  // answer and sending `locatorKeys: []` down the GUESS path — the absent-vs-
  // unrecognised conflation this file's history is made of. Nothing ships `[]` today,
  // so this is latent rather than witnessed; it was found while giving
  // `calendar_create_event` a fixed destination and is fixed here so the next
  // capability with ONE possible destination can say so.
  //
  //   · no `locatorKeys` property  → undeclared, from a source we do not control → guess.
  //   · `locatorKeys: []`          → declared: the destination is FIXED, nothing to
  //                                  read from config, `defaultLocator` is the answer.
  const declaredKeys = Array.isArray(cap?.locatorKeys) ? cap.locatorKeys : null;
  const keys = declaredKeys && declaredKeys.length ? declaredKeys : null;
  // WHY A DECLARED KEY LIST BEATS THE GUESS LIST.
  //
  // `collectLocators` walks LOCATOR_KEYS — a fixed list of key names that USUALLY
  // name a destination. It is a guess about FORM, and it is wrong whenever a
  // capability happens to use one of those names for CONTENT instead. Witnessed on
  // prod 2026-07-29: `tasks_create` takes `{title, notes, due, tasklistId}`. The
  // guess list contains `title` and not `tasklistId`, so the oracle reported the
  // task's own NAME as the place it was written to — "nothing reached \"My Tasks\"
  // in tasks — this run delivered to {{extract_email.subject}} (tasks)". A correct
  // workflow was therefore unsatisfiable, and the converger spent THREE Opus
  // rebuilds (~150s, ~$1.40) failing to fix a spec that was already right.
  //
  // This is the same defect family as `isWritingAction` and the trigger captions:
  // a rule scoped to the SHAPE of a name rather than to what the thing MEANS. The
  // guess list stays as the fallback for capabilities from sources we do not
  // control, but every capability we ship declares.
  const declared = declaredKeys
    ? (keys ?? []).map(k => config?.[k]).filter(v => typeof v === 'string' && v.trim())
    : collectLocators(config);
  // An implicit destination counts, but never over an explicit one. Reached both when
  // the declared keys are blank on THIS node and when the capability declared none.
  const locators = (declaredKeys && !declared.length && typeof cap?.defaultLocator === 'string' && cap.defaultLocator.trim())
    ? [cap.defaultLocator.trim()]
    : declared;
  // ── WHAT A PERSON CALLS THE PLACE, AND WHAT THE CONNECTOR CALLS ITSELF ────
  //
  // A contract is written in the words the OUTCOME uses — "tasks:My Tasks",
  // "docs:Weekly report" — which are SUB-SERVICE names. `cap.connector` is the
  // credential-owning connector, and for everything Google that is the single
  // value 'google'. Taking only the declared one is how declaring `effect: 'write'`
  // on `tasks_create` turned a locator bug into a CONNECTOR bug: the destination
  // was finally right, and the assertion failed anyway because "google" is not
  // "tasks". (Caught only by re-running the real build on prod — the unit tests
  // covered the runtime check and the receipt, and not this, the third decider.)
  //
  // Both names are legitimate; neither is a guess. The union is what the id-prefix
  // path produced before anything was declared, so declaring can only ever ADD a
  // name here, never remove one.
  const connectors = aliasesFor(connector);
  for (const alias of aliasesFor(String(id ?? '').split('_')[0])) connectors.add(alias);
  return {
    kind,
    connectors,
    locators,
    fields:     readFieldNames(config?.fields),
  };
}

/**
 * The effect a node has on the world, or `null` if it has none (a read, an LLM
 * step, a branch — none of which can satisfy an assertion, and none of which
 * should ever be mistaken for doing so).
 *
 * @returns {{ kind: string, connectors: Set<string>, locators: string[], fields: string[]|null } | null}
 */
export function nodeEffect(node) {
  if (!node || typeof node !== 'object') return null;

  // A `foreach` HAS the effects of the steps inside it. (P12 Increment F.)
  //
  // It returned null, so the shape Increment F's own prompt teaches — "create a
  // record for every row" — could not satisfy its own `record_exists` assertion and
  // therefore COULD NOT PUBLISH. The only way out was to delete the assertion,
  // which leaves the loop's write both unpromised by the outcome and (until this
  // increment) unchecked by the validator: the worst of both. A loop is not an
  // opaque box; it is N copies of what is inside it, and what is inside it is
  // exactly what the outcome is about. (Found by the test-adversary.)
  //
  // The first sub-step with a recognisable effect wins — the assertion asks "does
  // anything here write to airtable:Leads", and one write inside a loop is a write.
  if (node.type === 'foreach') {
    for (const sub of normalizeSteps(node.config?.steps)) {
      const eff = nodeEffect(sub);
      if (eff) return eff;
    }
    return null;
  }

  if (node.type === 'deliver') {
    const channel = String(node.config?.channel ?? '').trim();
    // AN EXPLICIT DECLARATION OUTRANKS THE TABLE. A capability that is merely
    // registered does not — see `declaresExplicitly`.
    const capchannel = capabilityOf(channel);
    if (declaresExplicitly(capchannel)) {
      const declaredFirst = declaredEffectOf(channel);
      if (declaredFirst === 'read')  return null;
      if (declaredFirst === 'write') return declaredWriteEffect(channel, capchannel, node.config);
    }
    const eff = CHANNEL_EFFECTS[channel];
    if (eff) {
      return {
        kind:       eff.kind,
        connectors: aliasesFor(eff.connector),
        locators:   eff.locatorKeys.map(k => node.config?.[k]).filter(v => typeof v === 'string' && v.trim()),
        fields:     readFieldNames(node.config?.fields),
      };
    }
    // SEAM #2 — a `deliver` used to return null here, with no fallback of any kind
    // (unlike `connector-action` below, which at least had the verb regex). So a
    // correctly-configured delivery to any capability outside the ~12-entry table
    // got effect `null`, its outcome assertion could never be satisfied, and publish
    // hard-failed with UNSATISFIED_ASSERTION on a workflow that was perfectly good.
    // Loud rather than silent — but it blocks a real user, so it is a blocker.
    if (!channel) return null;
    const declared = declaredEffectOf(channel);
    if (declared === 'read')  return null;
    if (declared === 'write') return declaredWriteEffect(channel, capabilityOf(channel), node.config);
    return null;
  }

  if (node.type === 'connector-action') {
    const action = String(node.config?.action ?? '').trim();
    if (!action) return null;

    // AN EXPLICIT DECLARATION OUTRANKS THE TABLE. A capability that is merely
    // registered does not — see `declaresExplicitly`.
    const capaction = capabilityOf(action);
    if (declaresExplicitly(capaction)) {
      const declaredFirst = declaredEffectOf(action);
      if (declaredFirst === 'read')  return null;
      if (declaredFirst === 'write') return declaredWriteEffect(action, capaction, node.config);
    }

    // A registered delivery capability used as a mid-flow step has the same
    // effect it would have as a delivery — the world does not care which node
    // type called it.
    const known = CHANNEL_EFFECTS[action];
    if (known) {
      return {
        kind:       known.kind,
        connectors: aliasesFor(known.connector),
        locators:   known.locatorKeys.map(k => node.config?.[k]).filter(v => typeof v === 'string' && v.trim()),
        fields:     readFieldNames(node.config?.fields),
      };
    }

    // SEAM #1 — the DECLARED effect wins over any inference from the id. A write
    // whose name contains no verb we happen to recognise is still a write.
    const declared = declaredEffectOf(action);
    if (declared === 'read')  return null;   // declared a read: satisfies nothing.
    if (declared === 'write') return declaredWriteEffect(action, capabilityOf(action), node.config);

    // Legacy path: native capabilities that declare nothing. Unchanged behaviour.
    const connector = action.split('_')[0].toLowerCase();
    for (const kind of ASSERTION_KINDS) {
      if (!WRITE_VERBS[kind].test(action)) continue;
      // `create` on a doc connector makes a document; on a data connector, a record.
      let k = kind;
      if (kind === 'record_exists' && DOC_CONNECTORS.has(connector)) k = 'document_exists';
      return {
        kind:       k,
        connectors: aliasesFor(connector),
        locators:   collectLocators(node.config),
        fields:     readFieldNames(node.config?.fields),
      };
    }
    return null;   // a read. It satisfies nothing, and must not appear to.
  }

  return null;
}

/** Config values that could name a destination. Ids, tables, channels, addresses. */
const LOCATOR_KEYS = ['target', 'user', 'to', 'channel', 'table', 'tableId', 'baseId',
                      'spreadsheetId', 'url', 'path', 'title', 'name', 'folderId'];
function collectLocators(config) {
  if (!config || typeof config !== 'object') return [];
  return LOCATOR_KEYS
    .map(k => config[k])
    .filter(v => typeof v === 'string' && v.trim());
}

/**
 * The field names a write node actually sets — but ONLY when they are readable.
 * A `fields` that is a template string, or absent, yields `null` meaning "we
 * cannot see them", which is NOT the same as "there are none". Reporting a
 * missing field we simply could not read would be a false accusation, and it
 * would block a valid spec.
 */
function readFieldNames(fields) {
  // A JSON-STRING `fields` still names its columns, and the Airtable handler parses
  // it (`typeof fields === 'string' ? JSON.parse(fields)`), so refusing to read it
  // here was a FAIL-OPEN: the oracle made "no claim", the assertion counted as
  // satisfied, and a spec writing entirely invented columns published clean. The
  // shape we genuinely cannot check — a TEMPLATE string, where the column names are
  // chosen by a model at RUN time — is rejected outright by the validator
  // (UNCHECKABLE_WRITE_FIELDS), so it never reaches here.
  // (Found by the independent verifier + the test-adversary.)
  if (typeof fields === 'string') {
    try { fields = JSON.parse(fields); } catch { return null; }
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const keys = Object.keys(fields);
  return keys.length ? keys : null;
}

/** "slack:#ops" → { connector: 'slack', locator: '#ops' }. A bare "slack" has no locator. */
export function splitTarget(target) {
  const raw = String(target ?? '').trim();
  if (!raw) return { connector: '', locator: '' };
  const i = raw.indexOf(':');
  if (i < 0) return { connector: raw.toLowerCase(), locator: '' };
  return { connector: raw.slice(0, i).trim().toLowerCase(), locator: raw.slice(i + 1).trim() };
}

/**
 * An assertion target in the words a person would use.
 *
 * `target` is a MACHINE locator — "<connector>:<locator>" — and it had been reaching
 * the user verbatim on two surfaces that matter: the gap question the builder asks
 * before it will finish ("The outcome says inbox:Email Summary should happen only
 * when urgent_approved…") and the test panel's failure line ("nothing reached
 * inbox"). Neither is English, and the first one is a question a non-technical
 * person is being asked to JUDGE. Identifiers are the codebase's filing system.
 *
 * One renderer, here, because this module already owns what a target MEANS
 * (`splitTarget`, `CHANNEL_EFFECTS`) — a second copy in the gap scorer or in the
 * browser would drift, and the day it drifts the user is reading a description of
 * a promise the checker is not checking.
 */
export function describeTarget(target) {
  const { connector, locator } = splitTarget(target);
  if (!connector) return String(target ?? '').trim() || 'its destination';
  const place = CONNECTOR_PLACE[connector] ?? connector.replace(/[_-]+/g, ' ');
  if (!locator) return place;
  // A Slack locator carries its own decoration ("#ops", "@amy") and reads fine as-is.
  if (connector === 'slack') return `${locator} on Slack`;
  return `"${locator}" in ${place}`;
}

/** How each connector is referred to in conversation, rather than by its id. */
const CONNECTOR_PLACE = {
  inbox: 'your Atlas inbox',
  slack: 'Slack',
  gmail: 'Gmail',
  airtable: 'Airtable',
  sheets: 'Google Sheets',
  docs: 'Google Docs',
  drive: 'Google Drive',
};

/** A route value in the words a person used: "urgent_approved" → "urgent approved". */
export function describeValue(v) {
  return String(v ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Strip the decoration people put on destinations: "#ops" / "@amy" / "ops " all compare equal. */
function normLocator(s) {
  return String(s ?? '').trim().toLowerCase().replace(/^[#@]+/, '');
}

/** A locator that is a template can only be resolved at run time — so it matches anything. */
function isTemplate(s) {
  return /\{\{[^}]+\}\}/.test(String(s ?? ''));
}

/**
 * A LOCATOR THAT NAMES THE PRODUCT IS NOT AN ADDRESS.
 *
 * The assertion target is prose a model writes, and it phrases the same promise a
 * different way on every build. Observed on three consecutive prod builds of ONE
 * workflow, all correct, none satisfiable:
 *
 *     tasks:My Tasks          the list
 *     google_tasks:My Tasks   the product, then the list
 *     tasks:Google Tasks      the product, twice
 *
 * The third names no destination at all — "a task in Google Tasks" is the connector
 * repeated, and there is no second Google Tasks to mis-route to. Requiring it to
 * match the list name means the model must guess a provider default ("My Tasks")
 * that nobody in the conversation ever said.
 *
 * So: when the locator is just the connector's own name, the promise is about the
 * CONNECTOR, and any delivery there keeps it. This is the same judgement made three
 * times already in this file — a template locator, an opaque provider id, the inbox
 * — "undecidable / not an address here, therefore not a mismatch". It does not
 * weaken the check: kind, connector and fields are still enforced, a promise naming
 * a REAL destination is still compared exactly, and a workflow that promises Google
 * Tasks and delivers nothing there still fails.
 *
 * Chasing the phrasings one at a time is unwinnable; this removes a whole class.
 */
function locatorIsJustTheConnector(locator, connector) {
  const flat = (s) => normLocator(s).replace(/[\s_\-]+/g, '');
  const l = flat(locator);
  if (!l) return true;
  // DELIBERATELY EXACT, NOT FUZZY. An earlier draft also excused anything of the
  // form "my<connector>" — which swallowed "My Tasks", the REAL default list name,
  // and with it the check that a promise about a different list must fail. The
  // vendor prefix is the only variation allowed, because it is the only one that
  // adds no information: "Google Tasks" says nothing "tasks" had not already said,
  // while "My Tasks" names a specific list.
  for (const n of new Set([connector, canonicalConnector(connector)])) {
    const c = flat(n);
    if (c && (l === c || l === `google${c}` || c === `google${l}`)) return true;
  }
  return false;
}

/**
 * An OPAQUE PROVIDER ID — `tblbQ0PmkA2o1P17Q` — as opposed to a name a person
 * wrote. Whether it names the same table as `Table 1` is a question only a network
 * call to the provider can answer, so string comparison must not answer it, and
 * must never answer it "mismatch". Same judgement already made for a template.
 *
 * Deliberately NARROW: the documented Airtable id prefixes with their exact 14-char
 * body. `Sheet1`, `#general`, `ops@acme.com` are unaffected, so a genuinely wrong
 * human-named destination still fails.
 *
 * WHY IT IS SHARED (2026-07-28, witnessed on prod). This rule existed only inside
 * `satisfiesAssertion` — the BUILD-time check — while `checkAssertionAtRuntime`
 * compared the same two strings without it, under a comment claiming it "mirrors
 * the build-time check". It did not. A live approval workflow whose Airtable write
 * SUCCEEDED was reported to the user as:
 *
 *   "nothing reached "Table 1" in Airtable — this run delivered to
 *    tblbQ0PmkA2o1P17Q (Airtable), and nothing else."
 *
 * — a sentence that names the delivery it says did not happen, and which locked
 * Go live on a workflow that had done exactly what it promised. The guarantee is
 * not weakened by letting the id through: the dry-run `probe` independently reads
 * the base's schema and fails the run when the table genuinely is not there, so
 * existence is still proven — by the mechanism equipped to prove it.
 */
export function isOpaqueProviderId(s) {
  return /^(app|tbl|rec|fld|viw)[A-Za-z0-9]{14}$/.test(String(s ?? '').trim());
}

/**
 * Is this assertion well-formed? An assertion we cannot check must never pass
 * silently — that is precisely how a requested delivery gets dropped.
 *
 * @returns {string|null} the reason it is malformed, or null if it is fine.
 */
export function assertionDefect(assertion) {
  if (!assertion || typeof assertion !== 'object') return 'it is not an object';
  if (!assertion.kind) return 'it has no `kind`';
  if (!ASSERTION_KINDS.includes(assertion.kind)) {
    return `"${assertion.kind}" is not a kind this system can check (${ASSERTION_KINDS.join(', ')})`;
  }
  if (!assertion.target || !String(assertion.target).trim()) return 'it has no `target`';
  const { connector } = splitTarget(assertion.target);
  if (!connector) return `its target "${assertion.target}" names no connector`;
  return null;
}

/**
 * Does `node` satisfy `assertion`?
 *
 * Satisfaction is: same effect kind, a connector the node actually writes to,
 * and — where the assertion named a locator — a locator the node actually uses.
 */
/**
 * Where a `human` node's QUESTION is sent — one entry per approval channel.
 *
 * ── Why an ask has to count, and why it is NOT a delivery ────────────────────
 *
 * A `human` node sends a message: that is what an approval step IS. It posts the
 * question and waits. But `nodeEffect()` returns null for it, and deliberately so
 * — that function answers "does this step WRITE to the world", and its answer
 * feeds `isWriteNode`, which is what decides whether a forwardable email approval
 * is allowed to stand in front of a write (WEAK_APPROVAL_FOR_WRITE). Teaching
 * `nodeEffect` about `human` would make an approval step count as a write and
 * gate approvals behind approvals. So the ask is recognised HERE, in the promise
 * checker, and nowhere else.
 *
 * Without this, a promise like *"DM me asking to approve"* could only be kept by a
 * SEPARATE `deliver` node duplicating the question — because folding it into the
 * approval step left the promise pointing at a step that no longer existed, and
 * the spec then refused to publish (UNSATISFIED_ASSERTION). The generated shape was
 * therefore either unpublishable or double-messaged, and the model burned its whole
 * build budget negotiating between the two until the proxy killed the request.
 *
 * ── The narrowing, and why it is drawn here ──────────────────────────────────
 *
 * Only `inbox` and `slack` asks can satisfy a promise. An `email` ask is a signed
 * magic link sent by the PLATFORM mailer — it is not the tenant's Gmail connector,
 * so letting it satisfy a `gmail:…` promise would claim a send this deployment
 * never made through that connector. It fails closed instead.
 *
 * Each channel is matched WHOLE — its own connector against its own target. Pooling
 * every channel's target into one list would let a node asking over `slack:#ops` and
 * `email:bob@x.com` satisfy `slack:bob@x.com`, which nothing sends.
 */
function humanAskTargets(node) {
  if (node?.type !== 'human') return [];
  const out = [];
  for (const ch of normalizeChannels(node.config?.channels)) {
    const type = String(ch?.type ?? '').trim().toLowerCase();
    // email is deliberately absent — see above.
    const connector = type === 'slack' ? 'slack' : type === 'inbox' ? 'inbox' : null;
    if (!connector) continue;
    const locator = typeof ch.target === 'string' ? ch.target.trim() : '';
    out.push({ connector, locator });
  }
  return out;
}

/**
 * Does this `human` node's ask satisfy the assertion?
 *
 * A question is a `message_sent` and nothing else: it creates no record and no
 * document, so those kinds are refused outright rather than falling through to a
 * looser check.
 */
function askSatisfiesAssertion(assertion, node) {
  if (!assertion || typeof assertion !== 'object') return false;
  if (assertion.kind !== 'message_sent') return false;
  const targets = humanAskTargets(node);
  if (!targets.length) return false;

  const { connector, locator } = splitTarget(assertion.target);

  return targets.some((t) => {
    if (connector && !aliasesFor(t.connector).has(connector)) return false;
    if (isLocatorFree(t.connector)) return true;          // the inbox: its locator is a label
    if (!locator || isTemplate(locator)) return true;     // nothing to contradict / resolved at run time
    if (!t.locator) return false;                         // a slack ask with no target sends nowhere
    const want = normLocator(locator);
    const have = normLocator(t.locator);
    return have === want || have.includes(want) || want.includes(have);
  });
}

export function satisfiesAssertion(assertion, node) {
  // An approval step's QUESTION is a real message, but it is not a "write" and must
  // never be mistaken for one — hence its own path, before nodeEffect() is consulted.
  if (node?.type === 'human') return askSatisfiesAssertion(assertion, node);

  const eff = nodeEffect(node);
  if (!eff) return false;
  if (!kindSatisfies(eff.kind, assertion.kind, eff.connectors)) return false;

  const { connector, locator } = splitTarget(assertion.target);
  // CANONICALISE, AS THE RUNTIME CHECK ALREADY DID.
  //
  // `checkAssertionAtRuntime` has always compared `canonicalConnector(connector)`;
  // this, the BUILD-TIME half of the same question, compared the raw string. So the
  // two disagreed about what a target name refers to — the exact drift the
  // `isOpaqueProviderId` comment two paragraphs down was written about, in the same
  // function, for the same reason. A model writes what a person would say
  // ("google_tasks:My Tasks"); the runtime check understood it and the build-time
  // check raised UNSATISFIED_ASSERTION on a step that plainly satisfied it.
  //
  // Additive: an exact match still wins, so this can only ever accept a name it
  // previously rejected, never reject one it accepted.
  if (connector && !eff.connectors.has(connector) && !eff.connectors.has(canonicalConnector(connector))) return false;

  // For a locator-free connector (the inbox), the locator is a label, not an
  // address — any delivery to the connector satisfies the assertion.
  if (isLocatorFree(connector)) return true;
  // …and likewise when the locator merely repeats the product name.
  if (locatorIsJustTheConnector(locator, connector)) return true;
  // …INCLUDING when it names the SERVICE the delivery uses while the assertion names
  // the VENDOR. `google:Calendar` is the natural way to write "an event exists in my
  // calendar", and the rule above cannot see it: it compares the locator against
  // `google`, never against `calendar`.
  //
  // WITNESSED ON PROD, 2026-07-30 (`build-platform-1785424869443`), a demo-booking
  // workflow: *"nothing reached "Calendar" in google — this run delivered to
  // {{compute_event.event_title}} (calendar)"*. Two whole-spec Opus passes and a
  // refused third, on a correct workflow.
  //
  // Additive, exactly like the canonicalisation above: it can only accept a target
  // that was previously rejected, never reject one that was accepted. The locator is
  // still compared normally when it names a real destination — "Calendar" is excused
  // only because it repeats what the connector already said.
  for (const c of eff.connectors) if (locatorIsJustTheConnector(locator, c)) return true;

  // AN OPAQUE PROVIDER ID IS UNDECIDABLE HERE, NOT A MISMATCH (2026-07-19).
  //
  // A contract is written in the words a PERSON used — `airtable:Sheet1`. A node may
  // carry the same destination as the id the PROVIDER uses — `tblVbidmBZuBt1Tkf`.
  // Both name one table; only a network call to Airtable can say so. Comparing them
  // as strings therefore answers a question this function cannot answer, and it
  // answered it "mismatch", which is the one answer that is never safe.
  //
  // The cost was total: a correct `foreach` write with fully-resolved ids was reported
  // as *"no step in this workflow does that"*, the suggested remedy was a no-op, the
  // run was rejected (`run.invalid: UNSATISFIED_ASSERTION`) before the engine started,
  // and no "Go live" control was rendered. A workflow the product had itself built
  // correctly could be neither run nor published, with no path forward.
  //
  // This is the SAME judgement the line below already makes for a template locator —
  // "resolved at run time, undecidable here, so not a mismatch". An id is undecidable
  // for the same reason. It does NOT widen the check: kind, connector and fields are
  // all still enforced, and a human-readable locator is still compared exactly as
  // before. It only stops the oracle from failing a spec on a comparison it is not
  // equipped to make.
  //
  // Deliberately NARROW: only the documented Airtable id prefixes with their exact
  // 14-char body. `Sheet1`, `#general`, `ops@acme.com` are all unaffected, so a
  // genuinely wrong human-named destination still fails.
  //
  // Hoisted to module scope (2026-07-28) so the RUNTIME check shares it — see
  // `isOpaqueProviderId` and `checkAssertionAtRuntime`. It lived here as a local,
  // which is precisely how the two checks came to disagree.
  if (locator && !isTemplate(locator)) {
    const want = normLocator(locator);
    const hit = eff.locators.some((l) => {
      if (isTemplate(l)) return true;                  // resolved at run time — undecidable here, so not a mismatch
      if (isOpaqueProviderId(l)) return true;          // a provider id — undecidable here, same reason (see below)
      const have = normLocator(l);
      return have === want || have.includes(want) || want.includes(have);
    });
    // A node with NO locators at all (e.g. a webhook whose url is injected) can
    // still satisfy a located assertion — we have nothing to contradict it with.
    if (!hit && eff.locators.length) return false;
  }

  return true;
}

/**
 * Which nodes satisfy which assertions. The one call both the validator and the
 * gap scorer make.
 *
 * The `satisfied` map is keyed by the assertion's INDEX, not its id.
 *
 * Keying it by `a.id ?? a.target` silently DROPPED an assertion whenever two of
 * them shared an id — two Map.set() calls on the same key leave one entry, so
 * three assertions could be reported as two, falsifying the one property this
 * whole module exists to guarantee. Worse, the surviving entry then carried the
 * FIRST assertion's `fields`, so the second's `fields: ['Budget']` was checked
 * against a list that never mentioned Budget, and a spec that never wrote Budget
 * published clean. Nothing validated id uniqueness — and an LLM generates these
 * ids. (Found by the test-adversary.) The index is unique by construction, which
 * is the point: a key that CAN collide is a silent drop waiting to happen.
 *
 * @returns {{ satisfied: Map<number, object[]>, unsatisfied: object[], malformed: {assertion, reason}[] }}
 */
export function checkOutcome(outcome, nodes = []) {
  const assertions = Array.isArray(outcome?.assertions) ? outcome.assertions : [];
  const satisfied   = new Map();
  const unsatisfied = [];
  const malformed   = [];

  assertions.forEach((a, i) => {
    const reason = assertionDefect(a);
    if (reason) { malformed.push({ assertion: a, reason }); return; }

    const hits = nodes.filter(n => satisfiesAssertion(a, n));
    if (hits.length) satisfied.set(i, hits);
    else unsatisfied.push(a);
  });

  return { satisfied, unsatisfied, malformed };
}

/**
 * Fields an assertion demanded that a satisfying node demonstrably does not set.
 * Only reported when the node's field names are READABLE (see readFieldNames) —
 * we never accuse a spec of dropping a field we merely could not see.
 */
export function missingFields(assertion, node) {
  const want = Array.isArray(assertion?.fields) ? assertion.fields : [];
  if (!want.length) return [];
  const eff = nodeEffect(node);
  if (!eff?.fields) return [];                       // unreadable — no claim made
  const have = new Set(eff.fields.map(f => String(f).trim().toLowerCase()));
  return want.filter(f => !have.has(String(f).trim().toLowerCase()));
}

/**
 * The connectors this tenant can actually be held to a promise about — derived
 * from the live delivery catalog (`capabilities.channels`), which is already
 * narrowed to what they have authorised.
 *
 * The converger must never PROMISE what it cannot DELIVER. Asked to "make my
 * business better", the model cheerfully invented an assertion against
 * `airtable:business improvements` for a tenant with no Airtable connected — an
 * unsatisfiable promise, which means a spec that can never publish and a user
 * stuck in a dead end with no way out. Prompt wording alone cannot prevent that;
 * a model asked for a contract will produce one. So the CODE decides what may be
 * promised.
 *
 * Returns an empty set when the catalog is unknown — in which case nothing can be
 * checked, and nothing is claimed (headless callers pass no channels).
 */
export function assertableConnectors(capabilities) {
  const chans = capabilities?.channels;
  const out = new Set();
  if (!Array.isArray(chans)) return out;
  for (const c of chans) {
    if (!c?.id || c.available === false) continue;
    const eff = CHANNEL_EFFECTS[c.id];
    const connector = eff?.connector ?? String(c.id).split('_')[0].toLowerCase();
    for (const alias of aliasesFor(connector)) out.add(alias);
  }
  return out;
}

/**
 * Backward-chaining: the node that WOULD satisfy this assertion.
 *
 * This is what lets `process` derive the graph from the outcome instead of
 * asking the user to describe it — "the system proposes, the user disposes"
 * (converger-v2 §6.2). Returns null when the shape can't be derived without
 * information we don't have (an Airtable write needs a baseId — that is
 * Increment F's schema discovery, and guessing it would ship a broken spec).
 */
export function nodeForAssertion(assertion, { capabilities = {} } = {}) {
  if (assertionDefect(assertion)) return null;
  const { connector, locator } = splitTarget(assertion.target);
  const id = `deliver_${connector}_${assertion.id ?? 'out'}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();

  const available = (channel) => {
    const chans = capabilities?.channels;
    if (!Array.isArray(chans)) return true;         // unknown catalog — don't block on it
    return chans.some(c => c?.id === channel && c.available !== false);
  };

  // The inbox is derivable for ANY kind — it is dual-nature (see kindSatisfies),
  // handles messages and records alike, and needs no schema to write to. Deriving
  // it only for `message_sent` was the other half of the fan-out/foreach dead end:
  // a `record_exists → inbox` gap had no auto-fix, so "Accept all defaults" left the
  // build stranded on an assertion the system itself refused to satisfy.
  if (aliasesFor('inbox').has(connector) && available('inbox_deliver')) {
    return { id, type: 'deliver', label: 'Save to the Atlas inbox',
             config: { channel: 'inbox_deliver', subject: (locator && !isTemplate(locator)) ? locator : 'Workflow result' } };
  }

  if (assertion.kind === 'message_sent') {
    const isSlack = aliasesFor('slack').has(connector);
    const isMail  = aliasesFor('gmail').has(connector) && connector !== 'google';

    if (isSlack && available('slack') && locator && !isTemplate(locator)) {
      const dm = !locator.startsWith('#') && (locator.includes('@') || locator.startsWith('@'));
      if (dm && available('slack_dm')) {
        return { id, type: 'deliver', label: `DM ${locator}`,
                 config: { channel: 'slack_dm', user: locator.replace(/^@/, '') } };
      }
      if (!dm) {
        return { id, type: 'deliver', label: `Post to ${locator}`,
                 config: { channel: 'slack', target: locator.startsWith('#') ? locator : `#${locator}` } };
      }
    }
    if (isMail && available('gmail_send') && locator && !isTemplate(locator)) {
      return { id, type: 'deliver', label: `Email ${locator}`,
               config: { channel: 'gmail_send', to: locator } };
    }
  }

  // Other record_exists / document_exists targets (airtable, sheets, docs) need a
  // destination schema (base, table, folder) we cannot invent. Increment F reads it
  // from the connector; until then this correctly returns null and the assertion
  // stays an open gap rather than becoming a node with a made-up id in it.
  return null;
}

// ── The RUNTIME oracle (P12 Increment G) ─────────────────────────────────────
//
// `satisfiesAssertion` above answers a BUILD-time question: does the SPEC contain
// a node that CAN produce this effect? The test panel asks the RUN-time twin: on
// this sample input, DID the effect actually happen? A build-time yes and a
// run-time no is the most valuable thing a test panel can show — the workflow is
// shaped right and still doesn't deliver, which is exactly the case a person needs
// to see before it goes live.
//
// It reads the run's DELIVERIES (each `{delivered, channel, target, ts, …}` — what
// a deliver/write node returns) rather than re-deriving anything. The check is the
// same connector-aliasing this file already owns, applied to what a run PRODUCED
// instead of to what a spec DECLARES — one definition of "slack:#ops", used both
// ways.

/**
 * The CANONICAL connector key for a name that may be a key OR an alias.
 * `mail` and `email` both canonicalise to `gmail`, so a `mail:` assertion and a
 * `gmail_send` delivery compare equal without either side having to know the
 * other's spelling.
 */
export function canonicalConnector(name) {
  const n = String(name ?? '').toLowerCase();
  if (CONNECTOR_ALIASES[n]) return n;                       // already a key
  for (const [key, aliases] of Object.entries(CONNECTOR_ALIASES)) {
    if (aliases.includes(n)) return key;
  }
  // COMPOUND VENDOR NAMES. A model writes what a person would say — "google_docs",
  // "google_sheets" — and neither is a connector id (`google`) or a capability id
  // (`docs_create`). Unresolved, the candidate filter in the converger reads it as
  // an unconnected connector and REFUSES TO BUILD: "I can't include google_docs —
  // that connector is not connected", for a connector the live catalog reports as
  // available. Try the parts before giving up, most specific first, so
  // `google_docs` resolves to `docs` rather than to the vaguer `google`.
  const parts = n.split(/[_\-.]/).filter(Boolean);
  if (parts.length > 1) {
    for (const part of parts.slice().reverse()) {
      if (CONNECTOR_ALIASES[part]) return part;
      for (const [key, aliases] of Object.entries(CONNECTOR_ALIASES)) {
        if (aliases.includes(part)) return key;
      }
    }
  }
  // ── THE SAME NAME WITH NOTHING BETWEEN THE WORDS ──────────────────────────
  //
  // A model writes `gdrive`, `gsheets`, `googledrive` as readily as `google_drive`,
  // and the split above only helps when there IS a separator. `gdocs` and `gcal`
  // happened to be spelled out in the alias table; `gdrive` and `gsheets` were
  // simply forgotten — and the cost of forgetting is not a cosmetic one.
  //
  // WITNESSED ON PROD, 2026-07-29. Asked for a weekly CRM digest in a Google Doc,
  // Atlas spent three turns designing it, produced a plan, and then refused to
  // build: *"I can't include gdrive — that connector is not connected, so I won't
  // promise something the workflow can't actually do."* Google Workspace WAS
  // connected. `assertableConnectors` never saw `gdrive`, so a workflow Atlas could
  // run perfectly well was declined, and the user was told their working connector
  // was missing.
  //
  // Handled as the two FAMILIES rather than the instances, because the instances are
  // unbounded: a vendor prefix run together with the service name. Only reached when
  // the name is otherwise unknown, so `gmail` — a key in its own right — is returned
  // long before it could ever be shortened to `mail`.
  // Order between the two prefixes is immaterial — the loop tries both, so
  // `googledrive` resolves whether `google` or `g` is stripped first. A name with
  // nothing after the prefix (`g`, `google`) needs no guard either: the remainder is
  // empty, matches no key and no alias, and falls through to being returned as
  // itself. Both were confirmed by mutation — neither could be made to fail.
  for (const prefix of ['google', 'g']) {
    if (!n.startsWith(prefix)) continue;
    const rest = n.slice(prefix.length);
    if (CONNECTOR_ALIASES[rest]) return rest;
    for (const [key, aliases] of Object.entries(CONNECTOR_ALIASES)) {
      if (aliases.includes(rest)) return key;
    }
  }
  return n;
}

/** The connector a delivery went to, from its `channel` (e.g. `gmail_send` → gmail). */
/**
 * DOES THIS DELIVERY REACH THE CONNECTOR THE PROMISE NAMES?
 *
 * The build-time half (`satisfiesAssertion`) asks whether the wanted connector is
 * among the ALIASES of the connector the node writes to — `docs` carries
 * `['docs','google','drive','gdocs']`, because a Google Doc genuinely does live in
 * Drive. The runtime half compared two canonical SCALARS instead: `docs` vs `drive`,
 * not equal, promise broken.
 *
 * WITNESSED ON PROD, 2026-07-30 (`build-platform-1785413586868`). A weekly CRM digest
 * written to a Google Doc. The contract said `google_drive:New Companies This Week`
 * (canonical `drive`); the delivery went via `docs_create` (canonical `docs`).
 * Build-time said satisfied, runtime said *"nothing reached … in google drive — this
 * run delivered to … (Google Docs)"*, and the build spent two more Opus passes trying
 * to fix a spec that was already right. Writing the very same promise as `docs:`
 * passed both halves — the workflow was correct and the wording decided the verdict.
 *
 * Seventh instance today of one rule living in two places and drifting. Both halves
 * now consult the same table.
 *
 * DIRECTED, NOT SYMMETRIC — and that is the whole safety of it. `gmail` and `docs`
 * both list `google` among their aliases, so intersecting their alias sets would make
 * an email satisfy a promise about a document. The question asked is the same one
 * build-time asks: is the WANTED connector among the aliases of what was actually
 * written to.
 */
function deliveryReaches(delivery, wantConnector) {
  const got = deliveryConnector(delivery);
  if (!wantConnector || got === wantConnector) return true;
  // Mutation-checked three ways. Replacing this with a scalar `===` restores the prod
  // bug (6 tests red); making it always-true opens it wide (3 red); and INTERSECTING
  // the two alias SETS — the shape the note above warns about — lets an email satisfy
  // a promise about a document, because `gmail` and `docs` both list `google` (2 red).
  // Adding the reverse `aliasesFor(wantConnector).has(got)` is behaviourally
  // equivalent, not a second guard: no pair reachable here differs on it.
  return aliasesFor(got).has(wantConnector);
}

function deliveryConnector(delivery) {
  const ch = String(delivery?.channel ?? '').toLowerCase();
  // A delivery names its channel (`slack`, `gmail_send`, `airtable_create_record`,
  // `in_app`); the connector is that channel's own prefix/alias.
  for (const [connector, aliases] of Object.entries(CONNECTOR_ALIASES)) {
    if (aliases.some(a => ch === a || ch.startsWith(`${a}_`))) return connector;
  }
  const head = ch.split('_')[0];
  return canonicalConnector(head || ch);
}

/**
 * Build a runtime delivery object from the delivering NODE + the handler's return.
 *
 * Delivery handlers are inconsistent about what they return — only Slack stamps
 * both `channel` and a destination. Inbox omits `channel`; gmail_send / airtable
 * writes omit both `channel` AND `delivered`. But the NODE always knows its channel
 * (a deliver node's `config.channel`, a connector-action's `config.action`), and the
 * SME's destination lives in the node config (or the handler output) under that
 * channel's own locator keys. So connector + locator are derived from the node — the
 * one place they are reliably present — and merged over the handler output. Without
 * this the runtime oracle could only ever confirm a Slack delivery: every inbox,
 * gmail, or airtable delivery read back as "nothing reached …" on a SUCCESSFUL run.
 * (P12 Increment G — the unit tests hand-built deliveries that carried these fields,
 * so they never exercised the real handler shapes; CLAUDE.md flaw #2.)
 */
export function normalizeDelivery(node, output) {
  const o = (output && typeof output === 'object') ? output : {};
  const channel = node?.type === 'deliver'          ? String(node.config?.channel ?? 'in_app')
                : node?.type === 'connector-action' ? String(node.config?.action  ?? '')
                : String(o.channel ?? '');
  const eff = CHANNEL_EFFECTS[channel];
  // Collect EVERY plausible destination this delivery reached, in one array —
  // both what the handler RESOLVED and what the node DECLARED. The two can differ,
  // and the assertion is written in the DECLARED terms:
  //   a Slack DM handler returns `target: "U0B3LM5KRGV"` (the resolved user id) while
  //   the node declares `user: "amy@acme.co"` (the email the assertion names). Keying
  //   the match to the resolved id alone reported "nothing reached slack:amy@acme.co"
  //   on a DM that was genuinely delivered — the exact false PROMISE BROKEN found in
  //   live testing. Carrying both lets `checkAssertionAtRuntime` match either.
  const locators = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) locators.push(v); };
  push(o.target); push(o.to); push(o.user); push(o.slackChannel); push(o.channelName);
  if (o.channel && o.channel !== channel) push(o.channel);
  if (eff) for (const k of eff.locatorKeys) { push(o[k]); push(node?.config?.[k]); }
  // ── THE CAPABILITY'S OWN DECLARATION, AHEAD OF ANY GUESS ──────────────────
  // This function is the SECOND place that decides where a delivery went; the
  // first is `nodeEffect`. They were separate rules over the same question, and
  // they drifted: fixing `tasks_create`'s destination in `nodeEffect` alone would
  // leave the RECEIPT — the thing `checkAssertionAtRuntime` actually matches, and
  // the thing whose first entry gets quoted back to the user as "this run
  // delivered to …" — still naming the task's title. Both now read the one
  // declaration.
  //
  // Ordering is load-bearing: matching accepts ANY locator in the list, so extra
  // entries are harmless, but `locators[0]` becomes `target` and that is what the
  // failure message quotes. The declared destination has to come first.
  //
  // What the RUN reported comes first, then what the node declared — the same
  // resolved-then-declared order used above, and the only way a wrong declaration
  // can ever be corrected by a real run. (`tasks_create` returns the list it wrote
  // to; without reading `o` here that return was dead weight.)
  if (!eff) {
    const cap = capabilityOf(String(node?.config?.action ?? node?.config?.channel ?? ''));
    if (Array.isArray(cap?.locatorKeys)) for (const k of cap.locatorKeys) push(o[k]);
    const d = nodeEffect(node); if (d) for (const l of d.locators) push(l);
  }
  // Fallback for a capability that declares nothing (an imported server, a
  // generated connector) — a guess is still better than losing the target.
  for (const l of collectLocators(node?.config)) push(l);
  const target = locators[0] ?? null;
  // WOULD-SATISFY (dry-run, increment #21). A build-time dry run stubs terminal
  // side-effect nodes into a receipt `{ dryRun:true, wouldDeliver, … }` instead of
  // firing them, so the converger's self-verification loop can iterate without
  // sending real emails or writing real records. Such a receipt satisfies an
  // assertion only if it WOULD have delivered — a wouldDeliver:false receipt
  // (empty body, unresolved template, unconnected channel) is NOT a delivery.
  //
  // Additive and inert for real runs: a genuine handler return has no `dryRun`
  // flag, so `delivered` stays `true` exactly as before — the real runtime check
  // is untouched.
  const delivered = o.dryRun === true ? o.wouldDeliver === true : true;
  return { ...o, delivered, channel, ...(target != null ? { target } : {}), locators };
}

/** Is this node a delivery — a `deliver` node, or a `connector-action` that WRITES? */
export function isDeliveryNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'deliver') return true;
  if (node.type === 'connector-action') return nodeEffect(node) != null;
  return false;
}

/**
 * Where a delivery node is headed, and whether that destination is PRESENT in
 * config — used by the dry-run oracle (increment #21) to compute `targetPresent`
 * without a real send. It does NOT check the destination EXISTS in the tenant's
 * live account (that is a later increment); presence only.
 *
 * The inbox (`in_app`) is locator-free — its "address" is a label, not an
 * external id — so it counts as present with no explicit target, mirroring how
 * `checkAssertionAtRuntime` treats a locator-free connector. Channel knowledge
 * stays here in the oracle, the one place that knows locator keys per channel.
 *
 * @returns {{ present: boolean, locatorFree: boolean, target: string|null }}
 */
export function deliveryTarget(node) {
  const eff = nodeEffect(node);
  if (!eff) return { present: false, locatorFree: false, target: null };
  const locatorFree = [...eff.connectors].some(c => LOCATOR_FREE_CONNECTORS.has(c));
  return {
    present: locatorFree || eff.locators.length > 0,
    locatorFree,
    target: eff.locators[0] ?? null,
  };
}

/**
 * WHY A RECEIPT DID NOT GO THROUGH, IN THE RUN'S OWN WORDS.
 *
 * A dry run does not merely record "no": `_dryRunDeliver` (flow-tester.js) records
 * WHICH of five conditions failed — `{hasBody, bodyWellFormed, targetPresent,
 * capabilityConnected, destinationReachable}` — and, when a connector `probe`
 * positively refused the destination, an `unreachableReason` in plain English
 * ("no Slack user matches \"charles@agntic.co\"").
 *
 * `normalizeDelivery` spreads all of that straight through, so every receipt the
 * runtime oracle sees is already carrying its own diagnosis. The loop below used
 * to `continue` past a `delivered:false` receipt without ever reading it, and the
 * check then reported the generic `nothing reached <target>` — a person was told
 * the destination was not reached and never told that Atlas knew exactly why.
 *
 * Composed, never narrated: every clause is a field off the receipt, and the
 * order mirrors `_dryRunDeliver`'s own `wouldDeliver` conjunction so the sentence
 * names the FIRST condition that failed rather than an arbitrary one. A receipt
 * that carries no diagnosis at all yields null, and the caller says so — filling
 * that gap with a plausible cause is the defect this whole file guards against.
 */
function undeliveredReason(d) {
  if (typeof d?.unreachableReason === 'string' && d.unreachableReason.trim()) {
    return d.unreachableReason.trim();
  }
  const c = d?.checks;
  if (c && typeof c === 'object') {
    if (c.hasBody === false)             return 'there was no content to send';
    if (c.bodyWellFormed === false)      return 'the message still had an unfilled {{…}} placeholder in it';
    if (c.targetPresent === false)       return 'no destination was filled in';
    if (c.capabilityConnected === false) return `${deliveryPlace(d)} is not connected`;
    if (c.destinationReachable === false) return 'the destination could not be reached';
  }
  return null;
}

/** The connector a receipt belongs to, in the words a person would use. */
function deliveryPlace(d) {
  return describeTarget(deliveryConnector(d));
}

/** Where a delivery actually landed, for "it went here instead". */
function deliveryWhere(d) {
  const loc = (Array.isArray(d?.locators) ? d.locators : [])
    .find(l => typeof l === 'string' && l.trim() && l !== d.channel)
    ?? d?.target ?? d?.to ?? d?.user ?? d?.slackChannel ?? null;
  const place = deliveryPlace(d);
  return loc ? `${loc} (${place})` : place;
}

/**
 * THE ONE RULE FOR "WHAT COUNTS AS A DELIVERY THIS RUN MADE".
 *
 * Both places that assemble a run's deliveries — `dry-run-runner.js` and
 * `POST /workflows/run` — used to carry their own copy of this rule, each a
 * comment apart, and each one blind to the approval step. That duplication is
 * how the build-time and runtime checks came to disagree in the first place.
 *
 * ── Why an approval step's ask belongs here (2026-07-28) ─────────────────────
 *
 * `satisfiesAssertion` has always known that a `human` node's question IS a
 * message — see `askSatisfiesAssertion`, and the long note above it explaining
 * that folding the DM into the approval step is the CORRECT shape, because a
 * separate delivery node would message the person twice. So a spec promising
 * *"DM me asking to approve"* passes the build.
 *
 * At runtime it did not. Deliveries were collected as
 * `isDeliveryNode(node) || output.delivered === true`, and a `human` node is
 * neither — so the ask was invisible to the oracle. Witnessed on prod
 * (2026-07-28, v1.6.48) on an otherwise passing run: *"Nothing in this run could
 * check hello@agntic.co on Slack, so that part is still unproven."* One of the
 * workflow's three promises went live unverified, on a run that did send it.
 *
 * The narrowing is inherited whole from `humanAskTargets`: slack and inbox only
 * (an `email` ask is a platform magic link, not the tenant's connector, so it
 * must not satisfy a gmail promise), and each channel matched as its own
 * connector+target pair rather than pooled.
 *
 * REACHING THE NODE IS THE EVIDENCE. `steps` contains only nodes that executed,
 * so an ask receipt exists exactly when the workflow actually got to the point of
 * asking — the same standard every other dry delivery is held to.
 */
export function askDeliveriesOf(node) {
  return humanAskTargets(node).map(t => ({
    delivered: true,
    ask:       true,
    channel:   t.connector === 'slack' ? 'slack' : 'inbox_deliver',
    target:    t.locator || null,
    locators:  t.locator ? [t.locator] : [],
  }));
}

/** Every delivery one executed step produced — 0, 1, or (for a multi-channel ask) more. */
export function deliveriesForStep(node, output) {
  const asks = askDeliveriesOf(node);
  if (asks.length) return asks;
  if (!isDeliveryNode(node) && !(output && output.delivered === true)) return [];
  return [normalizeDelivery(node, output)];
}

/** Did this run produce the effect this assertion promises? */
export function checkAssertionAtRuntime(assertion, deliveries = []) {
  const defect = assertionDefect(assertion);
  if (defect) return { ok: false, reason: `can't check — ${defect}` };

  const { connector, locator } = splitTarget(assertion.target);
  const wantConnector = canonicalConnector(connector);
  const wantLocator   = normLocator(locator);

  // ASK ABOUT THE NAME AS WRITTEN **AND** ITS CANONICAL FORM — the build-time half
  // has always done both (`eff.connectors.has(connector) || …has(canonical…)`), and
  // doing only one here is a drift that costs whole builds.
  //
  // The case that exposed it: `canonicalConnector('google')` is **`gmail`**, because
  // `google` appears in gmail's alias list. So a promise written with the VENDOR name
  // — `google:Calendar`, `google:My Report` — silently became a promise about GMAIL at
  // run time, and every non-Gmail Google delivery was recorded as "delivered
  // somewhere else". Witnessed on prod 2026-07-30 as *"nothing reached "Calendar" in
  // google"* on a correct demo-booking workflow: two whole-spec Opus passes, then a
  // refused third. Asking with the raw name as well finds it, because `calendar`
  // carries `google` among ITS aliases — which is the directed question this check is
  // supposed to ask.
  const reaches = (d) => deliveryReaches(d, wantConnector) || deliveryReaches(d, connector);

  const locatorFree = isLocatorFree(connector);

  // The diagnosis this run already holds, gathered as we go — see undeliveredReason.
  const blocked   = [];   // receipts for THIS connector that did not go through
  const landed    = [];   // deliveries that DID happen, but somewhere else

  for (const d of deliveries) {
    if (!d?.delivered) {
      // A receipt that refused itself. It is not a match — but it is the single
      // most useful thing this run knows about why the promise was not kept, and
      // reading it is the whole difference between "nothing reached them" and
      // "nothing reached them because no Slack user matches that address".
      if (reaches(d)) {
        const why = undeliveredReason(d);
        blocked.push(why ? `${deliveryPlace(d)}: ${why}` : `${deliveryPlace(d)}: the run did not record why`);
      }
      continue;
    }
    if (!reaches(d)) { landed.push(deliveryWhere(d)); continue; }
    // No locator on the assertion, a template locator (resolved at run time), or a
    // locator-free connector (the inbox — its "locator" is a label, not an address)
    // ⇒ "some delivery to this connector" is enough.
    // The build-time half applies `locatorIsJustTheConnector` too; leaving it out
    // here is how these two came to disagree about `google_tasks` in the first place.
    // …and against the connectors the DELIVERY uses, not only the one the assertion
    // names, so `google:Calendar` is recognised as naming the service rather than a
    // specific event. Added with the build-time half on 2026-07-30 and in the same
    // commit ON PURPOSE: putting it in one side only is precisely how these two came
    // to disagree about `google_tasks`, and about `google_drive` after that.
    if (!wantLocator || isTemplate(locator) || locatorFree
        || locatorIsJustTheConnector(locator, connector)
        || [...aliasesFor(deliveryConnector(d))].some(c => locatorIsJustTheConnector(locator, c))) {
      return { ok: true, detail: describeDelivery(d) };
    }
    // The delivery reached one or more destinations (its resolved value AND its
    // declared one — see normalizeDelivery). It satisfies the assertion if ANY of
    // them names the wanted locator. `includes` both ways mirrors the build-time
    // check, so "amy@acme.co" (the declared DM user) matches "slack:amy@acme.co"
    // even though the handler only returned the resolved user id.
    const cands = (Array.isArray(d.locators) && d.locators.length)
      ? d.locators
      : [d.target ?? d.to ?? d.user ?? d.channelName ?? d.slackChannel ?? ''];
    const hit = cands.some((c) => {
      // An opaque provider id cannot be string-compared with a human table name —
      // see `isOpaqueProviderId`. The build-time check has always treated this as
      // undecidable; omitting it HERE is what reported a successful Airtable write
      // as "nothing reached Table 1 — this run delivered to tblbQ0PmkA2o1P17Q".
      if (isOpaqueProviderId(c)) return true;
      const got = normLocator(c);
      return got && (got === wantLocator || got.includes(wantLocator) || wantLocator.includes(got));
    });
    if (hit) return { ok: true, detail: describeDelivery(d) };
    // Right connector, wrong address. That is a different failure from "nothing
    // was sent", and the person needs to be told where it actually went.
    landed.push(deliveryWhere(d));
  }
  return { ok: false, reason: `nothing reached ${describeTarget(assertion.target)}${becauseOf(blocked, landed)}` };
}

/**
 * The clause that turns "nothing reached them" into something a person can act on.
 *
 * Three distinct situations, and telling them apart is the entire point — they
 * lead to three different fixes:
 *
 *   · nothing was even attempted            → the workflow has no step that does this
 *   · it was attempted and refused, because → the step is right, the destination is not
 *   · things were delivered, elsewhere      → the step is right, it is pointed somewhere else
 *
 * Every clause is assembled from the run's own receipts. Nothing is inferred and
 * nothing is worded by a model — when the run recorded no diagnosis, this says so
 * rather than supplying one.
 */
function becauseOf(blocked, landed) {
  if (blocked.length) return ` — ${listOfUpTo(blocked, 3)}`;
  if (landed.length)  return ` — this run delivered to ${listOfUpTo(landed, 3)}, and nothing else`;
  return ' — no step in this run attempted it';
}

/** "a", "a and b", "a, b and 2 more" — bounded, so one clause cannot swamp the sentence. */
function listOfUpTo(items, max) {
  const xs = [...new Set(items.filter(Boolean))];
  const shown = xs.slice(0, max);
  const rest  = xs.length - shown.length;
  const head  = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  return rest > 0 ? `${head} and ${rest} more` : head;
}

/** A one-line, human description of what a delivery did — shown in the test panel. */
function describeDelivery(d) {
  const where = d.target ?? d.to ?? d.user ?? d.slackChannel ?? d.channel ?? '';
  return `${d.channel ?? 'delivered'}${where ? ` → ${where}` : ''}${d.ts ? ` (${d.ts})` : ''}`;
}

// The exact sentinel the converger writes into every content llm node's guard
// ("If the provided data is empty or missing, output EXACTLY: ERROR: required data
// not found"). Its presence in a run means a content step could not find its input
// and emitted an error string instead of real content — which then flows to the
// delivery. Matched precisely so a genuine summary that merely says "error" is not
// caught.
const CONTENT_ERROR_SENTINEL = /\bERROR:\s*required data not found\b/i;

/**
 * Did any step in the run emit the content-error sentinel? Returns {step, snippet}
 * for the first offender, else null. Scans every step's output (string or the
 * common content fields of an object) so a broken content node is caught wherever
 * it sits on the path to a delivery.
 */
export function runProducedContentError(runResult) {
  for (const s of (runResult?.steps ?? [])) {
    let o = s.output;
    const text = typeof o === 'string' ? o
      : (o && typeof o === 'object' ? String(o.text ?? o.body ?? o.summary ?? o.output ?? '') : String(o ?? ''));
    if (CONTENT_ERROR_SENTINEL.test(text)) {
      return { step: s.nodeId ?? s.type ?? 'a step', snippet: text.trim().slice(0, 60) };
    }
  }
  return null;
}

// ── Branch awareness: a CONDITIONAL assertion applies only on the lane it names ─
//
// A branching workflow (classify → branch → N lanes → N deliveries) delivers to
// exactly ONE lane per input. Its contract therefore carries CONDITIONAL assertions
// — `{ target: 'slack:#support', when: 'urgent' }` — each promising a delivery only
// on its own route. A single sample takes ONE lane, so the oracle must:
//   · ENFORCE the assertion whose `when` equals the route this run took (a real miss
//     there is still a failure — the anti-weakening guard);
//   · SKIP the assertions for lanes this sample did not take (neither pass nor fail);
//   · FAIL CLOSED on a `when` that names a value NO route can produce — an
//     uncheckable promise reported as met is exactly the failure the oracle exists
//     to prevent, so it is flagged, never silently skipped.
// An UNCONDITIONAL assertion (`when` null) is untouched: it must ALWAYS be satisfied.

/**
 * Normalise a routing value for comparison. Route values are categories / decision
 * outputs / human decisions — compared case-insensitively, the SAME way branch.js
 * `matches()` compares a case's `when` against the routed-on value (so the oracle and
 * the engine agree on what "took the urgent lane" means). An object output
 * (`decision`/`classify`/`human` all differ in shape) is reduced to its scalar first,
 * mirroring branch.js `matches()`.
 */
function normRoute(v) {
  if (v != null && typeof v === 'object') v = v.output ?? v.decision ?? v.value ?? v.text;
  return String(v ?? '').trim().toLowerCase();
}

/**
 * The CLOSED set of route values this spec can produce — the union, over every
 * `branch`, of the closed domain of the node it routes on (classify categories,
 * decision output values, human decisions). This is the vocabulary an assertion's
 * `when` MUST come from; a `when` outside it is unprovable. Derived from the shared
 * `closedDomainOf`, so the oracle and the validator's moat cannot disagree about it.
 *
 * @returns {Set<string>} normalised route values (empty when the spec has no branch
 *                        or none whose source declares a domain).
 */
export function routeDomainOf(spec) {
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const byId = new Map(nodes.map(n => [n?.id, n]));
  const domain = new Set();
  for (const b of nodes) {
    if (b?.type !== 'branch') continue;
    const srcId = onRefId(b.config?.on);
    if (!srcId) continue;
    for (const v of (closedDomainOf(byId.get(srcId)) ?? [])) domain.add(normRoute(v));
  }
  return domain;
}

/**
 * Which route value actually gates a step — the condition under which it runs.
 *
 * WHY THIS EXISTS. `assertion.when` holds ONE route value, but a real promise is
 * often a CONJUNCTION: "file it only when the email is urgent AND I approved it".
 * The model writes that as a single invented word — `urgent_approved` — which no
 * node can ever produce. Observed live: the contract carried it, `routeDomainOf`
 * reported the real vocabulary as `urgent, routine, junk, none, approve, reject,
 * timeout`, and the workflow's central promise became permanently uncheckable
 * while the panel showed it to the user as the contract. That unprovable promise
 * then drove rebuild after rebuild, each leaving another escalation gate behind.
 *
 * The conjunction does not need to be expressible, because the DEEPEST gate on a
 * path already implies every gate above it: the approval branch is only reachable
 * from the urgent lane, so "approved" and "urgent AND approved" select exactly the
 * same runs. So we walk the graph and take the NEAREST branch case that gates the
 * step.
 *
 * NEAREST, not any — and that is the whole correctness argument. Picking the outer
 * gate (`urgent`) would enforce the promise on runs that went urgent and were
 * REJECTED, i.e. a false failure on a workflow behaving exactly as designed.
 *
 * A branch only counts as a gate if at least one of its cases does NOT reach the
 * step: a branch all of whose lanes converge on it decides nothing about whether
 * it runs, and treating it as a condition would invent a gate the user never made.
 *
 * @returns {{ branch: string, values: string[] } | null} — null when nothing gates
 *          it (it runs on every path), which is not a failure: it means the promise
 *          is unconditional and `when` should simply be dropped.
 */
export function gatingRouteFor(spec, nodeId) {
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec?.edges) ? spec.edges : [];
  if (!nodeId || !nodes.some(n => n?.id === nodeId)) return null;

  const fwd = new Map();
  for (const e of edges) {
    if (!e?.from || !e?.to) continue;
    if (!fwd.has(e.from)) fwd.set(e.from, []);
    fwd.get(e.from).push(e.to);
  }
  /** Hops from `start` to `nodeId`, or -1. Breadth-first, so the count is the shortest. */
  const distTo = (start) => {
    if (start === nodeId) return 0;
    const seen = new Set([start]);
    let frontier = [start], d = 0;
    while (frontier.length) {
      d++;
      const next = [];
      for (const id of frontier) {
        for (const to of (fwd.get(id) ?? [])) {
          if (to === nodeId) return d;
          if (seen.has(to)) continue;
          seen.add(to); next.push(to);
        }
      }
      frontier = next;
    }
    return -1;
  };

  let best = null;
  for (const b of nodes) {
    if (b?.type !== 'branch') continue;
    const cases = normalizeCases(b.config?.cases).filter(c => c?.to);
    if (!cases.length) continue;

    const reaching = cases.filter(c => distTo(c.to) >= 0);
    // Reached by every lane (or by none) ⇒ this branch does not decide it.
    if (!reaching.length || reaching.length === cases.length) continue;

    const dist = Math.min(...reaching.map(c => distTo(c.to)));
    const values = reaching
      .map(c => String(c.when).trim())
      .filter(w => w && w !== CATCH_ALL);
    if (!values.length) continue;   // gated only by the catch-all: no value names it
    if (!best || dist < best.dist) best = { branch: b.id, values, dist };
  }
  return best ? { branch: best.branch, values: best.values } : null;
}

/**
 * What a run needs to reason about conditional assertions: whether it branches at
 * all, the closed domain of route values, and the routes this particular run
 * actually took (read from the branch's SOURCE node's output in the run steps).
 *
 * @returns {{ hasBranch: boolean, domain: Set<string>, taken: Set<string> }}
 */
export function runRouteInfo(spec, runResult) {
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const byId  = new Map(nodes.map(n => [n?.id, n]));
  const branches = nodes.filter(n => n?.type === 'branch');

  // The run's step outputs, keyed by node id. A classify step emits a bare string
  // ("urgent"); a decision/human step emits an object — parse a JSON-string output
  // but keep a non-JSON string as-is.
  const stepOut = new Map();
  for (const s of (runResult?.steps ?? [])) {
    let o = s?.output;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { /* keep the string */ } }
    stepOut.set(s?.nodeId, o);
  }
  // Every node the run actually EXECUTED. A skipped node emits `step_skipped`, which
  // the dry-run does not push, so a node absent here did not run on this sample. Used
  // below to tell "this branch was on the executed path" from "this branch never ran".
  const executed = new Set(stepOut.keys());

  const domain = new Set();
  const taken  = new Set();
  // Also record the route PER BRANCH. A single global `taken` conflates branches: an
  // assertion gated on branch B2's value could be skipped just because a *different*
  // branch B1 positively took a *different* value (adversary Finding 1). `branchRoutes`
  // lets a promise be judged against ITS OWN branch. `taken` is kept for back-compat.
  const branchRoutes = [];             // per-branch: { domain:Set, taken: string|null, reached }
  for (const b of branches) {
    const srcId = onRefId(b.config?.on);
    if (!srcId) continue;
    const bDomain = new Set();
    for (const v of (closedDomainOf(byId.get(srcId)) ?? [])) { const r = normRoute(v); bDomain.add(r); domain.add(r); }
    let bTaken = null;
    if (stepOut.has(srcId)) { const r = normRoute(stepOut.get(srcId)); if (r) { bTaken = r; taken.add(r); } }
    // Was this branch ON THE EXECUTED PATH at all? Yes if its source ran, or if any of
    // its lane targets ran (a lane's entry node runs only if the branch routed there —
    // this is what distinguishes "ran but route unreadable" from "never reached").
    // Adversary Finding 1's shape (branch on the path, source step artificially absent)
    // stays `reached:true` because its delivery target IS in the steps → still enforced.
    const reached = executed.has(srcId)
      || normalizeCases(b.config?.cases).some(c => c?.to && executed.has(c.to));
    branchRoutes.push({ domain: bDomain, taken: bTaken, reached });
  }
  return { hasBranch: branches.length > 0, domain, taken, branchRoutes };
}

/**
 * Which LANE each branch actually sent this run down.
 *
 * Read from the branch node's OWN output (`{value, matched, to, viaCatchAll}`) —
 * the engine's own record of the decision it made — rather than by re-matching the
 * routed-on value against the cases here. Re-deriving it would be a second
 * implementation of `branch.run()`'s selection rule (first explicit match, else the
 * catch-all), and the day the two disagree the coverage report describes a program
 * nobody is running. That is not hypothetical: `decision-analysis.js` held the
 * condition grammar in two functions and they diverged twice.
 *
 * @returns {Array<{branch: string, to: string, matched: string, viaCatchAll: boolean}>}
 */
export function lanesTakenBy(spec, runResult) {
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const branchIds = new Set(nodes.filter(n => n?.type === 'branch').map(n => n.id));
  const out = [];
  for (const s of (runResult?.steps ?? [])) {
    if (!branchIds.has(s?.nodeId)) continue;
    let o = s?.output;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { continue; } }
    if (o && typeof o === 'object' && o.to) {
      out.push({ branch: s.nodeId, to: String(o.to), matched: String(o.matched ?? ''), viaCatchAll: !!o.viaCatchAll });
    }
  }
  return out;
}

/**
 * LANE COVERAGE ACROSS A WHOLE SAMPLE SET (F16 invariant 1).
 *
 * A router's entire value is the routing, and ONE sample can only ever prove ONE
 * lane. The live test suite built a 3-lane router — urgent→Slack, billing→inbox,
 * general→do nothing — ran a single sample that classified `general`, executed no
 * delivery node whatsoever, and certified "every promise held". Both delivery
 * promises were reported kept without either ever having run.
 *
 * Per-example verdicts cannot see this: each example is individually honest. It is
 * a property of the SET, so it is computed over the set.
 *
 * A lane is a distinct branch TARGET, not a distinct route VALUE. Values are
 * grouped by the node they route to, because covering a lane is what proves the
 * behaviour behind it — a decision table mapping P2 and P3 to the same "stay
 * quiet" step has one lane there, not two, and demanding a sample per value would
 * make coverage unreachable on exactly the tables that need it most.
 *
 * @param {object} spec
 * @param {Array<object>} results — per-example results carrying `lanes` (from
 *                                  `evaluateExampleRun`)
 * @returns {{applicable: boolean, total: number, covered: number,
 *            uncovered: Array<{branch: string, to: string, label: string}>}}
 */
export function laneCoverage(spec, results) {
  const inventory = laneInventoryOf(spec);
  if (!inventory.length) return { applicable: false, total: 0, covered: 0, uncovered: [] };

  // Every lane actually taken, across every example.
  const hit = new Set();
  for (const r of (results ?? [])) {
    for (const l of (r?.lanes ?? [])) hit.add(laneKey(l.branch, l.to));
  }
  const uncovered = inventory.filter(l => !hit.has(laneKey(l.branch, l.to)));
  return { applicable: true, total: inventory.length, covered: inventory.length - uncovered.length, uncovered };
}

/**
 * Stable identity for a lane. One definition, so producer and consumer agree.
 *
 * JSON, not a delimiter. A separator can COLLIDE (a node id containing it splits
 * the key in the wrong place), and CLAUDE.md's standing rule -- earned when a
 * NUL-separated branch/edge key silently matched nothing and made an entire
 * feature unpublishable -- is that an unprintable separator is never acceptable:
 * it is invisible in an editor, in a diff, and in the debugger where you would
 * finally catch it. This is unambiguous for any id and prints as itself.
 */
export function laneKey(branch, to) { return JSON.stringify([branch, to]); }

/**
 * EVERY lane this spec has, named the way the USER wrote it.
 *
 * Shipped to the client with each example result so the browser never has to
 * re-derive "what lanes exist" — that rule (group cases by target, name them by
 * their `when` values, fall back to the target's label) lives HERE, once. The
 * client does set subtraction over data this produced; it holds no copy of the
 * rule, so the two cannot drift. Same reason `outcome-oracle` is the single
 * satisfaction oracle for the validator and the gap scorer.
 *
 * @returns {Array<{branch: string, to: string, label: string}>}
 */
export function laneInventoryOf(spec) {
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const byId = new Map(nodes.map(n => [n?.id, n]));
  const out = [];
  for (const b of nodes) {
    if (b?.type !== 'branch') continue;
    // Group this branch's cases by target — the values that share a lane.
    const byTarget = new Map();
    for (const c of normalizeCases(b.config?.cases)) {
      if (!c?.to) continue;
      if (!byTarget.has(c.to)) byTarget.set(c.to, []);
      byTarget.get(c.to).push(String(c.when));
    }
    for (const [to, whens] of byTarget) {
      // Name it as the user wrote it ("urgent", "billing"), falling back to the
      // target node's own label. A lane reported as `deliver_slack_a1` tells
      // them nothing about which case went unproven.
      const named = whens.filter(w => w.trim() !== CATCH_ALL);
      const target = byId.get(to);
      out.push({
        branch: b.id, to,
        label: named.length ? named.join(' or ')
                            : (target?.label || target?.description || 'anything else'),
      });
    }
  }
  return out;
}

/**
 * Does this assertion apply to a run that took `routeInfo.taken`?
 *
 *   { conditional:false, applies:true }                     — unconditional: always enforced
 *   { conditional:true,  applies:true }                     — its lane was taken (or the route
 *                                                             couldn't be read — enforce, never
 *                                                             skip on doubt): enforce the delivery
 *   { conditional:true,  applies:false, malformed:false }   — a DIFFERENT lane was taken: SKIP
 *   { conditional:true,  applies:false, malformed:true }    — the `when` names no possible route:
 *                                                             FAIL CLOSED (unprovable)
 *
 * The doubt rule is deliberately biased toward ENFORCEMENT: skipping only when we
 * POSITIVELY read a different route means an unreadable route falls through to the
 * strict delivery check — which can only cause a (recoverable) false failure, never
 * a false pass.
 */
export function assertionApplicability(assertion, routeInfo) {
  const when = assertion?.when;
  if (when == null || String(when).trim() === '') return { conditional: false, applies: true };

  const w = normRoute(when);
  const info = routeInfo ?? { hasBranch: false, domain: new Set(), taken: new Set() };

  // FAIL CLOSED — a conditional promise with nothing that routes, or a `when` outside
  // the closed route domain, can never be checked. Report it; do not skip it.
  if (!info.hasBranch) {
    return { conditional: true, applies: false, malformed: true,
      reason: `it happens only when "${when}", but this workflow has no branch that routes on a value — that condition can never be checked` };
  }
  if (info.domain.size && !info.domain.has(w)) {
    return { conditional: true, applies: false, malformed: true,
      reason: `it happens only when "${when}", but no step here can produce "${when}" (the routes are: ${[...info.domain].join(', ')}) — that promise can never be checked` };
  }

  // Judge against the OWNING branch's route — the branch whose closed domain can produce
  // `w` — not the global set (Finding 1). Enforce if that branch took this lane OR its
  // route couldn't be read (doubt → enforce); skip only if it positively took a different
  // lane. Falls back to the global `taken` for a hand-built routeInfo with no per-branch data.
  if (Array.isArray(info.branchRoutes)) {
    const owning = info.branchRoutes.filter(b => b.domain.has(w));
    if (owning.length) {
      // Enforce if an owning branch positively took this lane, OR ran but its route was
      // unreadable (doubt → enforce). A branch that was NEVER REACHED on this run is NOT
      // doubt: an upstream branch sent the sample down a different lane, so this gate's
      // node never executed and its lane definitively did not happen — the promise does
      // not apply. Without the `b.reached` guard, a conditional gated on a DOWNSTREAM
      // branch (e.g. an approval gate reachable only from the "urgent" lane) is wrongly
      // enforced on every sample that never reaches it: a spam email "fails" a promise
      // about approved mail, and the converger's self-test rebuilds — corrupting the
      // classifier to force the delivery. `reached` is the whole fix.
      if (owning.some(b => b.taken === w || (b.reached && b.taken == null))) return { conditional: true, applies: true };
      const took = owning.map(b => b.taken).filter(Boolean);
      return { conditional: true, applies: false, malformed: false,
        reason: took.length
          ? `this sample routed "${took.join(', ')}", not "${when}", so this promise does not apply to it`
          : `this sample never reached the step that decides "${when}", so this promise does not apply to it` };
    }
  }
  // A different lane was positively taken ⇒ this promise is about a case this sample
  // didn't hit. Skip it: not satisfied, not failed.
  if (info.taken?.size && !info.taken.has(w)) {
    return { conditional: true, applies: false, malformed: false,
      reason: `this sample routed "${[...info.taken].join(', ')}", not "${when}", so this promise does not apply to it` };
  }

  // Its lane was taken, or the route couldn't be read (enforce on doubt).
  return { conditional: true, applies: true };
}

/**
 * ── THE RUN-TIME TWIN OF `askSatisfiesAssertion` (the flagship-shape defect) ──
 *
 * THE DEFECT. The two halves of this one oracle disagreed about one node type. At
 * BUILD time an approval step's question satisfies a `slack:<someone>` promise —
 * `satisfiesAssertion` routes `type:'human'` into `askSatisfiesAssertion`, and it
 * must, or "DM me to approve" can only be kept by a second `deliver` node sending
 * the question twice. At RUN time `checkAssertionAtRuntime` reads the run's
 * DELIVERIES and nothing else, and a `human` node produces no delivery at all
 * (`isDeliveryNode` is false for it, and both delivery-assembly sites drop it).
 * So the promise fell through the loop and came back `nothing reached
 * charles@agntic.co on Slack` — deterministically, on every run, for a workflow
 * that was built correctly. The flagship shape (draft → a person approves → send)
 * passed every build check and could never be published, and the person was given
 * a sentence with no cause and no action in it.
 *
 * WHY THIS IS NOT A PASS. The honest answer to "did this run show the question
 * reach that person?" in a pre-publish test is **no, and it never can**:
 *
 *   · deliveries are forced dry on that path (`dryRunDeliveries: true`,
 *     server.js — the ONE real delivery is go-live), so nothing is sent;
 *   · the gate is PRE-ANSWERED by the panel, so the run never even pauses; and
 *   · the only code that issues an ask — `ApprovalService.deliverAsk` — is
 *     reachable solely from `WorkflowScheduler` (`registerAskDeliverer`), a module
 *     the test path never enters. No Slack call happens, so no Slack setup can
 *     change the outcome.
 *
 * A dry run also holds no Slack credential for a `human` node's channels (token
 * injection covers connector-action config, not `human.config.channels`), so it
 * cannot even probe the destination the way `_dryRunDeliver` probes a delivery's.
 * There is therefore no evidence to certify on, and manufacturing a would-ask
 * receipt here would be a second copy of `deliverAsk`'s channel dispatch — a proof
 * about a program nobody runs.
 *
 * So the verdict is the THIRD one: **not exercised**. Not a pass, not a failure.
 * Refusing to certify stays available; certifying without checking does not.
 *
 * WHAT KEEPS THIS FROM BEING A BLANKET EXCUSE — four narrowings, all load-bearing:
 *
 *  1. It is consulted ONLY after the ordinary delivery check has already said no,
 *     so a genuine delivery always wins and this can never mask one.
 *  2. The promise must be one an approval ask could keep, decided by
 *     `askSatisfiesAssertion` — the SAME function the build-time half uses, so the
 *     two halves now share one definition and cannot drift apart again.
 *  3. The ask step must have RUN ON THIS SAMPLE — present in the run's steps. Not
 *     "a `human` node exists in the spec": a sample that routed away from the gate
 *     gets nothing, exactly as a `deliver` node that never ran gets nothing.
 *  4. If the run records that the answer came back OVER THE PROMISED CONNECTOR,
 *     the ask WAS issued and it counts as kept — you cannot answer a question you
 *     were never asked. That is the positive half, and it is the production shape:
 *     a real Slack approval resumes with `{by:'slack:U…', channel:'slack'}`
 *     (approval-service.js), while both test-panel paths stamp
 *     `channel:'test_panel'`, which matches no connector and so can never pass.
 *
 * @returns {null | {issued:true, detail:string} | {issued:false, reason:string}}
 */
export function approvalAskEvidence(assertion, spec, runResult) {
  const asks = (spec?.nodes ?? []).filter(n => n?.type === 'human' && askSatisfiesAssertion(assertion, n));
  if (!asks.length) return null;

  // RUN EVIDENCE, not spec presence: which of them actually executed on this sample.
  const outputs = new Map();
  for (const s of (runResult?.steps ?? [])) outputs.set(s?.nodeId, s?.output);
  const ran = asks.filter(n => outputs.has(n.id));
  if (!ran.length) return null;

  const wantConnector = canonicalConnector(splitTarget(assertion.target).connector);

  for (const n of ran) {
    let o = outputs.get(n.id);
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
    const over = String((o && typeof o === 'object' ? o.channel : '') ?? '').trim();
    if (over && canonicalConnector(over) === wantConnector) {
      return { issued: true, detail: `"${n.label ?? n.id}" asked, and the answer came back over ${describeTarget(over)}` };
    }
  }

  const label = ran[0].label ?? ran[0].id;
  return {
    issued: false,
    reason: `"${label}" is where this workflow asks a person, and this test answers that question itself `
      + `instead of sending it — so whether the question reaches ${describeTarget(assertion.target)} was not checked here`,
  };
}

/**
 * Evaluate one example's RUN against the outcome contract. (P12 Increment G.)
 *
 * The CONTRACT is machine-checkable and generic — every workflow has one, and it
 * is the same three kinds everywhere — so it is GATED: an assertion the run did
 * not satisfy is a real failure.
 *
 * The example's `expect` is the SME's own words, freeform and different in every
 * workflow (`{priority: 'P1', urgent: true}`), so it is SHOWN, NOT GATED: nothing
 * workflow-agnostic can truthfully judge a key whose meaning it does not know, and
 * a check that pretends to is exactly the false-confidence this phase exists to
 * kill. It is displayed against what the run produced, for a person to read.
 *
 * @param {object} spec        — the workflow spec (reads spec.outcome.assertions)
 * @param {object} example     — { id?, label?, given, expect? }
 * @param {object} runResult   — { completed, deliveries, steps, error? } from a run
 */
export function evaluateExampleRun(spec, example, runResult) {
  const assertions = Array.isArray(spec?.outcome?.assertions) ? spec.outcome.assertions : [];
  const deliveries = Array.isArray(runResult?.deliveries) ? runResult.deliveries : [];

  // Branch awareness: a CONDITIONAL assertion is judged only on the lane it names.
  const routeInfo = runRouteInfo(spec, runResult);

  const contract = assertions.map(a => {
    const base = { id: a.id ?? null, target: a.target, kind: a.kind, when: a.when ?? null };
    const appl = assertionApplicability(a, routeInfo);

    // A different lane was taken — SKIP: neither satisfied nor failed. `ok:true` so it
    // never blocks the example; `applicable:false` so it renders as "n/a" and the
    // content-error guard below leaves it alone (its lane never ran).
    if (appl.conditional && !appl.applies && !appl.malformed) {
      return { ...base, applicable: false, skipped: true, ok: true, detail: appl.reason };
    }
    // FAIL CLOSED — a `when` that names no route, or a conditional with nothing that
    // routes: report it, do not skip it. It blocks the example, exactly like a real
    // miss, because a promise the workflow can never make good on is not "kept".
    if (appl.conditional && !appl.applies && appl.malformed) {
      return { ...base, applicable: true, ok: false, reason: `can't check — ${appl.reason}` };
    }
    // Unconditional, or its lane was taken: enforce the delivery (unchanged path —
    // this is the anti-weakening core; a real miss here is still a real failure).
    const rt = checkAssertionAtRuntime(a, deliveries);
    if (rt.ok) return { ...base, applicable: true, ...rt };

    // ── ONLY NOW: is this a promise that an APPROVAL QUESTION keeps? ──────────
    // Consulted strictly AFTER the delivery check has said no, so a real delivery
    // always wins and this can never mask one. See approvalAskEvidence for why an
    // unissued ask is "not exercised" rather than broken — and for the four
    // narrowings that stop it becoming a blanket excuse.
    const ask = approvalAskEvidence(a, spec, runResult);
    if (ask?.issued) return { ...base, applicable: true, ok: true, detail: ask.detail };
    if (ask) return { ...base, applicable: false, skipped: true, ok: true, detail: ask.reason };

    return { ...base, applicable: true, ...rt };
  });

  // CONTENT-ERROR GUARD. `message_sent → inbox` is a FLOOR — any delivery satisfies
  // it, even one whose body is the converger's own "I couldn't do my job" sentinel
  // (an llm node that can't find its input outputs EXACTLY "ERROR: required data not
  // found"). A run that delivered that string kept nothing — the inbox got an error,
  // not a summary — so it must NOT read as "Contract kept / Go live". If any step
  // produced the sentinel, the promise it fed is broken: fail every SATISFIED,
  // APPLICABLE assertion with a plain reason, and fail the example. A SKIPPED lane
  // (applicable:false) never ran and is left untouched.
  const broken = runProducedContentError(runResult);
  if (broken) {
    for (const c of contract) {
      if (c.applicable !== false && c.ok) { c.ok = false; c.reason = `a message was delivered, but its content was an error — "${broken.step}" couldn't find the data it needed and produced "${broken.snippet}" instead of real content`; }
    }
  }

  // The run itself failing is a contract failure — a workflow that errored on this
  // input did not keep any promise.
  const ran = runResult?.completed === true && !runResult?.error;
  const contractPassed = ran && !broken && contract.every(c => c.ok);

  // ── THE THIRD VERDICT: "not exercised" ──────────────────────────────────────
  //
  // `contract.every(c => c.ok)` is TRUE over an empty set, and it is true over a
  // set that is ENTIRELY skips. Both were rendered to the user as "every promise
  // held — it's cleared to go live", which is a vacuous truth presented as a
  // verification. Three live shapes reached it:
  //
  //   · a spec with no assertions at all         → `contract` is []          (F12)
  //   · an edit that cleared `outcome.examples`  → zero runs, zero results   (F12)
  //   · a 3-lane router whose one sample took the do-nothing lane → every
  //     assertion `skipped:true, ok:true`, and NO delivery node ever executed (F16)
  //
  // The honest verdict in all three is "not verified", never "kept". `enforced`
  // counts the assertions this run actually CHECKED (a skipped lane is not a
  // check), and it is the floor: a promise is kept only if something was proved.
  //
  // `contractPassed` is DELIBERATELY LEFT UNCHANGED. The converger's self-test
  // (`verify`) reads it to decide whether to regenerate, and a spec whose sample
  // simply didn't reach the asserted lane must NOT trigger a rebuild — resolving
  // "unexercised" pessimistically is what makes a valid 12-node draft get thrown
  // away and rebuilt until the build gives up (F17). The two failures are the two
  // wrong answers to the same question, so the fix adds the missing answer rather
  // than flipping the existing one from one wrong sign to the other.
  const enforced = contract.filter(c => c.applicable !== false).length;

  // A BLANK PROMISE CANNOT BE KEPT (F12 invariant 1b).
  //
  // The assertions are the machine-checkable half of the contract; `statement` is
  // the half the PERSON reads, and it is what the panel renders as "THE DEAL"
  // directly above the words "every promise held". A spec can reach here with
  // `{ statement: '', assertions: [one] }` — `spec-assembler.js` defaults the
  // statement to `''` when a model turn omits it, and the validator only ever
  // requires `assertions.length` — so the run satisfies its one assertion and the
  // UI certifies a blank deal. That is the same vacuous truth as certifying zero
  // examples, through a second door, and it is NOT closed by persisting the
  // contract (F11): that fixed a contract lost on the way to the database, not
  // one that was empty when it was written.
  //
  // Deliberately NOT a fourth verdict: the vocabulary stays at three, and
  // `contractIncomplete` tells the UI to say "this contract has no statement"
  // rather than the misleading "nothing was exercised".
  const contractIncomplete = contract.length > 0
    && !String(spec?.outcome?.statement ?? '').trim();

  // A "SHOULD NOT HAPPEN" EXAMPLE CANNOT BE PROVED BY THIS HARNESS.
  //
  // A generated sample set routinely carries a negative case — "Weekend trigger —
  // should not fire". But the test panel never fires the TRIGGER: it seeds the
  // workflow with `given` and runs it. So the negative case runs like any other,
  // DELIVERS like any other, satisfies the delivery assertion, and was reported
  // `kept` — a green tick reading "should not fire" sitting directly above "every
  // promise held", moments after a real Slack DM had gone out for it. The one row a
  // reader would take as proof the workflow stays quiet was proof of the opposite.
  //
  // Whether it would have fired is a question about the TRIGGER FILTER, which this
  // harness does not evaluate, so the only honest answer is "not checked".
  // Deliberately NOT 'broken': the delivery happened because the harness bypassed
  // the trigger, not because the workflow is wrong, and resolving that
  // pessimistically is what throws away a valid spec and rebuilds it (F17). It is
  // `not_exercised`, which neither certifies nor blocks — the positive examples
  // still carry the workflow to "kept".
  //
  // WHY THIS IS KEYED ON `shouldTrigger`, NOT ONLY `expect === null`. The first fix
  // (2026-07-21) keyed on `expect === null`, the encoding the generator used then.
  // The generator has since moved to `shouldTrigger: false` with `expect: {}` — so
  // `{} !== null`, the check missed it, and the exact same "should not fire" row was
  // certified `kept` again, found by the QA driving a real scheduled fan-out
  // (2026-07-23). This is the same defect through a drifted encoding. `shouldTrigger`
  // is the generator's EXPLICIT declaration of intent (a positive carries
  // `shouldTrigger: true`), so keying on `=== false` tracks the intent rather than
  // one incidental spelling of it; `expect === null` is retained for older/stored
  // sample sets. Deliberately NOT keying on an empty `expect: {}`, which is ambiguous
  // — a sparsely-specified POSITIVE could carry it, and demoting that to
  // not_exercised is the F17 regression (a valid workflow that can no longer certify)
  // the prior fix warned against. Absent `expect` AND absent `shouldTrigger` is still
  // judged on the contract exactly as before — declaring nothing is not a negative.
  const negative = !!example && (
    example.shouldTrigger === false
    || (Object.prototype.hasOwnProperty.call(example, 'expect') && example.expect === null)
  );

  // ── ORDER MATTERS, AND FOR TWO YEARS IT WAS WRONG ────────────────────────
  //
  // `negative` used to be consulted only AFTER `!contract.every(c => c.ok)` had
  // already resolved to 'broken'. For a negative that is backwards: a
  // "should not happen" example that correctly delivers NOTHING fails every
  // delivery assertion by design, short-circuited to 'broken', and never reached
  // the branch written for it. The branch was effectively reachable only when a
  // negative had DELIVERED — the opposite case.
  //
  // WITNESSED ON PROD, 2026-07-29. A pricing-enquiry workflow with an in-flow
  // classifier and a silent stop: 12 examples, 10 kept, and the two labelled
  // "Non-pricing email — should not trigger workflow" reported as broken promises
  // for staying quiet. `broke > 0` ⇒ 'failed' (run-summary.js), so the workflow
  // could not go live.
  //
  // WORSE, IT PUNISHED THE BETTER DESIGN. A workflow that filters at the TRIGGER
  // lets the negative sample through, delivers, passes its contract, and lands on
  // 'not_exercised' correctly. A workflow that classifies IN-FLOW and stops — the
  // safer shape, and the one a person asks for — was the only one that failed.
  //
  // A crash is still a crash: `!ran` and a content error stay 'broken' for a
  // negative too. Only the CONTRACT result is excused, because for a negative an
  // unsatisfied contract is the expected outcome, not a defect. This cannot
  // certify anything on its own — 'not_exercised' neither certifies nor blocks,
  // so the positive examples must still carry the run to 'kept'.
  //
  // `contractPassed` is deliberately untouched (see above): the converger's verify
  // reads it, and this is a fix to what the PERSON is told, not to what drives a
  // rebuild.
  const verdict = !ran || broken
    ? 'broken'
    : negative
      ? 'not_exercised'
      : !contract.every(c => c.ok)
        ? 'broken'
        : (enforced > 0 && !contractIncomplete ? 'kept' : 'not_exercised');

  return {
    exampleId: example?.id ?? null,
    label:     example?.label ?? null,
    given:     example?.given ?? null,
    ran,
    error:     runResult?.error ?? null,
    contractPassed,
    // How many assertions this run actually checked. Zero means nothing was
    // proved — neither a pass nor a failure.
    enforced,
    // 'kept' | 'broken' | 'not_exercised'. What the USER-FACING surface must
    // certify on; `contractPassed` alone cannot distinguish proof from silence.
    verdict,
    // The contract has assertions but no statement — there is no promise in words
    // to have kept, so it is not certifiable however well the run went.
    contractIncomplete,
    // This example asserts that NOTHING should happen. Unprovable here (the
    // harness bypasses the trigger), so the UI must render it as "not checked"
    // rather than as a pass — see the note above the verdict.
    negative,
    // Which branch lane(s) this run went down. Per-example it is only a fact;
    // aggregated across the sample set by `laneCoverage` it is what stops a router
    // being certified on lanes no sample ever took (F16).
    lanes: lanesTakenBy(spec, runResult),
    // The full lane inventory rides along so the CLIENT never re-derives "what
    // lanes exist" — it subtracts `lanes` from this and holds no copy of the rule.
    laneInventory: laneInventoryOf(spec),
    // TRUE when the ONLY reason this failed is a content node emitting the error
    // sentinel — i.e. the delivery STRUCTURALLY happened but an llm step judged its
    // (present) input unusable on this run. This is a per-run CONTENT flake, not a
    // wiring defect: rebuilding the spec produces the same guard and flakes the same
    // way. The self-test uses it to retry/accept rather than regenerate a working spec.
    contentError: !!broken,
    contract,                                   // GATED — the machine-checkable promise
    expect:    example?.expect ?? null,         // SHOWN, not gated — the SME's own words
    produced:  summariseRun(runResult),         // …next to what actually happened
  };
}

/** What a run produced, in a shape the test panel can lay beside `expect`. */
function summariseRun(runResult) {
  const out = {};
  for (const s of (runResult?.steps ?? [])) {
    let o = s.output;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { continue; } }
    if (o && typeof o === 'object' && !Array.isArray(o) && !o.delivered) Object.assign(out, o);
  }
  return out;
}
