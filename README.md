<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/atlas-globe-white.png">
    <img src="public/assets/atlas-globe-black.png" width="76" alt="Atlas logo">
  </picture>

  <h1>Atlas by Agntic</h1>

  <p><strong>Build automations by talking.</strong></p>

  <p>A conversational workflow builder. Describe what you want in plain language — Atlas asks the right questions, builds a runnable automation, and runs it for you on a schedule or a trigger.</p>

  <p>
    <img alt="status: pilot" src="https://img.shields.io/badge/status-pilot-6b7bff">
    <img alt="node >= 22" src="https://img.shields.io/badge/node-%3E%3D22-3c873a">
    <img alt="license: proprietary" src="https://img.shields.io/badge/license-proprietary-8b90a3">
    <img alt="by Agntic" src="https://img.shields.io/badge/by-Agntic-111">
  </p>
</div>

---

## What is Atlas?

Most automation tools make you draw flowcharts. Atlas doesn't.

A non-technical operator describes a goal — *"every morning, summarize my unread shipping emails and post them to #ops"* — and an AI **converger** elicits the missing details one step at a time, confirms each, and emits a runnable automation. No drag-and-drop, no code.

Finished workflows run on a durable execution engine and are fully observable: run history, per-step detail, retries, failure alerts, time-saved metrics, and an exportable SOP. Every customer is a hard-isolated tenant.

> Atlas is currently in **private pilot**.

## Features

- 🗣️ **Build by talking** — the converger turns a vague intent into a runnable spec, and never proposes a step your connected tools can't actually do.
- 🔌 **Connectors** — Slack, Google Workspace (Gmail, Calendar, Drive, Sheets, Docs, Tasks), Airtable, Web (search + read), your own files/Knowledge, and an in-app Inbox — one unified, position-agnostic capability catalog.
- ⏰ **Triggers & scheduling** — run on a schedule (down to minutes), on inbound email, or on connector events.
- 📊 **Monitoring console** — inventory, live run monitoring, per-step detail, retries, failure alerts, and SOP export (PDF / Markdown).
- 📈 **Proof of value** — time-saved per run, an all-up ROI summary, and a customer-facing report.
- 🏢 **Multi-tenant & secure** — hard, fail-closed per-tenant isolation; argon2id auth, revocable JWT sessions, AES-256-GCM-encrypted OAuth tokens; RAG physically isolated per tenant.
- 🛠️ **Admin & team** — an operator console for per-tenant usage + cost, workspace provisioning with email invites, seat-gated teammate invites, and tenant lifecycle (suspend / archive).

## How it works

```
  intent  ──▶  converger  ──▶  JSON spec  ──▶  execution engine  ──▶  connectors
 (plain       (elicits +      (proprietary    (topological DAG,      (Slack, Google,
  language)    confirms)       format)          data threading)        Airtable, Web…)
                                                      │
                                                      ▼
                                             observable runs
                                      (console · SOP · ROI · alerts)
```

- The **converger** (`src/converger/`) is the hard IP — a conversational elicitation engine built on a custom agent-graph runtime (a compiled state graph + a ReAct tool loop with a human-in-the-loop pause).
- The **execution engine** (`src/workflows/`) is a topological DAG executor with real inter-step data threading (`{{prev}}`, `{{nodeId.output}}`, transitive fan-in) and durable, cost-tracked run logs.
- Connectors expose a single **capability catalog** (`src/connectors/`) — each capability declares which positions it can occupy (trigger / step / delivery) and its required scopes, resolved live from a tenant's granted permissions.

## Tech stack

- **Runtime** — Node.js ≥ 22, [Express](https://expressjs.com)
- **Data** — SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (workflows, auth, cost logs); per-tenant vector stores for RAG
- **AI** — Anthropic Claude / OpenAI in the cloud, or local GGUF models via [node-llama-cpp](https://github.com/withcatai/node-llama-cpp); [Voyage AI](https://voyageai.com) or local embeddings
- **Frontend** — a custom lightweight reactive framework, no build step (`public/index.html`)
- **Deploy** — a single Node process + systemd, fronted by a Cloudflare Tunnel

## Getting started (local dev)

**Prerequisites:** Node.js ≥ 22.

```bash
git clone https://github.com/agnticco/agntic-atlas.git
cd agntic-atlas
npm ci

# Configure — the only required value for cloud inference is an Anthropic key.
cp .env.example .env
#   ANTHROPIC_API_KEY=sk-ant-...      # without it, Atlas falls back to a local model

npm start          # boots on http://localhost:3000
```

On first run Atlas prints a **one-time setup token** — open the URL and paste it to create the first platform admin. From the admin dashboard you can provision a workspace and start building.

> `npm start` is development mode. Use `npm run prod` for production (`NODE_ENV=production`, which fails fast without a cloud LLM key). Config is read from `.env`, which is never committed.

## Project structure

```
src/
  api/           HTTP spine — grows deliberately, mounts only what's wired
  converger/     the elicitation engine (the IP)
  workflows/     execution engine — DAG executor, scheduler, node types
  connectors/    Slack · Google · Airtable · Web · Filesystem — one capability catalog
  auth/          argon2id auth, JWT sessions, tenant + OAuth-token stores
  rag/           per-tenant company-context RAG
  llm/           model pool (cloud + local GGUF) and cost tracker
  entitlements/  plan-based gating (seats today; see the tier-gating spec)
  admin/         platform operator console (usage + cost per tenant)
  graph/ core/   the agent-graph runtime the converger is built on
public/          the frontend (single page, no build step)
docs/            architecture, deployment, and design docs
```

## Deployment

Atlas runs as a single Node process behind a Cloudflare Tunnel.

- **[VPS runbook](docs/deployment/vps-runbook.md)** — provision a production host from scratch
- **[Update / deploy protocol](docs/deployment/update-protocol.md)** — the develop → commit → push → deploy → verify loop
- **[Operator cheat sheet](docs/deployment/operator-cheatsheet.md)** — plain-language terminal commands for running the server

## Documentation

| Topic | Doc |
|---|---|
| Multi-tenancy (isolation model) | [architecture/multi-tenancy.md](docs/architecture/multi-tenancy.md) |
| Connector capability catalog | [architecture/connector-capabilities.md](docs/architecture/connector-capabilities.md) |
| Plan / tier gating | [architecture/tier-gating.md](docs/architecture/tier-gating.md) |
| Scaling path | [architecture/scaling.md](docs/architecture/scaling.md) |
| Local models + RAG | [capabilities/local-models-rag.md](docs/capabilities/local-models-rag.md) |
| Commit convention | [COMMIT_CONVENTION.md](docs/COMMIT_CONVENTION.md) |

The build constitution — closed decisions, off-limits code, and working rules — lives in [`CLAUDE.md`](CLAUDE.md).

## License

© 2026 Agntic LLC. All rights reserved. Proprietary and confidential — not for redistribution.

---

<div align="center"><sub>Atlas · by <strong>Agntic</strong> · Birmingham, AL</sub></div>
