# Atlas Builder UI — Claude Design Brief

Paste the brand kit HTML + this brief into Claude design and ask for a fully interactive artifact.

---

## The prompt to give Claude design:

---

You are designing **Atlas**, an AI workflow builder by Agntic. Build a **fully interactive desktop app mockup** in a single HTML file with working JavaScript — not a static screenshot.

---

### What Atlas does

Atlas lets non-technical business operators build automations by having a conversation. They describe what they want in plain English. Atlas proposes each piece of the workflow one at a time. The operator confirms, rejects, or tweaks each proposal. When all pieces are confirmed, they publish the workflow.

The operator never writes code or configures anything technical. Atlas handles all of that behind the scenes.

---

### The screen to design: The Builder

A two-column desktop app window (macOS chrome — traffic light buttons). This is the main surface of the product.

**Left column — Conversation (60% width):**
The chat thread between the operator and Atlas. Atlas speaks first with a friendly, plain-language question or proposal. The operator responds in the text input at the bottom. The conversation grows upward as the workflow is built step by step.

**Right column — Live Spec Panel (40% width):**
A live running view of the workflow being assembled. As each proposal is confirmed, a new step appears here. Steps have three visual states:
- **Confirmed** — green tint, checkmark
- **Pending** — amber tint, "waiting for confirmation"  
- **Upcoming (empty)** — dashed border, greyed out

The spec panel shows progress (e.g. "3 / 5 steps confirmed") and a progress bar. The "Publish workflow" button at the bottom unlocks only when all steps are confirmed.

---

### The proposal card (the core UI component)

When Atlas proposes a workflow step, it appears as a **proposal card** in the chat thread. Each card has:

1. **Tag line** — small eyebrow text showing what type of component it is (e.g. "Proposal · Trigger", "Proposal · Processing", "Proposal · Delivery"). Amber dot = waiting. Green dot = confirmed.
2. **Heading** — the plain-language name of the step (e.g. "Watch Gmail for UPS emails")
3. **Rationale** — one sentence explaining why Atlas is proposing this
4. **Spec detail** — a small dark panel showing key/value pairs in monospace (e.g. `filter: from:ups.com`, `channel: #social`). This is the technical detail, de-emphasized.
5. **Actions** — three buttons:
   - **Confirm** (primary pill button) — accepts the proposal as-is, turns the card green
   - **Change it** (ghost pill button) — opens a small inline text input asking "What would you like to change?" The operator types their change in plain English. Atlas proposes an updated version.
   - **Not this** (text link) — rejects entirely, Atlas will propose something different

When confirmed, the card transforms: actions disappear, a green "✓ Confirmed" badge appears, the card gets a green tint, and the step appears in the right spec panel.

---

### The interactive demo flow to build

Wire up a complete walkthrough of building the "UPS tracking email → Slack" workflow. The user clicks through it:

