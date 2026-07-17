# Builder chat UI — the design system, and the decisions around it

**Source of truth:** the handed-off element pages (`Chat - *.dc.html`, `Node System.dc.html`,
`Workflow Assembly.dc.html`), delivered 2026-07-17. Working copy:
`tmp-g-verify/ui-design/` (gitignored scratch — re-unzip from the operator's zip if lost).

**All copy in those files is DEMO FILLER.** Never hardcode it. The elements are the contract.

`uploads/builder-cot-lanes-design-brief.md` inside the zip is an **EARLIER iteration** and is
**stale** — it puts the reasoning stream in the right panel and says to refine `isSignalLine`
in place. Both were superseded. Read it for tokens/principles only.

## What is LOCKED

9 of 12 element pages carry a `LOCKED` marker: Reasoning Stream (`isReasoning`, variant 3a),
Plan Gate (`isPlan`), Clarify (`isClarify` — a **SET of 3** forms, chosen per question type),
Atlas Message (`isAtlas`+`hasReason`), User Message (`isOperator`), CTA/Note (`isCta`/`isNote`),
Action Confirm (`isActionConfirm`), Greeting (`isGreeting`), Thinking (`isLoading`, variant 1a —
its many "variants" are a LABEL SCRIPT, not designs).

`Node System`, `Live Graph` and `Workflow Assembly` carry **no LOCKED marker**. Treat the node
**vocabulary** (Node System) as settled; the graph **harness** as guidance.

## Node vocabulary (Node System — authoritative)

The rule, stated by the design: **capsules start and end, squares process, diamonds decide,
circles wait on people.**

| Type | Tag | Shape | Icon | Accent |
|---|---|---|---|---|
| trigger | `TRIGGER` | capsuleL | `icoBolt` (email → `icoMail`) | amber; no in-port |
| llm | `LLM · SUMMARIZE/EXTRACT/REWRITE/FREEFORM` | square | `icoSpark` | neutral |
| llm classify | `LLM · CLASSIFY` | square | `icoFork` | neutral |
| branch | `BRANCH` | diamond | `icoSplit` | amber; N out-ports |
| decision | `DECISION` | diamond | `icoGrid` | amber |
| human | `HUMAN` | circle | `icoPerson` | amber; **holdBadge** |
| foreach | `FOREACH` | square, dashed stroke | `icoLoop` | neutral |
| assemble | `ASSEMBLE` | square | `icoLayers` | neutral |
| connector-action | `CONNECTOR-ACTION` | square | `icoPlug` (CRM/airtable/sheet → `icoDb`) | neutral |
| search_web | `SEARCH_WEB` | square | `icoGlobe` | neutral |
| deliver | `DELIVER` | capsuleR | `icoSend` | green; no out-port |
| **stop** | `STOP` | **capsuleR, muted/outlined** | `icoStop` | neutral; **no out-port** |

`_nodeShape()` in `public/index.html` already derives most of this, including the contextual
icons — largely a re-skin, not a rebuild.

## Decisions (operator, 2026-07-17) — these override the files where they conflict

1. **NOTHING ABOUT WORKFLOW SHAPE IS HARDCODED.** *"Workflows take all shapes and sizes…
   The workflow should take exactly the shape that the converger builds."* The design's
   fan-out is drawn with **literal 2-lane SVG paths and a fixed 236px height** — that is a
   DRAWING OF ONE EXAMPLE, not a constraint. Implement the design's visual LANGUAGE (curve
   style, arrowheads, italic amber lane labels, per-lane colouring, shape-per-role) as a
   **generic renderer** that lays out whatever graph arrives — 2 lanes, 3, 5, nested. The same
   workflow-agnostic rule the backend lives by, applied to the UI.
2. **Reasoning Stream: prose only.** The LOCKED design has **no beats** — no `read`/`wire`/
   `fix`/`check` chips (proof of absence: no design file mentions them). Ship the iris header +
   flowing first-person prose + blinking caret, collapsing to "How Atlas thought through this
   build ▸". The backend keeps emitting beat kinds (harmless); the UI renders only prose.
3. **`isSignalLine` is RETIRED.** The Live Graph is the only step surface. (The stale brief said
   "refine it in place, do not add a new card kind" — superseded.)
4. **Per-node hover confirm/reject WINS** over the earlier "one OK" model. Nodes stream in;
   the proposed node reveals confirm/reject on hover; confirm advances; reject stops and asks
   for a note in chat (`explaining`). Footer: "N / M APPROVED · hover a node to confirm or reject".
5. **`stop` is KEPT and gets a design.** Node System says "no abstract finish marker — the last
   real step is the end", but `stop` is load-bearing: it is what makes "ignore this input"
   actually do nothing (it exists because the converger otherwise invented a delivery for an
   ignore lane — a silent violation of user intent). Render it in the design's language: a
   terminal **capsule-right like deliver, but muted/outlined rather than green, no out-port**.

## What is BUILT (2026-07-17, verified headed)

- **Dotted chat surface** — the design's exact token.
- **Reasoning Stream** (`isReasoning`) — iris header + "Building…" + live streamed prose +
  caret, collapsing to "How Atlas thought through this build". Prose only, no beats.
- **Live Graph** (`isLiveGraph`) — assembles in the chat under the CoT as the converger
  writes it. Shape-per-role from the Node System catalog. Per-node hover confirm/reject;
  confirm advances with the 560ms green flash; the last confirm sends the accept and the
  right panel flips to Ready-to-test. Reject opens a note → `request_changes`.
  **Lanes** derived from the spec's real edges (any count, any depth), labelled in the
  plan's plain words. `stop` renders as the muted terminal.
- **Retired**: the pinned graph band and `isSignalLine`.
- **Right panel** — contract + test only.
- **CoT persistence** — `build_reasoning` on the workflow row.

Deliberate deviation from the design file: **every streamed node is visible** (dim ahead
of the approval cursor) rather than hidden. The demo hides them because it replays a
canned build; here the user approves a REAL graph and must see what they are confirming.

## Backend gaps the design implies

- **Edges + lane grouping during streaming.** `node` beats carry `{id,type,label,mode,description}`
  only. Edges exist ONLY in the final spec, so a live graph cannot draw real connections until
  the end. Decide: derive client-side, add to the beat, or accept a degraded live view.
- **Plain-language lane labels** ("if it's a lead"/"otherwise"). Branch cases carry raw enum
  values today (`needs_alert`).
- **Per-node approve/reject round-trip** — the design's core interaction is per-node; the
  current live strip is a progress view whose approval only arrives on completion.
- **`holdBadge`** for `human` nodes is mandated by Node System but absent from Live Graph.
- **Clarify question type** — the backend must say WHICH of the three locked forms to render
  (single / multi / single+write-in), plus per-option `desc` for the explanation form.
- **Plan Gate provenance chips** (`YOU SAID` / `I FOUND` / `I INFERRED`) — already shipped and
  working; keep.
- **Settled-stream tense** — the design's streaming copy is future tense, the collapsed copy
  past tense. Whether a rewritten past-tense summary is expected is UNRESOLVED; do not invent one.

## The empty-CoT bug (diagnosed 2026-07-17)

The BACKEND IS HEALTHY. Proved directly against the real functions: `openReasoningHub` +
`narrate` buffer all kinds (thinking/node/check) and the `node` beat carries its payload; the
SSE endpoint replays the buffer then subscribes; the hub only closes on `done`. The fault was
CLIENT-SIDE — the improvised in-chat block never bound to `state.reasoningSegs`. The Reasoning
Stream rewrite should fix it by construction; verify segs actually render.
