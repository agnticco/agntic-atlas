/**
 * THE GATE CANNOT SEND REAL EMAIL — and it is true by construction, not by luck.
 *
 * ── What was actually wrong ──────────────────────────────────────────────────
 *
 * "No gate step sends mail" used to be an unenforced accident of which invocation
 * happened to carry `--env-file`. `scripts/checks/approval-adversarial.mjs` (P12
 * increment D) boots the REAL server and parks two runs on a `human` node whose
 * channels are `[{inbox}, {email, to: 'ops@acme.test'}]`; `deliverAsk` dispatches
 * every declared channel, so it reaches the real mailer on every run. With mail
 * credentials present, TWO approval messages are dispatched — each carrying a live
 * single-use approval magic link — and the check still prints
 * APPROVAL-ADVERSARIAL-PASS and exits 0, because `Promise.allSettled` swallows the
 * result either way. Silent, and green.
 *
 * The protection is `scripts/gates/_no-mail.sh`: sourced by `scripts/gate.sh` and
 * by every runnable gate script, it exports the mail credentials EMPTY, which
 * beats the .env file (Node v22 does not let `--env-file` overwrite a variable
 * already in the environment, and an empty string counts as present), and then
 * PROBES the mailer and refuses to start the gate if it is somehow still live.
 *
 * ── This suite is SELF-CONTAINED, on purpose ─────────────────────────────────
 *
 * It does NOT inspect the environment of the process running it, and it does not
 * care who invoked it. Every test BUILDS the gate's conditions itself — a
 * throwaway env file carrying a fabricated mail credential, a shell environment
 * carrying a fabricated mail credential, and a child spawned exactly the way a
 * gate step is spawned (`bash -c '. scripts/gates/_no-mail.sh; node
 * --env-file-if-exists=…'`) — and then asserts the outcome inside that child.
 *
 * So it gives the SAME verdict however it is run:
 *
 *     node --test tests/gates/gate-cannot-send-mail.test.js     ← green
 *     bash scripts/gate.sh 12    (or 13)                        ← green
 *     with or without a .env in the checkout                    ← green
 *
 * and it goes RED the moment the protection is weakened — including when it is run
 * standalone on a machine that has no credentials at all, which is exactly the
 * case the earlier, gate-bound version of this file could not cover: it inherited
 * the gate's environment instead of establishing it, so it passed vacuously where
 * there was nothing to find and failed where there was no gate.
 *
 * Every credential below is FABRICATED and syntactically invalid. Nothing here
 * ever sends anything: the mailer is only ever ASKED which mode it would pick
 * (`mailerConfigured()` reads process.env and returns a boolean — no network, no
 * send).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAILER_URL = new URL('../../src/utils/mailer.js', import.meta.url).href;

/** Every environment variable that can switch a real sender on (mailer.js `mode()`). */
const MAIL_VARS = [
  'RESEND_API_KEY', 'MAIL_FROM',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'GMAIL_SA_KEY_FILE', 'GMAIL_SA_CLIENT_EMAIL', 'GMAIL_SA_PRIVATE_KEY', 'GMAIL_SEND_AS',
];

/**
 * Fabricated, invalid, never sent anywhere — one value for every variable in
 * MAIL_VARS, so each line of the lockout's strip list is individually pinned.
 * GMAIL_SA_KEY_FILE deliberately names a path that does not exist: `mode()`
 * selects Resend before it ever looks, and the service-account loader falls back
 * rather than crashing if it does.
 */
const FAKE_MAIL = {
  RESEND_API_KEY:        're_FAKE_gate_test_never_valid_000',
  MAIL_FROM:             'Atlas Gate Test <nobody@invalid.example>',
  SMTP_HOST:             'smtp.invalid.example',
  SMTP_PORT:             '587',
  SMTP_USER:             'nobody',
  SMTP_PASS:             'nothing',
  GMAIL_SA_KEY_FILE:     '/nonexistent/atlas-gate-test/sa.json',
  GMAIL_SA_CLIENT_EMAIL: 'gate-test@invalid.example',
  GMAIL_SA_PRIVATE_KEY:  'NOT-A-KEY-gate-test-000',
  GMAIL_SEND_AS:         'nobody@invalid.example',
};

const FAKE_ANTHROPIC = 'sk-ant-FAKE-gate-test-000';

/**
 * The three sending modes `mode()` can select, and the smallest fabricated
 * credential set that selects each one. Each is asserted BOTH ways — off under
 * the lockout, ON without it — so no case can quietly stop being a credential.
 */