**Step 1:** Atlas opens: *"What should this workflow do?"*
**Step 2:** Operator types (or a pre-filled demo input): *"When a UPS tracking email arrives, summarize it and post to Slack"*
**Step 3:** Atlas responds and proposes the **email trigger** card (watch Gmail for from:ups.com)
**Step 4:** Operator clicks **Confirm** → card turns green, trigger appears in spec panel
**Step 5:** Atlas proposes the **summarize** step card
**Step 6:** Operator clicks **Change it** → types "make it more concise" → Atlas updates the card
**Step 7:** Operator clicks **Confirm** → step 2 appears confirmed in spec panel
**Step 8:** Atlas proposes the **Slack delivery** card (#social channel)
**Step 9:** Operator clicks **Confirm** → step 3 confirmed
**Step 10:** Atlas proposes the **workflow name** ("UPS tracking email → Slack")
**Step 11:** Operator confirms → all 4 steps confirmed, progress bar fills, "Publish workflow →" button unlocks
**Step 12:** Operator clicks **Publish** → success state: green glow, "Workflow is live" message, running status dot activates

Include a **"Run demo →"** button at the top that auto-plays the whole flow with 1.2s pauses between steps, so it can be shown without clicking.

---

### Design language — apply exactly

**Colors (do not invent new ones):**
- Background: `#000000`
- App surface: `#0A0A0A` (Ink)
- Panel/sidebar: `#121214`
- Dividers/borders: `rgba(255,255,255,.08)` — `rgba(255,255,255,.14)`
- Muted text: `#6B6B6B` (Ash), `#8A8A8A`
- Body text: `rgba(255,255,255,.82)`
- Status green: `#7FC28A` (confirmed, live, online) — with glow `0 0 8px rgba(127,194,138,.55)`
- Status amber: `#F0BF6B` (pending, in-progress) — with glow `0 0 8px rgba(240,191,107,.55)`
- Warm off-white: `#F5F4F0` (Paper) — use for hover highlights on dark backgrounds only

**Liquid glass surface** (use for proposal cards and the spec panel):
```css
background: linear-gradient(170deg, rgba(255,255,255,.16) 0%, rgba(255,255,255,.04) 40%, rgba(255,255,255,.08) 100%), rgba(18,18,20,.42);
border: 1px solid rgba(255,255,255,.14);
backdrop-filter: blur(40px) saturate(140%);
box-shadow: 0 24px 48px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.22);
```
Always add a bright top crest (1px gradient line at top of glass cards):
```css
/* ::before pseudo or absolute div */
top: 0; left: 14%; right: 14%;
height: 1px;
background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
```

**Typography:**
- Font: `Inter Tight` (import from Google Fonts, weights 400 and 500)
- Accent: `Instrument Serif` italic — use ONLY for the occasional editorial word (e.g. *"now"*, *"intent"*)
- All text: `letter-spacing: -0.005em` baseline; headings tighter
- Eyebrow labels: `font-size: 11px; font-weight: 500; letter-spacing: .22em; text-transform: uppercase; color: #8A8A8A`
- Eyebrow always has a leading hairline: `— ` (18px wide, 1px, opacity .5) before the text

**Buttons:**
- ALL buttons are full-radius pills (`border-radius: 999px`)
- Primary (on dark): `background: #fff; color: #0A0A0A; padding: 10px 22px; font-weight: 500`
- Ghost: `border: 1px solid rgba(255,255,255,.14); color: rgba(255,255,255,.75)`
- Text link: no border, `color: rgba(255,255,255,.5)`
- Never square buttons

**Logo mark:** Display `[ ]` (the bracket) + `atlas` wordmark in Inter Tight 500, `letter-spacing: -0.03em` in the sidebar header.

**Status dots:** `width: 7px; height: 7px; border-radius: 50%` with the appropriate glow. Green = confirmed/live. Amber = pending. `rgba(255,255,255,.3)` = idle.

---

### Sidebar (left, fixed 220px)

- Logo at top: `[ ] atlas`
- Section label "Workflows" (eyebrow style)
- List of workflow items, each with a status dot + name. Active item has subtle white background.
- Section label "Connectors" — shows connected apps (Slack with ⬛ icon, Gmail with ✉)
- "+ New workflow" primary pill button at the bottom

---

### Key UX rules for Atlas (non-technical operators)

1. **Plain language always.** Never show raw config keys in primary text. "Watch Gmail for UPS emails" — not "trigger: email, filter: from:ups.com". The spec detail panel can show technical values but they're secondary/small.
2. **One proposal at a time.** Never show more than one pending proposal card. Atlas is patient.
3. **Show the work being built.** The spec panel on the right updates in real time as steps are confirmed. The operator always sees the whole picture and the current step.
4. **The operator is always in control.** Every Atlas proposal is a question, not a declaration. The three actions (Confirm / Change it / Not this) are always visible on pending cards.
5. **Transitions matter.** Confirming a step should feel satisfying — a smooth green transition, the step sliding into the spec panel, a brief "✓" animation.

---

### Deliverable

A single self-contained HTML file. No external dependencies except Google Fonts. All CSS inline or in a `<style>` block. All JS in a `<script>` block. The full interactive flow must work by clicking through, plus the auto-play demo button.

---
