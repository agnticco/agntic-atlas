/**
 * CapabilityRegistry — unified, position-agnostic connector capability catalog.
 *
 * Every connector action registers here with explicit positions. The engine,
 * converger, event dispatch, and UI all read from this single object — no more
 * separate ChannelRegistry / SourceRegistry / per-connector-provider fragmentation.
 *
 * Position vocabulary:
 *   'trigger'  — fires a workflow when the event occurs
 *   'step'     — runs mid-workflow (connector-action node)
 *   'delivery' — final output node (deliver node)
 *
 * A capability can occupy any subset of positions it legitimately supports.
 * e.g. gmail_send: ['step', 'delivery']  |  slack_message: ['trigger']
 *      sheets_append: ['step', 'delivery']  |  gmail_search: ['step']
 */

export class CapabilityRegistry {
  constructor() {
    /** @type {Map<string, object>} */
    this._caps = new Map();
  }

  /**
   * Register a capability.
   *
   * @param {object}   def
   * @param {string}   def.id              — stable namespaced id, e.g. 'slack_post_message'
   * @param {string[]} def.positions       — subset of ['trigger','step','delivery']
   * @param {string}   [def.connector]     — 'slack'|'google'|'airtable'|... (optional for built-ins)
   * @param {string}   [def.name]
   * @param {string}   [def.description]
   * @param {string}   [def.icon]
   * @param {object[]} [def.configSchema]
   * @param {string[]} [def.requiredScopes]
   * @param {string}   [def.outputFormat]  — 'html' | 'mrkdwn' | 'plain'; format the engine delivers as-is to this channel
   * @param {Function} [def.handle]        — async ({ config, body, lastOutput, title }) => result
   * @param {Function} [def.isReady]       — () => boolean; defaults to always ready
   *
   * ── Effect (P13-0 seam #1) ────────────────────────────────────────────────
   * @param {'read'|'write'} [def.effect]  — does this capability CHANGE the outside world?
   * @param {string} [def.assertionKind]   — 'message_sent' | 'record_exists' | 'document_exists'
   * @param {string[]} [def.locatorKeys]   — config keys that name the destination
   *
   * ── Schema discovery (P13-0 seam #3) ──────────────────────────────────────
   * @param {object} [def.schemaDiscovery] — declared on a connector's DESCRIBE capability.
   *
   * The converger's `destinations` node reads a write target's real schema so it can
   * offer click-to-pick and map promised fields onto columns that actually exist —
   * "never ask for what we can read". It was hardwired to the literal string
   * 'airtable' and to `airtable_list_bases` / `airtable_describe_base`, so EVERY
   * other connector dropped back to "make the user paste an id".
   *
   * A connector now DECLARES how its schema is discovered:
   *   listCapability    — capability id that lists containers; null = one implicit container
   *   listResultKey     — key on that result holding the container array  ([{id,name}])
   *   describeArg       — argument name the describe capability takes (the container id)
   *   describeResultKey — key on the describe result holding the tables   ([{id,name,…}])
   *   tableColumnsKey   — key on a table entry holding its columns        ([{name}])
   *   containerKey      — the WRITE node's config key naming the container
   *   tableKey          — the WRITE node's config key naming the table
   *   containerLabel/tableLabel — plain words for the questions the user is asked
   *
   * Only connectors whose write model is "container → table → NAMED columns" can
   * declare this. Google Sheets deliberately does NOT: `sheets_append` takes a
   * positional `values` array of arrays, its tab lives inside a `range` string
   * rather than its own key, and it has no capability that lists spreadsheets — so
   * it needs name→column-INDEX mapping, which is a different feature, not this one.
   * Declaring it here would be a schema nothing can honour.
   *
   * A capability's read/write effect is a property it DECLARES, never something
   * inferred from its id. `outcome-oracle.js` used to derive it by testing the id
   * against verb regexes, so a write whose name contained no known verb token
   * (`notion_create_page` — "page" is not in the set) was silently misclassified as
   * a READ and skipped both idempotency and the approval gate. That is invisible in
   * production: the run reports success and the guard never fired.
   *
   * FAIL CLOSED: a capability that declares no `effect` but whose position set makes
   * it a plausible writer is treated as a WRITE by the oracle. A spurious idempotency
   * key on a read is harmless; a missing one on a real write is unrecoverable.
   */
  register(def) {
    if (!def?.id) throw new Error('CapabilityRegistry.register: id is required');
    if (!Array.isArray(def.positions) || !def.positions.length)
      throw new Error(`CapabilityRegistry.register "${def.id}": positions[] is required`);
    if (def.effect != null && def.effect !== 'read' && def.effect !== 'write')
      throw new Error(`CapabilityRegistry.register "${def.id}": effect must be 'read' or 'write', got ${JSON.stringify(def.effect)}`);

    this._caps.set(def.id, {
      id:             def.id,
      connector:      def.connector      ?? null,
      positions:      def.positions,
      name:           def.name           ?? def.id,
      description:    def.description    ?? '',
      icon:           def.icon           ?? 'plug',
      configSchema:   def.configSchema   ?? [],
      requiredScopes: def.requiredScopes ?? [],
      outputFormat:   def.outputFormat   ?? 'plain',
      isReady:        def.isReady        ?? (() => true),
      handle:         def.handle         ?? null,
      // Declared effect. `null` means "this capability said nothing" — the oracle
      // decides what to do with silence (see nodeEffect / declaredEffectOf). It is
      // deliberately NOT defaulted to 'read' here: a default here would be a silent
      // fallback on a security-relevant value, which is the bug this seam removes.
      effect:         def.effect         ?? null,
      // ── CONFIGURES A RESOURCE ONCE, RATHER THAN DOING PER-RUN WORK ─────────
      // "Add a column", "create a channel" — things a workflow needs to EXIST, not
      // things it does each time it fires. They belong on the setup path, which runs
      // once at build time; as a workflow step they repeat on every run.
      //
      // Witnessed on prod 2026-07-29: the converger put two `airtable_create_field`
      // steps inside an email-triggered workflow, so every incoming email tried to
      // re-add the same two columns. Declared, never inferred from the id — a regex
      // over capability names is the shape this codebase has been bitten by three
      // times (`isWritingAction`, the trigger captions, the step-type tables).
      oneTimeSetup:   def.oneTimeSetup === true,
      assertionKind:  def.assertionKind  ?? null,
      locatorKeys:    Array.isArray(def.locatorKeys) ? def.locatorKeys : null,
      schemaDiscovery: def.schemaDiscovery ?? null,
      // A non-destructive READ that confirms this delivery's DESTINATION exists and is
      // reachable — e.g. "does this Slack channel exist and is the bot in it", "does this
      // Airtable base/table exist". Called ONLY by the dry-run test path (`_dryRunDeliver`)
      // so a test can say "it WILL deliver" without doing the delivery. Optional: a
      // capability with no probe keeps the shallower "a target is specified" check.
      probe:          def.probe          ?? null,
    });
    return this;
  }

