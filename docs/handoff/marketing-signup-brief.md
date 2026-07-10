# Brief — Marketing-site pricing cards → Atlas signup (deep-link)

**For:** the website/marketing-repo agent. **From:** the Atlas app team.
**Status of the Atlas side:** built, deployed to production (`atlas.agntic.co`).

## Objective

Add a **pricing section** to the marketing site whose plan cards send the prospect straight
into the Atlas app's existing **Create-account** flow, **with the chosen plan pre-selected**.

There is **no API integration, no form, no Stripe code, no CORS setup** on the marketing site.
Each card's CTA is a plain link. The Atlas app owns everything after the click — account
creation, plan selection, Stripe Checkout, provisioning, email.

## The one integration point: the deep link

Each plan card links to the Atlas app with the plan id in a `plan` query param:

```
https://atlas.agntic.co/?plan=solo
https://atlas.agntic.co/?plan=professional
https://atlas.agntic.co/?plan=team
https://atlas.agntic.co/?plan=business
```

When the app loads with a valid `?plan=<id>` and the visitor has no existing session, it opens
the **Create-account** form with that plan **pre-selected** in the plan dropdown. The prospect
fills in workspace name + work email and continues to Stripe Checkout. (If they happen to already
be signed in, the param is ignored and they land in the app — correct behavior.)

That's the whole contract. **Verify it live** before building UI on top of it: open
`https://atlas.agntic.co/?plan=team` in a logged-out browser — you should see the Create-account
form with **Team** already chosen in the plan selector. If the plan ids ever change, this doc is
just provenance; the running app is the contract.

## The plans (card content)

| `plan` id | name | price | live automations | runs/mo | users | framing |
|---|---|---|---|---|---|---|
| `solo` | Solo | **$20/mo** | 1 | 30 | 1 | adoption / "get in the door" — lead with this |
| `professional` | Professional | $50/mo | 10 | 200 | 1 | "run several in parallel" |
| `team` | Team | $200/mo | 50 | 1,000 | 5 | for a whole ops team |
| `business` | Business | $600/mo | ∞ | 5,000 | ∞ | scale, no limits |

Tiering is **volume-only** — every feature is on every plan; you differentiate on
automations/runs/seats, not locked features. The felt constraint is **live automations** (you can
only run so many at once), so let the cards make that concrete. Atlas is positioned as **serious
B2B automation software**, not consumer AI — keep the copy in that register. Solo ($20) is the
low-friction on-ramp; the rest is an expansion ladder.

## What to build

1. **Pricing section** — four plan cards (content above), each with a primary CTA linking to
   `https://atlas.agntic.co/?plan=<id>` for its tier. Make Solo the visual on-ramp. An
   enterprise "contact us" card and a monthly/annual toggle are optional and out of the initial
   scope unless you already have annual prices.
2. Optionally a top-nav **"Sign in"** link to `https://atlas.agntic.co/` for returning customers.

That's it — no scripts, no state, no error handling. The links are static.

## Acceptance criteria (behavioral)

- Each card's CTA opens `atlas.agntic.co/?plan=<its id>`; in a logged-out browser the app shows
  the Create-account form with that plan pre-selected.
- No secrets, keys, API calls, or Stripe code exist anywhere on the marketing site.

## Out of scope (Atlas owns these — do not build)

- The signup form, plan selection UI, Stripe Checkout, the post-checkout return screen.
- Tenant/workspace provisioning, onboarding email, plan enforcement.
- Sign-in, password setting, billing management (all inside the app).
