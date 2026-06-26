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
import { statSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { numEnv } from './env.js';

const LOG_DIR = process.env.LOG_DIR ?? './memory/logs';
const FILE = join(LOG_DIR, 'atlas-events.log');
// Size-based rotation so the append-only log can't fill the disk. When FILE would
// exceed MAX_BYTES it's rotated to FILE.1 (shifting .1→.2 … up to KEEP) and a fresh
// FILE is started. Set MAX_BYTES=0 to disable. Env-tunable.
const MAX_BYTES = numEnv('EVENT_LOG_MAX_BYTES', 10 * 1024 * 1024); // 10 MB
const KEEP      = numEnv('EVENT_LOG_KEEP', 3);
let dirReady = false;
let bytes = null; // tracked size of FILE; lazily initialized from disk on first write

async function ensureDir() {
  if (dirReady) return;
  try { await mkdir(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
  dirReady = true;
}

// Rotate synchronously (atomic, no await) when the next line would exceed the cap.
function rotateIfNeeded(nextLen) {
  if (MAX_BYTES <= 0) return;
  if (bytes == null) { try { bytes = statSync(FILE).size; } catch { bytes = 0; } }
  if (bytes + nextLen <= MAX_BYTES) return;
  try {
    const oldest = `${FILE}.${KEEP}`;
    if (existsSync(oldest)) { try { unlinkSync(oldest); } catch { /* ignore */ } }
    for (let i = KEEP - 1; i >= 1; i--) {
      if (existsSync(`${FILE}.${i}`)) { try { renameSync(`${FILE}.${i}`, `${FILE}.${i + 1}`); } catch { /* ignore */ } }
    }
    if (existsSync(FILE)) renameSync(FILE, `${FILE}.1`);
    bytes = 0;
  } catch { /* best-effort: if rotation fails, keep appending to the current file */ }
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
      const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...safe }) + '\n';
      const len = Buffer.byteLength(line);
      rotateIfNeeded(len);
      bytes += len; // optimistic so concurrent fire-and-forget writes see it
      await appendFile(FILE, line);
    } catch { /* logging is best-effort */ }
  })();
}

/** Normalize an error for logging (message + stack). */
export function errFields(err) {
  return { error: err?.message ?? String(err), stack: err?.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined };
}
