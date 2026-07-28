# Workflow library — proposed starting set

**Draft, 2026-07-24. Grounded at SHA `dac5ab6`, `package.json` v1.6.36.**
Author: QA Manager (design pass, not a browser session — no server was started, no
tests run, no UI driven).

---

## How this was grounded, and what that means for how much to trust it

Three different grades of evidence are mixed in here, and they are labelled per claim:

- **Read today (strongest).** I read the actual capability registrations, node types,
  validator rules and event dispatchers in `src/` at the SHA above. Every "this exists /
  this does not exist" claim below carries a `file:line`. Absence claims come from a
  full enumeration of a file's registrations, not from a failed grep.
- **From written QA history (second-hand but recorded).** The findings in
  `docs/handoff/ui-test-findings-2026-07-19.md`, `hardening-2026-07-21.md`,
  `hardening-2026-07-22.md` and `qa-findings-2026-07-22.md`. **I did not personally
  drive the UI** — I am a fresh instance. Where I cite one of those, I say so.
- **Judgement (weakest).** My call on grouping, count and which candidates are worth a
  slot. Argued, not proven.

**Nothing in here has been built as a library entry and run end to end.** Every entry
below is a *proposal that the parts exist for*, not a verified template. Before any of
these ships as a card a customer can click, someone has to build it in the browser and
watch it reach a verdict. That is the single most important sentence in this document.

---

## Part 1 — What Atlas can actually do today

This is the substrate the library has to be built out of. It is deliberately blunt
about what is catalogued-but-dead, because a library entry built on a dead trigger is
worse than no entry: it looks like a working product and fails silently.

### Triggers that genuinely fire

| Trigger | Status | Evidence |
|---|---|---|
| **Schedule (cron)** incl. `*/N` minutes and `0 */N` hours | Works | `workflow-store.js:1366+` `_isFlowDue`; sub-daily patterns confirmed |
| **Email arrives** (Gmail poll on the connected account, filtered by a Gmail query) | Works | `server.js:936–947`; `workflow-scheduler.js:116–120`. Proven live 2026-07-21 (`hardening-2026-07-21.md` §5: "real run 55s after the email landed") |
| **Slack message in a channel** | Works, with two sharp caveats below | `server.js:550–578` `dispatchSlackEvent` |
| Manual / one-time / webhook | Exist in the trigger vocabulary | `prompts.js:193–199` |
| **Airtable record changed** | **Catalogued but effectively dead** — see gap G1 | `airtable/index.js:445` registers it; nothing calls the webhook-creation route on publish |
| **Slack app-mention ("@Atlas do X")** | **Catalogued but dead** — see gap G2 | `slack/index.js:1049` registers it; `server.js:554` drops every event that is not `type: 'message'` |

**Slack message trigger, caveat 1 (read today):** the channel filter compares the
configured value against the raw Slack channel **ID**. `server.js:562` does
`want === ev.channel || String(want).replace(/^#/,'') === ev.channel` — comparing
`"general"` to `"C0123ABC"`. **A trigger filtered to `#general` by name will never
fire.** Only a channel ID works.

**Slack message trigger, caveat 2 (read today):** the trigger declares a `keywords`
filter (`slack/index.js:1042`) and **nothing enforces it**. `channelMatches`
(`server.js:559`) is the only filter applied in the dispatcher. A workflow configured
to fire "only when the message contains 'urgent'" will fire on **every** message in
that channel.

Both of these are findings in their own right, not just library constraints. They are
listed again in Part 4.

### Steps the engine can run

`trigger · llm · assemble · connector-action · deliver · search_web` plus the control
types `branch · foreach · human · decision · stop` (`node-types/index.js:30–52`).

- **`llm`** with `mode` ∈ `summarize | extract | rewrite | classify | freeform`
  (`llm.js:31`). Config keys are a **closed set** — an undeclared key fails the publish.
- **`assemble`** — stitches sections into one markdown document. No model call, so it
  is free and exact (`assemble.js:1–15`).
- **`branch`** — routes on a value. **The moat:** it may only route on a value from a
  fixed, declared list — an `llm` node in `classify` mode, a `decision` table, or a
  `human` node's answer (`workflow-validator.js:587–670`, `LLM_INPUT_NOT_ENUM`). It is
  an allowlist, not a denylist, because a denylist was defeated by one laundering hop.
  **Every branching library entry must be designed around this**: the thing being
  routed on has to be a closed list, named up front.
- **`decision`** — a decision table, for when the answer depends on two or more inputs
  together, or on a numeric threshold ("over $50k", "more than 3 days late")
  (`prompts.js:225`). This is the least-driven surface in the product.
