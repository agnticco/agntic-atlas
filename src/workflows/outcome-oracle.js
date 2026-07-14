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
 * Deliver channels → (connector, effect). The `deliver` node's `channel` is the
 * only place the destination is named, so this table is how a deliver node gets
 * an effect at all.
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
    const eff = CHANNEL_EFFECTS[channel];
    if (!eff) return null;
    return {
      kind:       eff.kind,
      connectors: aliasesFor(eff.connector),
      locators:   eff.locatorKeys.map(k => node.config?.[k]).filter(v => typeof v === 'string' && v.trim()),
      fields:     readFieldNames(node.config?.fields),
    };
  }

  if (node.type === 'connector-action') {
    const action = String(node.config?.action ?? '').trim();
    if (!action) return null;

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

/** Strip the decoration people put on destinations: "#ops" / "@amy" / "ops " all compare equal. */
function normLocator(s) {
  return String(s ?? '').trim().toLowerCase().replace(/^[#@]+/, '');
}

/** A locator that is a template can only be resolved at run time — so it matches anything. */
function isTemplate(s) {
  return /\{\{[^}]+\}\}/.test(String(s ?? ''));
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
export function satisfiesAssertion(assertion, node) {
  const eff = nodeEffect(node);
  if (!eff) return false;
  if (eff.kind !== assertion.kind) return false;

  const { connector, locator } = splitTarget(assertion.target);
  if (connector && !eff.connectors.has(connector)) return false;

  if (locator && !isTemplate(locator)) {
    const want = normLocator(locator);
    const hit = eff.locators.some((l) => {
      if (isTemplate(l)) return true;          // resolved at run time — undecidable here, so not a mismatch
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
    if (aliasesFor('inbox').has(connector) && available('inbox_deliver')) {
      return { id, type: 'deliver', label: 'Save to the Atlas inbox',
               config: { channel: 'inbox_deliver', subject: locator || 'Workflow result' } };
    }
  }

  // record_exists / document_exists need a destination schema (base, table,
  // folder) we cannot invent. Increment F reads it from the connector; until
  // then this correctly returns null and the assertion stays an open gap rather
  // than becoming a node with a made-up id in it.
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
function canonicalConnector(name) {
  const n = String(name ?? '').toLowerCase();
  if (CONNECTOR_ALIASES[n]) return n;                       // already a key
  for (const [key, aliases] of Object.entries(CONNECTOR_ALIASES)) {
    if (aliases.includes(n)) return key;
  }
  return n;
}

/** The connector a delivery went to, from its `channel` (e.g. `gmail_send` → gmail). */
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

/** Did this run produce the effect this assertion promises? */
export function checkAssertionAtRuntime(assertion, deliveries = []) {
  const defect = assertionDefect(assertion);
  if (defect) return { ok: false, reason: `can't check — ${defect}` };

  const { connector, locator } = splitTarget(assertion.target);
  const wantConnector = canonicalConnector(connector);
  const wantLocator   = normLocator(locator);

  for (const d of deliveries) {
    if (!d?.delivered) continue;
    if (deliveryConnector(d) !== wantConnector) continue;
    // No locator on the assertion ⇒ "some delivery to this connector" is enough.
    if (!wantLocator) return { ok: true, detail: describeDelivery(d) };
    // The delivery names its own destination in one of a few keys; a template
    // locator (resolved at run time) matches anything, exactly as at build time.
    const got = normLocator(d.target ?? d.to ?? d.user ?? d.channelName ?? d.slackChannel ?? '');
    if (isTemplate(locator) || got === wantLocator || (got && wantLocator && got.includes(wantLocator))) {
      return { ok: true, detail: describeDelivery(d) };
    }
  }
  return { ok: false, reason: `nothing reached ${assertion.target}` };
}

/** A one-line, human description of what a delivery did — shown in the test panel. */
function describeDelivery(d) {
  const where = d.target ?? d.to ?? d.user ?? d.slackChannel ?? d.channel ?? '';
  return `${d.channel ?? 'delivered'}${where ? ` → ${where}` : ''}${d.ts ? ` (${d.ts})` : ''}`;
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

  const contract = assertions.map(a => ({
    id: a.id ?? null,
    target: a.target,
    kind: a.kind,
    ...checkAssertionAtRuntime(a, deliveries),
  }));

  // The run itself failing is a contract failure — a workflow that errored on this
  // input did not keep any promise.
  const ran = runResult?.completed === true && !runResult?.error;
  const contractPassed = ran && contract.every(c => c.ok);

  return {
    exampleId: example?.id ?? null,
    label:     example?.label ?? null,
    given:     example?.given ?? null,
    ran,
    error:     runResult?.error ?? null,
    contractPassed,
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
