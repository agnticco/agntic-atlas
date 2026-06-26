# Atlas VPS Deployment Runbook

Produces a clean Atlas production environment from scratch on a single VPS,
fronted by a Cloudflare Tunnel. Single Node process + SQLite (see
[`../architecture/scaling.md`](../architecture/scaling.md) for the scale-out path).

## 0. Prerequisites
- A VPS (Ubuntu 22.04+, ≥2 vCPU / 2 GB RAM), SSH access.
- A domain on Cloudflare (here: `atlas.agntic.co`).
- An Anthropic API key; OAuth client credentials for the connectors you enable
  (Slack, Google, Airtable).

## 1. Base hardening
```bash
adduser atlas && usermod -aG sudo atlas      # non-root run user
ufw allow OpenSSH && ufw enable              # firewall; no app port is exposed —
                                             # Cloudflare Tunnel dials out, nothing inbound
# SSH: disable password auth, keys only (/etc/ssh/sshd_config: PasswordAuthentication no)
```

## 2. Runtime
```bash
# Node 22 LTS (nodesource or nvm)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
node -v   # expect v22.x
```

## 3. Clone + install
```bash
sudo -iu atlas
git clone https://github.com/agnticco/agntic-atlas.git ~/atlas && cd ~/atlas
npm ci
```

## 4. Configuration (`~/atlas/.env`)
`.env` is gitignored and loaded by `npm run prod` (`node --env-file-if-exists=.env`).
Required:
```
NODE_ENV=production
ANTHROPIC_API_KEY=sk-ant-...
OAUTH_REDIRECT_BASE=https://atlas.agntic.co
# Connectors you enable:
SLACK_CLIENT_ID=... SLACK_CLIENT_SECRET=... SLACK_SIGNING_SECRET=...
GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=...
AIRTABLE_CLIENT_ID=... AIRTABLE_CLIENT_SECRET=...
```
Optional hardening knobs (sensible defaults shown — override only to tune):
```
PORT=3000
SCHEDULER_ENABLED=true            # set false on all-but-one instance if you scale out
TENANT_DAILY_USD_LIMIT=25         # per-tenant daily LLM spend cap
TENANT_MAX_CONCURRENT=6           # per-tenant in-flight cap
LLM_MAX_RETRIES=4  LLM_TIMEOUT_MS=120000
NODE_RUN_TIMEOUT_MS=180000        # per-node execution backstop
EVENT_LOG_MAX_BYTES=10485760  EVENT_LOG_KEEP=3
DB_BACKUP_KEEP=7                  # boot snapshots kept under ./memory/backups
CONVERGER_TTL_DAYS=7              # abandoned converger session sweep
SHUTDOWN_GRACE_MS=10000
CORS_ALLOWED_ORIGINS=https://atlas.agntic.co
```
`validateBootConfig()` **fails fast** if `NODE_ENV=production` and no LLM key — that
is intentional (no silent fallback to the local model).

## 5. First boot + platform admin
```bash
npm run prod    # boots on :3000; prints a one-time setup token to the console
```
Open `https://atlas.agntic.co` (after step 7) and paste the token to create the
platform admin, or hit `POST /setup` with it. Then stop and install as a service.

## 6. Run as a service (systemd)
`/etc/systemd/system/atlas.service`:
```ini
[Unit]
Description=Atlas
After=network.target
[Service]
Type=simple
User=atlas
WorkingDirectory=/home/atlas/atlas
ExecStart=/usr/bin/npm run prod
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now atlas && journalctl -u atlas -f
```
Auto-restart pairs with the app's process-fault handlers (uncaughtException exits
non-zero) and boot reconciliation (stuck `running` runs are marked errored on the
next start), so a crash self-heals.

## 7. Cloudflare Tunnel + DNS
```bash
cloudflared tunnel login
cloudflared tunnel create atlas
# ~/.cloudflared/config.yml:
#   tunnel: <id>
#   credentials-file: ~/.cloudflared/<id>.json
#   ingress:
#     - hostname: atlas.agntic.co
#       service: http://localhost:3000
#     - service: http_status:404
cloudflared tunnel route dns atlas atlas.agntic.co     # creates the DNS CNAME
sudo cloudflared service install                        # run the tunnel as a service
```
Register `https://atlas.agntic.co/connectors/*/callback` redirect URLs in the
Slack/Google/Airtable consoles (they derive from `OAUTH_REDIRECT_BASE`).

## 8. Smoke test (closes the P11 gate)
```bash
PROD_HOST=atlas.agntic.co node scripts/checks/p11-smoke.mjs   # DNS + /health + /setup/status + / → 200
PROD_HOST=atlas.agntic.co bash scripts/gate.sh 11            # full gate: E2E + adversarial + smoke
```

## 9. Off-host backups
App-side boot snapshots live in `./memory/backups/` (kept: `DB_BACKUP_KEEP`). Copy
them **off the VPS** on a schedule — they're worthless on the same disk:
```bash
# crontab -e (atlas user)
0 * * * * rsync -a /home/atlas/atlas/memory/backups/ backup-host:/srv/atlas-backups/
```

## 10. Deploys / updates
```bash
cd ~/atlas && git pull && npm ci && sudo systemctl restart atlas
```
SIGTERM triggers graceful drain (scheduler stops, in-flight requests finish,
`SHUTDOWN_GRACE_MS` backstop). A WAL checkpoint runs on clean shutdown.

## 11. Rollback
`git checkout <previous-tag> && npm ci && sudo systemctl restart atlas`. The boot
snapshot in `./memory/backups/<timestamp>/` from the new boot lets you restore the
DBs if a migration misbehaved (stop service, copy files back, restart).
