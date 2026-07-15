# Builder node-canvas — implementation brief

Implements the Claude Design "Atlas Flow Builder UI" into `public/index.html`. Additive UI
work on branch `feat/builder-node-canvas`. Companion design source: the design project's
`Node System.dc.html` (component spec) + `public/index.html` (integrated demo, rough — the
mid-build branches are a hardcoded demo seed, see "Reality check"). A truncated copy of the
design's integrated template is on disk at
`<scratchpad>/design-index.html` (first 2068 lines — the canvas + detail + thinking-stream
markup is all within it: canvas `589–682`, detail card `684–735`, thinking stream `877–941`).

## CORRECTION (operator, 2026-07-15) — branches are NOT deferrable; demo-gate the mock

Stages A–C shipped a flat linear rail and deferred all branch fan-out to "F". **That was the
wrong cut.** Rendering a branching workflow as a flat rail in the converger's node-array order
misrepresents it (e.g. `name → classify → summarize → extract → create-CRM → branch → deliver`
reads as nonsense — the non-lead `summarize` sits between two lead-path steps, and the branch
lands after the steps it splits). For the workflows that actually branch — the whole point — the
canvas must draw the real graph, or it's actively misleading, not merely incomplete.

**The fix is frontend-only for a COMPLETED draft:** once the draft is done (or a saved workflow
is reopened), `this.state.spec.{nodes,edges}` exists client-side, so the true graph can be laid
out with no backend. Two changes, now (not "later"):
1. **Real graph layout.** When `state.spec` has nodes+edges, render the canvas FROM THE SPEC:
   trunk (entry → … → the branch/decision node) as `item.mainNodes`, and each branch case as a
   labeled lane in `item.branches[]` (un-gate `hasBranches`/`fan2`). During BUILDING (no spec yet)
   keep the incremental linear rail from `steps` — that's honest because the draft isn't complete.
2. **Demo-gate the reasoning.** `_rsnSegs()` mock only renders when `window.__ATLAS_DEMO__` is set.
   A real build shows the RESTING placeholder during building (never fabricated streaming beats).
   The live feed replaces it later (backend). Showing hardcoded lead-router narration next to a
   real, different build is misleading and must not happen.

(The converger's own junk output — orphaned `classify`, a "Remove a connection" plumbing node —
is a SEPARATE pre-existing backend problem the UI merely renders; not in scope here.)

## Reality check (scout recon, 2026-07-15) — READ FIRST

During the **building** phase the client has **only a flat, ordered `steps` array** on the active
signal-line message. There is NO graph, NO edges, NO branch/case membership:
- `state.spec` is set only at `iv.type === "done"` (`index.html:4737`); it's `null` throughout building.
- Edge proposals are **streamed but discarded** — `index.html:5070` auto-accepts `component==="edge"`
  with no render and no state capture.
- Step objects carry NO `type`/`mode`/`component`; `_humanStep(p)` (`5224–5285`) converts the spec
  to plain `title`/`desc`/`prompt` and throws the spec away.
- Even post-`done`, `_pipeline()`/`_draftNodes()` (`5810–5823`) iterate `sp.nodes` in array order and
  never read `sp.edges`.

**Consequence:** branch lanes cannot be drawn *during* build without backend changes. So:
- **Linear rail while building** (all the client knows), **full branched graph once `state.spec` exists**
  (`phase==='proposed'`), laid out from `spec.{nodes,edges}`.
- Mid-build branches = a **backend follow-up** (surface the swallowed edges through the stream +
  accumulate client-side). Same bucket as the live reasoning feed.

## Architecture decision

Build the canvas + reasoning view-models in **`renderVals()`** (where `testSteps` and `contract`
are already built — `~6215–6252`, `_contractPanel()` at `6102`), NOT in `_withParts`. Rationale:
handlers on steps are live closures from construction (`5134–5162`); `_withParts` (`2680–2716`) has
no signal-line branch and localStorage-restored steps are inert anyway (`3533`). Deriving the canvas
VM each render from `message.steps` + a per-message `_selNode` avoids the whole reattachment problem.

