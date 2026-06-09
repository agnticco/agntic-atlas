/**
 * TokenCipher — AES-256-GCM authenticated encryption for OAuth tokens at rest.
 *
 * Wire format (versioned so the scheme can evolve without ambiguity):
 *
 *   v1:<base64url( iv(12) | authTag(16) | ciphertext )>
 *
 * GCM gives us confidentiality + tamper detection in one primitive; a
 * modified ciphertext fails decryption rather than returning garbage.
 * Plaintext tokens never leave this module unencrypted and are never logged.
 *
 * @module src/auth/token-cipher.js
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO     = 'aes-256-gcm';
const IV_BYTES  = 12;  // GCM standard nonce length
const TAG_BYTES = 16;
const PREFIX    = 'v1:';

export class TokenCipher {
  /**
   * @param {Buffer} key - exactly 32 raw bytes (AES-256)
   */
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error('TokenCipher requires a 32-byte Buffer key');
    }
    this._key = key;
  }

  /**
   * Encrypt a UTF-8 string. Returns the versioned wire format.
   * @param {string} plaintext
   * @returns {string}
   */
  encrypt(plaintext) {
    if (plaintext == null) return null;
    const iv     = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this._key, iv);
    const ct     = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64url');
  }

  /**
   * Decrypt a value produced by encrypt(). Throws on tamper / wrong key /
   * malformed input — callers should treat a throw as "unusable credential".
   * @param {string} blob
   * @returns {string}
   */
  decrypt(blob) {
    if (blob == null) return null;
    const s = String(blob);
    if (!s.startsWith(PREFIX)) {
      throw new Error('TokenCipher.decrypt: missing v1 prefix (not a ciphertext produced by this cipher)');
    }
    const raw = Buffer.from(s.slice(PREFIX.length), 'base64url');
    if (raw.length < IV_BYTES + TAG_BYTES + 1) {
      throw new Error('TokenCipher.decrypt: ciphertext too short / corrupt');
    }
    const iv  = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct  = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGO, this._key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

export default TokenCipher;
