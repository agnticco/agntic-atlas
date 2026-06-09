/**
 * Checkpoint — a snapshot of graph state at a specific point in execution.
 *
 * Checkpoints are created by a Checkpointer after each node completes.
 * They allow a graph run to be paused, inspected, replayed, or resumed
 * from any prior state — critical for the human-in-the-loop planning loop
 * where the user may approve, reject, or modify a plan before execution.
 *
 * @module src/graph/checkpoint.js
 */

let _counter = 0;

export class Checkpoint {
  /**
   * @param {object} options
   * @param {string}  [options.id]        - Unique checkpoint ID (auto-generated if omitted)
   * @param {object}  options.state       - Full graph state at this point
   * @param {string}  options.node        - Name of the node that just completed
   * @param {number}  [options.step]      - Step index within the run (0-based)
   * @param {number}  [options.timestamp] - Unix ms timestamp (defaults to now)
   * @param {object}  [options.metadata]  - Optional arbitrary metadata
   */
  constructor({ id, state, node, step = 0, timestamp, metadata = {} } = {}) {
    if (!state)  throw new Error('Checkpoint: state is required');
    if (!node)   throw new Error('Checkpoint: node is required');

    this.id        = id        ?? `ckpt-${Date.now()}-${_counter++}`;
    this.state     = structuredClone(state);   // deep copy — immutable snapshot
    this.node      = node;
    this.step      = step;
    this.timestamp = timestamp ?? Date.now();
    this.metadata  = metadata;
  }

  toJSON() {
    return {
      id:        this.id,
      state:     this.state,
      node:      this.node,
      step:      this.step,
      timestamp: this.timestamp,
      metadata:  this.metadata,
    };
  }

  static fromJSON(json) {
    return new Checkpoint(json);
  }
}

export default Checkpoint;
