<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/atlas-globe-white.png">
    <img src="public/assets/atlas-globe-black.png" width="76" alt="Atlas logo">
  </picture>

  <h1>Atlas by Agntic</h1>

  <p><strong>Build automations by talking.</strong></p>

  <p>Describe what you want in plain language. Atlas asks the questions it actually needs answered, builds a runnable automation, tests it, and runs it on a schedule or a trigger. Self-hosted, on your own API key, with no usage limits.</p>

  <p>
    <img alt="license: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-8b90a3">
    <img alt="node >= 22" src="https://img.shields.io/badge/node-%3E%3D22-3c873a">
    <img alt="tests" src="https://img.shields.io/badge/tests-2%2C552%20passing-6b7bff">
    <img alt="self-hosted" src="https://img.shields.io/badge/self--hosted-yes-111">
  </p>
</div>

---

## What is Atlas?

Most automation tools make you draw a flowchart. Atlas doesn't.

You say *"every morning, summarise my unread shipping emails and post them to #ops"*. Atlas works out what it still needs to know, asks you one thing at a time, shows you a plan, and walks you through every step before anything is built. Then it writes down — in your own words — **what the finished automation promises to deliver**, and holds itself to that promise before it will let you turn it on.

That last part is the point. The failure that matters here isn't a workflow that crashes; it's a workflow that quietly does nothing and reports success. Atlas is built around refusing to say something worked when it can't tell.

**It is not a hosted service.** You run it, on your machine or your own server, against your own API key. Nothing phones home.

---

## Install

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
git clone https://github.com/agnticco/agntic-atlas.git
cd agntic-atlas
cp .env.example .env          # add your key
docker compose up
```

**Atlas prints a one-time setup code in your terminal on first start**, and you need it to create your admin account — so keep that window visible. Open `http://localhost:3000`, paste the code, and choose an email and password. That account is the administrator; it can create workspaces for other people. If you miss the code, restart — a fresh one is printed every time until an account exists.

That's the whole install. No account with us, no usage limits, nothing to buy.

> **It costs money to run.** Every build and every run spends against your API key. Spend is tracked per workspace and shown in the admin console. If anyone but you can sign in, set `TENANT_DAILY_USD_LIMIT=5` in `.env` — there is no ceiling by default.

---

## Using it

### 1. Describe what you want

Press **+** at the top of the sidebar and type the job the way you'd explain it to a colleague:

> *"When someone emails us asking about pricing, draft a reply, show it to me for approval, then send it."*

Atlas replies with **either a question or an offer to build with a Build it button**. It asks about the things it genuinely cannot infer — which mailbox, which channel, what counts as a pricing email — one at a time, rather than handing you a form.

### 2. Approve the plan

