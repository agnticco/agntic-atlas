/**
 * AuthProvider — abstraction over the identity source.
 *
 * The default implementation (LocalAuthProvider) reads the users table and
 * uses argon2id to verify passwords. Customer-specific adapters (OIDC,
 * SAML, SSO) implement this same shape; the rest of the codebase talks to
 * the abstract provider so the auth transport is swappable per deployment.
 *
 * See docs/multi-user-architecture.md §5 for the full contract.
 *
 * @module src/auth/auth-provider.js
 */

/* eslint-disable class-methods-use-this */
export class AuthProvider {
  /**
   * Verify credentials and return the matching user. Throw AuthError (or a
   * plain Error) on rejection; return null for a soft "no such user / bad
   * password" result. Providers with redirect flows (OIDC) may ignore this.
   *
   * @param {object} creds
   * @param {string} creds.email
   * @param {string} creds.password
   * @returns {Promise<object|null>} user record (no password_hash)
   */
  async authenticate(_creds) {
    throw new Error('AuthProvider.authenticate not implemented');
  }

  /**
   * Create a new user. OIDC-style providers may throw "not supported" — the
   * app disables the registration UI in that case via supportsRegistration().
   *
   * @param {object} input
   * @param {string} input.email
   * @param {string} input.password
   * @param {'admin'|'user'} [input.role]
   * @param {string} [input.display_name]
   * @returns {Promise<object>} user record
   */
  async register(_input) {
    throw new Error('AuthProvider.register not implemented');
  }

  /** Whether this provider can create users itself (vs. relying on an IdP). */
  supportsRegistration() { return false; }

  /**
   * Change a user's password. May throw for providers where the IdP owns
   * passwords; UI hides the change-password form when supportsPasswordChange()
   * returns false.
   */
  async changePassword(_input) {
    throw new Error('AuthProvider.changePassword not implemented');
  }

  supportsPasswordChange() { return false; }

  /** Human-readable identifier — shown in admin UI + startup logs. */
  describe() { return this.constructor.name; }
}

export default AuthProvider;
