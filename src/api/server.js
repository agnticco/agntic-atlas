/**
 * Atlas — minimal API spine (P0).
 *
 * Deliberately thin. This is NOT a port of the salvage `agntic-prod/src/api/server.js`
 * (which drags in RAG + llama.cpp inference + the model pool + the MCP runtime that
 * P0 does not exercise). It mounts only what the spine needs to prove two things:
 *
 *   1. the migrated execution engine boots in the new repo (WorkflowStore opens its
 *      SQLite schema), and
 *   2. the auth + credential vault boots (better-sqlite3 user/session/oauth stores,
 *      JWT secret, AES-256-GCM key resolution).
 *
 * It exposes one unauthenticated route, `GET /health`. Later phases grow this file:
 * P1 mounts the Slack connector + MCP runtime, the converger phases mount the agent
 * graph, etc. Grow as needed — do not bulk-port the salvage server.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { createAuthSubsystem } from '../auth/index.js';
import { WorkflowStore } from '../workflows/workflow-store.js';
// Imported to assert the engine's executor + service layer load in the new repo.
// Constructed per-run (FlowTester) / with injected registries (WorkflowService)
// in the phases that exercise them — booting the store is the P0 persistence proof.
import { FlowTester } from '../workflows/flow-tester.js';
import { WorkflowService } from '../workflows/workflow-service.js';

const PORT = Number(process.env.PORT ?? 3000);
const WORKFLOWS_DB = process.env.WORKFLOWS_DB ?? './memory/workflows/workflows.sqlite';

/**
 * Boot the spine's subsystems. Returns the live handles + a close() for shutdown.
 * Throws if either subsystem fails to boot — a failed boot must not serve traffic.
 */
export async function bootSpine() {
  // Engine: opening the store runs its schema migration. If this throws, the
  // engine did not boot in this repo.
  try { mkdirSync(dirname(WORKFLOWS_DB), { recursive: true }); } catch { /* ok */ }
  const workflowStore = new WorkflowStore({ dbPath: WORKFLOWS_DB });
  await workflowStore.init();

  // Auth + vault: opens user/session/oauth SQLite stores, resolves the JWT
  // secret and the AES-256-GCM OAuth key.
  const auth = await createAuthSubsystem();

  // Touch the executor/service classes so a broken import fails boot, not a request.
  if (typeof FlowTester !== 'function' || typeof WorkflowService !== 'function') {
    throw new Error('engine executor/service failed to load');
  }

  return {
    workflowStore,
    auth,
    close() {
      try { workflowStore.close?.(); } catch { /* ignore */ }
      try { auth.close?.(); } catch { /* ignore */ }
    },
  };
}

/**
 * Build the express app around already-booted subsystems. Kept separate from
 * bootSpine() so tests can assert routes without standing up a listener.
 */
export function createApp(spine) {
  const app = express();
  app.use(cors());
  app.use(cookieParser());
  app.use(express.json());

  // Unauthenticated. Thin-spine payload reports only what is actually wired —
  // no rag/inference fields (those subsystems arrive in later phases).
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      version: '0.1.0',
      engine: spine.workflowStore ? 'ok' : 'down',
      auth: spine.auth ? 'ok' : 'down',
    });
  });

  return app;
}

export async function start() {
  const spine = await bootSpine();
  const app = createApp(spine);

  const server = app.listen(PORT, () => {
    console.log(`atlas spine listening on :${PORT} (engine ok, auth ok)`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} — shutting down`);
    server.close(() => { spine.close(); process.exit(0); });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, spine };
}

// Boot when run directly (`npm start`), not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error('spine failed to boot:', err);
    process.exit(1);
  });
}
