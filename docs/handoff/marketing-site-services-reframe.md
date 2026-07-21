# Marketing-site reframe — retire the product site, fold Atlas into agntic.co (SUB-PLAN)

> **⚠️ REVERSED IN PART, 2026-07-21 (operator).** **atlasbyagntic.com is NOT retired — it is
> live again.** The operator decided not to commit to the services pivot: Atlas stays a
> product in its current state, it simply cannot be bought self-serve, and consulting
> engagements are an option alongside it rather than a replacement for it. So the
> redirect-only bundle was replaced by a redeploy of `AGNTIC/website/atlas-landing/`, with the
> July-30 countdown, the four priced tiers and the whole `PRICING_MODE` flip **deleted** (the
> countdown flips itself to "We're live — sign-up is open" once the launch instant passes, so
> leaving it would have started lying on a timer). The pricing section is now one static
> "Atlas is set up with you" block: no prices, no dates, CTA opens the enquiry modal.
> In the app, self-serve signup is gated on Stripe being configured (see CLAUDE.md,
> "Self-serve is OFF"). **Everything below about agntic.co itself still stands** — only the
> retirement of the product site is reversed.

> **SHIPPED 2026-07-21.** agntic.co (Pages project `web`, source `AGNTIC/website/landing/`)
> is live with the reframed site and diverged from this plan in ways the operator directed
> live: the homepage is an **all-black, full-viewport, snap-scrolling** page = hero → a
> **founder story** ("I've been on both sides of this," with the operator's photo,
> `assets/charles-crepps.jpg`) → a centered book-a-call closer. Hero copy is now
> "save money and scale by automating…". **Our Work** shipped with FIVE entries: a
> first-person client story (`work/online-sales-scorecard.html`, with an anonymized real-UI
> screenshot — the online-sales dashboard rendered on fully scrubbed data) + four
> "Capability" cards linking the softened legacy showcase pages. Atlas page sunset (redirects
> to `/`); operations.html + our-tech.html sunset. **atlasbyagntic.com RETIRED 2026-07-21** —
> a redirect-only bundle (`AGNTIC/website/_atlas-retire/`: `_redirects` `/*  https://agntic.co/
> 301` + meta-refresh index) deployed to project `atlas-by-agntic`; every path now 301s to
> agntic.co (verified). Pre-deploy `.bak` backups moved to `AGNTIC/website/_predeploy-backups/`.


**Sub-plan of** [`services-pivot-plan.md`](./services-pivot-plan.md). **Independent of all
product refactor work — ships first, on its own, to unblock outbound.**

**Repo (separate from Atlas, and messy — many stale zips/archives):**
`/Users/crepps/Desktop/AGNTIC/website`. Two live sites live in sibling folders:
- `landing/` → **agntic.co** — the company/consulting site. **This is the front now.**
- `atlas-landing/` → **atlasbyagntic.com** — the standalone Atlas *product* site. **Retire it.**
- `worker/` → Cloudflare Worker `agntic-booking` (Google Calendar + D1 CRM) — the booking
  backend both sites already use. **Keep, no changes.**

Neither `landing/` nor `atlas-landing/` is under git (no VCS on the sites) — take a manual dated
copy before editing.

---

## The decision (operator, 2026-07-20, REVISION 2 — supersedes below)
**Positioning (the anchor for everything):** Agntic is an **operations consulting firm that uses AI
but is NOT AI-forward.** AI is behind the curtain; the work and the business outcomes are in front.
Never lead with "AI"; lead with the operational problem solved and the result.

