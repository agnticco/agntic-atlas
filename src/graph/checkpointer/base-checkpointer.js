/**
 * BaseCheckpointer — abstract interface for checkpoint storage.
 *
 * Subclasses implement save/load/list/clear for a specific backend
 * (in-memory, filesystem, database, etc).
 *
 * threadId is the key that identifies a single graph run or conversation.
 * In the agent, this maps to sessionId.
 *
 * @module src/graph/checkpointer/base-checkpointer.js
 */

export class BaseCheckpointer {
  constructor() {
    if (new.target === BaseCheckpointer) {
      throw new Error('BaseCheckpointer is abstract — use MemoryCheckpointer or FileCheckpointer');
    }
  }

  /**
   * Persist a checkpoint for the given thread.
   * @param {string}     threadId
   * @param {Checkpoint} checkpoint
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async save(threadId, checkpoint) {
    throw new Error(`${this.constructor.name}.save() not implemented`);
  }

  /**
   * Load the most recent checkpoint for the given thread.
   * Returns null if no checkpoint exists.
   * @param {string} threadId
   * @returns {Promise<Checkpoint|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async load(threadId) {
    throw new Error(`${this.constructor.name}.load() not implemented`);
  }

  /**
   * Load all checkpoints for the given thread, oldest first.
   * @param {string} threadId
   * @returns {Promise<Checkpoint[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async list(threadId) {
    throw new Error(`${this.constructor.name}.list() not implemented`);
  }

  /**
   * Delete all checkpoints for the given thread.
   * @param {string} threadId
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async clear(threadId) {
    throw new Error(`${this.constructor.name}.clear() not implemented`);
  }
}

export default BaseCheckpointer;