- **`foreach`** — runs a short sequence once per item, hard-capped (default 100,
  `foreach.js:31`). **No nesting.** Credentials inside a loop were broken and are fixed
  (`server.js:380–410`, closing F30).
- **`human`** — pauses and asks a person. Answers over **inbox** (always available),
  **Slack** (if connected), **email with a signed link** (if the mailer is configured)
  — `approval-channels.js:38–77`. **An approval reply-by-email is a hard error**, never
  a channel.
- **`stop`** — a genuine terminal for a "do nothing" lane, so the builder does not
  invent a delivery for an ignore path (`node-types/index.js:48`).

**An approval step alone is not a gate.** It only *reports* the answer — it needs a
`branch` reading it, or the next step runs regardless. Any library entry with an
approval must ship with that branch.

### What each connector can actually reach

Enumerated from the registration lists, not grepped for:

**Google** (`google/index.js:612–828`) — 15 step/delivery capabilities + 1 trigger:
`gmail_search`, `gmail_get_message`, `gmail_send`, `gmail_mark_read`,
`calendar_list_events`, `calendar_create_event`, `drive_create_folder`,
`drive_list_files`, `sheets_describe`, `sheets_read`, `sheets_append`, `docs_read`,
`docs_create`, `tasks_list`, `tasks_create`, `gmail_new_message` (trigger).

What that list does **not** contain, and it matters:
- **No threaded email reply.** `gmail_send` takes `to / subject / body` only
  (`google/index.js:641–645`). A reply goes out as a *new* email, not into the thread.
- **No `sheets_update`.** Append only. You cannot mark a row done in Sheets.
- **No `docs_update`.** Create only.
- **No file-content read from Drive.** `drive_list_files` lists; only a Google *Doc*
  can be read (`docs_read`). A PDF or spreadsheet attachment has no read path.
- **No Gmail attachment access at all.**
- **No calendar update or delete.**