Concrete direction:
1. **Retire the product site** `atlasbyagntic.com` (301 → agntic.co). Unchanged.
2. **SUNSET the Atlas page entirely** (`landing/atlas.html`) — the marketing agent's earlier rebuild
   of it is discarded. There is no Atlas page in the nav. (Reverses REVISION 1's "fold Atlas in".)
3. **The nav slot where "project atlas" pointed becomes "Our Work"** → a new blog-style section at
   `/work` where the operator posts things the firm builds.
4. **Our Work posts are OUTCOME-LED** (operator decision): each reads *problem → what we built →
   result*, with the technology (incl. AI) as supporting detail lower down. NOT AI deep-dives.
5. **Posting model = "describe it, I publish"** (operator decision): static HTML, no CMS, no build
   step, no login. A post is a page in the house style; the operator describes a build and an agent
   writes it up in the Our Work format and deploys. Build a reusable POST TEMPLATE + an index page +
   document the workflow.
6. **Homepage becomes the main content page (this is where the substance lives + the SEO).** Today
   it's a near-text-free wordmark hero — invisible to search. Add real, indexable sections with
   headings (operator, 2026-07-20):
   - **What Agntic is** — an operations consulting firm that uses AI but isn't AI-forward.
   - **What we do** — build the complex, multi-system operational processes that stay manual.
   - **Who we do it for** — the target buyer (operator to confirm the specifics; agent drafts from the
     positioning + the GTM notes).
   - **Observability section** — the old Atlas/observability-platform story lives HERE, not on its own
     page: *every automation from an Agntic engagement comes with a control panel — you see every run,
     and hear about a problem before your customer does.* Reuse the observability showcase's dashboard
     visual if it fits the homepage.
   - Keep the hero + the "Help us build" (book a call) CTA. Nav: "project atlas" → "Our Work".
   - **SEO:** real `<h1>/<h2>` copy, a truthful `<title>` + meta description with the what/who, so the
     page is actually indexable. This is the biggest available SEO win. Agent drafts 2–3 copy
     directions; operator picks/edits (do NOT invent facts about clients or results).
7. **The 4 AI-technical showcases** (`built-in-observability-platform`, `cross-session-memory-engine`,
   `multi-signal-vault-search`, `runnable-model-pool`) are **off-message as-is** (AI-forward, about
   internal tech not client outcomes). **Do not publish them as posts.** REUSE their visual design as
   the Our Work post template; leave their copy behind; hold the files as a style reference. `agntic-
   voice.html`: operator's call, same treatment by default. `operations.html`: **sunset** (self-serve
   product framing). `our-tech.html`: sunset or repurpose as the Our Work index shell.

Still in force: **no public pricing**, **no waitlist**. This is now a small BUILD (Our Work section +
homepage expansion + positioning pass), no longer just the "fast reframe".

--- REVISION 1 (2026-07-20, SUPERSEDED by the above — kept for history) ---

## What the ground truth already gives you (less work than it looks)
- agntic.co is **already services-framed** — hero "agntic / moving business into *now*", primary
  CTA "Help us build →" (book a call). Monochrome design system, Inter Tight + Instrument Serif.
- `landing/atlas.html` is a **12-line redirect stub** to atlasbyagntic.com — no product content to
  unwind; it becomes the new Atlas page.
- `landing/built-in-observability-platform.html` is **already** a services-framed showcase built
  around the exact client dashboard (spend, turns, active users, cost-by-context, recent traces)
  the operator wants to position — with a "Book a discovery call →" CTA. It just never names it
  "Atlas" or frames it as *the engagement deliverable*. **Reframe/rename, don't rebuild.**

## What stays (do not touch)
- The agntic.co design system (monochrome, Inter Tight + Instrument Serif, glass surfaces).
- The booking Worker (`worker/`, `agntic-booking`) and the `data-booking` / `booking.js` flow —
  already the primary CTA sitewide and already works end-to-end.

---

## The message spine (from `gtm-positioning-language` + the observability angle)
- **Lead with the work removed, never "AI".** The complex operational processes that stay manual
  because off-the-shelf tools can't express them — several systems, decision points, approvals,
  exceptions.
- **The Atlas page's job is narrow:** show that when Agntic builds your automations, you get a live
  dashboard — you see every run, you hear about a failure from us not from your customer, you get
  proof each workflow did what we agreed, and a written procedure doc. Control and accountability,
  not a feature list. This is the differentiator the operator wants foregrounded.
- **CTA everywhere: book a call** (the existing Worker). One conversation, not a sign-up.

---

## Work items (fast reframe)

### A. Retire the product site `atlas-landing/` (atlasbyagntic.com)
- Stop presenting it. **301-redirect the whole domain to agntic.co** (recommended — preserves any
  link equity, cheap) — likely a Cloudflare Pages redirect / `_redirects` on the
  `atlas-by-agntic` project, or a redirect rule. Decide target: `agntic.co` or `agntic.co/atlas`.
