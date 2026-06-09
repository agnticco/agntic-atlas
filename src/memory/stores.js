/**
 * Memory Stores — persistence backends
 *
 * Both stores implement the BaseStore namespaced API (LangGraph-style long-term memory)
 * plus a flat API (save/load/delete) for backward-compat with vector store internals.
 *
 * BaseStore namespaced API:
 *   put(namespace[], key, value)    — write under namespace path
 *   get(namespace[], key)           — read by namespace + key
 *   remove(namespace[], key)        — delete a namespaced entry
 *   list(namespace[])               — list all keys in a namespace
 *   search(namespace[], query)      — text-match search within a namespace
 *
 * Flat API (existing, unchanged):
 *   save(key, data)   — write a top-level key
 *   load(key)         — read a top-level key
 *   delete(key)       — remove a top-level key
 *
 * @module src/memory/stores.js
 */

import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import { BaseStore } from './base-store.js';

// ── MemoryStore ───────────────────────────────────────────────────────────────

/**
 * MemoryStore — in-process storage only.
 * Fast, zero-config, but non-persistent (data lost on process restart).
 * Use for development, tests, or ephemeral session data.
 */
export class MemoryStore extends BaseStore {
  constructor() {
    super();
    /** Flat API store: key → value */
    this._flat = new Map();
    /** Namespaced API store: namespaceKey → Map<key, value> */
    this._ns   = new Map();
  }

  // ── Flat API ───────────────────────────────────────────────────────────────

  async save(key, data) {
    this._flat.set(key, JSON.parse(JSON.stringify(data)));
  }

  async load(key) {
    return this._flat.get(key) ?? null;
  }

  async delete(key) {
    this._flat.delete(key);
  }

  // ── BaseStore (namespaced) API ─────────────────────────────────────────────

  _nsKey(namespace) {
    return namespace.map(String).join('/');
  }

  _getNsMap(namespace) {
    const k = this._nsKey(namespace);
    if (!this._ns.has(k)) this._ns.set(k, new Map());
    return this._ns.get(k);
  }

  async put(namespace, key, value) {
    this._getNsMap(namespace).set(key, JSON.parse(JSON.stringify(value)));
  }

  async get(namespace, key) {
    return this._getNsMap(namespace).get(key) ?? null;
  }

  async remove(namespace, key) {
    this._getNsMap(namespace).delete(key);
  }

  async list(namespace) {
    return [...this._getNsMap(namespace).keys()];
  }

  async search(namespace, query) {
    const needle  = query.toLowerCase();
    const results = [];
    for (const [key, value] of this._getNsMap(namespace)) {
      if (JSON.stringify(value).toLowerCase().includes(needle)) {
        results.push({ key, value });
      }
    }
    return results;
  }
}

// ── FileStore ─────────────────────────────────────────────────────────────────

/**
 * FileStore — disk-backed JSON storage.
 * Survives process restarts. Default dir: './memory'.
 *
 * Files are organised as:
 *   Flat:       <dir>/<key>.json
 *   Namespaced: <dir>/<ns[0]>/<ns[1]>/.../<key>.json
 *
 * @example
 *   const store = new FileStore({ dir: './memory' });
 *   await store.put(['user_123', 'prefs'], 'theme', { mode: 'dark' });
 *   const prefs = await store.get(['user_123', 'prefs'], 'theme');
 */
export class FileStore extends BaseStore {
  constructor(options = {}) {
    super();
    this.dir = options.dir ?? './memory';
  }

  // ── Flat API (existing, unchanged) ────────────────────────────────────────

  async save(key, data) {
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${key}.json`);
    // Stream-write to avoid V8 max string length with large vector stores
    const ws = createWriteStream(file, { encoding: 'utf8' });
    const write = (s) => new Promise((res, rej) => ws.write(s) ? res() : ws.once('drain', res));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      await write('{');
      const pairs = Object.entries(data);
      for (let i = 0; i < pairs.length; i++) {
        const [k, v] = pairs[i];
        await write(JSON.stringify(k) + ':');
        if (Array.isArray(v)) {
          await write('[');
          for (let j = 0; j < v.length; j++) {
            await write(JSON.stringify(v[j]));
            if (j < v.length - 1) await write(',');
          }
          await write(']');
        } else {
          await write(JSON.stringify(v));
        }
        if (i < pairs.length - 1) await write(',');
      }
      await write('}');
    } else {
      await write(JSON.stringify(data));
    }
    await new Promise((res, rej) => { ws.end(); ws.on('finish', res); ws.on('error', rej); });
  }

  async load(key) {
    try {
      const file = path.join(this.dir, `${key}.json`);
      const content = await fs.readFile(file, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async delete(key) {
    try {
      await fs.unlink(path.join(this.dir, `${key}.json`));
    } catch {
      // file may not exist — that's fine
    }
  }

  // ── BaseStore (namespaced) API ─────────────────────────────────────────────

  _nsDir(namespace) {
    return path.join(this.dir, ...namespace.map(String));
  }

  async put(namespace, key, value) {
    const dir  = this._nsDir(namespace);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${key}.json`);
    await fs.writeFile(
      file,
      JSON.stringify({ key, value, updatedAt: Date.now() }, null, 2),
      'utf-8'
    );
  }

  async get(namespace, key) {
    try {
      const file = path.join(this._nsDir(namespace), `${key}.json`);
      const raw  = await fs.readFile(file, 'utf-8');
      return JSON.parse(raw).value ?? null;
    } catch {
      return null;
    }
  }

  async remove(namespace, key) {
    try {
      await fs.unlink(path.join(this._nsDir(namespace), `${key}.json`));
    } catch {
      // file may not exist
    }
  }

  async list(namespace) {
    try {
      const dir   = this._nsDir(namespace);
      const files = await fs.readdir(dir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5));
    } catch {
      return [];
    }
  }

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
