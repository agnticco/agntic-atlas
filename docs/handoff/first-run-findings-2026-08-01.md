# First-run findings — a genuinely new tenant, driven on prod

**Date:** 2026-08-01 · **Version:** v1.6.106 · **Tenant:** `zz-firstrun-test`
(admin `firstrun@example.test`, created through the real admin UI)

Every build in the preceding session ran inside `agntic` — Google connected, a real
inbox to sample, an existing spreadsheet, months of history. **This is the first time
the product has been driven as a person who has just been given a login**, which is the
model Charles has chosen for taking on real users (hand-provisioned, self-serve off).

The findings below are ordered by what they cost a real customer. Everything is either a
screenshot or a database read; nothing here is inferred from code.

---

## F1 — BLOCKER. Atlas designs a workflow out of services the customer does not have,
## and states as fact that they are connected

**What happened.** Brand-new workspace, nothing connected. First message typed:

> *"When a customer emails us asking about pricing, send me a summary in Slack."*

Atlas replied:

> *"Love it — quick question: which Slack channel (or DM) should I drop the summary into?"*

Answered `#sales`. Atlas then said:

> *"Here's what I'll put together: whenever a new email lands in **your connected inbox**
> that looks like a pricing inquiry, the workflow will summarize it and post that summary
> to the #sales Slack channel. Hit 'Build it' and I'll walk you through each step before
> anything goes live."*

…and rendered a **Build it** button.

**Ground truth, read from the database, not inferred:** `oauth_tokens` holds six rows,
all belonging to `agntic` and `platform`. **Zero rows for `zz-firstrun-test`.** There is
no connected inbox and no Slack.

**Why this is the worst one.** It is a false factual claim *about the customer's own
account*, made in the first thirty seconds, in the most confident register, and it is
**guaranteed for every new user** — a brand-new workspace has no connectors by
definition. Atlas never says "connect Gmail and Slack first". It asks a configuration
question about a service that is not there, then describes the customer's account back to
them incorrectly.

This is the open residual *"a connector's availability is only checked at BUILD time"*
(2026-07-29) meeting the family *"Atlas confirms and elaborates capabilities it does not
have"* (2026-07-30). Both were recorded against an experienced user wasting an interview.
For a new user it is not a wasted interview — it is the entire first impression, and it
is wrong every time.

**Fix direction.** `capabilities.connectors` is known before the first reply is composed;
the chat prompt already receives it. The first turn must check what the workspace
actually has and say so plainly — offer to connect, not to configure. **Do not** solve
this by having the model describe the Connections screen (barred, 2026-07-26); point at
Connections in the sidebar and nothing more.

---

## F2 — BLOCKER for hand-provisioned onboarding. "They have been emailed" is a claim
## Atlas cannot support, and cannot ever correct

**What happened.** Creating the workspace through the admin UI reported:

> *"✓ ZZ Firstrun Test created — **firstrun@example.test** has been emailed a secure link
> to set their password and sign in."*

`example.test` is a **reserved, non-routable TLD (RFC 2606)**. No mail can be delivered to
it, ever. The server logged `admin.tenant.created … invited: true`.

**Cause.** `sendMail` returns `{delivered: true}` when the provider call does not throw
(`src/utils/mailer.js`) — i.e. *Resend accepted the request*. Bounces are asynchronous and
nothing consumes them: no webhook, no record, no retry. The admin route turns that into
`invited`, and the UI turns `invited` into a statement about the recipient.

**Why it matters more than it looks.** This is the only onboarding path Charles has, and
it is the one step he cannot observe. The word travels: *accepted by provider* →
`delivered` → `invited` → *"has been emailed"*. Each hop is a small overclaim; the last one
is a promise to the operator about another person's mailbox.

**Circumstantial and NOT proven, stated as such:** of five real people provisioned 8–10
July (`dilloncalhoun965@gmail.com`, `jonman4257@gmail.com`,
`ngrater@kartechsolution.com`, `awest.farmers@gmail.com`, `thomas@sportfeeds.com`),
**four never signed in at all** and the fifth signed in once and made a single model call.
Whether their invites bounced **cannot be established** — the event logs only retain back
to 25 July and those invites predate them. It is a reason to instrument this, not a
conclusion.

**Fix direction.** Report what is actually known: "queued with the mail provider" is
honest, "has been emailed" is not. Keep the invite link in the response *always* so the
operator can deliver it another way, and surface it on the tenant row for re-sending. A
bounce webhook is the real fix; the honest sentence is the cheap half and should not wait
for it.

---

## F3 — A new user's first screen is a changelog

After signing in for the first time, before seeing any part of the product, the user is
shown **"What's new · v1.6.106"** listing five engineering changes:

> *"Give Atlas a test case without it rebuilding your workflow"* ·
> *"A workflow that only acts on one path can go live"* ·
> *"Pick your spreadsheet, don't paste its ID"* ·
> *"Atlas won't ask you for things it should look up"* ·
> *"Atlas knows where an inbox message actually goes"*

Every one describes the repair of a problem they have never encountered, in vocabulary
they do not yet have. The modal is designed to fire once per user on the next login after
a release; a user whose *first* login follows a release therefore receives the release
notes as a welcome mat.

**Fix direction.** Suppress it when the account has never signed in before — a first
login has no "since last time" to report.

---

## F4 — Smaller, all first-run, all real

- **The invite screen says "reset".** A person who has never had an account is told
  *"Choose a new password for your account"* under a **Reset password** button, with no
  mention of the workspace they were invited to or who invited them.
- **The sign-in form does not pre-fill the email** after setting the password, although the
  invite token identified the user; they must retype the address they just arrived from.
- **Enter does not submit the sign-in form** — observed once, on the password field.
- **The identity shows the email twice** in the sidebar (as name and as subtitle), because
  provisioning sets `display_name: ''` and nothing ever asks for a name.

---

## What was NOT reached

The drive stopped at the Build it button, deliberately: F1 makes everything downstream a
test of a workflow built on connectors that do not exist. **Not yet exercised on a fresh
tenant:** connecting Google from scratch through OAuth, the first real build, the first
test run, the first publish, and the run-budget/plan limits on `solo` (1 workflow, 30
runs/month).

## Cleanup

`zz-firstrun-test` is left in place for inspection. Remove it from Admin → Tenants
(archive), or leave it: it is on `solo`, has no connections and cannot run anything.
Its login is `firstrun@example.test` with a disposable password set during this drive.
**Charles's own browser session was replaced** by signing in as this user; he will need to
sign in again.
