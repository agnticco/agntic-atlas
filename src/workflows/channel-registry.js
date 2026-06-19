/**
 * ChannelRegistry — extensible manifest of delivery channels.
 *
 * A channel exists iff a handler has been registered here. The handler is the
 * real code that executes the delivery; without it, users cannot select the
 * channel in the builder and the executor cannot route to it. This is the
 * single source of truth that keeps Flow honest: the UI, the builder prompt,
 * and the runtime all consult the same manifest.
 *
 * To add a new channel (e.g. Gmail via MCP):
 *   1. Write the handler below (or in its own module) with signature:
 *        async ({ config, body, title, context }) => result
 *   2. Call `channelRegistry.register({ id, name, description, icon,
 *        configSchema, deliver })` at server startup, typically wrapped in a
 *        guard that checks the backing capability is actually wired (e.g. the
 *        required MCP is available and its tool is callable).
 *   3. Nothing else needs to change — the builder prompt, picker, and tester
 *      pick up the new channel on the next run.
 *
 * @module src/workflows/channel-registry.js
 */

export class ChannelRegistry {
  constructor() {
    /** @type {Map<string, ChannelDefinition>} */
    this._channels = new Map();
  }

  /**
   * Register a channel. Overwrites any prior registration with the same id.
   *
   * @param {object} def
   * @param {string} def.id
   * @param {string} def.name
   * @param {string} def.description
   * @param {string} [def.icon]
   * @param {Array<ChannelConfigField>} [def.configSchema]
   * @param {(ctx: DeliveryContext) => Promise<object>} def.deliver  — handler (required)
   * @param {() => boolean} [def.isReady]  — optional runtime readiness probe; defaults to always ready
   */
  register(def) {
    if (!def?.id) throw new Error('Channel registration requires id');
    if (typeof def.deliver !== 'function') {
      throw new Error(`Channel "${def.id}" registration requires a deliver() handler`);
    }
    this._channels.set(def.id, {
      id: def.id,
      name: def.name ?? def.id,
      description: def.description ?? '',
      icon: def.icon ?? 'send',
      configSchema: def.configSchema ?? [],
      actionOnly: def.actionOnly ?? false,
      deliver: def.deliver,
      isReady: def.isReady ?? (() => true),
    });
    return this;
  }

  /** Unregister (for hot-reload scenarios — not used today). */
  unregister(id) { this._channels.delete(id); }

  /** Whether a channel is registered AND its readiness probe passes. */
  isAvailable(id) {
    const ch = this._channels.get(id);
    if (!ch) return false;
    try { return !!ch.isReady(); } catch { return false; }
  }

  /**
   * All channels with current availability. Unavailable channels are still
   * listed (with `available: false`) so the UI can show "installed but not
   * ready" with a reason. Channels that aren't registered AT ALL are simply
   * absent — from the user's perspective they don't exist.
   */
  getAll() {
    const out = [];
    for (const ch of this._channels.values()) {
      let available = true;
      let reason = null;
      try {
        if (!ch.isReady()) { available = false; reason = 'dependency not ready'; }
      } catch (e) { available = false; reason = e.message; }
      // Expose the public shape only — not the handler fn itself.
      out.push({
        id: ch.id,
        name: ch.name,
        description: ch.description,
        icon: ch.icon,
        configSchema: ch.configSchema,
        // actionOnly distinguishes mid-workflow connector ACTIONS (lookup,
        // history, react, …) from content DELIVERY destinations — consumers
        // (the converger's delivery vs step catalogs) need it to classify by
        // position. Without it both menus collapse together.
        actionOnly: ch.actionOnly ?? false,
        available,
        unavailableReason: reason,
      });
    }
    return out;
  }

  /** Public shape for a single channel, or null. */
  get(id) {
    const ch = this._channels.get(id);
    if (!ch) return null;
    const { deliver, isReady, ...pub } = ch; // pub includes actionOnly
    let available = true, reason = null;
    try { if (!isReady()) { available = false; reason = 'dependency not ready'; } }
    catch (e) { available = false; reason = e.message; }
    return { ...pub, available, unavailableReason: reason };
  }

  /** Internal — used by FlowTester to actually run a delivery. */
  getHandler(id) {
    const ch = this._channels.get(id);
    return ch?.deliver ?? null;
  }

  /** Builder-prompt summary. */
  describeForPrompt() {
    const lines = ['DELIVERY CHANNELS (outputs that actually work right now)'];
    const all = this.getAll();
    if (all.length === 0) {
      lines.push('  (none — no delivery channel handlers are registered in this build)');
      return lines.join('\n');
    }
    for (const ch of all) {
      const status = ch.available ? 'available' : `installed but not ready (${ch.unavailableReason})`;
      const cfg = ch.configSchema?.length
        ? ` · config: { ${ch.configSchema.map(f => `${f.key}${f.optional ? '?' : ''}: ${f.type}`).join(', ')} }`
        : '';
      lines.push(`  - ${ch.id} — ${ch.name} [${status}]${cfg}`);
      lines.push(`      ${ch.description}`);
    }
    lines.push('');
    lines.push('Channels NOT listed above are not wired in this build. Do not propose them. If the user asks for one, tell them it is not yet supported and offer a listed alternative.');
    return lines.join('\n');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Type definitions (JSDoc)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {object} ChannelConfigField
 * @property {string} key
 * @property {string} [label]
 * @property {string} type
 * @property {boolean} [optional]
 * @property {string} [hint]
 */

/**
 * @typedef {object} DeliveryContext
 * @property {object} config  — node.config after template substitution
 * @property {string} body    — stringified prior output
 * @property {string|null} title
 * @property {object} lastOutput  — raw prior-node output object/string
 */

/**
 * @typedef {object} ChannelDefinition
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string} icon
 * @property {ChannelConfigField[]} configSchema
 * @property {(ctx: DeliveryContext) => Promise<object>} deliver
 * @property {() => boolean} isReady
 */
