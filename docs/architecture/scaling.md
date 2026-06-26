# Scaling Atlas (single VPS → horizontal)

Atlas runs as **one Node process on one VPS** today. That is the supported
deployment. This doc records the seams already in place so a future scale-out to
multiple instances is a configuration change, not a rewrite — and the concrete
trigger for moving off SQLite.

## Current shape (single instance)

- One Node process (`npm run prod`), behind Cloudflare (TLS, edge WAF, per-IP
  rate limiting).
- SQLite via `better-sqlite3` (WAL mode) for all stores under `./memory/`.
- The scheduler tick loop, email polling, and the per-tenant concurrency guard
  all live in that one process.

## Seams for going horizontal (N instances behind a load balancer)

When you add instances, flip these — no code changes required:

1. **Scheduler must run on exactly one instance.** The tick loop fires scheduled
   workflows and polls email; running it on N instances double-fires everything.
   Gate: `SCHEDULER_ENABLED` (default `true`). Set `SCHEDULER_ENABLED=false` on
   every instance **except one**. Wired at `src/api/server.js` (the
   `workflowScheduler.start()` call site). The intra-process overlap guard
   (`_running` in `workflow-scheduler.js`) only protects a single process — it is
   **not** cross-instance, which is why the env gate exists.

2. **Sessions already survive multi-instance** — they're stored in the shared
   auth DB (not in process memory), so any instance can validate any session,
   provided all instances point at the **same** database (see SQLite note below).

3. **Per-tenant concurrency cap is per-instance.** `src/api/tenant-guard.js`
   tracks in-flight counts in process memory, so with N instances the effective
   cap is `N × TENANT_MAX_CONCURRENT`. The **daily USD ceiling is global** (it
   reads `llm_cost_log`), so cost runaway is still bounded cluster-wide. If you
   need a hard global concurrency cap, externalize the counter (e.g. Redis) — the
   guard is the single place to change.

## The SQLite ceiling

SQLite is a **single-writer** embedded database. It is the right choice now:
simple, fast, no ops burden, and correct for one process. It does **not** support
multiple processes/hosts writing the same file safely (a network filesystem makes
it worse, not better).

**Migrate to Postgres when any of these is true:**

- You run **more than one app instance** that needs to write (the moment you add
  a second instance for HA or throughput).
- You observe `SQLITE_BUSY` / "database is locked" errors under load.
- Write throughput or DB size outgrows a single disk (sustained heavy
  concurrent runs, very large run/cost logs).

**Migration path:** the stores (`src/auth/*-store.js`, `src/workflows/workflow-store.js`,
inbox/sources/interactions stores) wrap `better-sqlite3` behind thin,
parameterized query methods. Moving to Postgres means swapping the driver and SQL
dialect inside those store classes — callers (routes, engine, converger) are
unaffected because they only use the store methods. Multi-tenancy is already
enforced inside the stores (`tenant_id` scoping), so the isolation model carries
over unchanged. RAG is already physically isolated per tenant and is independent
of this choice.

## Off-host backups

App-side backup (boot snapshots + WAL checkpoint on shutdown) is in place
(`backupDatabases()` in `server.js`), but those snapshots live on the same host.
Production must additionally copy `./memory/backups/` (or the live DBs) **off the
VPS** on a schedule — define that in the VPS runbook (`docs/deployment/vps-runbook.md`,
a P11 gate item).
