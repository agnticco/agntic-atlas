/**
 * ChannelRegistry — backwards-compatible adapter over CapabilityRegistry.
 *
 * All registrations are forwarded to CapabilityRegistry. Consumers that
 * still use the old interface (FlowTester, connector-action node, deliver
 * node, WorkflowValidator) continue to work unchanged. New code should
 * call CapabilityRegistry directly.
 *
 * The only translation: old-style { deliver, actionOnly } → new-style
 * { handle, positions }. actionOnly:true → positions:['step'],
 * actionOnly:false (or absent) → positions:['step','delivery'].
 *
 * @module src/workflows/channel-registry.js
 */

export class ChannelRegistry {
  /**
   * @param {import('../connectors/capability-registry.js').CapabilityRegistry} capabilityRegistry
   */
  constructor(capabilityRegistry) {
    this._cap = capabilityRegistry;
  }

  /**
   * Register a delivery/step channel (old format). Translates to CapabilityRegistry.
   *
   * @param {object} def
   * @param {string} def.id
   * @param {string} [def.name]
   * @param {string} [def.description]
   * @param {string} [def.icon]
   * @param {string} [def.connector]
   * @param {Array}  [def.configSchema]
   * @param {boolean}[def.actionOnly]   — true → step only; false/absent → step + delivery
   * @param {Function} def.deliver      — the handler (required)
   * @param {Function} [def.isReady]
   */
  register(def) {
    if (!def?.id) throw new Error('Channel registration requires id');
    if (typeof def.deliver !== 'function') {
      throw new Error(`Channel "${def.id}" registration requires a deliver() handler`);
    }
    const positions = def.actionOnly ? ['step'] : ['step', 'delivery'];
    this._cap.register({
      id:             def.id,
      connector:      def.connector ?? _inferConnector(def.id),
      positions,
      name:           def.name        ?? def.id,
      description:    def.description ?? '',
      icon:           def.icon        ?? 'send',
      configSchema:   def.configSchema  ?? [],
      requiredScopes: def.requiredScopes ?? [],
      isReady:        def.isReady     ?? (() => true),
      handle:         def.deliver,
    });
    return this;
  }

  unregister(id) { /* no-op: CapabilityRegistry has no unregister */ }

  /** Whether a capability is registered AND ready. */
  isAvailable(id) { return this._cap.isAvailable(id); }

  /**
   * Public shape for one capability, with actionOnly computed from positions.
   * Returns null if not registered.
   */
  get(id) {
    const pub = this._cap.get(id);
    if (!pub) return null;
    return { ...pub, actionOnly: !pub.positions.includes('delivery') };
  }

  /** Internal — handler fn for node executors. */
  getHandler(id) { return this._cap.getHandler(id); }

  /**
   * All step + delivery capabilities (triggers excluded), deduplicated,
   * with actionOnly flag computed from positions.
   */
  getAll() {
    const seen = new Set();
    const out  = [];
    for (const pos of ['step', 'delivery']) {
      for (const c of this._cap.list({ position: pos })) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push({ ...c, actionOnly: !c.positions.includes('delivery') });
      }
    }
    return out;
  }

  /** Builder-prompt summary (delivery channels only). */
  describeForPrompt() {
    const lines = ['DELIVERY CHANNELS (outputs that actually work right now)'];
    const channels = this._cap.list({ position: 'delivery' }).filter(c => c.available);
    if (!channels.length) {
      lines.push('  (none — no delivery channel handlers are registered in this build)');
      return lines.join('\n');
    }
    for (const ch of channels) {
      const cfg = ch.configSchema?.length
        ? ` · config: { ${ch.configSchema.map(f => `${f.key}${f.optional ? '?' : ''}: ${f.type}`).join(', ')} }`
        : '';
      lines.push(`  - ${ch.id} — ${ch.name} [available]${cfg}`);
      lines.push(`      ${ch.description}`);
    }
    lines.push('');
    lines.push('Channels NOT listed above are not wired in this build. Do not propose them.');
    return lines.join('\n');
  }
}

/** Best-effort connector inference from id prefix for old-style registrations. */
function _inferConnector(id) {
  if (id.startsWith('slack'))                          return 'slack';
  if (/^(gmail|sheets|docs|drive|calendar|tasks)/.test(id)) return 'google';
  if (id.startsWith('airtable'))                       return 'airtable';
  return null;
}
