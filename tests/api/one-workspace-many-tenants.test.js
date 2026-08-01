/**
 * A SLACK WORKSPACE CONNECTED BY TWO TENANTS MUST REACH BOTH, NOT WHICHEVER ONE CAME BACK
 * FIRST.
 *
 * WITNESSED 2026-08-01, on prod, while diagnosing why no Slack trigger had ever fired.
 * The workspace `T0B3RTT3Z5X` is installed on BOTH `agntic` (11 July) and `platform`
 * (26 July). Tenant resolution was:
 *
 *     SELECT tenant_id FROM oauth_tokens WHERE connector_id = ? AND account = ? LIMIT 1
 *
 * …which returned `agntic`. The only live Slack-triggered workflow —
 * *"When a message containing 'urgent' is posted…"* — lived in `platform`.
 *
 * So every inbound event would have been matched against the WRONG tenant's workflows,
 * found nothing, and returned silently. This is a SECOND, independent reason for the
 * symptom the operator was already chasing: had the Slack console been corrected first,
 * the test would still have produced nothing and the config fix would have looked wrong.
 *
 * `LIMIT 1` on a key that legitimately has several rows is the silent-fallback shape this
 * codebase records repeatedly — an arbitrary answer to a question with more than one.
 *
 * ── WHY DISPATCHING TO ALL OF THEM IS NOT A LEAK ─────────────────────────────
 * Each of those tenants ran the OAuth flow and authorised the app against that workspace,
 * so an event from it is genuinely theirs. Each is dispatched against its OWN workflows
 * with its OWN token; neither sees anything belonging to the other. That property is
 * asserted below rather than assumed, because it is the one that would matter if it were
 * ever wrong.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { OAuthTokenStore } from '../../src/auth/oauth-token-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TEAM = 'T0B3RTT3Z5X';
let dir, db, store;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'atlas-oauth-'));
  db = new Database(path.join(dir, 'oauth.sqlite'));
  store = new OAuthTokenStore({ db });
  await store.init?.();
  // The prod shape, in install order: agntic first, platform second.
  const put = (tenantId, userId, createdAt) => db.prepare(
    `INSERT INTO oauth_tokens (user_id, tenant_id, connector_id, access_token_enc, refresh_token_enc, scope, expiry, account, created_at, updated_at)
     VALUES (?, ?, 'slack', 'x', NULL, 'chat:write', 0, ?, ?, ?)`,
  ).run(userId, tenantId, TEAM, createdAt, createdAt);
  // INSERTED IN THE OPPOSITE ORDER TO THEIR INSTALL DATES, on purpose: with rows added
  // in timestamp order the `ORDER BY` cannot be observed to do anything, and a mutation
  // removing it survived. Now insert order and install order disagree, so only the sort
  // produces the deterministic answer the dispatcher relies on.
  put('platform', 'wsinstall:platform', 1785252256454);   // installed SECOND, written first
  put('agntic',   'wsinstall:agntic',   1783908252938);   // installed FIRST,  written second
});

after(() => { try { db?.close(); rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('THE PROD CASE — one workspace, two tenants', () => {
  test('BOTH tenants are returned, not one', () => {
    const found = store.findTenantsByAccount({ connectorId: 'slack', account: TEAM });
    assert.deepEqual(found, ['agntic', 'platform'],
      'a workspace installed twice resolved to fewer tenants than installed it');
  });

  test('the order is INSTALL order, not alphabetical and not insert order', () => {
    /**
     * Deterministic dispatch order matters: an order that varies between runs is a bug
     * that only shows up in production.
     *
     * This needs its own workspace, and mutation is why. With `agntic` and `platform` the
     * sort is invisible — `GROUP BY` already returns them alphabetically and that happens
     * to match install order, so dropping the `ORDER BY` changed nothing. Here the two
     * orders DISAGREE, so only the sort can produce the right answer.
     */
    const OTHER = 'TOTHERWS';
    const put = (tenantId, createdAt) => db.prepare(
      `INSERT INTO oauth_tokens (user_id, tenant_id, connector_id, access_token_enc, refresh_token_enc, scope, expiry, account, created_at, updated_at)
       VALUES (?, ?, 'slack', 'x', NULL, 'chat:write', 0, ?, ?, ?)`,
    ).run(`wsinstall:${tenantId}`, tenantId, OTHER, createdAt, createdAt);
    put('zeta-co', 1000);        // installed FIRST,  sorts LAST alphabetically
    put('alpha-co', 2000);       // installed SECOND, sorts FIRST alphabetically
    assert.deepEqual(store.findTenantsByAccount({ connectorId: 'slack', account: OTHER }),
      ['zeta-co', 'alpha-co'],
      'tenants came back in alphabetical or insert order rather than install order');
  });

  test('the SINGULAR lookup still returns the first — and that is exactly the trap', () => {
    // Kept for callers that only ask "is this account known at all". Anything that ACTS
    // on the answer must use the plural; this assertion documents why.
    assert.equal(store.findTenantByAccount({ connectorId: 'slack', account: TEAM }), 'agntic');
  });

  test('an unknown workspace resolves to nothing at all', () => {
    assert.deepEqual(store.findTenantsByAccount({ connectorId: 'slack', account: 'TNOPE' }), []);
    assert.equal(store.findTenantByAccount({ connectorId: 'slack', account: 'TNOPE' }), null);
  });

  test('a different connector on the same account id is not confused with Slack', () => {
    assert.deepEqual(store.findTenantsByAccount({ connectorId: 'airtable', account: TEAM }), []);
  });

  test('missing arguments resolve to nothing rather than to everything', () => {
    /**
     * Asserts the PROPERTY, not the mechanism — and the early return that appears to
     * provide it is belt-and-braces. Mutation showed this is unkillable: the query binds
     * the missing value as NULL, and `account = NULL` is never true in SQL, so no row can
     * match either way. Recorded rather than contrived into a kill, and the guard is kept
     * because it states the intent and saves a pointless query.
     */
    for (const args of [{}, { connectorId: 'slack' }, { account: TEAM }, { connectorId: '', account: '' }]) {
      assert.deepEqual(store.findTenantsByAccount(args), [], JSON.stringify(args));
    }
  });

  test('one tenant with several rows is listed ONCE', () => {
    // A re-install writes another row for the same tenant. Returning it twice would
    // dispatch the same event to the same workflows twice — a duplicate run, which for a
    // workflow that sends email is a real-world duplicate message.
    db.prepare(
      `INSERT INTO oauth_tokens (user_id, tenant_id, connector_id, access_token_enc, refresh_token_enc, scope, expiry, account, created_at, updated_at)
       VALUES ('wsinstall:agntic-2', 'agntic', 'slack', 'x', NULL, 'chat:write', 0, ?, ?, ?)`,
    ).run(TEAM, 1785300000000, 1785300000000);
    const found = store.findTenantsByAccount({ connectorId: 'slack', account: TEAM });
    assert.deepEqual(found, ['agntic', 'platform'], 'a re-installed tenant would receive every event twice');
  });
});

