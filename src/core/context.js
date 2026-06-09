/**
 * RunnableConfig
 *
 * Configuration object passed through runnable chains
 *
 * @module src/core/context.js
 */
export class RunnableConfig {
  constructor(options = {}) {
    // Callbacks for monitoring
    this.callbacks = options.callbacks || [];

    // Metadata (arbitrary data)
    this.metadata = options.metadata || {};

    // Tags for filtering/organization
    this.tags = options.tags || [];

    // Recursion limit (prevent infinite loops)
    this.recursionLimit = options.recursionLimit ?? 25;

    // Runtime overrides for generation parameters
    this.configurable = options.configurable || {};

    // Pass through any additional keys (e.g. tools, onApprovalRequired, sessionId)
    const known = new Set(['callbacks', 'metadata', 'tags', 'recursionLimit', 'configurable']);
    for (const [key, value] of Object.entries(options)) {
      if (!known.has(key)) this[key] = value;
    }
  }

  /**
   * Merge with another config (child inherits from parent)
   */
  merge(other) {
    const known = new Set(['callbacks', 'metadata', 'tags', 'recursionLimit', 'configurable']);
    const extra = {};
    for (const obj of [this, other]) {
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) extra[key] = obj[key];
      }
    }
    return new RunnableConfig({
      callbacks: [...this.callbacks, ...(other.callbacks || [])],
      metadata: { ...this.metadata, ...(other.metadata || {}) },
      tags: [...this.tags, ...(other.tags || [])],
      recursionLimit: other.recursionLimit ?? this.recursionLimit,
      configurable: { ...this.configurable, ...(other.configurable || {}) },
      ...extra,
    });
  }

  /**
   * Create a child config with additional settings
   */
  child(options = {}) {
    return this.merge(new RunnableConfig(options));
  }
}

export default RunnableConfig;
