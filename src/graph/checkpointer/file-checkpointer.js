/**
 * FileCheckpointer — filesystem-backed checkpoint storage.
 *
 * Persists checkpoints as newline-delimited JSON files under a configurable
 * directory. Each threadId gets its own file: `{dir}/{threadId}.jsonl`
 *
 * Survives process restarts — the graph run can resume from where it left
 * off even if the server is restarted mid-conversation (e.g. between the
 * user receiving a plan and approving it).
 *
 * @module src/graph/checkpointer/file-checkpointer.js
 */

import { BaseCheckpointer } from './base-checkpointer.js';
import { Checkpoint }       from '../checkpoint.js';
import { promises as fs }   from 'fs';
import path                 from 'path';

export class FileCheckpointer extends BaseCheckpointer {
  /**
   * @param {object} [options]
   * @param {string} [options.dir='./memory/checkpoints'] - Directory to store checkpoint files
   */
  constructor({ dir = './memory/checkpoints' } = {}) {
    super();
    this._dir = dir;
  }

  _filepath(threadId) {
    // Sanitize threadId — strip any path separators to prevent directory traversal
    const safe = threadId.replace(/[/\\:*?"<>|]/g, '_');
    return path.join(this._dir, `${safe}.jsonl`);
  }

  async _ensureDir() {
    await fs.mkdir(this._dir, { recursive: true });
  }

  async save(threadId, checkpoint) {
    await this._ensureDir();
    const line = JSON.stringify(checkpoint.toJSON()) + '\n';
    await fs.appendFile(this._filepath(threadId), line, 'utf8');
  }

  async load(threadId) {
    const checkpoints = await this.list(threadId);
    return checkpoints.at(-1) ?? null;
  }

  async list(threadId) {
    const filepath = this._filepath(threadId);
    let content;
    try {
      content = await fs.readFile(filepath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => Checkpoint.fromJSON(JSON.parse(line)));
  }

  async clear(threadId) {
    try {
      await fs.unlink(this._filepath(threadId));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

export default FileCheckpointer;