Good news, and a stale doc to fix: `gmail_send` **does** handle HTML properly now —
it auto-detects HTML, wraps it in a responsive shell, sets `text/html`, strips stray
```` ```html ```` fences and RFC-2047-encodes the subject (`google/index.js:328–356`).
`CLAUDE.md`'s "Known gotchas" still says email delivery sends raw `<p>` tags verbatim.
**That gotcha is stale for `gmail_send` and should be corrected in the same commit as
whatever next touches that surface.**

**Airtable** (`airtable/index.js:298–447`) — `airtable_list_bases`,
`airtable_describe_base`, `airtable_create_field`, `airtable_list_records`,
`airtable_get_record`, `airtable_search_records`, `airtable_create_record`,
`airtable_update_record`, `airtable_delete_record`, + the (dead) trigger. **This is the
only full-CRUD write target Atlas has** — the only place a workflow can go back and
*change* a record it wrote earlier. That makes Airtable, not Sheets, the right system
of record for any library entry with a status field.

**Slack** (`slack/index.js:264–1028`) — ~35 capabilities. Everything a bot token can
do works: post to a channel, DM by email or ID, threaded reply, reaction, file upload,
create channel, invite, set topic, pin, look up a user, read channel history, list
channels/users, join/leave, group DM, read a profile.

**But:** Slack **search**, **reminders**, and **post/DM as the user** all require a
*user* OAuth token, and per-user OAuth is **not wired** — readiness is
`!!process.env.SLACK_USER_TOKEN`, a deployment-wide env var
(`slack/index.js:261, 828`). For a real customer tenant these are unavailable. **Any
library entry that wants to "search Slack for prior context" is not buildable today.**

**Web** (`web/index.js:186–214`) — `web_search` (Anthropic native) and `web_fetch`
(Mozilla Readability). Both server-side, no customer setup at all. `web_search` needs
`ANTHROPIC_API_KEY`, which is set in production.

**Filesystem** (`filesystem.js:1–12, 27–45`) — `filesystem_read`, `filesystem_list`.
**Server-side paths only**, sandboxed to folders an operator added via
`/rag/index-folder`, itself contained by `KNOWLEDGE_INDEX_ROOTS` (`server.js:125–137,
1606–1618`). Browser-uploaded documents are RAG-only and have no stable path. **A
hosted customer cannot reach their own machine's files.** Any "watch my folder" entry
is operator-provisioned content only — say that plainly or don't offer it.

**Atlas inbox** (`inbox/index.js:21, 69`) — `inbox_deliver` (delivery) and
`search_inbox` (semantic search over the tenant's past workflow outputs). Free, needs
no connector, always available. Underrated: `search_inbox` is the one "prior context"
lookup that works for every tenant today.

**Webhook out** (`channel-handlers.js:50`) — HTTP POST to a URL the user supplies.

---

## Part 2 — The gaps that shape this library

These are the constraints I designed around. Each is labelled with how I know it.

**G1 — The Airtable "record changed" trigger does not self-install. (Read today.)**
`POST /connectors/airtable/webhooks` exists (`server.js:2597`) but is only ever called
by hand — nothing in the publish path invokes it. And `refreshAirtableWebhook`
(`airtable/index.js:267`) is **defined and called from nowhere in `src/`**, so even a
hand-registered webhook expires and is never renewed. *Consequence: a workflow that
says "when a record changes in Airtable, do X" would publish, look live, and never
fire.* This also matches the standing `R23 Airtable trigger blocker` memory note.
**Every "record changed" library entry is on the shelf until this is wired.**

**G2 — The Slack app-mention trigger cannot fire. (Read today.)** `server.js:554`
returns early unless the Slack event is `type: 'message'`. `app_mention` events are
dropped. *Consequence: "@Atlas, summarise this thread" is offered by the catalog and
would never run.*

**G3 — A test example cannot vary a workflow that fetches its own data. (From written
QA history — F3a, `ui-test-findings-2026-07-19.md:189`.)** If the workflow's data comes
from a connector *read* rather than the trigger *payload*, every made-up test example
collapses onto the same live query result. The panel then reports N verified scenarios
having proved one. *Consequence, and this is the single biggest driver of how I ordered
the library:* **event-triggered workflows (an email arrives, a Slack message posts) can
be honestly tested; schedule-then-fetch workflows cannot.** Four of my ten entries trip
this and are flagged. It is not a reason to exclude them — it is a reason to say so on
the card, and to expect their first live build to end in "not exercised" rather than a
green tick.

**G4 — Sub-fields written to columns can silently publish blank. (From `CLAUDE.md`
"Open residuals".)** `{{item.field}}` inside a loop and `{{connectorRead.field}}` off a
connector read pass validation, write the column blank, and say nothing, because the
source declares no output schema. *Consequence: any entry that maps extracted fields
onto named columns is at risk of a row of blanks that reads as success.* Closing this
is P13's output-schema groundwork.

**G5 — Slack channel filter matches only a raw channel ID; the keyword filter is
enforced by nothing. (Read today, `server.js:559–565`.)** See Part 1.

**G6 — Test runs may inflate the live health score. (Contested in the written
history.)** `CLAUDE.md` carries it as open (F14); `hardening-2026-07-21.md:133` says it
did not reproduce and the dashboard tagged the test run separately. **I have not
checked this myself.** It matters for the library only in that a template's advertised
reliability should not be read off that number until someone settles it.

**G7 — A workflow can read its own output. (From `hardening-2026-07-21.md:140`.)** A
digest that delivers into the same inbox it reads consumed its own message. It now
fails loudly rather than reporting success, but the cycle is still constructible.
*Consequence: no library entry may read a mailbox and deliver into that same mailbox.*
I have honoured this in every entry below.

---

## Part 3 — The proposed library

### How many, and why

**Ten entries at launch, in four groups.** Plus a named shelf of seven that are
deliberately *not* offered, with the exact missing part written down.

The reasoning, since this is a judgement call:

- **Three per group is the floor for a group to read as a category.** Fewer and the
  grouping is decoration; a customer scanning "Keeping two systems in step" with one
  card under it learns nothing about what Atlas is for.
- **Ten is roughly what one person can build, test end to end, and keep true.** Every
  entry here is a real workflow that has to be built in a browser, driven to a verdict,
  and re-checked whenever the converger changes. This codebase's whole history is
  things that were green and wrong. A library of thirty templates nobody has run is
  exactly that failure with a nicer surface.
- **Each entry must be a job Atlas is uniquely good at**: more than one system,
  a real judgement, and usually a person in the loop. I dropped several plausible
  candidates on that test — a "daily calendar summary" and a "reminder digest" are
  things a calendar app already does, and putting them in the library teaches customers
  Atlas is a scheduler.
- **The shelf is the more valuable half of this document for planning.** It is a
  ranked list of what to build next, expressed as customer outcomes rather than
  tickets.

### Group 1 — When something lands in your inbox

*The strongest group, and it should launch first.* An arriving email delivers its
payload as the trigger event, so test examples genuinely reach the first step — these
are the only entries in the library that **do not** trip G3 and can therefore be
honestly certified. This is also the shape the team has spent the last week hardening,
so it is the best-understood path in the product.

---

#### 1.1 — Inbox Triage & Route

**Outcome:** Every email that arrives gets read, sorted into one of a few named
categories, and sent to the right place — urgent things reach you immediately, routine
things are logged, and junk is dropped without you seeing it.

**Who it's for / when they reach for it.** Anyone whose inbox is the front door to the
business — a shared support or sales address, an owner-operator, an ops lead. They
reach for it when the volume has passed the point where reading everything is the job.

**Shape.** Email arrives → `llm` classify into a closed list (urgent / needs a reply /
for the record / ignore) → `branch` four ways → **urgent:** Slack DM to the owner *and*
an Airtable row · **needs a reply:** hand to entry 1.2, or log · **for the record:**
Airtable row only · **ignore:** `stop`.

**Connects to.** Google (Gmail), Slack, Airtable.
**Setup required.** Google connected, and the mail must arrive in **the one connected
Gmail account** — an alias that forwards in is fine, a genuinely separate mailbox is
not (`prompts.js:203–208`). Slack connected, with the bot in the destination channel or
the recipient resolvable by email. Airtable connected at workspace level, with the base
and table existing.

**Approval step?** No — it routes and notifies, it does not act on anyone's behalf.

**Status: buildable today.** Every part exists. This is the canonical shape the product
was built around.
**Caution:** this is the exact shape that produced the "a promise was enforced against a
branch that never ran, so the builder rewrote the classifier to forward spam" defect —
fixed `d3902a8`, and per `CLAUDE.md` still **code-proven rather than live-witnessed**.
Build this one first and watch it, because it re-tests that fix.

---

#### 1.2 — Customer Reply Drafter (you approve before it sends)

**Outcome:** When a customer emails, Atlas drafts the reply for you, shows it to you in
Slack, and sends it only after you say yes.

**Who it's for.** Small teams answering a recurring stream of similar questions, where
the draft is 90% of the work and the judgement is the other 10%. The entry that best
demonstrates what Atlas is actually for.

**Shape.** Email arrives (filtered to a sender, domain or support alias) → `llm` extract
what is being asked → `search_inbox` for what was said last time → `llm` draft the reply
→ **`human` approval, asked in Slack, with the draft as the preview** → `branch` on the
answer → **approve:** `gmail_send` + log to Airtable · **reject:** `stop`, logged.
Unanswered times out as a **rejection**.

**Connects to.** Google (Gmail), Slack, Airtable, Atlas inbox.
**Setup required.** As 1.1, plus: Slack interactivity configured for the approval
buttons, and the approver reachable — the approval must go to a Slack **user ID or an
email Atlas can resolve**, never a raw email as a channel (that bug shipped once and
made a workflow wait forever, fixed v1.6.6).

**Approval step?** **Yes**, and it is the point of the entry.

**Status: buildable today, with one honest limitation to print on the card.**
**`gmail_send` cannot reply in the thread** — it takes `to / subject / body` only
(`google/index.js:641–645`). The customer receives a new email, not a reply under the
original. For many businesses that is fine; for some it is disqualifying, and they must
be told before they build it, not after.

---

#### 1.3 — Escalation Watch

**Outcome:** Emails that are both angry *and* from an account that matters get flagged
to a human straight away; everything else is logged quietly.

**Who it's for.** Anyone with a support or account-management function where the cost
of missing one specific message is much higher than the cost of reading the rest.

**Shape.** Email arrives → `llm` extract the account and the amount/tier mentioned →
`decision` table over **two** inputs (tone as a closed list × account tier or a numeric
threshold) → `branch` → **escalate:** Slack DM + an Airtable escalations row · **log
only:** Airtable row.

**Connects to.** Google (Gmail), Slack, Airtable.
**Setup required.** As 1.1. The tier/threshold rule has to be something the customer
can state — the decision table's inputs must be a closed list or a number, never free
prose (`workflow-validator.js:587–640`).

**Approval step?** No.

**Status: buildable today.** It is the only entry that exercises the **decision table**,
which the written QA history says is the least-driven surface in the product — the
review UI for it "renders as prose with raw field names, not the specified editable
table" (F31, `ui-test-findings-2026-07-19.md:1850`), and per `CLAUDE.md` the table's
rule grammar still lives in two functions that have disagreed twice.
**Recommendation: build this one, but expect it to surface defects, and treat that as
the entry earning its keep rather than as a reason to drop it.**

---

### Group 2 — Turning a request into a record

*Something arrives; a row appears somewhere a human can act on it.* The value is the
extraction and the mapping onto real columns — which is also where gap G4 bites.

---

#### 2.1 — Lead Intake → CRM Row

**Outcome:** Every enquiry that arrives becomes a properly filled-in row in your CRM,
with the team told about it, without anyone retyping anything.

**Who it's for.** Anyone whose leads arrive as email — a website form notification, a
marketplace enquiry, a referral. Reached for the moment the spreadsheet starts getting
out of date.

**Shape.** Email arrives → `llm` extract (name, company, what they want, urgency) →
`airtable_describe_base` to read the **real** column names → `airtable_create_record` →
Slack post to the sales channel.

**Connects to.** Google (Gmail), Airtable, Slack.
**Setup required.** Airtable connected, base and table existing. Note that Atlas *can*
add a missing column (`airtable_create_field`) but is instructed to ask first — a good
thing to keep.

**Approval step?** No by default. Worth offering an approval variant for teams who want
a person to check the mapping for the first fortnight.

**Status: buildable today — flagged for gap G4.** Mapping extracted fields onto named
columns is exactly the shape where `{{extract.field}}` can publish, write blank, and say
nothing. **This entry should not ship until someone has built it and read the resulting
Airtable row, not just the run status.** Using `airtable_describe_base` first is the
existing mitigation and this entry should be the proof it works.

---

#### 2.2 — Request Intake from Slack, with approval

**Outcome:** Someone posts a request in a Slack channel; it becomes a tracked record,
and the person who owns it approves it before it is accepted.

**Who it's for.** Internal ops — IT requests, purchase requests, access requests, time
off. Teams that currently run these on "post in the channel and hope".

**Shape.** Slack message posted in a nominated channel → `llm` classify the request type
(closed list) → `branch` → `assemble` the request record → **`human` approval in Slack**
→ `branch` on the answer → **approve:** `airtable_create_record` + `slack_reply` in the
original thread confirming · **reject:** `slack_reply` declining, with the reason.

**Connects to.** Slack, Airtable.
**Setup required.** Slack connected **with Event Subscriptions pointed at Atlas and
`SLACK_SIGNING_SECRET` set on the box** (`server.js:1876–1886`) — this is deployment
configuration, not something a customer does. The bot must be in the channel.

**Approval step?** **Yes.**

**Status: buildable, but it is the least-proven trigger in the launch set, and it
carries gap G5.** Two things must be handled before this can be a card:
- The channel must be identified by its **channel ID**, not `#name`, or the trigger
  never fires (`server.js:562`).
