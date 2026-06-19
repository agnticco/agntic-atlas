/**
 * event-log — append-only, machine-readable JSON-lines log for dev debugging.
 *
 * Unlike `logger.js` (pretty ANSI console output for a human watching the
 * terminal), this writes one JSON object per line to a file on disk so it can be
 * tailed/grepped after the fact — by a developer OR by an AI assistant helping
 * debug. Every builder/run request and its outcome lands here with correlating
 * ids (tenant, user, threadId), so "where did this conversation/run break?" is
 * answerable from the file alone.
 *
 *   path:  LOG_DIR/atlas-events.log   (LOG_DIR defaults to ./memory/logs)
 *   line:  {"ts":"…","kind":"run.error","tenant":"…","error":"…","stack":"…"}
 *
 * Logging must never throw or crash a request — all writes are best-effort.
 *
 * @module src/utils/event-log.js
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LOG_DIR = process.env.LOG_DIR ?? './memory/logs';
const FILE = join(LOG_DIR, 'atlas-events.log');
let dirReady = false;

async function ensureDir() {
  if (dirReady) return;
  try { await mkdir(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
  dirReady = true;
}

/** Append one structured event. Never throws. */
export function logEvent(kind, fields = {}) {
  // Fire-and-forget; do not await in request paths.
  (async () => {
    try {
      await ensureDir();
      const safe = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        // Truncate big strings so the log stays readable.
        safe[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v;
      }
      await appendFile(FILE, JSON.stringify({ ts: new Date().toISOString(), kind, ...safe }) + '\n');
    } catch { /* logging is best-effort */ }
  })();
}

/** Normalize an error for logging (message + stack). */
export function errFields(err) {
  return { error: err?.message ?? String(err), stack: err?.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined };
}