- **Selection state:** store `_selNode` (a step id) on the signal-line message. `onSelect = () =>`
  setState that updates that message's `_selNode`, default = the active/proposed node. `item.sel` =
  the selected step's detail VM (title/desc/prompt/isConfirmed/isActive/onConfirm/…, plus `num`,
  `typeLabel`, `detailTypeColor`). The detail card reuses the existing step handlers verbatim.
- **Preserve node type onto steps:** at the two step-construction sites (`5081–5096` setup,
  `5134–5145` normal) add `nodeType` and `mode` captured from the proposal — `_humanStep` already
  reads `p.component` / `s.type` / `effNodeType(s)` (`2445`) / `s.config`; capture `effNodeType(s)`
  → `step.nodeType` and `s.config?.mode` → `step.mode`. (Small, additive.)

## Node → shape / icon / color map (from Node System.dc.html)

Shape encodes role. Sizes: square 54px r13; diamond 42px r10 rotate(45)/unrotate; circle 52px r50%;
capsuleL r`27px 13px 13px 27px`; capsuleR r`13px 27px 27px 13px`. Icons are inline SVGs already in
the design dump (`icoMail/icoFork/icoDoc/icoDb/icoInbox/icoGear/icoSpark/icoSplit/icoPerson`) and
the fuller Node System set (`icoBolt/icoLayers/icoPlug/icoGlobe/icoSend/icoLoop/icoGrid`).

| node type | shape | icon | accent | typeLabel | notes |
|---|---|---|---|---|---|
| trigger (email) | capsuleL | mail (or bolt) | amber `#efc892` | `TRIGGER` | no in-port; leading bolt glyph precedes it |
| trigger (schedule/event) | capsuleL | bolt/gear | amber | `TRIGGER` | |
| llm summarize | square | spark | white `.75` | `LLM · SUMMARIZE` | |
| llm extract | square | doc | white | `LLM · EXTRACT` | |
| llm rewrite | square | gear | white | `LLM · REWRITE` | |
| llm freeform | square | spark | white | `LLM · AI STEP` | |
| llm classify | square | fork | white | `LLM · CLASSIFY` | only AI output a branch may route on |
| branch | diamond | split | amber | `BRANCH` | two out-ports; fan-out to lanes |
| decision | diamond | grid | amber | `DECISION` | rules table |
| human | circle | person | amber | `HUMAN` | **holdBadge** (red pulse) while proposed/awaiting |
| foreach | square (dashed) | loop | white | `FOREACH` | dashed border = repeated region |
| assemble | square | layers | white | `ASSEMBLE` | |
| connector-action | square | plug (db for CRM write) | white | `CONNECTOR-ACTION` | |
| search_web | square | globe | white | `SEARCH_WEB` | engine-only; converger won't emit |
| deliver | capsuleR | send (inbox for inbox) | green `#9fd6a8` | `DELIVER` | terminal, no out-port |

**State styling** (per node, from `_animNode`/`stateChips`):
- upcoming: border `rgba(255,255,255,.12)`, bg `.02`, fg `.35`, no anim/check.
- proposed/active: border `rgba(231,178,94,.5)`, bg `rgba(231,178,94,.07)`, fg `#efc892`,
  `animation:breatheAmber 2.4s ease-in-out infinite`, no check.
- approved: border `rgba(255,255,255,.22)` (or keep accent), bg `.03`, fg `.8`, **green check badge**
  `#5fc78a`.
- break/fail: border `rgba(232,116,97,.5)`, bg `.06`, fg `#f0a896`, red `!` badge.
- human hold: red `holdBadge` pulsing (`holdPulse`) until cleared → replaced by check on approve.
- confirm flash: one-tick green border + connector (`#5fc78a`).
- connectors/arrows: pending dim `.14` → confirmed amber `rgba(231,178,94,.5)` → flash green.

## Thinking stream (right panel) — `rsn` VM

Template `877–941` (design dump). `rsn = { show, resting, streaming, collapsed, segs, bodyRef,
onToggle, open, toggleLabel, chev }`. `segs` = ordered list; each `g` is:
- prose: `{ isProse:true, parts:[{t,w,c}], caret }`
- beat: `{ isBeat:true, kind, bg, border, anim, isCheck, icon, iconColor, iconStatic, textColor,
  parts:[{t,w,c}], detail, chipFg, chipBg, chipBorder, caret }`