- Do **not** offer a "only when the message says X" keyword option — the field exists
  and is enforced by nothing (`server.js:559`), so the workflow would fire on every
  message in the channel while the card promised otherwise. That is precisely the class
  of "looks like success" defect this product keeps shipping.

Whether the trigger event payload lets test examples vary (i.e. whether this escapes
G3) is **my expectation, not something I checked** — the Slack event does become the
step input (`server.js:569`), which suggests it behaves like the email trigger, but no
one has driven it.

---

#### 2.3 — Invoice / Bill Approval

**Outcome:** Bills that arrive by email are read, checked against your own rules, and
either logged automatically or held for your approval — with the due date put in your
calendar either way.

**Who it's for.** An owner or office manager approving spend, where "under £500 from a
supplier we know" and "£8,000 from someone new" deserve different treatment.

**Shape.** Email arrives (filtered) → `llm` extract vendor, amount, due date →
`decision` table (amount threshold × vendor known/unknown) → `branch` → **auto-log:**
`airtable_create_record` + `calendar_create_event` for the due date · **hold:** `human`
approval in Slack showing the extracted detail → `branch` → approve: same writes ·
reject: `stop` with a logged reason.

**Connects to.** Google (Gmail, Calendar), Airtable, Slack.
**Setup required.** As above, plus a Calendar the customer is happy to write to.

