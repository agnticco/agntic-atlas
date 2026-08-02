# Demo elements — extraction brief

**Purpose.** Render individual Atlas UI elements in isolation, for a demo reel or deck,
instead of screen-recording the whole build. Each element below is one beat of the
build process and can stand alone.

**Everything here is extracted from the live product** (`public/index.html`, prod
2026-08-02) — real copy, real tokens, real states. Do not invent values; if something
isn't specified below, ask rather than guess, because the point of rendering these is
that they match what a customer actually sees.

---

## Design tokens (real)

**Typefaces**
- Display / headings: **Instrument Serif** (Georgia, serif fallback)
- UI / body: **Inter Tight** (-apple-system fallback)
- Monospace / labels: **JetBrains Mono** — used for small uppercase meta labels
- Signature ("Atlas" on the plan card): **Dancing Script**

**Surface**
- Page background `#0A0A0A`
- Card background: `linear-gradient(170deg, rgba(255,255,255,.05), rgba(255,255,255,.015))`
- Card border `1px solid rgba(255,255,255,.10)`, radius `20px`
- Body text `rgba(255,255,255,.6)`; strong text `#fff`; faint `rgba(255,255,255,.32)`

**Accents — each means one thing, do not mix**
| Token | Hex | Means |
|---|---|---|
| Sage | `#9fd6a8` | kept / passed / verified |
| Green | `#7fc28a` | live, active, confirmed tick |
| Clay | `#f0a896` | broken, contract not met |
| Amber | `#f3cd86` | draft, awaiting approval, in progress |
| Coral | `#e87461` | paused |
| Dim | `rgba(255,255,255,.35)` | not exercised / not yet run |

**House style:** dark, quiet, editorial. Small uppercase mono labels over serif
headlines. Generous whitespace. No drop shadows, no gradients on text, no blue.

---

## The elements, in build order

### 1 — The opening composer
Centred wireframe globe, serif H1 **"What would you like to automate?"**, a single
rounded input with placeholder *"Describe what you want to automate…"* and a `›` prefix.
Three suggestion pills beneath: *"Post a daily briefing to a Slack channel"*,
*"Summarize unread emails every morning"*, *"Research a topic and compile a report"*.

### 2 — The clarifying question
A chat exchange. User bubble (lighter, right-aligned); Atlas reply left-aligned with a
thin left rule, no bubble. Real copy:

> **User:** Keep me in the loop on what competitors are shipping.
> **Atlas:** Happy to help with that! A few quick questions to make sure I build the right thing:
> Which competitors do you want to track — do you have a list of company names or websites in mind?

### 3 — The build offer + button
Atlas's restatement followed by a single pill button **"Build it →"** in sage/green.

> Every Monday morning, I'll search the web for recent product updates, new features, and
> releases from Zapier, Make, and n8n — then compile everything into a new Google Doc with
> a summary for each competitor, so you have a clean weekly read. Want me to set that up?

*Note: the button only ever appears attached to an offer — never render the offer without it.*

### 4 — The plan card  ← **hero element**
A document-styled card. Mono label **`OPERATING PROCEDURE`** top-left, **`5 STEPS`** right.
Serif purpose paragraph. Then labelled rows in mono small-caps:
`PURPOSE` · `TRIGGER` · `PROCEDURE` · `ON FAILURE`, values in body text.
Procedure steps numbered `01`–`05` with the number in dim mono.
Bottom right: `PREPARED BY` and **Atlas** in the script face, over a thin rule.
Footer buttons: **"Approve & build →"** (amber, filled) and **"Request a change"** (outline).

Real content: trigger *"Every Monday at 8:00am America/Chicago"*; steps 01–03 are the
three competitor searches, 04 compiles, 05 creates the dated Doc; ON FAILURE reads *"If a
web search returns no results for a competitor, that section will note that no updates
were found rather than failing the whole workflow."*

