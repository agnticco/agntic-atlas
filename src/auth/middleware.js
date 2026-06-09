/**
 * Auth middleware — populates req.user / req.session, or rejects with 401/403.
 *
 * Token transport: accepts EITHER an HTTP-only `session` cookie OR an
 * `Authorization: Bearer <jwt>` header. The same JWT works in both — the
 * cookie path serves the browser, the bearer path serves the future
 * native app and CLI tools. See docs/multi-user-architecture.md §5.2.
 *
 * @module src/auth/middleware.js
 */

const COOKIE_NAME = 'session';

/**
 * Build the requireAuth + requireAdmin middlewares.
 *
 * The middlewares are constructed against concrete stores so server.js can
 * keep wiring lightweight; the same factory is reused by tests.
 *
 * @param {object} deps
 * @param {import('./token-service.js').TokenService} deps.tokenService
 * @param {import('./session-store.js').SessionStore} deps.sessionStore
 * @param {import('./user-store.js').UserStore}       deps.userStore
 */
export function buildAuthMiddleware({ tokenService, sessionStore, userStore }) {
  if (!tokenService || !sessionStore || !userStore) {
    throw new Error('buildAuthMiddleware requires tokenService, sessionStore, userStore');
  }

  /** Pull the JWT from cookie first, then bearer. */
  function extractToken(req) {
    const cookie = req.cookies?.[COOKIE_NAME];
    if (cookie) return cookie;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
    return null;
  }

  /**
   * Verify the request and resolve the caller. Returns null on any failure
   * — middleware translates that to 401 with a uniform body so failure
   * modes don't leak (was the token bad? was the session revoked? was the
   * user disabled? all look the same to the client).
   */
  async function authenticate(req) {
    const token = extractToken(req);
    if (!token) return null;

    const claims = tokenService.verify(token);
    if (!claims?.sub || !claims?.jti) return null;

    const session = sessionStore.touch(claims.jti);
    if (!session) return null;
    if (session.user_id !== claims.sub) return null;

    const user = userStore.findById(claims.sub);
    if (!user || user.disabled_at) return null;

    return { user, session };
  }

  /** Express middleware: require a valid session. */
  async function requireAuth(req, res, next) {
    try {
      const ctx = await authenticate(req);
      if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
      req.user    = ctx.user;
      req.session = ctx.session;
      next();
    } catch (err) {
      // Don't expose internal failures — log + 401.
      // eslint-disable-next-line no-console
      console.warn(`[auth] middleware error: ${err.message}`);
      res.status(401).json({ error: 'Unauthorized' });
    }
  }

  /** Express middleware: require role=admin. Run AFTER requireAuth. */
  function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  }

  /**
   * Optional auth — if a valid session is present it populates req.user;
   * otherwise it lets the request through anonymously. Useful for the
   * /setup/status endpoint where the caller might be authed (admin) or not
   * (first-run visitor).
   */
  async function optionalAuth(req, _res, next) {
    try {
      const ctx = await authenticate(req);
      if (ctx) { req.user = ctx.user; req.session = ctx.session; }
    } catch { /* swallow; treat as anonymous */ }
    next();
  }

  return { requireAuth, requireAdmin, optionalAuth, authenticate, COOKIE_NAME };
}

export { COOKIE_NAME };
export default buildAuthMiddleware;
