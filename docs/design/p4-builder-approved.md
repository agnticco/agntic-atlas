# P4 Builder UI — Approved Design

**Approved:** 2026-06-17  
**Canonical source (current):** `docs/design/p4-export-2026-06-17/` — the three-screen
export from "Workflow Creation Demo Mockup (1).zip" (Builder, Draft Review, Live Dashboard
+ `INTEGRATION.md`). This **supersedes** the earlier single-file `p4-builder-final.dc.html`,
which is kept only as iteration history.

## Rebuild decisions (2026-06-17, post second-export review)

A prior session built a first P4 UI against the earlier export. After reviewing the newer
three-screen export, these decisions were made (and govern the rebuild):

1. **Rebuild `public/` fresh from the new export** — do not extend the first attempt.
2. **Live Dashboard is deferred to P5.** It is full live-run monitoring (metrics, run
   ledger, run-detail drawer), which the constitution assigns to P5. P4 keeps Build +
   Draft only; the "Live" state is a minimal *"workflow is live"* confirmation seeded from
   the just-created workflow — no run ledger/metrics in P4.
3. **Structural `edge` proposals are auto-accepted silently.** The converger proposes
   `edge` components ("connect A→B"); the UI confirms these automatically without a card.
   Operators only ever see trigger / action / delivery / name steps. (Aligns with the
   brief: "the operator never configures anything technical.")
4. **"Run test" runs the real engine and is required before publish.** The assembled spec
   is executed end-to-end via `POST /workflows/run` (real `FlowTester` through the engine);
   publish unlocks only on a passing run. This also satisfies the P4 gate's
   "the resulting spec runs on the execution engine."
5. **Login + first-run setup are in scope.** Every backend route is auth-gated and there is
   no default session, so the UI ships a login screen and a first-run admin/tenant setup
   screen (`GET /setup/status` → `POST /setup` / `POST /auth/login`).

### Converger contract the UI is wired to (NOT the REST guesses in INTEGRATION.md)

`INTEGRATION.md` assumes a per-workflow REST API (`/plan`, `/plan/step`, `/test`,
`/publish`, `/metrics`, `/runs`). That was the designer's guess; the real backend uses a
**session-based converger API**. The UI is wired to the real contract:

| UI action | Real call |
|---|---|
| Intent → first proposal | `POST /api/builder/sessions {intent}` → `{threadId, interrupt}` |
| Confirm / Change it / Not this | `POST …/sessions/:id/respond` `{type:'accept'}` / `{type:'modify',modification}` / `{type:'reject'}` |
| Clarification answer | `respond {type:'clarification', answer}` |
| Spec complete | converger raises `ratify {spec}` interrupt |
| Run test | `POST /workflows/run {spec}` → per-step `steps` + `deliveries` |
| Approve & go live | `respond {type:'approve'}` → `done {spec}` → `POST /api/builder/workflows {spec, intent}` |
| Revise / Keep building | `respond {type:'request_changes', feedback}` |

Interrupt types from `src/converger/`: `proposal {proposal:{component,rationale,spec}, step}`,
`clarification {question, step}`, `ratify {spec, step}`, terminal `done {spec, confirmationLog}`.

## What is approved (design language)

The interactive `.dc.html` prototype is the approved design for Phase 4. Build the Builder
screen against `docs/design/p4-export-2026-06-17/Atlas Builder (Skeleton).dc.html` and the
draft review against `Atlas - Draft Review.dc.html` as the canonical references.

## Layout

Three-panel shell inside a macOS-style window frame:

| Panel | Width | Collapsible | Contents |
|---|---|---|---|
| Left sidebar | 248px (collapsed: 56px) | Yes | Workflow list with status dots, "+ New workflow", Connections, user profile |
| Center | flex-1 | — | Conversation: Atlas proposes steps, user confirms |
| Right | 400px (collapsed: 52px) | Yes | Test environment: step-firing pipeline, output preview, Run test / See draft / locked state |

## Four modes (single surface, no page navigations)

1. **Build** — proposal/confirm conversation + right-panel test environment
2. **Draft** — full workflow review before go-live (Instrument Serif header, trigger→action→deliver nodes horizontal, sample trigger + Slack output side by side, "Approve & go live →" CTA)
3. **Live** — monitoring dashboard: runs today, success rate, avg latency, status tile, pipeline health, recent activity feed, latest output
4. **Connections** — connect/manage integrations (own mode, accessible from sidebar or profile menu)

## Converger contract (from the mockup tagline)

> "Atlas proposes one step at a time. Confirm, tweak, or undo any step — nothing goes live until you publish."

The proposal card shows: tag (TRIGGER / SUMMARIZE / DELIVER / FINISH), heading, spec pairs (key/value monospace), and three actions: **Confirm** · **Change it** · **Not this**. "Change it" opens an inline text field. Confirmed steps collapse to a slim green row with an Undo link.

## Design tokens

| Token | Value |
|---|---|
| App background | `#0A0A0A` |
| Title bar | `#0E0E10` |
| Sidebar | `#101012` |
| Border | `rgba(255,255,255,.07)` |
| Green (live / confirmed) | `#7fc28a` · glow `rgba(127,194,138,.X)` |
| Gold (proposal / pending) | `#f0bf6b` · text `#f3cd86` |
| Red (error) | `#e87461` |
| Primary CTA | `background:#fff; color:#0a0a0a` |
| Live CTA | `background:#7fc28a; color:#06210d` |
| Body font | Inter Tight 400/500/600 |
| Display font | Instrument Serif (workflow titles, page headers) |
| Code/spec font | ui-monospace / Menlo |
| Letter spacing (weight 500+) | `-0.01em` to `-0.03em` |
| Uppercase labels | `font-size:11px; letter-spacing:.2em; text-transform:uppercase; color:#6B6B6B` |

## Proposal card visual treatment

Frosted-glass panel: `backdrop-filter:blur(40px) saturate(140%)`, gradient border, top highlight stripe (`linear-gradient(90deg, transparent, rgba(255,255,255,.65), transparent)`), gold dot + tag label.

## Step flow (Build → Draft → Live)

1. Atlas greets → user types intent
2. Atlas proposes Trigger step → confirm/change/reject
3. Atlas proposes Summarize step → confirm/change/reject
4. Atlas clarifies channel (chip buttons) → proposes Deliver step → confirm
5. Atlas proposes name → confirm
6. Right panel: "Run test" unlocks → fires each step with status → shows Slack output preview → verdict
7. "See the draft →" → Draft mode (full review)
8. "Approve & go live →" → Live mode (monitoring dashboard)
