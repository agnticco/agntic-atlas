/**
 * TokenService — signs + verifies the JWTs used by the auth middleware.
 *
 * Secret resolution order (see docs/multi-user-architecture.md §5.2):
 *   1. process.env.JWT_SECRET        — operator-managed, preferred in prod
 *   2. ./memory/.jwt-secret          — persisted random secret (created once)
 *   3. freshly generated + written   — first-run fallback, prints warning
 *
 * Path 3 is a convenience so fresh installs work without configuration. In
 * production the secret should come from the deployment's secret manager
 * and be passed via env — losing the file invalidates every active session.
 *
 * @module src/auth/token-service.js
 */

import jwt from 'jsonwebtoken';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { log } from '../utils/logger.js';

const ISSUER = 'agntic';
const ALGO   = 'HS256';

export const COOKIE_TTL_MS  = 24 * 60 * 60 * 1000;       // 24h
export const BEARER_TTL_MS  = 30 * 24 * 60 * 60 * 1000;  // 30d

export class TokenService {
  /**
   * @param {object} opts
   * @param {string} opts.secret - HMAC secret (>= 32 bytes recommended)
   * @param {string} [opts.source] - Human-readable description of where the secret came from (for logs)
   */
  constructor({ secret, source = 'unknown' }) {
    if (!secret || secret.length < 16) {
      throw new Error('JWT secret is missing or too short');
    }
    this._secret = secret;
    this.source  = source;
  }

  /**
   * Resolve a secret from env → file → generate-and-persist.
   * @param {object} [opts]
   * @param {string} [opts.secretPath] - path to persist generated secret (default ./memory/.jwt-secret)
   */
  static fromEnvOrFile({ secretPath = './memory/.jwt-secret' } = {}) {
    const envSecret = process.env.JWT_SECRET?.trim();
    if (envSecret) {
      if (envSecret.length < 32) {
        log.warn('[auth] JWT_SECRET is shorter than 32 chars — use a strong random value in production.');
      }
      return new TokenService({ secret: envSecret, source: 'env:JWT_SECRET' });
    }

    const abs = resolve(secretPath);
    if (existsSync(abs)) {
      const secret = readFileSync(abs, 'utf8').trim();
      if (secret) return new TokenService({ secret, source: `file:${secretPath}` });
    }

    // Generate + persist (chmod 600). Log clearly that this is a first-run fallback.
    try { mkdirSync(dirname(abs), { recursive: true }); } catch { /* ok */ }
    const secret = randomBytes(48).toString('base64url');
    writeFileSync(abs, secret, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(abs, 0o600); } catch { /* best effort */ }
    log.warn(`[auth] No JWT_SECRET set — generated a random secret at ${secretPath}.`);
    log.warn('[auth] Back this file up, or set JWT_SECRET in your deployment secrets.');
    return new TokenService({ secret, source: `file:${secretPath} (generated)` });
  }

  /**
   * Sign a JWT for a session.
   * @param {object} claims
   * @param {string} claims.userId
   * @param {string} claims.sessionId  - also the jti
   * @param {'admin'|'user'} claims.role
   * @param {number} claims.ttlMs      - lifetime in ms
   * @returns {string}
   */
  sign({ userId, tenantId, sessionId, role, ttlMs }) {
    if (!userId || !sessionId || !role || !ttlMs) {
      throw new Error('sign() requires userId, sessionId, role, ttlMs');
    }
    if (!tenantId) throw new Error('sign() requires tenantId');
    return jwt.sign(
      { sub: userId, jti: sessionId, role, tid: tenantId },
      this._secret,
      { algorithm: ALGO, expiresIn: Math.floor(ttlMs / 1000), issuer: ISSUER },
    );
  }

  /**
   * Sign a short-lived, scoped token that is NOT a session — it carries a tenant + a
   * scope only (no user/session), so it can't authenticate against the middleware.
   * Used for the resubscribe flow: a suspended user (who can't get a session) proves
   * account ownership at login, gets one of these, and spends it at /api/billing/resubscribe.
   * Verify with verify() then check `claims.scope`.
   */
  signScoped({ tenantId, scope, ttlMs }) {
    if (!tenantId || !scope || !ttlMs) throw new Error('signScoped() requires tenantId, scope, ttlMs');
    return jwt.sign(
      { tid: tenantId, scope },
      this._secret,
      { algorithm: ALGO, expiresIn: Math.floor(ttlMs / 1000), issuer: ISSUER },
    );
  }

  /**
   * Verify + decode a token. Returns the claims on success, null on any failure.
   * Swallows jsonwebtoken errors to a uniform null — callers should treat null
   * as "unauthorized" without needing to distinguish failure modes.
   */
  verify(token) {
    if (!token || typeof token !== 'string') return null;
    try {
      return jwt.verify(token, this._secret, { algorithms: [ALGO], issuer: ISSUER });
    } catch {
      return null;
    }
  }
}

export default TokenService;
