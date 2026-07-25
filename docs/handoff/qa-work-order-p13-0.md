# QA work order — P13-0 (the four seams)

**Issued:** 2026-07-24 · **Branch:** `p13-0/seams-generalize` · **For:** QA Manager

> **Written from the increment's stated guarantees, not from the implementation.**
> Everything under "Must be true" is a restatement of what P13-0 *promised* before the
> code existed. Do not let the built behaviour reshape this list — if the product does
> something sensible that is not on here, that is an observation, not a pass.

---

## The job

You are a customer with Airtable connected. **Build a workflow that saves something into
an Airtable table, by talking to Atlas. Publish it. Run it. Confirm the record is really
there.**

Then, separately: **open an existing workflow that posts to Slack, and run it.**

That is the whole assignment. It is deliberately an ordinary job, because the change under
test sits underneath ordinary jobs.

## Context

What changed, in one line each — you do not need to read the code:

- Atlas used to decide whether a step **changes something in the outside world** by
  pattern-matching the step's internal name. It now reads a property the step declares.
- Atlas used to work out **where an Airtable write lands** using logic hardwired to
  Airtable by name. It now reads instructions the connector publishes about itself.
- Atlas used to decide **which account credentials a step needs** from three hand-typed
  lists of step names. It now reads the connector each step declares it belongs to.

**The third one touches every workflow run in the product.** That is the main risk and the
reason this order exists.

Known-broken already, do not report as new: five tests in `tests/e2e/onboarding.test.js`
(workspace provisioning, slug dedupe, team invites, seat limits) fail at baseline.

## Must be true

Each of these is observable from a customer's seat. Report **held / broke / could not
test** for every one. "Could not test" is a real verdict — never round it up to a pass.

1. **You are never asked to paste an Airtable base or table ID.** Building a workflow that
   writes to Airtable offers your real bases and tables to pick from.
2. **The columns Atlas maps onto are the table's real columns.** If you promise something
   the table has no column for, you are told — it is not silently dropped, and the record
   is not created with an empty field.
3. **A published workflow actually runs and writes the record.** This is the credential
   check. If credential resolution broke, the run fails with something like "no access
   token" on a connector that shows as connected.
4. **Slack still works.** Open a workflow that posts to Slack and run it. Its credentials
   resolve through the same changed path.
5. **A workflow that only reads is not made to ask for approval**, and a workflow that
   writes is not allowed to go live without its promise being checked.
6. **Nothing that used to publish now refuses to publish.** A correctly-built workflow
   reaching the end of the build must be able to go live.

## Out of scope

Do not chase these — they are known and deliberate:

- **Google Sheets click-to-pick.** Not built, on purpose. A Sheets workflow still asks for
  a spreadsheet ID and a range. Recorded as a residual; not a finding.
- **Connecting a service Atlas has never hand-built** (Notion, Linear, Stripe). That is
  P13-A and does not exist yet.
- **Triggers.** Whether a workflow fires by itself is a separate piece of work.
- Cosmetic issues unrelated to building, publishing or running a workflow.

## Report back

- Every "Must be true" with a verdict and the evidence for it.
- Any finding with: what you did, what you saw, what you expected, and a severity call —
  **blocking** (a real person hits it and it either looks like success or destroys
  something) versus **carry** (everything else).
- Screenshots saved to disk for anything you assert about the screen.
- If you could not run the app at all, say that plainly and stop. A blocked run is a
  result; a guessed one is not.