**Approval step?** **Yes**, conditionally — only above the threshold. This is the single
best demonstration in the library of "judgement decides whether a person is needed",
which is the product's actual pitch.

**Status: buildable today with one hard limit that must be on the card.** **Atlas cannot
read email attachments.** The Google capability list has no attachment access at all
(enumerated, `google/index.js:612–828`), and no way to read a PDF. **The amount and due
date must be in the body of the email.** For invoices-as-PDF-attachments — which is most
of them — this entry does not work, and saying so up front is the difference between a
useful template and a support ticket.

---

### Group 3 — Keeping an eye on things

*Atlas watches something outside the business and tells you only what matters.* Both
entries trip **G3** — their data comes from a live fetch, so the built-in test can prove
one scenario however many examples it generates.

---

#### 3.1 — Outside-World Watch

**Outcome:** Every weekday Atlas looks for news about the things you care about, decides
which items are actually significant, and puts those in front of you — routine ones are
just logged.

**Who it's for.** Founders, BD and account teams tracking competitors, customers,
regulation or a market. The judgement is the product: they don't want a feed, they want
the two things worth reading.

**Shape.** Schedule (weekday morning) → `web_search` on the named topics → `llm` classify
each result into a closed list (significant / routine / not relevant) → `branch` →
**significant:** `assemble` a short brief → **fans out to two destinations**: Slack DM
*and* the Atlas inbox · **routine:** `sheets_append` to a running log · **not relevant:**
`stop`.

