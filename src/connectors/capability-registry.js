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
   */
  register(def) {
    if (!def?.id) throw new Error('CapabilityRegistry.register: id is required');
    if (!Array.isArray(def.positions) || !def.positions.length)
      throw new Error(`CapabilityRegistry.register "${def.id}": positions[] is required`);

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
    const { handle, isReady, ...pub } = cap;
    return { ...pub, available, unavailableReason };
  }
}
