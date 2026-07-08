# Atlas Update / Deploy Protocol

How a code change gets from your machine to production (`atlas.agntic.co`) safely
and repeatably. Pairs with [`vps-runbook.md`](./vps-runbook.md) (first-time setup)
and `scripts/deploy.sh` (the deploy command on the box).

## The loop

```
 develop → commit → push → deploy on VPS → verify → (rollback if needed)
```

### 1. Develop locally
Make the change and test it. For anything with a check/test, run it:
```bash
node --test tests/e2e/connectors.test.js      # or the relevant suite
node --test tests/e2e/full-journey.test.js
```

### 2. Commit
Branch off `main`, conventional-commit message with a `Phase:` trailer (the
commit-msg hook enforces this). Merge to `main`.
```bash
git checkout -b feat/<slug>
git add <files> && git commit          # <type>(<scope>): <subject>  +  Phase: <N>
git checkout main && git merge --no-edit feat/<slug>
```

### 3. Push
```bash
git push origin main
```
The pre-push hook blocks any commit carrying a `Gate:` trailer unless that phase's
check passes — so a broken gate physically can't ship.

**If the push is rejected** (`! [rejected] ... fetch first`) a parallel session
pushed to `main` first. Integrate before pushing — never force:
```bash
git pull --rebase origin main    # replay your commits on top; resolve any conflict
git push origin main
```

### 4. Deploy on the VPS
The live box is **AWS Lightsail, static IP `32.198.159.147`**. You log in as
`ubuntu` (Lightsail's default SSH user); the app runs as the `atlas` service
account under `/home/atlas/atlas`. So you SSH as `ubuntu` and `sudo -u atlas` to
run the deploy. One line, no interactive shell needed:
```bash
ssh ubuntu@32.198.159.147 'sudo -u atlas -H bash -c "cd /home/atlas/atlas && ./scripts/deploy.sh"'
```
(There is no `atlas` SSH login — don't try `ssh atlas@…`. To poke around
interactively: `ssh ubuntu@32.198.159.147`, then `sudo -u atlas -H bash`.)

`deploy.sh` is idempotent and self-verifying: it `git pull --ff-only`s `main`,
runs `npm ci`, `sudo systemctl restart atlas`, then polls `/health` for 30s. On
failure it prints the exact rollback command. If `main` hasn't moved it no-ops.

### 5. Verify
Deploy isn't "done" until the running process serves the new code:
```bash
curl -s https://atlas.agntic.co/health          # {"status":"ok",...}
PROD_HOST=atlas.agntic.co node scripts/checks/p11-smoke.mjs
```
Then eyeball the actual change in the browser (hard-refresh for frontend edits).
**A result from a process that booted before the change landed is not a result** —
`deploy.sh` restarts the service, so this is handled, but never skip the eyeball.

### 6. Rollback (if verify fails)
```bash
cd ~/atlas
git checkout <previous-sha>     # deploy.sh prints this SHA on failure
npm ci && sudo systemctl restart atlas
```
The boot snapshot in `./memory/backups/<timestamp>/` from the failed boot lets you
restore the SQLite DBs if a schema migration misbehaved (stop service, copy files
back, restart).

## Versioning & What's New

Every production release bumps the app version (`package.json` — the single source
of truth, surfaced in `/health` and the What's-New feature). Use `scripts/release.sh`
as part of step 2:

```bash
./scripts/release.sh patch                                 # silent bump (internal fix)
./scripts/release.sh minor "We sped up scheduled runs."    # bump + a user-facing note
```

- **User-facing change?** Pass one or more notes — they become a **What's New**
  entry in `release-notes.json`, shown once to each user on their next login after
  the deploy (tracked per-user by `last_seen_version`; brand-new users are marked
  caught-up so they don't see a backlog).
- **Internal-only change?** Bump with no notes — the version still moves, but no
  modal is shown.
- Write notes in **plain, benefit-first language** ("We sped up runs", not "refactored
  the scheduler"). Keep to 1–3 bullets.
- The version bump + notes get committed with the change, so the release is atomic:
  the code and its announcement ship together.

## Special cases

- **Frontend-only change** (e.g. `public/index.html`): still deploy via
  `deploy.sh` for uniformity; a browser **hard-refresh** shows the new UI. The
  service restart also clears any in-memory template cache.
- **`.env` / secret change**: edit `~/atlas/.env` **on the box** (it's gitignored,
  never in git), then `sudo systemctl restart atlas`. No `git pull` needed.
- **New connector / OAuth app**: add its creds to `.env`, restart, then register
  the redirect URL (`https://atlas.agntic.co/connectors/<id>/callback`) in the
  provider console.
- **Dependency change** (`package.json`): `deploy.sh` runs `npm ci`, so it's
  covered — just make sure `package-lock.json` was committed.
- **Downtime**: single-node, so a restart is a ~2–3s blip (SIGTERM drains
  in-flight runs first). Fine for the pilot. The scale-out / zero-downtime path is
  in [`../architecture/scaling.md`](../architecture/scaling.md).

## Cadence

- **Routine changes:** deploy any time — the blip is negligible and runs self-heal.
- **Schema migrations / risky changes:** deploy when traffic is low; confirm the
  boot snapshot exists (`ls ~/atlas/memory/backups/`) before and keep the rollback
  SHA handy.
- **Always** finish with step 5. An unverified deploy is an outage waiting to be
  discovered by a customer instead of by you.