describe('both Slack paths use the plural lookup', () => {
  /** SOURCE-level, and weaker than the rest — both close over the request/response. */
  const SRC = readFileSync(path.join(ROOT, 'src/api/server.js'), 'utf8');

  test('the EVENT path dispatches to every tenant that installed the workspace', () => {
    const at = SRC.indexOf('async function dispatchSlackEvent(');
    assert.ok(at > 0, 're-point this test');
    const body = SRC.slice(at, at + 1400);
    assert.match(body, /findTenantsByAccount/, 'the event path still picks one tenant arbitrarily');
    assert.match(body, /for \(const tenantId of tenants\)/);
  });

  test('the APPROVAL BUTTON path asks each tenant until one owns the run', () => {
    const at = SRC.indexOf("logEvent('approval.slack.no_tenant'");
    assert.ok(at > 0, 're-point this test');
    const body = SRC.slice(at - 900, at + 1200);
    assert.match(body, /findTenantsByAccount/, 'an approval click can still land on the wrong tenant');
    assert.match(body, /if \(r\?\.ok\)/, 'it must keep the first ANSWER, not the first attempt');
  });

  test('nothing that ACTS on the result uses the singular lookup any more', () => {
    // The singular one survives for "is this known at all"; a caller that dispatches,
    // resolves or executes on it is the defect coming back.
    const acting = SRC.split('\n').filter(l =>
      /findTenantByAccount/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    for (const line of acting) {
      assert.match(line, /recordSlackEventSeen|tid\b/,
        `a path that acts on one arbitrary tenant is back: ${line.trim()}`);
    }
  });
});
