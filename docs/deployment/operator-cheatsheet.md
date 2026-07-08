# Atlas — Operator Cheat Sheet

Plain-language commands for running the Atlas server. You don't need to be an
engineer — find your task below, copy the command, paste it in. When in doubt,
the safe default is **restart** (it never loses data).

---

## The basics (memorize these three facts)

| Thing | Value |
|---|---|
| **Your site** | https://atlas.agntic.co |
| **Admin dashboard** | https://atlas.agntic.co/admin |
| **The server's address** | `32.198.159.147` (AWS Lightsail) |

The app lives on the server and runs **by itself, 24/7** — your Mac can be off.
There are two background services: **`atlas`** (the app) and **`cloudflared`**
(the tunnel that connects your web address to the app).

---

## Is the site working? (check without logging into anything)

From **any** terminal (even your Mac), run:

```bash
curl -s https://atlas.agntic.co/health
```

- ✅ You want to see something like `{"status":"ok",...,"version":"1.2.0"}`.
- ❌ If it hangs or shows an error page, jump to **"The site is down"** below.

You can also just open **https://atlas.agntic.co** in a browser.

---

## Logging into the server

Everything below (except the health check) is run **on the server**. To get there,
open Terminal on your Mac and run:

```bash
ssh ubuntu@32.198.159.147
```

You'll land at a prompt like `ubuntu@ip-...:~$`. When you're done, type `exit` to leave.

> Some commands run as the **`atlas`** user (the account the app runs under). When a
> step says "as atlas", first run `sudo -iu atlas` (your prompt changes to
> `atlas@...`), do the steps, then `exit` back to `ubuntu`.

---

## I want to… check if the app is running

```bash
sudo systemctl status atlas
```

Look for **`active (running)`** in green. Press `q` to exit the view.
Check the tunnel the same way:

```bash
sudo systemctl status cloudflared
```

---

## I want to… restart the app (the fix-most-things button)

```bash
sudo systemctl restart atlas
```

Safe to run anytime — it takes ~3 seconds, finishes what it's doing first, and
**never deletes data**. Use this if the app is acting weird.

If the tunnel/web address seems broken (site unreachable but the app is running):

```bash
sudo systemctl restart cloudflared
```

---

## I want to… see the logs (what the app is doing / why it broke)

Watch live (new lines appear as things happen). Press **`Ctrl+C`** to stop watching:

```bash
sudo journalctl -u atlas -f
```

See the last 50 lines (a snapshot, doesn't keep running):

```bash
sudo journalctl -u atlas -n 50
```

Tunnel logs (if the web address is the problem):

```bash
sudo journalctl -u cloudflared -n 50
```

---

## I want to… deploy an update (get new code live)

When new code has been pushed to GitHub, run this **as atlas**:

```bash
sudo -iu atlas
cd ~/atlas
./scripts/deploy.sh
exit
```

`deploy.sh` does everything safely: pulls the latest code, installs it, restarts
the app, and checks it's healthy. If it prints **`✓ healthy`**, you're done. If it
fails, it prints the exact command to undo it.

---

## I want to… change a setting or add a connector key (`.env`)

Settings and secret keys live in a file called `.env`. Edit it **as atlas**:

```bash
sudo -iu atlas
cd ~/atlas
nano .env
```

In the `nano` editor: use arrow keys, type your change. To save: **`Ctrl+O`** then
**Enter**. To exit: **`Ctrl+X`**. Then apply the change by restarting:

```bash
sudo systemctl restart atlas
exit
```

---

## I want to… undo a bad update (rollback)

If a deploy broke something, **as atlas**:

```bash
sudo -iu atlas
cd ~/atlas
git log --oneline -5          # shows the last 5 versions (newest on top)
git checkout <PASTE-THE-ID-OF-THE-PREVIOUS-GOOD-ONE>
npm ci && sudo systemctl restart atlas
exit
```

(The IDs are the short codes on the left, like `c6549e0`.) `deploy.sh` also prints
the exact rollback command whenever a deploy fails.

---

## The site is down — first aid

Run these in order; stop when the site comes back:

```bash
# 1. Is the app running?
sudo systemctl status atlas          # not "active (running)"? →
sudo systemctl restart atlas

# 2. Is the tunnel running?
sudo systemctl status cloudflared    # not "active (running)"? →
sudo systemctl restart cloudflared

# 3. Still down? Look at the logs for a red error:
sudo journalctl -u atlas -n 50
```

If it's still down after that, restart the whole machine (services come back
automatically):

```bash
sudo reboot
```

(You'll get kicked out of SSH — that's expected. Wait ~60 seconds, then re-check
the health URL.)

---

## Backups & recovery

- **Automatic backups are on** — AWS Lightsail snapshots the whole server daily
  (set in the Lightsail console → your instance → Snapshots).
- **To recover from disaster:** in the Lightsail console, create a new instance
  from a snapshot, then re-attach your static IP to it. The site comes back with
  data as of that snapshot.
- The app also keeps its own quick-restore snapshots on the server under
  `~/atlas/memory/backups/` (used automatically for rollback).

---

## Things to NOT do

- ❌ **Don't `sudo systemctl stop atlas`** unless you intend to take the site
  offline (use **restart**, not stop).
- ❌ **Don't delete or "stop" the Lightsail instance** — that's the server itself;
  it takes the site down.
- ❌ **Don't hand-edit code files on the server.** Change code by pushing to GitHub
  and running `deploy.sh`. The **only** file you edit directly on the server is
  `.env`.
- ❌ **Don't share your `.env`** — it holds the secret keys.

---

## Cheat sheet (the 6 you'll actually use)

```bash
curl -s https://atlas.agntic.co/health     # is it up? (from anywhere)
ssh ubuntu@32.198.159.147                  # log into the server
sudo systemctl status atlas                # is the app running?
sudo systemctl restart atlas               # fix-most-things button
sudo journalctl -u atlas -n 50             # what went wrong?
sudo -iu atlas; cd ~/atlas; ./scripts/deploy.sh   # deploy an update
```
