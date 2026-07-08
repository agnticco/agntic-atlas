# Support tickets — in-app feedback / bug reporting

End users submit **bugs / ideas / requests** from the operator app; the Agntic
team triages them in the admin app and hands each off to a coding agent (rich
Markdown brief or a one-click GitHub issue). Added 2026-07-08.

## Flow

1. **Operator app** (`public/index.html`) — a persistent floating **Feedback**
   button (bottom-right, every surface, authed only). Opens a modal: pick a type,
   fill a guided form (bugs get severity + expected/actual/steps), attach a
   screenshot (auto-captured via `html2canvas`, or paste/upload), submit →
   "Thanks — ticket #… received." Fire-and-forget (no user-facing status list).
2. **Auto-captured context** — an early ring buffer (`window.__atlasDiag`,
   installed in `<head>`) records the last 25 JS errors + failed `fetch` calls.
   On submit the client sends surface/phase/workflow id/URL/viewport/UA + those
   logs; the **server** stamps app version, workspace name, and receive time
   (can't be spoofed/forgotten).
3. **Submit endpoint** — `POST /api/tickets` (`src/api/tickets.js`, mounted in
   `server.js` via `mountTicketRoutes`, `requireActiveTenant`). Writes the
   screenshot under `./memory/tickets/<tenant>/<uuid>.<ext>`, inserts the row,
   best-effort team notify (Slack + email, env-gated, non-blocking).
4. **Triage (admin app)** — a **Tickets** view (`src/admin/index.html`) +
   endpoints in `src/admin/server.js`, all `adminOnly` (platform admin):
   - `GET /admin/tickets?status=&type=&tenant=` — list + counts (sidebar badge).
   - `GET /admin/tickets/:id` — detail incl. inline screenshot (data URL) + brief.
   - `PATCH /admin/tickets/:id` — status / triage notes.
   - `GET /admin/tickets/:id/brief` — the Markdown brief as a download.
   - `POST /admin/tickets/:id/github` — file the brief as a GitHub issue.

## Storage

- `TicketStore` (`src/support/ticket-store.js`) — own SQLite file
  `./memory/tickets/tickets.sqlite`. Fail-closed on tenant for `create` (modeled
  on `user-store.js`'s `requireTenant`); admin reads are cross-tenant **by
  design**, gated by `requirePlatformAdmin`. NOT to be confused with the unrelated
  dead-wired `src/workflows/feedback-store.js` (per-run feedback).
- `renderTicketBrief` (`src/support/ticket-brief.js`) — the coding-agent hand-off
  Markdown, shared by the admin export and the GitHub issue body.
- Screenshots + the DB live under `./memory/tickets/` (gitignored).

## Config (all optional — see `.env.example`)

| Var | Effect if unset |
|---|---|
| `SUPPORT_EMAIL` | no email notification |
| `SUPPORT_SLACK_CHANNEL` (+ `SLACK_BOT_TOKEN`) | no Slack notification |
| `GITHUB_REPO` + `GITHUB_TOKEN` | "Create GitHub issue" returns a clear "not configured" error; brief copy/download still work |
| `TICKETS_DB` / `TICKETS_DIR` | defaults under `./memory/tickets/` |

Without any of these the feature still fully works (store + admin triage +
Markdown brief). Screenshots are compressed client-side to JPEG (≤1600px, q0.72)
to stay under the 4 MB JSON body cap.