**Connects to.** Web (nothing to connect), Slack, Google (Sheets).
**Setup required.** Almost none — web search needs no customer connector. The lightest
entry in the library to get running, which makes it a reasonable first workflow.

**Approval step?** No.

**Status: buildable today — flagged for G3.** The test panel cannot vary what the web
search returns, so expect the honest verdict on a first test to be **"not exercised"**
for at least the lanes the live search doesn't happen to produce. That is the product
behaving correctly. The card should set that expectation rather than let it read as a
failure.

---

#### 3.2 — Weekly Report from a Spreadsheet, with sign-off

**Outcome:** Your weekly numbers are pulled from the spreadsheet, written up, shown to
you, and sent to the distribution list only once you have approved the wording.

**Who it's for.** Anyone who currently spends Friday afternoon turning a sheet into an
email that four people read.

**Shape.** Schedule (weekly) → `sheets_describe` then `sheets_read` → `llm` extract the
figures → `llm` write the narrative → `assemble` the document → **`human` approval**
(inbox or Slack, showing the full draft) → `branch` → **approve:** `docs_create` for the
archive *and* `gmail_send` to the list · **reject:** `stop`.

**Connects to.** Google (Sheets, Docs, Gmail), Slack for the approval.
**Setup required.** Google connected with Sheets and Docs scopes; the spreadsheet ID;
a recipient list. **Do not deliver into a mailbox this workflow also reads** (gap G7).

**Approval step?** **Yes** — this is the "nothing goes out in my name unread" entry.

**Status: buildable today — flagged for G3.** Reads live sheet data, so test examples
cannot vary it. Also worth noting: there is **no `sheets_update`**, so this entry can
read and it can append, but it cannot mark the sheet as reported. If that matters, the
system of record should be Airtable.

---

### Group 4 — Keeping two systems in step

*The most Atlas-shaped work there is, and the hardest.* Both trip G3.

---

#### 4.1 — Stale Record Sweep

**Outcome:** Records that have been sitting untouched too long get a chasing message to
the person who owns them — after you have looked at the list and approved it.

**Who it's for.** Sales pipelines, support queues, onboarding checklists — anywhere
"nobody looked at it" is the actual failure mode.

**Shape.** Schedule (daily) → `airtable_search_records` with a formula (status open AND
last touched > N days) → `llm` draft a per-record nudge (inside a `foreach`) →
`assemble` the whole list into one preview → **`human` approval, once, for the batch** →
`branch` → **approve:** `foreach` → `slack_dm` the owner + `airtable_update_record` to
stamp "chased" · **reject:** `stop`.

**Connects to.** Airtable, Slack.
**Setup required.** Airtable connected; a table with an owner field and a date field;
owners resolvable to Slack users by email.

**Approval step?** **Yes**, and unusually it is one gate covering many items — which is
the right design (nobody wants twelve approval prompts) and also the risky one.

**Status: buildable today, and it is the most valuable *and* most exposed entry in the
library.** Three flags, all of which make it a good early build rather than a bad one:
- It is the only entry using **`foreach` + a connector write**, the combination that was
  completely broken until recently (F30 — a write inside a loop got no credentials and
  failed as "not connected"; fixed at `server.js:380–410`). This entry re-proves that fix.
- **G4 applies hard**: `{{item.field}}` is exactly the template that publishes and
  writes blank in silence.
- The written QA history flags that "**more than one route could gate a step**" was
  never exercised (`qa-findings-2026-07-22.md:86`) — a batch gate in front of a loop of
  writes is close to that shape.

---

#### 4.2 — Two-System Reconciliation

**Outcome:** Atlas compares two systems that are supposed to agree, tells you exactly
where they don't, and fixes the mismatches you approve.

**Who it's for.** Any business running a spreadsheet next to a CRM, or a billing list
next to a customer list, where the drift is discovered by a customer complaining.