### 5 — The step diagram
A horizontal row of rounded-square nodes joined by thin arrows, left to right. Each node:
an icon, a clipped name beneath (~18 chars, ellipsis), and a mono uppercase type label.
Real labels in order: `STARTS IT` · `CONNECTED APP` · `CONNECTED APP` · `CONNECTED APP` ·
`AI WRITES IT` · `AI WRITES IT` · `SENDS IT`.
Two states worth rendering: **unconfirmed** (dim) and **confirmed** (small green tick,
bottom-right of the node).
Below: a progress bar and the status line **`7 / 7 APPROVED · every step approved`**.

### 6 — The step-approval card  ← **hero element**
Sits under the diagram. Mono position label **`STEP 4 OF 7`**, then the step's **full,
untruncated** name in serif, a one-line grey subtitle of what kind of step it is, a
plain-language sentence, then a two-column fact table (dim mono key, body value).

Render two variants:
- **AI step** — facts: `Instruction` (multi-line), `Length`, `Style`
- **Delivery step** — facts: `Sends to` → *"a new Google Doc"*, `Subject / title` →
  *"the result of 'Compile competitor updates'"*

*Critical: no raw identifiers and no `{{templates}}` on this card — a reference is always
described in words. That is the whole point of the screen.*

### 7 — The contract panel  ← **the differentiator, render all four states**
Right-hand panel. Serif headline pairs a roman word with an italic verdict:

| State | Headline | Accent | Primary CTA |
|---|---|---|---|
| Proposed | Contract *proposed.* | dim | Run the test |
| Kept | Contract *kept.* | sage `#9fd6a8` | **Go live** |
| Not verified | Contract *not verified.* | dim | Try a real example |
| Not met | Contract *not met.* | clay `#f0a896` | Fix & re-test |

Below the headline: a one-sentence verdict note, then `THE DEAL` (the promise in the
user's own words, with key phrases underlined), then `THE EVIDENCE · 1 REAL EXAMPLE` —
a list of rows each with a mark: `✓` kept (sage), `!` broken (clay), `○` not exercised (dim).

Real verdict notes:
- kept — *"We ran 1 real example through your workflow. Every promise held — it's cleared to go live."*
- not verified — *"Nothing broke, but nothing was proved either."*

### 8 — The live dashboard header
Serif workflow title, a green `● active` chip, and a clock glyph with
*"Scheduled — Every Monday at 8:00 AM CDT"*. Right-aligned buttons: **▶ Run now**,
**❙❙ Pause**, **Edit workflow**. Beneath, a strip: run count, error count, and
*"not yet run live · 1 test run"*.

---

## The prompt to hand the design agent

> You are designing isolated UI elements for Atlas, a conversational workflow builder.
> I will render these individually for a product demo — each must stand alone on a dark
> slide, not as part of a full screenshot.
>
> Use ONLY the design tokens and copy in the attached brief. Every string is real product
> copy; do not paraphrase, shorten, or invent. If a value isn't in the brief, ask me —
> do not fill the gap.
>
> House style: dark (`#0A0A0A`), quiet, editorial. Instrument Serif for headlines, Inter
> Tight for UI, JetBrains Mono for small uppercase labels. No shadows, no blue, no
> gradients on text. Colour carries meaning — sage means proved, clay means broken, amber
> means awaiting a person, dim means not yet exercised. Never use an accent decoratively.
>
> Produce each element as a self-contained HTML block with inline CSS, sized to sit on a
> 1600×900 slide with generous margin, transparent or `#0A0A0A` background.
>
> Start with element 7, the contract panel, in all four states — it is the one that
> carries the product's argument. Then 4 and 6.

---

## Two things to decide

1. **Which elements make the cut.** 4, 6 and 7 carry the story (the plan, the human
   check, the verdict). 1, 2 and 3 are the opening. 5 and 8 are context. Rendering all
   eight is probably more than a demo needs.
2. **Whether the four contract states appear together.** Showing *kept* beside *not met*
   and *not verified* on one slide is the strongest single frame in the whole set — it is
   the claim that the product refuses to certify what it did not check.
