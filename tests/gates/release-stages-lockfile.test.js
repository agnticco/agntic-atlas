/**
 * A RELEASE MUST NOT LEAVE THE REPOSITORY DISAGREEING WITH ITSELF ABOUT ITS VERSION.
 *
 * `scripts/release.sh` runs `npm version`, which rewrites the version in BOTH
 * `package.json` and `package-lock.json`. It used to `git add` only the first, so
 * every release left the lockfile's new version unstaged in the working tree.
 *
 * Measured on 2026-07-27: the committed lockfile said **1.6.36** while the
 * committed `package.json` said **1.6.42** — six releases of drift — and the gap
 * had to be closed by hand on three consecutive releases that day.
 *
 * This was never a broken deploy: `npm ci` does not fail on that mismatch,
 * verified against exactly what was on `origin/main` (345 packages, clean). It is
 * a repository that quietly contradicts itself, which is the kind of thing
 * somebody later loses an hour to.
 *
 * WHY THIS SHAPE. The script does `cd "$(dirname "$0")/.."` — it always operates
 * on ITS OWN parent directory, never on the caller's cwd. So the only honest way
 * to test it is to build a throwaway git repository with the same shape
 * (`<tmp>/scripts/release.sh`, `<tmp>/package.json`, `<tmp>/package-lock.json`)
 * and run the REAL script inside it. It never touches this repository, and it
 * would have caught the drift the day it started.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_SCRIPT = path.join(ROOT, 'scripts/release.sh');

let dir;
const sh = (cmd, args, cwd = dir) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A throwaway repo shaped like Atlas, carrying a COPY of the real script. */
function makeRepo(version = '1.0.0') {
  const d = mkdtempSync(path.join(tmpdir(), 'atlas-release-'));
  mkdirSync(path.join(d, 'scripts'));
  copyFileSync(REAL_SCRIPT, path.join(d, 'scripts/release.sh'));
  writeFileSync(path.join(d, 'package.json'),
    JSON.stringify({ name: 'atlas', version, private: true }, null, 2) + '\n');
  // The two places npm keeps the version, exactly as the real lockfile does.
  writeFileSync(path.join(d, 'package-lock.json'),
    JSON.stringify({
      name: 'atlas', version, lockfileVersion: 3, requires: true,
      packages: { '': { name: 'atlas', version } },
    }, null, 2) + '\n');
  sh('git', ['init', '-q'], d);
  sh('git', ['config', 'user.email', 'test@example.com'], d);
  sh('git', ['config', 'user.name', 'Test'], d);
  sh('git', ['add', '.'], d);
  sh('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init', '--no-verify'], d);
  return d;
}

/** Paths git reports as STAGED (index differs from HEAD). */
const staged = () =>
  sh('git', ['diff', '--cached', '--name-only']).split('\n').map(s => s.trim()).filter(Boolean);

const versionOf = (file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8')).version;

describe('release.sh stages the lockfile it just rewrote', () => {
  before(() => { dir = makeRepo('1.0.0'); });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('a silent bump stages BOTH manifests', () => {
    sh('bash', ['scripts/release.sh', 'patch']);

    assert.equal(versionOf('package.json'), '1.0.1', 'npm version did not bump package.json');
    assert.equal(versionOf('package-lock.json'), '1.0.1',
      'npm version did not bump the lockfile — the premise of this test is gone, re-check it');

    const s = staged();
    assert.ok(s.includes('package.json'), `package.json not staged; staged: ${s.join(', ')}`);
    assert.ok(s.includes('package-lock.json'),
      `THE DEFECT: the lockfile was rewritten but left unstaged; staged: ${s.join(', ')}`);
  });

  test('nothing is left behind in the working tree', () => {
    // The whole point: after the script runs, a plain `git commit` must capture
    // every file it changed. Anything unstaged here is drift waiting to happen.
    const unstaged = sh('git', ['diff', '--name-only']).split('\n').map(x => x.trim()).filter(Boolean);
    assert.deepEqual(unstaged, [],
      `release.sh changed files it did not stage: ${unstaged.join(', ')}`);
  });

  test('the two manifests agree after a commit — the drift is actually closed', () => {
    sh('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'release', '--no-verify']);
    const pkg = JSON.parse(sh('git', ['show', 'HEAD:package.json']));
    const lock = JSON.parse(sh('git', ['show', 'HEAD:package-lock.json']));
    assert.equal(pkg.version, lock.version,
      'committed package.json and package-lock.json disagree about the version');
    assert.equal(lock.packages[''].version, pkg.version,
      "the lockfile's inner packages[''] version drifted from package.json");
  });
});

describe('the notes path stages it too — both branches, not just the one in use', () => {
  let d2;
  before(() => { d2 = makeRepo('2.0.0'); });
  after(() => { if (d2) rmSync(d2, { recursive: true, force: true }); });

  test('a bump WITH release notes stages the lockfile as well', () => {
    sh('bash', ['scripts/release.sh', 'patch', '--title', 'A title', 'A note.'], d2);
    const s = sh('git', ['diff', '--cached', '--name-only'], d2)
      .split('\n').map(x => x.trim()).filter(Boolean);
    assert.ok(s.includes('package.json'), `staged: ${s.join(', ')}`);
    assert.ok(s.includes('release-notes.json'), `staged: ${s.join(', ')}`);
    assert.ok(s.includes('package-lock.json'),
      `the notes branch left the lockfile unstaged; staged: ${s.join(', ')}`);
  });
});
