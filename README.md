<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/atlas-globe-white.png">
    <img src="public/assets/atlas-globe-black.png" width="76" alt="Atlas logo">
  </picture>

  <h1>Atlas by Agntic</h1>

  <p><strong>Build automations by talking.</strong></p>

  <p>Describe what you want in plain language. Atlas asks the questions it actually needs answered, builds a runnable automation, tests it, and runs it on a schedule or a trigger. Self-hosted, on your own API key.</p>

  <p>
    <img alt="license: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-8b90a3">
    <img alt="node >= 22" src="https://img.shields.io/badge/node-%3E%3D22-3c873a">
    <img alt="tests" src="https://img.shields.io/badge/tests-2%2C500%2B-6b7bff">
    <img alt="self-hosted" src="https://img.shields.io/badge/self--hosted-yes-111">
  </p>
</div>

---

## What is Atlas?

Most automation tools make you draw a flowchart. Atlas doesn't.

You say *"every morning, summarise my unread shipping emails and post them to #ops"*. Atlas works out what it still needs to know, asks you one thing at a time, shows you a plan, and walks you through every step before anything is built. Then it writes down — in your own words — **what the finished automation promises to deliver**, and holds itself to that promise before it will let you turn it on.

That last part is the point. The failure that matters in this category isn't a workflow that crashes; it's a workflow that quietly does nothing and reports success. Atlas is built around refusing to say something worked when it can't tell.

## Run it

