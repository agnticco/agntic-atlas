/**
 * LocalAuthProvider — default AuthProvider backed by UserStore.
 *
 * Stores password hashes in the local users table, verifies with argon2id,
 * and supports both registration and password change. This is the v1
 * default; enterprise deployments can supply an OIDC/SAML provider instead
 * by implementing the AuthProvider interface.
 *
 * @module src/auth/local-auth-provider.js
 */

import { AuthProvider } from './auth-provider.js';

export class LocalAuthProvider extends AuthProvider {
  /** @param {{ userStore: import('./user-store.js').UserStore }} opts */
  constructor({ userStore }) {
    super();
    if (!userStore) throw new Error('LocalAuthProvider requires a userStore');
    this.userStore = userStore;
  }

  /**
   * Returns the user on valid credentials, null otherwise. Does not throw
   * on bad passwords — callers should treat null as "unauthorized" and
   * render a generic failure to avoid user-enumeration leaks.
   */
  async authenticate({ email, password }) {
    if (!email || !password) return null;
    return await this.userStore.verifyPassword({ email, password });
  }

  async register({ tenantId, email, password, role = 'user', display_name = '' }) {
    return await this.userStore.create({ tenantId, email, password, role, display_name });
  }

  async changePassword({ userId, oldPassword, newPassword }) {
    return await this.userStore.changePassword({ userId, oldPassword, newPassword });
  }

  supportsRegistration()    { return true; }
  supportsPasswordChange()  { return true; }

  describe() { return 'local (argon2id)'; }
}

export default LocalAuthProvider;
