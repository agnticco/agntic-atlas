/**
 * Point every durable path at a throwaway directory, so a test that boots the real
 * spine cannot collide with another one doing the same.
 *
 * ── Why this exists (measured 2026-08-14) ────────────────────────────────────
 *
 * `npm test` runs with `--test-concurrency=4`, and several suites boot a full
 * spine. `bootSpine()` opens SIXTEEN storage locations, and a test that overrode
 * only the obvious half — the auth, workflow and vector databases — silently left
 * the rest pointing at the shared `./memory/` of the working copy. Four spines then
 * opened the same SQLite files at once.
 *
 * The failure it produced was not an error message. On CI the whole test FILE was
 * cancelled before a single test in it ran (`cancelledByParent`, `duration_ms: 0`),
 * which reads like the tests failed when in fact they never started; locally it
 * showed up once as an inexplicable flake and passed on re-run. That is the worst
 * shape a test failure can take, because the obvious response — re-run it — makes
 * it go away without fixing anything.
 *
 * So: isolate ALL of them, from one list, and let every spine-booting suite import
 * that list rather than each remembering its own subset. A path added to
 * `bootSpine` in future needs adding HERE, once, instead of in every suite.
 *
 * Note the remaining hazard, deliberately not solved here: a few locations are
 * hardcoded rather than read from the environment (`./memory/backups`,
 * `./memory/converger`, `./memory/recordings`). `DB_BACKUP_KEEP=0` disables the
 * only one of those that writes during a plain boot. If a suite ever starts
 * contending on the other two, they need an env var before they can be isolated.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every storage path `bootSpine()` will read from the environment. */
const PATHS = {
  WORKFLOWS_DB:           'workflows.sqlite',
  IDEMPOTENCY_DB:         'idempotency.sqlite',
  SOURCES_DB:             'sources.sqlite',
  INTERACTIONS_DB:        'interactions.sqlite',
  INBOX_DB:               'inbox.sqlite',
  APPROVALS_DB:           'approvals.sqlite',
  TICKETS_DB:             'tickets.sqlite',
  BILLING_EVENTS_DB:      'billing-events.sqlite',
  AUTH_DB:                'auth.sqlite',
  OAUTH_DB:               'oauth.sqlite',
  AUTH_SECRET:            '.jwt-secret',
  OAUTH_KEY:              '.oauth-key',
  VECTOR_DIR:             'vectors',
  KNOWLEDGE_DIR:          'knowledge',
  TICKETS_DIR:            'tickets',
  AIRTABLE_WEBHOOKS_FILE: 'airtable-webhooks.json',
  WEB_DISABLED_FILE:      'web-disabled.json',
};

/**
 * Create a temp directory, point every path at it, and return a cleanup function.
 * Call from a `before` hook; call the returned function from `after`.
 *
 * @param {string} [label] short name, so a leftover directory says which suite made it
 * @returns {{ dir: string, cleanup: () => void }}
 */
export function isolateSpineStorage(label = 'suite') {
  const dir = mkdtempSync(join(tmpdir(), `atlas-${label}-`));
  for (const [envVar, leaf] of Object.entries(PATHS)) {
    process.env[envVar] = join(dir, leaf);
  }
  // Boot-time snapshots would copy every database on every spine start, which is
  // pure cost in a test and writes to a directory that is NOT overridable.
  process.env.DB_BACKUP_KEEP = '0';
  // Nothing in a test wants a scheduler tick firing workflows underneath it.
  process.env.SCHEDULER_ENABLED = 'false';

  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

/** The env var names, exported so a test can assert the list has not drifted. */
export const ISOLATED_PATH_VARS = Object.keys(PATHS);