  /**
   * List capabilities, optionally filtered by position and/or connector.
   * Returns public shapes (no handler fn, availability computed live).
   *
   * @param {{ position?: string, connector?: string }} [opts]
   * @returns {object[]}
   */
  list({ position, connector } = {}) {
    const out = [];
    for (const cap of this._caps.values()) {
      if (position  && !cap.positions.includes(position)) continue;
      if (connector && cap.connector !== connector)        continue;
      out.push(this._public(cap));
    }
    return out;
  }

  /** Public shape for a single capability (availability computed live), or null. */
  get(id) {
    const cap = this._caps.get(id);
    return cap ? this._public(cap) : null;
  }

  /** Internal — used by node executors to actually invoke the capability. */
  getHandler(id) {
    return this._caps.get(id)?.handle ?? null;
  }

  /** Internal — the destination reachability probe (dry-run test path only), or null. */
  getProbe(id) {
    return this._caps.get(id)?.probe ?? null;
  }

  /**
   * How is this connector's destination schema discovered? (P13-0 seam #3.)
   *
   * Returns the connector's declared `schemaDiscovery` descriptor plus the id of the
   * capability that declared it, or `null` when the connector declares none — in
   * which case the converger ASKS the user rather than guessing, exactly as before.
   *
   * A connector declares this on ONE capability (its describe/schema-read action).
   * If more than one declares it the first registered wins, deterministically, and
   * that is a registration bug rather than a runtime choice.
   *
   * @param {string} connector
   * @returns {{ describeCapability: string, ...descriptor }|null}
   */
  schemaDiscoveryFor(connector) {
    if (!connector) return null;
    const want = String(connector).toLowerCase();
    for (const cap of this._caps.values()) {
      if (!cap.schemaDiscovery) continue;
      if (String(cap.connector ?? '').toLowerCase() !== want) continue;
      return { ...cap.schemaDiscovery, describeCapability: cap.id };
    }
    return null;
  }

  /** Every connector that has declared how to discover its schema. */
  schemaDiscoveryConnectors() {
    const out = [];
    for (const cap of this._caps.values()) {
      if (cap.schemaDiscovery && cap.connector && !out.includes(cap.connector)) out.push(cap.connector);
    }
    return out;
  }

  /** Whether a capability is registered AND its isReady() probe passes. */
  isAvailable(id) {
    return this.get(id)?.available ?? false;
  }

  _public(cap) {
    let available = true;
    let unavailableReason = null;
    try {
      if (!cap.isReady()) { available = false; unavailableReason = 'dependency not ready'; }
    } catch (e) {
      available = false;
      unavailableReason = e.message;
    }
    const { handle, isReady, probe, ...pub } = cap;
    return { ...pub, available, unavailableReason };
  }
}
