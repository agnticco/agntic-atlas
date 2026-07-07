/**
 * Release notes ("What's New") — reads release-notes.json (repo root, newest
 * first) and computes which entries a user hasn't seen yet. The version in each
 * entry is compared against the user's stored `last_seen_version` preference.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const NOTES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'release-notes.json');

let _cache;
/** All release-note entries, newest first. Cached (deploys restart the process). */
export function releaseNotes() {
  if (_cache) return _cache;
  try {
    const parsed = JSON.parse(readFileSync(NOTES_PATH, 'utf8'));
    _cache = Array.isArray(parsed) ? parsed : [];
  } catch { _cache = []; }
  return _cache;
}

/** Compare semver strings. >0 if a>b, <0 if a<b, 0 if equal. Null/empty b → a is newer. */
export function cmpSemver(a, b) {
  if (!b) return 1;
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Release-note entries strictly newer than `seenVersion` (null → all of them). */
export function notesSince(seenVersion) {
  return releaseNotes().filter((e) => e && e.version && cmpSemver(e.version, seenVersion) > 0);
}