Beat kinds → styling: `read` (chip on the count), `wire` (amber), `fix` (amber pulse, "caught &
handled", never red), `check` (green, drawn check `rsnCheckDraw`). Right panel is empty during
building today (`_contractPanel` returns `{show:false}` — `6120`), so the stream naturally owns that
space. **Stage C ships a realistic MOCK `segs`; the live streamed feed is the backend follow-up.**

## Keyframes to ADD (near `index.html:100–117`)

`holdPulse`, `rsnCheckDraw`, `fadeUp` (missing). Existing and reused: `msgIn`, `breatheAmber`,
`flowPulse`, `cpBlink`, `slPopIn`, `slFlash*`, `liveRing`.

## Stages

- **A** — keyframes (DONE); preserve `nodeType`/`mode` onto steps; canvas VM = a **linear rail**
  (nodes in step order) for BOTH building and complete phases — **no branch fan-out yet** (it needs
  edges, which are phase F). Swap the `isSignalLine` template (`570–677`) for the canvas markup, but
  render only `item.mainNodes`; keep the branch markup present and gated OFF (`item.hasBranches` /
  `item.fan2` = `false`). Deliver = green terminal node; everything reads as one horizontal rail.
- **B** — selection (`_selNode` + `onSelect`) + detail card wired to existing handlers.
- **C** — `rsn` VM + thinking-stream template in the right panel, with mock `segs`.
- **D** — polish; fix demo node breakage; verify all node types render.
- **E** — headed browser verification (operator watches; `?demo` seeds the mock lead-router — the
  design added `window.__ATLAS_DEMO__`, useful for isolated testing).
- **F (backend — COMMITTED, after frontend; operator 2026-07-15):** two pieces, done once A–E land:
  1. **Branch fan-out (all of it)** — surface the edges currently swallowed at `index.html:5070`
     (and branch/case membership) through the SSE proposal stream; accumulate a running
     `{nodes,edges}` client-side. Then the canvas draws lanes both *during* the build AND on
     completion (same layout code, since edges are now client-side throughout). Un-gate the branch
     markup (`item.hasBranches` / `item.fan2` / `item.branches`) that stage A leaves stubbed. Lane
     labels humanize the branch node's `cases[].when` (`*` → "otherwise", else "if it's a <when>").
  2. **Live reasoning feed** — stream the model's genuine (guardrailed) reasoning into `rsn.segs`,
     replacing the mock. Prompt instruction (plain first-person + typed beats) in
     `src/converger/prompts.js`; redaction map scrubs confusing ids/codes, keeps the trust beats;
     SSE plumbing in `src/api/builder.js` streams into the `rsn` state field the frontend ships.

## Icon SVGs (the 7 not present in the design dump's canvas loop)

The design dump (`<scratchpad>/design-index.html`) canvas loop already contains
`icoMail / icoFork / icoDoc / icoDb / icoInbox / icoGear / icoSpark / icoSplit / icoPerson`. The
remaining node types need these (from `Node System.dc.html`; `width="20" height="20"` or match the
loop; amber/white/green per the map). `fill="currentColor"` for bolt, else `fill="none"
stroke="currentColor" stroke-width="1.7"`:
- **bolt** (trigger): `<path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z"/>` (fill=currentColor)
- **layers** (assemble): `<path d="M12 2 2 7.5 12 13l10-5.5z"/><path d="M2 12.5 12 18l10-5.5"/><path d="M2 17.5 12 23l10-5.5"/>`
- **plug** (connector-action): `<path d="M9 7V3M15 7V3"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>`
- **globe** (search_web): `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.7 2.6 4 5.7 4 9s-1.3 6.4-4 9c-2.7-2.6-4-5.7-4-9s1.3-6.4 4-9z"/>`
- **send** (deliver): `<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>`
- **loop** (foreach): `<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`
- **grid** (decision): `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M12 3v18"/>`

## DC-framework gotchas (CLAUDE.md)

`sc-if`/`sc-for` with `{{ }}`; global `sc-if,sc-for{display:none}` guard (no `{{ }}` in `<img src>`
or `background:url()`); match existing event-attr casing; NO NUL bytes; keep both light/dark
(`:root` `80–89`). Don't touch the contract panel / `testSteps` bindings. Verify headed, not just
"scripts pass".