Before writing anything, Atlas shows a plan: the trigger, every step in order, **every route it can take** (including ones you didn't mention but it needs), and what happens when a step fails.

Read it properly — this is where a misunderstanding is cheapest to fix. Then **Approve & build**, or **Request a change** and say what's wrong in your own words.

### 3. Confirm each step

Atlas builds the workflow and walks you through it one step at a time. Each card shows the step's full name, a plain-English sentence about what it does, its real configuration, and — for a step that routes — **every path it can take**. A possible outcome that no path covers is called out in red rather than quietly absorbed.

Nothing runs until you've confirmed every step.

### 4. Test it

**Run test** executes the workflow against real examples. It is a **dry run** — nothing is sent, nothing is written, no email leaves your machine — but everything else is real: the AI steps actually run, connectors are actually checked, and destinations are verified to exist in your account.

You get a verdict per example and one for the set. A workflow that routes is only cleared once **every path has been tested**; proving the happy path is not proof.

### 5. Go live

**Go live** unlocks only once the test genuinely passed. The workflow moves into your sidebar and runs on its trigger from then on.

Its dashboard gives you run history, per-step detail of what each run actually did, failure alerts, retries, and an exportable written procedure (PDF or Markdown) if you ever need to hand the process to a person instead.

---

## Connecting your tools

**Connections**, in the left sidebar. There are two kinds.

### One click, nothing to set up

**Notion · Linear · Sentry · Asana · Stripe · Figma**

Press connect, approve on the service's own screen, done. Atlas identifies itself to these services automatically, so there is no developer app to create and no key to paste. Their tools become steps you can use in any workflow.

### About ten minutes of setup each

| | What you get | What you do |
|---|---|---|
| **Slack** | Post messages, read channels, approval buttons, message triggers | Create a Slack app; paste its client ID and secret into `.env` |
| **Google Workspace** | Gmail, Calendar, Drive, Sheets, Docs, Tasks — one consent covers all of them | Create OAuth credentials in Google Cloud Console |
| **Airtable** | Read and write records, record-change triggers | Create an OAuth integration at airtable.com |

[`.env.example`](.env.example) names exactly what each one needs and where to get it.

### Available immediately, no connector at all

- **Web search and page reading** — uses the API key you already set
- **Knowledge** — upload documents and workflows can read them, indexed per workspace
- **Atlas Inbox** — have a workflow deliver to you inside Atlas
- **Schedules** — hourly, daily, weekly, or every N minutes

> **What can start a workflow:** a schedule, a new Gmail message, a Slack message, or an Airtable record change. The one-click services above are step-and-delivery only — none of them can *trigger* a workflow yet. Slack and Airtable triggers also need Atlas reachable from the internet.

---

## Configuring it

Everything is environment variables in `.env`, and [`.env.example`](.env.example) documents every one. The ones that matter most:

| Variable | Why you'd set it |
|---|---|
| `ANTHROPIC_API_KEY` | Required (or `OPENAI_API_KEY`). Nothing works without a model. |
| `OAUTH_REDIRECT_BASE` | The address you actually reach Atlas at. OAuth redirects and password-reset links are built from it — set it for anything but localhost. |
| `ATLAS_TIMEZONE` | What Atlas thinks "today" and "9am" mean. Defaults to UTC, which is wrong for most people. |
| `TENANT_DAILY_USD_LIMIT` | A hard daily spend cap per workspace. Off by default. |
| `SUPPORT_EMAIL` | Who *your* users contact for help. Unset means the line is omitted rather than guessed. |
| `JWT_SECRET`, `OAUTH_TOKEN_KEY` | Auto-generated into `./memory/` if unset. **Set them, or back that directory up** — losing `OAUTH_TOKEN_KEY` makes every stored connector token permanently unreadable. |

**Everything durable lives in `./memory/`** — accounts, workflows, run history, encrypted tokens, uploaded documents. That is the directory to back up. Atlas snapshots the databases at boot to the same disk, which is not a backup.

`ATLAS_SELF_HOSTED` defaults to **true**, meaning no limits on workflows, runs or seats. Set it to `false` only if you are running Atlas as a metered service for other people.

---

## How it works

```
  intent  ──▶  converger  ──▶  JSON spec  ──▶  execution engine  ──▶  connectors
 (plain       (elicits +      (the saved      (topological DAG,      (Slack, Google,
  language)    confirms)       workflow)        data threading)        Notion, Web…)
                                                      │
                                                      ▼
                                             observable runs
                                      (console · procedure export · alerts)
```

- The **converger** (`src/converger/`) is the hard part — a conversational elicitation engine on a custom agent-graph runtime (a compiled state graph plus a tool loop with a human-in-the-loop pause).
- The **execution engine** (`src/workflows/`) is a topological DAG executor with real data threading between steps (`{{prev}}`, `{{nodeId.output}}`, transitive fan-in) and durable, cost-tracked run logs.
- **Connectors** (`src/connectors/`) expose one capability catalog. Each capability declares which positions it can occupy (trigger / step / delivery), what it changes in the world, and where it writes — so nothing else has to guess from a name.

Three more things worth knowing:

- **Approval steps.** A workflow can stop and wait for a person before doing something serious. Approvals go through signed single-use links, never an email reply — a `From:` header is forgeable and a forwarded thread is full of the word "yes".
- **Workspace isolation.** Hard and fail-closed: the stores throw on a missing workspace rather than quietly returning everything, and document knowledge is physically separated per workspace rather than filtered.
- **Local models.** Run against GGUF weights instead of a cloud API if you want to — `npm install node-llama-cpp` and set `LOCAL_MODEL_PATH`. It is optional precisely because most people don't.

---

## Project layout

```
src/
  converger/     the elicitation engine — turns a conversation into a workflow
  workflows/     execution engine — DAG executor, scheduler, node types
  connectors/    Slack · Google · Airtable · Notion · Web · Files — one catalog
  api/           HTTP spine (server.js) and the build/chat API (builder.js)
  auth/          argon2id auth, JWT sessions, workspaces, encrypted token vault
  rag/           per-workspace document knowledge
  llm/           model pool (cloud + local) and cost tracking
  admin/         operator console — usage and cost per workspace
  graph/ core/   the agent-graph runtime the converger is built on
public/          the entire frontend, one file, no build step
tests/           2,552 tests, ~8 seconds, no API key needed
```

---

## Contributing

Yes please — start with [CONTRIBUTING.md](CONTRIBUTING.md). It is short, and it carries the one habit this codebase depends on: **when you add a guard, put the bug back by hand and watch the test fail.**

[`docs/ENGINEERING-LOG.md`](docs/ENGINEERING-LOG.md) is worth reading even if you never write a line. It is an unusually honest record — every significant defect this project shipped, what it looked like to the person using it, what it actually cost, and the rule that came out of it. Most of them turn out to be the same few mistakes wearing different clothes.

Found a security problem? Please [report it privately](SECURITY.md) rather than opening an issue.

## Documentation

| Topic | Doc |
|---|---|
| Workspace isolation model | [architecture/multi-tenancy.md](docs/architecture/multi-tenancy.md) |
| Connector capability catalog | [architecture/connector-capabilities.md](docs/architecture/connector-capabilities.md) |
| Connecting services with no setup | [architecture/mcp-capability-adapter.md](docs/architecture/mcp-capability-adapter.md) |
| Local models + document knowledge | [capabilities/local-models-rag.md](docs/capabilities/local-models-rag.md) |
| Running Atlas as a metered service | [architecture/tier-gating.md](docs/architecture/tier-gating.md) |
| Deploying to a server | [deployment/vps-runbook.md](docs/deployment/vps-runbook.md) |
| Scaling beyond one process | [architecture/scaling.md](docs/architecture/scaling.md) |

## Licence

[GNU AGPL v3](LICENSE). Use it, run it, change it, freely.

The one obligation: if you run a **modified** Atlas as a network service for other people, you have to make your changes available to them. Running it for yourself or your own company, modified however you like, carries no such requirement.

---

<div align="center"><sub>Atlas · originally built by <strong>Agntic</strong> · Birmingham, AL</sub></div>
