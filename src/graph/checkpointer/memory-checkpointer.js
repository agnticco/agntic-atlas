/**
 * MemoryCheckpointer — in-process checkpoint storage.
 *
 * Stores checkpoints in a Map keyed by threadId. Fast, zero-config,
 * but non-persistent — state is lost when the process restarts.
 *
 * Use this during development or for ephemeral graph runs. Use
 * FileCheckpointer for runs that need to survive process restarts
 * (e.g. long-running human-approval loops).
 *
 * @module src/graph/checkpointer/memory-checkpointer.js
 */

import { BaseCheckpointer } from './base-checkpointer.js';

export class MemoryCheckpointer extends BaseCheckpointer {
  constructor() {
    super();
    /** @type {Map<string, import('../checkpoint.js').Checkpoint[]>} */
    this._store = new Map();
  }

  async save(threadId, checkpoint) {
    if (!this._store.has(threadId)) {
      this._store.set(threadId, []);
    }
    this._store.get(threadId).push(checkpoint);
  }

  async load(threadId) {
    const checkpoints = this._store.get(threadId);
    return checkpoints?.at(-1) ?? null;
  }

  async list(threadId) {
    return [...(this._store.get(threadId) ?? [])];
  }

  async clear(threadId) {
    this._store.delete(threadId);
  }

  /** Total number of threads stored. */
  get threadCount() {
    return this._store.size;
  }
}

export default MemoryCheckpointer;
