/**
 * OAuthKey — per-deployment symmetric key for encrypting stored OAuth tokens.
 *
 * Secret resolution order (deliberately identical to TokenService.fromEnvOrFile
 * so operators have one mental model for deployment secrets):
 *   1. process.env.OAUTH_TOKEN_KEY   — operator-managed, preferred in prod
 *      (base64 or hex encoding of 32 raw bytes)
 *   2. ./memory/.oauth-key           — persisted random key (created once)
 *   3. freshly generated + written   — first-run fallback, prints warning
 *
 * Losing/rotating the key makes every stored token undecryptable (users must
 * reconnect). That is the same trade-off as losing .jwt-secret invalidating
 * sessions — acceptable, and the warning says so.
 *
 * @module src/auth/oauth-key.js
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { log } from '../utils/logger.js';

const KEY_BYTES = 32; // AES-256

/** Decode a 32-byte key from base64 or hex; returns null if not 32 bytes. */
function decodeKey(str) {
  const s = String(str ?? '').trim();
  if (!s) return null;
  for (const enc of ['base64', 'hex']) {
    try {
      const buf = Buffer.from(s, enc);
      if (buf.length === KEY_BYTES) return buf;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Resolve the token-encryption key: env → file → generate-and-persist.
 * @param {object} [opts]
 * @param {string} [opts.keyPath] - path to persist a generated key (default ./memory/.oauth-key)
 * @returns {{ key: Buffer, source: string }}
 */
export function resolveOAuthKey({ keyPath = './memory/.oauth-key' } = {}) {
  const envKey = process.env.OAUTH_TOKEN_KEY?.trim();
  if (envKey) {
    const buf = decodeKey(envKey);
    if (!buf) {
      throw new Error('OAUTH_TOKEN_KEY is set but is not 32 bytes (base64 or hex). Generate with: openssl rand -base64 32');
    }
    return { key: buf, source: 'env:OAUTH_TOKEN_KEY' };
  }

  const abs = resolve(keyPath);
  if (existsSync(abs)) {
    const buf = decodeKey(readFileSync(abs, 'utf8'));
    if (buf) return { key: buf, source: `file:${keyPath}` };
    log.warn(`[oauth] ${keyPath} exists but is not a valid 32-byte key — regenerating.`);
  }

  // Generate + persist (chmod 600). First-run fallback.
  try { mkdirSync(dirname(abs), { recursive: true }); } catch { /* ok */ }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(abs, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(abs, 0o600); } catch { /* best effort */ }
  log.warn(`[oauth] No OAUTH_TOKEN_KEY set — generated a random key at ${keyPath}.`);
  log.warn('[oauth] Back this file up. Losing it forces every user to reconnect their accounts.');
  return { key, source: `file:${keyPath} (generated)` };
}

export default resolveOAuthKey;
