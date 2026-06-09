/**
 * BaseStore — abstract interface for LangGraph-style long-term memory stores.
 *
 * Unlike short-term memory (thread-scoped, managed via checkpointer), a Store
 * persists data across threads. It is scoped by namespace arrays, enabling
 * per-user, per-agent, or per-application memory that can be recalled at any
 * time from any thread.
 *
 * Namespace arrays map to hierarchical storage paths:
 *   ['user_123', 'preferences']   → user-specific preferences
 *   ['global', 'knowledge_base']  → shared application-level facts
 *
 * All concrete implementations (MemoryStore, FileStore) extend this class
 * and must implement the five core methods.
 *
 * Built-in implementations in src/memory/stores.js already implement this API.
 *
 * @module src/memory/base-store.js
 */

export class BaseStore {
  constructor() {
    if (new.target === BaseStore) {
      throw new Error('BaseStore is abstract — use MemoryStore or FileStore');
    }
  }

  /**
   * Write a value to the store under a namespaced key.
   *
   * @param {string[]} namespace - Path segments (e.g. ['user_123', 'entities'])
   * @param {string}   key       - Entry identifier
   * @param {*}        value     - JSON-serialisable data
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async put(namespace, key, value) {
    throw new Error(`${this.constructor.name}.put() not implemented`);
  }

  /**
   * Read a value by namespace + key.
   * Returns null if not found.
   *
   * @param {string[]} namespace
   * @param {string}   key
   * @returns {Promise<*>}
   */
  // eslint-disable-next-line no-unused-vars
  async get(namespace, key) {
    throw new Error(`${this.constructor.name}.get() not implemented`);
  }

  /**
   * Delete an entry by namespace + key.
   *
   * @param {string[]} namespace
   * @param {string}   key
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async remove(namespace, key) {
    throw new Error(`${this.constructor.name}.remove() not implemented`);
  }

  /**
   * List all keys in a namespace.
   *
   * @param {string[]} namespace
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async list(namespace) {
    throw new Error(`${this.constructor.name}.list() not implemented`);
  }

  /**
   * Search entries in a namespace.
   * Default implementation: simple substring match on JSON-serialised values.
   * Override for semantic/vector search.
   *
   * @param {string[]} namespace
   * @param {string}   query
   * @returns {Promise<Array<{ key: string, value: * }>>}
   */
  async search(namespace, query) {
    const keys    = await this.list(namespace);
    const results = [];
    const needle  = query.toLowerCase();
    for (const key of keys) {
      const value = await this.get(namespace, key);
      if (value !== null && JSON.stringify(value).toLowerCase().includes(needle)) {
        results.push({ key, value });
      }
    }
    return results;
  }
}

export default BaseStore;
