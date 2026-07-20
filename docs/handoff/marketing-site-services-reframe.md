# Marketing-site reframe — retire the product site, fold Atlas into agntic.co (SUB-PLAN)

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

## The decision (operator, 2026-07-20, revised)
**Do not keep a product website.** Kill `atlasbyagntic.com`. Make Atlas a single modest **page on
agntic.co**, framed as *the client-facing observability dashboard clients get during a consulting
engagement* — a detail of working with Agntic, not a product to buy. This supersedes the earlier
"keep atlasbyagntic.com with Agntic framing" fork. Rationale: foregrounding Atlas as a product is
exactly what invites "why pay you if I can use the tool?"; as an engagement deliverable it does the
opposite — it's proof the firm's work is watchable and accountable.

Still in force from the earlier forks: **no public pricing**, **no waitlist**, **fast reframe
first (not a redesign)**.

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

## OPEN — must resolve before shipping
- **How does agntic.co actually deploy?** No `wrangler.toml` / `_headers` / `_redirects` / Pages
  config was found inside `landing/` (only `atlas-landing/` has `_headers`). The local preview runs
  a plain `python3 -m http.server`. The production deploy path for **agntic.co specifically** is not
  captured in the repo — the executing session MUST establish it (Cloudflare Pages project name?
  something else?) before it can ship, and record it in operator memory `marketing-site-deploy`
  (which today only documents the atlas-by-agntic project).
- **atlasbyagntic.com redirect target** — `agntic.co` or `agntic.co/atlas`? (Recommend `/atlas`.)

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