- The July-30 countdown, the four pricing tiers, the `PRICING_MODE` flip, and `PRICING-FLIP.md`
  are now **all dead** — they die with the product site. (Operator memory `july30-pricing-flip` is
  obsolete — retire it.)

### B. Build the Atlas page on agntic.co — `landing/atlas.html`
Replace the redirect stub with a real page, **assembled mostly from
`built-in-observability-platform.html`**:
- Reframe headline/copy so the dashboard is **named Atlas** and framed as *"the control panel you
  get when we run your automations"* — the client-facing surface of an engagement.
- Keep the existing live-dashboard mockup and the observability substance (it's the proof).
- Primary CTA: **book a call** (`data-booking`). No pricing, no signup.
- Match the agntic.co monochrome design system (NOT the terracotta product-site palette).

### C. Clean the leftover self-serve links across agntic.co (`landing/`)
- **Nav "pricing"** (`index.html:390` → `atlasbyagntic.com/pricing`): remove — there is no public
  pricing. (Grep all pages; nav is copy-pasted per page, so fix every copy.)
- **Nav "project atlas"** (`index.html:389` → `atlasbyagntic.com`): repoint to the internal
  `/atlas` page (B). Other pages already link `/atlas` — consistent once the stub becomes real.
- **"Join the waitlist"** (`data-waitlist`, sitewide — home, operations, our-tech, connect):
  replace with book-a-call, or remove. Waitlist signals "product launching." Confirm booking is
  the only CTA left.

### D. Loose ends
- `landing/operations.html` ("Agntic Operations — coming soon") and `agntic-voice.html` — leave as
  is unless they carry self-serve/pricing/waitlist assumptions; out of scope for this pass, but
  grep them in step C.
- Stale product email/social templates in `atlas-landing/` (`pilot*.html`, still selling a $149
  self-serve pilot): **mark stale so no one sends them.** Not shipped by any site; just flag.

---

## Deploy paths (CONFIRMED 2026-07-20 via `wrangler pages project list`)
Both are Cloudflare **Pages**, **direct-upload** (Git Provider: No → manual `wrangler pages deploy`):
- **agntic.co** = Pages project **`web`** (`web-5jv.pages.dev`). Deploy the company site with:
  `npx wrangler pages deploy landing --project-name web` (run from `/Users/crepps/Desktop/AGNTIC/website`).
- **atlasbyagntic.com** = Pages project **`atlas-by-agntic`** (`atlas-by-agntic.pages.dev`). This is
  the site being retired.
- The Cloudflare MCP does NOT expose Pages (only D1/KV/R2/Workers/Hyperdrive) — use `wrangler`
  (via `npx`, v4.x present) or the dashboard for Pages work.

## OPEN — decide before shipping
- **How to retire atlasbyagntic.com.** It's the direct-upload project `atlas-by-agntic`. Cleanest
  options: (a) deploy a tiny `_redirects` into that project — `/* https://agntic.co/atlas 301` — so
  the domain 301s everywhere; or (b) a Cloudflare Bulk Redirect / redirect rule at the zone. Recommend
  (a) — one file, same deploy tool. **Redirect target: `agntic.co/atlas` (recommend).**

## Acceptance (fast reframe is "done" when)
- `atlasbyagntic.com` no longer serves a product site — it redirects to agntic.co (or /atlas).
- agntic.co has a real `/atlas` page framing Atlas as the engagement's client dashboard; no pricing,
  no signup, book-a-call CTA; monochrome design consistent with the rest of the site.
- No "pricing" link, no waitlist CTA anywhere on agntic.co; every primary CTA books a call, and a
  test booking still lands in the calendar + CRM.
- No "AI" in the hero copy; nothing implies self-serve or self-build.
- **Operator-witnessed** in a headed browser before deploy (visible-verification rule), then deploy
  via whatever mechanism step "OPEN" establishes, then eyeball live + hard-refresh.

## Deliberately deferred (not this pass)
Full redesign; a dedicated Agntic domain question (already resolved — agntic.co is the front);
the outbound email/social sequence; case studies (none yet — they come from the first engagements).