**You need:** Node.js 22+ and an [Anthropic API key](https://console.anthropic.com/settings/keys) (or an OpenAI one).

```bash
git clone https://github.com/agnticco/agntic-atlas.git
cd agntic-atlas
npm install

cp .env.example .env          # add ANTHROPIC_API_KEY=sk-ant-...
npm start                     # http://localhost:3000
```

Or with Docker, if you'd rather not install Node:

```bash
cp .env.example .env          # add your key
docker compose up
```

**On first start, Atlas prints a one-time setup code in your terminal.** You need it to create your admin account, so keep that window visible. Miss it and a fresh one is printed on the next restart.

That's the whole install. There are no usage limits, no account to create with us, and nothing phones home.

> **Costs.** Atlas spends real money on your API key every time it builds or runs something. It is metered per workspace and visible in the admin console. If anyone but you can sign in, set `TENANT_DAILY_USD_LIMIT` in `.env` — there is no ceiling by default.

## What works immediately, and what doesn't

Being straight about this, because it's the thing that wastes people's evenings.

**Works the moment you start it — nothing to register:**

| | |
|---|---|
| **Notion, Linear, Sentry, Asana, Stripe, Figma** | Click connect, approve on their site, done. Atlas identifies itself to these services automatically, so there is no app to create and no key to paste. Their tools become steps in your workflows. |
| **Web search and page reading** | Uses the Anthropic key you already set. |
| **Knowledge** | Upload documents, and workflows can read them. Indexed per workspace. |
| **Atlas Inbox** | Have a workflow deliver to you inside Atlas — useful before you've connected anything. |
| **Schedules** | Hourly, daily, weekly, or every N minutes. |

**Needs about ten minutes of setup each — you create a developer app and paste two values into `.env`:**

| | |
|---|---|
| **Slack** | Post messages, read channels, approval buttons. Also the only way to get Slack *triggers*, which additionally need Atlas reachable from the internet. |
| **Google Workspace** | Gmail, Calendar, Drive, Sheets, Docs, Tasks. One consent covers all of them. |
| **Airtable** | Read and write records; real webhook triggers. |

`.env.example` says exactly what each one needs and where to get it.

**Doesn't exist yet, so you know:** the one-click services above are step-and-delivery only — none of them can *start* a workflow. Triggers today are schedules, Gmail, Slack messages, and Airtable record changes.

## How it works

```
  intent  ──▶  converger  ──▶  JSON spec  ──▶  execution engine  ──▶  connectors
 (plain       (elicits +      (the saved      (topological DAG,      (Slack, Google,
  language)    confirms)       workflow)        data threading)        Notion, Web…)
                                                      │
                                                      ▼
                                             observable runs
                                      (console · SOP export · alerts)
```

- The **converger** (`src/converger/`) is the hard part — a conversational elicitation engine on a custom agent-graph runtime (a compiled state graph plus a ReAct tool loop with a human-in-the-loop pause).
- The **execution engine** (`src/workflows/`) is a topological DAG executor with real data threading between steps (`{{prev}}`, `{{nodeId.output}}`, transitive fan-in) and durable, cost-tracked run logs.
- **Connectors** (`src/connectors/`) expose one capability catalog. Each capability declares which positions it can occupy (trigger / step / delivery), what it changes in the world, and where it writes — so the rest of the system never has to guess from a name.

## What else is in here

- **Approval steps.** A workflow can stop and wait for a person before it does something serious. Approvals go through signed single-use links, never an email reply — a `From:` header is forgeable and a forwarded thread is full of the word "yes".
- **Branching with proof.** A workflow that routes is only cleared to go live once every path has actually been tested.
- **A monitoring console.** Run history, per-step detail, retries, failure alerts, and an exportable written procedure (PDF or Markdown).
- **Multi-workspace isolation.** Hard and fail-closed — the stores throw on a missing tenant rather than quietly returning everything. RAG is physically separated per workspace, not filtered.
- **Local models.** Run against GGUF weights instead of a cloud API if you want to (`npm install node-llama-cpp`; it's optional precisely because most people don't).

## Project layout

```
src/
  converger/     the elicitation engine — turns a conversation into a workflow
  workflows/     execution engine — DAG executor, scheduler, node types
  connectors/    Slack · Google · Airtable · Notion · Web · Files — one catalog
  api/           HTTP spine (server.js) and the build/chat API (builder.js)
  auth/          argon2id auth, JWT sessions, tenants, encrypted token vault
  rag/           per-workspace document knowledge
  llm/           model pool (cloud + local) and cost tracking
  admin/         operator console — usage and cost per workspace
  graph/ core/   the agent-graph runtime the converger is built on
public/          the entire frontend, one file, no build step
tests/           ~2,500 tests, ~8 seconds, no API key needed
```

## Contributing

Yes please — start with [CONTRIBUTING.md](CONTRIBUTING.md). It's short, and it contains the one habit this codebase genuinely depends on: **when you add a guard, put the bug back by hand and watch the test fail.**

[`docs/ENGINEERING-LOG.md`](docs/ENGINEERING-LOG.md) is worth a look even if you never write a line. It's an unusually honest engineering diary — every significant defect this project shipped, why it happened, what it cost, and the rule that came out of it. Most of them are the same few mistakes wearing different clothes.

Found a security problem? Please [report it privately](SECURITY.md) rather than opening an issue.

## Documentation

| Topic | Doc |
|---|---|
| Multi-workspace isolation model | [architecture/multi-tenancy.md](docs/architecture/multi-tenancy.md) |
| Connector capability catalog | [architecture/connector-capabilities.md](docs/architecture/connector-capabilities.md) |
| Connecting services with no setup (MCP) | [architecture/mcp-capability-adapter.md](docs/architecture/mcp-capability-adapter.md) |
| Local models + document knowledge | [capabilities/local-models-rag.md](docs/capabilities/local-models-rag.md) |
| Running Atlas as a metered service | [architecture/tier-gating.md](docs/architecture/tier-gating.md) |
| Deploying to a server | [deployment/vps-runbook.md](docs/deployment/vps-runbook.md) |
| Scaling beyond one process | [architecture/scaling.md](docs/architecture/scaling.md) |

## Licence

[GNU AGPL v3](LICENSE). Use it, run it, change it, freely.

The one obligation: if you run a modified Atlas as a network service for other people, you have to make your changes available to them. Running it for yourself or your own company, modified however you like, carries no such requirement.

---

<div align="center"><sub>Atlas · originally built by <strong>Agntic</strong> · Birmingham, AL</sub></div>