const SENDING_MODES = {
  resend: { RESEND_API_KEY: FAKE_MAIL.RESEND_API_KEY },
  smtp:   { SMTP_HOST: FAKE_MAIL.SMTP_HOST, SMTP_PORT: FAKE_MAIL.SMTP_PORT },
  'gmail-sa': {
    GMAIL_SA_CLIENT_EMAIL: FAKE_MAIL.GMAIL_SA_CLIENT_EMAIL,
    GMAIL_SA_PRIVATE_KEY:  FAKE_MAIL.GMAIL_SA_PRIVATE_KEY,
    GMAIL_SEND_AS:         FAKE_MAIL.GMAIL_SEND_AS,
  },
};

const PROBE_KEYS = [...MAIL_VARS, 'ANTHROPIC_API_KEY'];

/** The child asks the real mailer which mode it would choose. It never sends. */
const PROBE = `
import(${JSON.stringify(MAILER_URL)}).then((m) => {
  const env = {};
  for (const k of ${JSON.stringify(PROBE_KEYS)}) env[k] = process.env[k] ?? null;
  console.log('ATLAS_PROBE ' + JSON.stringify({ mailerConfigured: m.mailerConfigured(), env }));
});
`;

/** Render an env file the way a real .env is written. */
function envFileText(vars) {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

/**
 * Spawn a child EXACTLY the way a gate step is spawned: a bash process running at
 * the repo root that sources `scripts/gates/_no-mail.sh` and then runs
 * `node --env-file-if-exists=<file>`.
 *
 * The child's environment is SCRUBBED of every mail variable and of
 * ANTHROPIC_API_KEY before `shellEnv` is applied, so nothing this test observes
 * can have come from whoever invoked it. That is what makes the suite give the
 * same verdict standalone and under the gate, with or without a .env.
 *
 * @param {object}  opts
 * @param {object}  opts.envFile   vars written into the throwaway env file
 * @param {object}  opts.shellEnv  vars exported in the child's shell environment
 * @param {boolean} opts.lockout   whether to source _no-mail.sh (false = control)
 */
function gateChild({ envFile = {}, shellEnv = {}, lockout = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-gate-nomail-'));
  const file = join(dir, '.env');
  writeFileSync(file, envFileText(envFile));

  const env = { ...process.env };
  for (const k of PROBE_KEYS) delete env[k];       // no inheritance from the caller
  Object.assign(env, shellEnv);
  env.ATLAS_PROBE_ENV_FILE = file;
  env.ATLAS_PROBE_SRC = PROBE;

  // The script is a fixed string; the file path and the probe source reach bash
  // through the environment, so nothing is interpolated into shell syntax.
  const run = 'exec node --env-file-if-exists="$ATLAS_PROBE_ENV_FILE"'
    + ' --input-type=module -e "$ATLAS_PROBE_SRC"';
  const script = lockout ? `. scripts/gates/_no-mail.sh\n${run}` : run;

  try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8', env, cwd: REPO_ROOT });
    const line = out.split('\n').find((l) => l.startsWith('ATLAS_PROBE '));
    assert.ok(line, `the gate child produced no probe result; it said:\n${out}`);
    return JSON.parse(line.slice('ATLAS_PROBE '.length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The mail variables that arrived in the child carrying a non-empty value. */
function liveIn(result) {
  return MAIL_VARS.filter((k) => (result.env[k] ?? '').trim() !== '');
}

// ── The lockout blanks every mail credential, whichever way it arrives ───────

test('a mail credential in the gate\'s env FILE cannot reach a gate child', () => {
  const r = gateChild({ envFile: { ...FAKE_MAIL, ANTHROPIC_API_KEY: FAKE_ANTHROPIC } });
  assert.deepEqual(
    liveIn(r), [],
    'these mail credentials survived from the env file into a child spawned the '
    + 'way the gate spawns them. scripts/gates/_no-mail.sh must export every one '
    + 'of them empty — do not shorten that list.',
  );
  assert.equal(
    r.mailerConfigured, false,
    'a gate child picked up a mail credential from its env file and would send '
    + 'real email carrying live approval links.',
  );
});

test('a mail credential exported in the operator\'s SHELL cannot reach a gate child', () => {
  // The route a gate step takes when it is invoked WITHOUT --env-file: it simply
  // inherits whatever the operator has exported. approval-adversarial.mjs is
  // exactly such a step, which is why blanking has to beat inheritance too.
  const r = gateChild({ shellEnv: { ...FAKE_MAIL, ANTHROPIC_API_KEY: FAKE_ANTHROPIC } });
  assert.deepEqual(
    liveIn(r), [],
    'these mail credentials survived from the surrounding shell into a gate child.',
  );
  assert.equal(r.mailerConfigured, false, 'the gate child would send real email');
});

// ── Anti-vacuity: the fixtures really are credentials ───────────────────────

test('the env-file fixture is LIVE — without the lockout it does switch the mailer on', () => {
  const r = gateChild({ envFile: FAKE_MAIL, lockout: false });
  assert.deepEqual(
    liveIn(r).sort(), [...MAIL_VARS].sort(),
    'the env file no longer delivers every fabricated mail credential to the child, '
    + 'so the protection test above is not exercising what it claims to.',
  );
  assert.equal(
    r.mailerConfigured, true,
    'the fabricated credentials no longer turn the mailer on, so the protection '
    + 'test above is vacuous. Update FAKE_MAIL to match mode() in src/utils/mailer.js.',
  );
});

test('the shell fixture is LIVE — without the lockout it does switch the mailer on', () => {
  const r = gateChild({ shellEnv: FAKE_MAIL, lockout: false });
  assert.deepEqual(liveIn(r).sort(), [...MAIL_VARS].sort());
  assert.equal(
    r.mailerConfigured, true,
    'the fabricated shell credentials no longer turn the mailer on — the shell '
    + 'protection test above is vacuous.',
  );
});

// ── Every sending mode, both directions ─────────────────────────────────────

for (const [modeName, creds] of Object.entries(SENDING_MODES)) {
  test(`the '${modeName}' sending mode is switched ON by its own fixture and OFF by the lockout`, () => {
    const unprotected = gateChild({ envFile: creds, lockout: false });
    assert.equal(
      unprotected.mailerConfigured, true,
      `the fabricated '${modeName}' credentials no longer select a sending mode, so `
      + 'the protected case below would prove nothing. Reconcile SENDING_MODES with mode().',
    );

    const guarded = gateChild({ envFile: creds });
    assert.equal(
      guarded.mailerConfigured, false,
      `a gate child can still send via '${modeName}'. Every variable that selects `
      + 'this mode must be in the strip list in scripts/gates/_no-mail.sh.',
    );
  });
}

// ── The lockout's second half: it PROVES it, and refuses to run if it can't ──

/**
 * The strip list is the first line of defence; the probe in `_no-mail.sh` is the
 * second, and it is the one that matters when the first has quietly gone stale —
 * a new sending mode added to `mode()` in mailer.js and not to the strip list.
 *
 * Nothing else can exercise it: given a COMPLETE strip list the probe can never
 * fire, so a test that only ran the real file would leave it unpinned and a
 * mutation of it would survive. So this constructs the one scenario in which it
 * must fire — an incomplete strip list — by DERIVING a copy from the real file at
 * runtime with a single `export` line removed. The copy cannot drift from the
 * original, because it is generated from it on every run.
 */
test('the lockout REFUSES to start the gate when a credential survives its strip list', () => {
  const lockoutPath = join(REPO_ROOT, 'scripts/gates/_no-mail.sh');
  const real = readFileSync(lockoutPath, 'utf8');
  const holed = real.split('\n').filter((l) => !/^\s*export\s+RESEND_API_KEY=/.test(l)).join('\n');
  assert.notEqual(
    holed, real,
    'scripts/gates/_no-mail.sh has no `export RESEND_API_KEY=` line to remove — the '
    + 'strip list has changed shape and this test is no longer constructing a hole.',
  );

  const dir = mkdtempSync(join(tmpdir(), 'atlas-gate-nomail-holed-'));
  const file = join(dir, '_no-mail-with-a-hole.sh');
  writeFileSync(file, holed);

  const env = { ...process.env };
  for (const k of PROBE_KEYS) delete env[k];
  env.RESEND_API_KEY = FAKE_MAIL.RESEND_API_KEY;   // the credential the hole lets through
  env.ATLAS_HOLED_LOCKOUT = file;

  let refused = false;
  let output = '';
  try {
    output = execFileSync(
      'bash',
      ['-c', '. "$ATLAS_HOLED_LOCKOUT"\necho ATLAS_LOCKOUT_LET_THE_GATE_START'],
      { encoding: 'utf8', env, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    refused = true;
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(
    refused && !output.includes('ATLAS_LOCKOUT_LET_THE_GATE_START'),
    'the lockout let the gate start with a live mailer. Its probe — the `node -e '
    + 'mailerConfigured()` check at the bottom of scripts/gates/_no-mail.sh — is '
    + 'the only thing that catches a strip list that has gone stale against '
    + `mode() in mailer.js. It must exit non-zero. It said:\n${output}`,
  );
  assert.match(
    output, /GATE REFUSED TO RUN/,
    'the lockout exited non-zero but never said why; a gate that refuses without '
    + 'an explanation gets deleted by the next person who hits it.',
  );
});

// ── The lockout is targeted at mail, and is not a blanket wipe ──────────────

test('ANTHROPIC_API_KEY still reaches a gate child — the gate\'s reason for loading .env survives', () => {
  // tests/e2e/full-journey.test.js SELF-SKIPS the converger test without this key
  // and the gate then passes on a suite that did not test the thing under test.
  // That is how P11 was nearly closed on a false pass, so the lockout must strip
  // mail and nothing else. The key here is fabricated and supplied by this test,
  // so the assertion is load-bearing even in a checkout that has no .env at all.
  const r = gateChild({ envFile: { ...FAKE_MAIL, ANTHROPIC_API_KEY: FAKE_ANTHROPIC } });
  assert.equal(
    r.env.ANTHROPIC_API_KEY, FAKE_ANTHROPIC,
    'the env file no longer delivers ANTHROPIC_API_KEY to a gate child — the mail '
    + 'lockout has become a blanket wipe and the converger test will self-skip.',
  );
  assert.equal(r.mailerConfigured, false, 'and mail is still off in that same child');
});

// ── Wiring: nothing runnable in scripts/gates/ escapes the lockout ──────────

/**
 * The invariant it enforces is the one that actually matters: NO GATE SCRIPT MAY
 * SPAWN A NODE PROCESS WITHOUT THE LOCKOUT SOURCED FIRST. Stated that way it is
 * self-maintaining — a script that spawns nothing (p6.sh is scrapped and just
 * exits) needs no lockout, and the day it gains a `node` line this test fires.
 * Chained gate scripts (`p12.sh` runs `p3.sh`) are covered transitively, because
 * the callee is held to this same rule.
 *
 * Structural, not behavioural, and deliberately so: it READS each gate script
 * rather than running it, because running twenty gate scripts to find out would
 * boot servers and write to the operator's disk on every suite run. It is
 * stronger than "the string appears somewhere" — it checks ORDER. That the
 * lockout then works is proved behaviourally by every test above.
 */
test('no gate script spawns node without sourcing the mail lockout first', () => {
  const gatesDir = join(REPO_ROOT, 'scripts/gates');
  const scripts = [
    'scripts/gate.sh',
    ...readdirSync(gatesDir)
      .filter((f) => f.endsWith('.sh') && f !== '_no-mail.sh')
      .sort()
      .map((f) => `scripts/gates/${f}`),
  ];
  assert.ok(scripts.length > 1, 'found no gate scripts to check — the glob is wrong');

  const offenders = [];
  const spawners = [];
  for (const rel of scripts) {
    // Comments are blanked, not removed, so reported line numbers stay true.
    const code = readFileSync(join(REPO_ROOT, rel), 'utf8')
      .split('\n')
      .map((l) => (/^\s*#/.test(l) ? '' : l));
    const sourcedAt = code.findIndex((l) => /^\s*(\.|source)\s+scripts\/gates\/_no-mail\.sh\s*$/.test(l));
    const spawnsAt = code.findIndex((l) => /(^|[^A-Za-z0-9_./-])(node|npm|npx)[ \t]/.test(l));

    if (spawnsAt === -1) continue;               // spawns nothing — nothing to protect
    spawners.push(rel);
    if (sourcedAt === -1) {
      offenders.push(`${rel}: spawns node at line ${spawnsAt + 1} and never sources scripts/gates/_no-mail.sh`);
    } else if (sourcedAt > spawnsAt) {
      offenders.push(`${rel}: spawns node at line ${spawnsAt + 1}, before the lockout at line ${sourcedAt + 1}`);
    }
  }

  assert.deepEqual(
    offenders, [],
    'these gate scripts can be run directly (`bash <script>`), which bypasses '
    + 'scripts/gate.sh, and would hand a live mail credential to their children:\n  '
    + offenders.join('\n  '),
  );
  // Guard the guard: if the spawn detector ever stops matching, the loop above
  // would `continue` past every script and pass on an empty check.
  assert.ok(
    spawners.length >= 10,
    `only ${spawners.length} gate scripts were detected as spawning node — the `
    + 'detector has stopped matching and this test is checking nothing.',
  );
});
