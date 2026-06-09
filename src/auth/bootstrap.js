/**
 * Bootstrap — first-run admin creation flow.
 *
 * On server boot:
 *   - If any user exists, the bootstrap is a no-op (returns false).
 *   - Otherwise, a cryptographically random setup token is generated and
 *     printed to stderr inside a framed banner; its sha256 is stored in
 *     bootstrap_tokens.
 *
 * The setup endpoint accepts the token + admin credentials and creates the
 * first user. See docs/multi-user-architecture.md §5.5.
 *
 * @module src/auth/bootstrap.js
 */

/**
 * Ensure a bootstrap token exists if (and only if) no users are registered.
 * Idempotent across reboots: an unused, unexpired token is reused. A fresh
 * one is issued if none exists or the previous one expired.
 *
 * @param {object} deps
 * @param {import('./user-store.js').UserStore}    deps.userStore
 * @param {import('./session-store.js').SessionStore} deps.sessionStore
 * @returns {{ required: boolean, token: string|null }}
 */
export function ensureBootstrap({ userStore, sessionStore }) {
  if (userStore.count() > 0) {
    sessionStore.pruneBootstrapTokens();
    return { required: false, token: null };
  }

  sessionStore.pruneBootstrapTokens();
  if (sessionStore.hasActiveBootstrapToken()) {
    // We stored only the hash; caller can't retrieve the raw token after
    // restart. Issue a fresh one so the banner always matches reality.
    const token = sessionStore.createBootstrapToken();
    printSetupBanner(token);
    return { required: true, token };
  }

  const token = sessionStore.createBootstrapToken();
  printSetupBanner(token);
  return { required: true, token };
}

/**
 * Consume a setup token + create the first admin in one atomic operation.
 * Returns the new user on success; throws on invalid token, duplicate user,
 * or validation failure.
 *
 * @param {object} deps
 * @param {import('./user-store.js').UserStore}       deps.userStore
 * @param {import('./session-store.js').SessionStore} deps.sessionStore
 * @param {import('./auth-provider.js').AuthProvider} deps.authProvider
 * @param {object} input
 * @param {string} input.token
 * @param {string} input.email
 * @param {string} input.password
 * @param {string} [input.display_name]
 */
export async function completeBootstrap(
  { userStore, sessionStore, authProvider },
  { token, email, password, display_name = '' },
) {
  if (userStore.count() > 0) {
    throw new Error('Bootstrap already completed — an admin account exists.');
  }
  const consumed = sessionStore.consumeBootstrapToken(token);
  if (!consumed) {
    throw new Error('Setup token is invalid, already used, or expired.');
  }
  // Any validation failure past this point leaves the token consumed — which
  // is fine: the operator can restart the server to get a fresh one. This
  // prevents a race where two concurrent submissions both pass validation.
  const user = await authProvider.register({
    email, password, role: 'admin', display_name,
  });
  return user;
}

// ═══════════════════════════════════════════════════════════════════════════
// banner
// ═══════════════════════════════════════════════════════════════════════════

function printSetupBanner(token) {
  const line = '═'.repeat(68);
  const lines = [
    '',
    line,
    ' AGNTIC — FIRST RUN',
    '',
    ' No admin account exists yet. Open the UI and paste this one-time',
    ' setup token to create the first admin:',
    '',
    `   ${token}`,
    '',
    ' This token is valid for 24 hours and can only be used once.',
    line,
    '',
  ];
  // stderr so it's visible even when stdout is piped to a file.
  for (const l of lines) process.stderr.write(l + '\n');
}

export default { ensureBootstrap, completeBootstrap };
