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
      assertionKind:  def.assertionKind  ?? null,
      locatorKeys:    Array.isArray(def.locatorKeys) ? def.locatorKeys : null,
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
