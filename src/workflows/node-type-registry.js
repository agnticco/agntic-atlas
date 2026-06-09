/**
 * NodeTypeRegistry — pluggable node types for Flow workflows.
 *
 * Each node type is registered once at server startup as a self-describing
 * module with:
 *
 *   {
 *     type,          // unique id, e.g. 'summarize'
 *     label,         // plain-English label shown to users
 *     description,   // one-line user-facing description
 *     icon,          // material symbol name
 *     family,        // 'trigger' | 'fetch' | 'transform' | 'assemble' | 'deliver' | 'low_level'
 *     configSchema,  // array of field specs that drive the inline editor
 *     validate,      // optional (node) => issues[] for extra rules
 *     run,           // async (cfg, ctx, services) => output
 *   }
 *
 * Consumers:
 *   - FlowTester dispatches execution via `get(type).run(...)`.
 *   - WorkflowValidator asks the registry for per-type required fields and
 *     optional custom validators.
 *   - The /node-types endpoint returns the full public shape (minus run) so
 *     the UI can render schema-driven editors and a palette.
 *
 * @module src/workflows/node-type-registry.js
 */

export class NodeTypeRegistry {
  constructor() {
    /** @type {Map<string, NodeTypeDefinition>} */
    this._types = new Map();
  }

  /** Register a node type. Overwrites any prior registration of the same id. */
  register(def) {
    if (!def?.type) throw new Error('Node type registration requires a type id');
    if (typeof def.run !== 'function') {
      throw new Error(`Node type "${def.type}" registration requires a run() function`);
    }
    this._types.set(def.type, {
      type:            def.type,
      label:           def.label        ?? def.type,
      description:     def.description  ?? '',
      icon:            def.icon         ?? 'adjust',
      family:          def.family       ?? 'low_level',
      configSchema:    def.configSchema ?? [],
      previewTemplate: def.previewTemplate ?? null,
      validate:        def.validate     ?? null,
      run:             def.run,
    });
    return this;
  }

  /** Known node type id? */
  has(type) { return this._types.has(type); }

  /** Full definition for a type (including run). */
  get(type) { return this._types.get(type) ?? null; }

  /** All registered types, public shape (strips `run` and `validate` fns). */
  list() {
    return [...this._types.values()].map(t => this._publicShape(t));
  }

  /** All registered type ids. */
  typeIds() { return [...this._types.keys()]; }

  /**
   * Summary block for the builder system prompt. Groups by family so the
   * agent can pick the highest-level appropriate primitive instead of
   * defaulting to raw `llm` + `tool`.
   */
  describeForPrompt() {
    const byFamily = new Map();
    for (const t of this._types.values()) {
      if (!byFamily.has(t.family)) byFamily.set(t.family, []);
      byFamily.get(t.family).push(t);
    }
    const order = ['trigger', 'fetch', 'transform', 'assemble', 'deliver', 'low_level'];
    const familyLabels = {
      trigger:   'Triggers (start the workflow)',
      fetch:     'Fetch (pull data)',
      transform: 'Transforms (reshape data)',
      assemble:  'Assemble (combine into output)',
      deliver:   'Deliver (send the result)',
      low_level: 'Low-level building blocks (only when no primitive fits)',
    };
    const lines = ['NODE TYPES (prefer higher-level primitives over low_level)'];
    for (const fam of order) {
      const types = byFamily.get(fam) ?? [];
      if (!types.length) continue;
      lines.push('');
      lines.push(familyLabels[fam]);
      for (const t of types) {
        const fields = t.configSchema.length
          ? ` config: { ${t.configSchema.map(f => `${f.key}${f.optional ? '?' : ''}: ${f.type}`).join(', ')} }`
          : '';
        lines.push(`  - ${t.type} — ${t.description}${fields}`);
      }
    }
    return lines.join('\n');
  }

  _publicShape(t) {
    return {
      type:            t.type,
      label:           t.label,
      description:     t.description,
      icon:            t.icon,
      family:          t.family,
      configSchema:    t.configSchema,
      previewTemplate: t.previewTemplate,
    };
  }
}

/**
 * @typedef {object} ConfigField
 * @property {string}  key
 * @property {string}  label
 * @property {'text'|'textarea'|'number'|'select'|'boolean'|'object'} type
 * @property {boolean} [optional]
 * @property {string}  [hint]
 * @property {string}  [placeholder]
 * @property {string[]} [options]  — for select
 * @property {*}       [default]
 * @property {number}  [rows]      — for textarea
 */

/**
 * @typedef {object} NodeTypeDefinition
 * @property {string} type
 * @property {string} label
 * @property {string} description
 * @property {string} icon
 * @property {string} family
 * @property {ConfigField[]} configSchema
 * @property {(node:object) => Array<object>} [validate]
 * @property {(cfg:object, ctx:object, services:object) => Promise<*>} run
 */