**Shape.** Schedule → `sheets_read` **and** `airtable_list_records` (fan-in) → `llm`
compare and produce a discrepancy list → `llm` classify (discrepancies found / none) →
`branch` → **none:** `stop` · **found:** `assemble` the list → Slack post *and* Atlas
inbox → **`human` approval before writing anything** → `branch` → approve: `foreach` →
`airtable_update_record` · reject: `stop`, list retained.

**Connects to.** Google (Sheets), Airtable, Slack.
**Setup required.** Both systems connected; a shared key the two can be matched on
(this is the thing the customer must have and often doesn't).

**Approval step?** **Yes** — mandatory. Nothing should write corrections unattended.

**Status: buildable today — flagged for G3 and G4.** The most complete demonstration of
what Atlas is for: two systems, real judgement, a person in the loop, and a write-back.
Also the hardest to build, so it should be built *last* of the ten, once the simpler
ones have shaken out the converger.

---

## Part 4 — The shelf: named, and exactly what is missing

These are workflows customers will ask for. They are **not** buildable today. Each one
names the single missing part, so this doubles as a priority list.

| Wanted outcome | Missing part | Where |
|---|---|---|
| **"When a record changes in Airtable, do something."** The most-requested shape after email. | Nothing creates the Airtable webhook when a workflow is published, and the renewal call is never made — so the webhook never exists, and if hand-made it expires. | G1. `server.js:2597` is call-only-by-hand; `airtable/index.js:267` `refreshAirtableWebhook` is called nowhere. |
| **"@Atlas, summarise this thread / do this."** | App-mention events are dropped by the dispatcher. | G2. `server.js:554`. |
| **Reply in the same email thread.** Blocks 1.2 from feeling like a real reply. | `gmail_send` has no thread/in-reply-to parameter. | `google/index.js:641–645`. |
| **Mark a row done in Google Sheets.** | There is no `sheets_update` — append only. | Enumerated, `google/index.js:612–828`. |
| **Read an invoice or contract that arrived as a PDF.** Probably the single biggest unlock for SMB back-office work. | No Gmail attachment access, and no non-Doc file read at all. | Enumerated, as above. |
| **"Find what we told them last time" from Slack history.** | Slack search needs a per-user OAuth token; per-user OAuth is not wired — readiness is a deployment-wide env var. | `slack/index.js:261, 828`. |
| **"Watch my folder / read my files."** | The filesystem connector reads paths on the Atlas **server**, gated to operator-approved roots. A hosted customer's own files are unreachable; browser uploads are search-only. | `filesystem.js:1–12`; `server.js:125–137`. |

**My read on priority, as a recommendation:** the Airtable trigger (G1) is the cheapest
unlock with the widest effect — it is wiring an existing endpoint into the publish path
plus a renewal tick, and it turns an entire fifth group ("when a record changes…") from
impossible into buildable. PDF/attachment reading is the biggest customer unlock and the
biggest piece of work. Threaded email reply is small and makes an existing entry
noticeably better.

### Committed to-dos — trigger work only (operator's call, 2026-07-24)

**Why this list is short.** The shelf above mixes two different kinds of work, and only
one of them is safe to do now.

Capability *matching* in Atlas is already dynamic — the converger receives a live,
per-tenant, scope-aware catalog and selects from it (`prompts.js` `stepSummary` /
`deliverySummary` / `connectorTriggerSummary`). But the **catalog itself is hand-authored**:
every entry is a literal `registry.register({...})` block with its own `handle` that calls
the vendor API (`google/index.js`, `slack/index.js`, `airtable/index.js`, `web/index.js`,
`filesystem.js`). Nothing derives a capability from a vendor's API surface or from granted
scopes. **P13 is precisely the plan to stop hand-authoring that catalog**
(`docs/architecture/mcp-capability-adapter.md`).

Therefore: **anything whose fix is "add another capability to the catalog" is deferred to
P13** — building it by hand now is work P13 is designed to delete. **Triggers are
hand-built under P13 either way** (stated in `CLAUDE.md`'s P13 section), so trigger defects
are safe to fix now and are the only committed items.

| # | To-do | Size | Why it survives the P13 filter | Status |
|---|---|---|---|---|
| 1 | Airtable "record changed" trigger self-installs on publish and renews (G1) | small | Trigger plumbing — hand-built under P13 regardless. Widest effect per hour | **built** |
| 2 | Slack channel filter accepts a channel name; keyword filter actually enforced (G5) | small | Trigger dispatch — silent success today: fires on everything, or never fires, and says nothing | **built** |
| 3 | Slack app-mention events reach a workflow (G2) | small | Trigger dispatch — offered by the catalog, cannot run | **built** |

All three are **trigger-dispatch/registration wiring**, none touches the capability
catalog, and all three were silent failures a customer could publish and believe in.
Done as one pass.

**What was actually wrong — G1 was worse than this document first recorded.** Grounding
before implementing turned up a THIRD independent break on the same feature: the
converger's generic trigger template emits the capability id (`airtable_record_changed`)
as the event name, while `dispatchAirtableEvent` matched only the bare `record_changed`.
So the trigger matched **no workflow at all**, even with a webhook in place — the missing
webhook was merely the first of three reasons it could never fire. A fourth, softer one:
the generic template emits no `baseId`, so nothing named which base to watch. Both are
fixed (`isAirtableRecordChangedTrigger` accepts either spelling; `prompts.js` now gives
Airtable an explicit trigger template that requires a real base id).

**Built, pinned, NOT yet witnessed.** New `src/connectors/airtable/webhook-sync.js`
(idempotent tenant-scoped reconcile + daily renewal, wired into publish/edit/delete/status
and `POST /connectors/airtable/webhooks/sync`); `selectSlackFlows` / `slackEventKind`
exported from `server.js` so the matching logic can be checked the way production builds
it. 33 tests across `tests/api/slack-trigger-dispatch.test.js` and
`tests/api/airtable-webhook-sync.test.js`, every guard hand-mutated red→green. The
remaining step is a person watching a real Slack message and a real Airtable record edit
fire a workflow, with the server restarted on the new code — a passing test is not that.

### Parked pending P13 (not dropped)

Recorded here so the reasoning survives, since the to-do list no longer carries them.

| Shelf item | Why parked |
|---|---|
| Reply inside the email thread | Pure catalog work — threading params on the Gmail send capability. Most likely of all of these to arrive free from a generated catalog |
| `sheets_update` | Pure catalog work — a vendor API Atlas simply has no hand-written wrapper for |
| Read email attachments / PDFs | **Partly** catalog, partly ours: the menu entry could be generated, but moving file bytes through the engine and extracting text is Atlas-side work whatever happens. Revisit once P13's shape is fixed — it is still the biggest customer unlock |
| Per-user Slack OAuth for Slack search | The capability could be generated; the per-user token + cross-user isolation story is ours and needs its own design pass |
| Hosted customers' own files | Needs an operator decision first (a Drive-folder watch beats a local filesystem or an installed agent). Trigger-shaped, so revisit after the decision |

---

## Part 5 — What the library itself will need from the backend

Named so it can be scoped, not designed here.

1. **Somewhere for templates to live**, versioned, with the same blueprint shape the
   converger already emits — so a template is a real workflow definition, not prose.
2. **Instantiation into a conversation, not into a workflow.** The right behaviour is
   almost certainly: picking a card starts a builder session pre-loaded with the intent
   and the shape, and the customer still walks the plan, the questions and the step
   approvals. Dropping a finished workflow straight into their account would hand them
   something that has never been tested against *their* destinations — which is the exact
   "certified without being checked" failure the whole product is built to prevent.
3. **A readiness check before a card is offered.** Every entry above lists connectors it
   needs. A card for a Gmail workflow shown to a tenant with no Google connection is a
   dead end. The capability catalog already answers this per tenant
   (`capability-registry.js` `isReady` / the `/capabilities` endpoint) — the library
   should read it, and either grey the card out with "needs Google" or lead with the
   connect step.
4. **A per-template health record.** Which templates have actually been built and driven
   to a verdict, at which version, by whom. Given this codebase's history, a template
   nobody has run should be visibly marked as such rather than sitting next to ones that
   have.

---

## What I could not check, and why

Stated plainly, because an untested area passed over in silence reads as "checked, fine".

- **I did not drive the UI at all.** This was a design session by instruction: no server
  started, no browser opened, no test run. Everything about how these workflows *behave
  when built* is inference from code plus the written QA record.
- **No entry in this library has been built.** Not one. Every "buildable today" verdict
  means "the parts exist and I can trace the shape through the validator's rules" — not
  "I saw it work."
- **I could not verify whether the Slack-message trigger's event payload lets test
  examples vary** (entry 2.2's G3 exposure). The code suggests it does; nobody has run it.
- **G6 (test runs inflating the health score) is unresolved in the written record** —
  `CLAUDE.md` says open, `hardening-2026-07-21.md` says it did not reproduce. I did not
  settle it.
- **I did not verify any capability against its live API.** "Airtable can update a
  record" means the capability is registered with a handler, not that I watched a record
  change.
- **The relative demand for these ten is my judgement, not research.** I have no data on
  what customers actually ask for. The grouping and the ordering are arguments, and the
  operator should overrule them where they know the market better than the code does.
