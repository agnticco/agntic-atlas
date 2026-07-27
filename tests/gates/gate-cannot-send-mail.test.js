/**
 * THE GATE CANNOT SEND REAL EMAIL — and it is true by construction, not by luck.
 *
 * ── What was actually wrong ──────────────────────────────────────────────────
 *
 * "No gate step sends mail" used to be an unenforced accident of which invocation
 * happened to carry `--env-file`. `scripts/checks/approval-adversarial.mjs` (P12
 * increment D) boots the REAL server and parks two runs on a `human` node whose
 * channels are `[{inbox}, {email, to: 'ops@acme.test'}]`; `deliverAsk` dispatches
 * every declared channel, so it reaches the real mailer on every run. Measured
 * 2026-07-27 against a local SMTP catcher: with mail credentials present, TWO
 * approval emails are delivered — each carrying a live single-use approval magic
 * link — and the check still prints APPROVAL-ADVERSARIAL-PASS and exits 0, because
 * `Promise.allSettled` swallows the result either way. Silent, and green.
 *
 * The protection is `scripts/gates/_no-mail.sh`: sourced by `scripts/gate.sh` and
 * by every gate that loads .env, it exports the mail credentials EMPTY, which
 * beats the .env file (measured: Node v22 does not let `--env-file` overwrite a
 * variable already in the environment, and an empty string counts as present).
 *
 * ── This suite is GATE-BOUND on purpose ─────────────────────────────────────
 *
 * It asserts a property of the environment the gate establishes, so it is RED when
 * run outside the gate. That is the point: it must fail the moment the protection
 * is absent. Run it the way the gate does:
 *
 *     bash scripts/gate.sh 12          (or 13)
 *
 * Nothing here ever sends anything. Every credential below is fabricated and
 * syntactically invalid; the mailer is only ever ASKED which mode it would pick.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mailerConfigured } from '../../src/utils/mailer.js';

const MAILER_URL = new URL('../../src/utils/mailer.js', import.meta.url).href;

/** Every environment variable that can switch a real sender on (mailer.js `mode()`). */
const MAIL_VARS = [
  'RESEND_API_KEY', 'MAIL_FROM',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'GMAIL_SA_KEY_FILE', 'GMAIL_SA_CLIENT_EMAIL', 'GMAIL_SA_PRIVATE_KEY', 'GMAIL_SEND_AS',
];

/** Fabricated, invalid, and never sent anywhere. */
const FAKE_ENV_FILE = [
  'RESEND_API_KEY=re_FAKE_gate_test_never_valid_000',
  'MAIL_FROM=Atlas Gate Test <nobody@invalid.example>',
  'SMTP_HOST=smtp.invalid.example',
  'SMTP_PORT=587',
  'SMTP_USER=nobody',
  'SMTP_PASS=nothing',
  'GMAIL_SEND_AS=nobody@invalid.example',
  'ANTHROPIC_API_KEY=sk-ant-FAKE-gate-test-000',
  '',
].join('\n');

const FAKE_ANTHROPIC = 'sk-ant-FAKE-gate-test-000';

// The child asks the real mailer which mode it would choose. It never sends.
const PROBE = `
import(${JSON.stringify(MAILER_URL)}).then((m) => {
  console.log(JSON.stringify({
    mailerConfigured: m.mailerConfigured(),
    resend:    process.env.RESEND_API_KEY    ?? null,
    smtpHost:  process.env.SMTP_HOST         ?? null,
    gmailAs:   process.env.GMAIL_SEND_AS     ?? null,
    anthropic: process.env.ANTHROPIC_API_KEY ?? null,
  }));
});
`;

/**
 * Spawn a child EXACTLY the way a gate step is spawned — `node
 * --env-file-if-exists=<file>` inheriting this process's environment — so the
 * check is configured the way production is. `envOverrides` with a value of
 * `undefined` deletes the variable from the child's inherited environment.
 */
function gateChild({ envFile = FAKE_ENV_FILE, envOverrides = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-gate-nomail-'));
  const file = join(dir, '.env');
  writeFileSync(file, envFile);

  const env = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  try {
    const out = execFileSync(
      process.execPath,
      [`--env-file-if-exists=${file}`, '--input-type=module', '-e', PROBE],
      { encoding: 'utf8', env, cwd: fileURLToPath(new URL('../..', import.meta.url)) },
    );
    const line = out.trim().split('\n').filter(Boolean).pop();
    return JSON.parse(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

test('this process — which IS a gate-spawned child — cannot send real email', () => {
  assert.equal(
    mailerConfigured(), false,
    'mailerConfigured() is TRUE inside a gate-run test process. A gate step that '
    + 'reaches the mailer will email real people. Source scripts/gates/_no-mail.sh '
    + 'from the gate script that started this run — do not delete this assertion.',
  );
});

test('no mail credential survives into a gate-run test process', () => {
  const live = MAIL_VARS.filter((k) => (process.env[k] ?? '').trim() !== '');
  assert.deepEqual(
    live, [],
    `these mail credentials reached a gate child: ${live.join(', ')}. `
    + 'scripts/gates/_no-mail.sh must export them empty.',
  );
});

test('a fabricated mail credential in the gate\'s env FILE cannot switch the mailer on', () => {
  // This is the load-bearing one on a machine with no .env: it supplies the
  // credential itself, so the protection is exercised rather than assumed.
  const r = gateChild();
  assert.equal(r.mailerConfigured, false,
    'a child spawned the way the gate spawns them picked up a mail credential from '
    + 'its env file and would send real email');
  assert.equal((r.resend ?? '').trim(), '', 'RESEND_API_KEY leaked in from the env file');
  assert.equal((r.smtpHost ?? '').trim(), '', 'SMTP_HOST leaked in from the env file');
  assert.equal((r.gmailAs ?? '').trim(), '', 'GMAIL_SEND_AS leaked in from the env file');
});

test('the fixture is LIVE — the same env file does switch the mailer on unprotected', () => {
  // Anti-vacuity. Without this, the test above would keep passing if the
  // fabricated credential ever stopped being a credential the mailer recognises,
  // and would then be proving nothing at all.
  const unprotected = Object.fromEntries(MAIL_VARS.map((k) => [k, undefined]));
  const r = gateChild({ envOverrides: unprotected });
  assert.equal(r.mailerConfigured, true,
    'the fabricated credential no longer turns the mailer on, so the protection '
    + 'test above is vacuous. Update FAKE_ENV_FILE to match mailer.js mode().');
  assert.equal(r.resend, 're_FAKE_gate_test_never_valid_000');
});

test('ANTHROPIC_API_KEY still reaches a gate-run child — the gate\'s reason for loading .env survives', () => {
  // tests/e2e/full-journey.test.js SELF-SKIPS the converger test without this key
  // and the gate then passes on a suite that did not test the thing under test.
  // That is how P11 was nearly closed on a false pass, so the lockout above must
  // be targeted at mail and nothing else.
  const r = gateChild({ envOverrides: { ANTHROPIC_API_KEY: undefined } });
  assert.equal(r.anthropic, FAKE_ANTHROPIC,
    'the env file no longer delivers ANTHROPIC_API_KEY to a gate child — the mail '
    + 'lockout has become a blanket wipe and the converger test will self-skip');
  assert.equal(r.mailerConfigured, false, 'and mail is still off in that same child');
});
