# Atlas demo script — screen recording

**Written 2026-08-02, from a full day of driving prod.** Every timing below is measured,
not estimated. Every step has been done end to end on `atlas.agntic.co`.

**The one sentence this demo exists to prove:**
> *You can trust it went live only because it was actually checked.*

Everything else — the chat, the plan, the diagram — is table stakes that other tools have.
The promise being **checked, and refused when unproven**, is the thing nobody else does.

---

## Before you record

| Check | Why |
|---|---|
| Sign in as a tenant with **Google + Web connected** | The demo builds a Doc workflow. Connections flyout, left sidebar. |
| Dismiss the **What's New** modal first | It appears after every deploy and will swallow your first click. |
| Have a **second tab open on Google Drive** | Act 3 ends by showing the real document. |
| Don't deploy during the recording | Restarting the server kills an in-flight test. |
| Budget **~6 minutes** of real time | Cut points marked below. |

**Do NOT demo Slack triggers.** Slack has never delivered an event to Atlas in
production — a Slack-triggered workflow will correctly refuse to publish, which is honest
but not what you want on camera. Slack as a *destination* is fine.

---

## Act 1 — one sentence becomes a working automation (~2 min)

**Say:** *"I'm going to describe a job in one sentence and not touch a settings screen."*

1. Click **+** in the sidebar.
2. Type, and press Return:

   > Every weekday at 10am Central, search the web for AI automation news from the last
   > day and save a short three-story briefing as a new Google Doc titled with that day's
   > date. Don't email anyone.

3. **~15s.** Atlas replies. It either asks **one clarifying question** or offers to build.
   If it asks (it often asks whether to focus the search), answer in plain words —
   *"Keep it broad, whatever's trending"* — and press Return.

   **Say:** *"Note it asked instead of guessing. And notice what it didn't ask —
   it never asked me for a document ID or a folder path."*

4. Click **Build it →**.
5. **~45s** to the plan card.

   **Point at:** the trigger line — *"Runs automatically Monday through Friday at 10:00am
   America/Chicago"* — and the **ON FAILURE** row.

   **Say:** *"It has already decided what happens when the search finds nothing: you still
   get a document, and it tells you it was empty. It's not going to fail silently."*

6. Click **Approve & build →**.
7. **~75s.** Optionally expand *"How Atlas thought through this build"* and scroll.

   **Say:** *"That's its actual reasoning. It's weighing trade-offs and correcting itself."*

> **CUT POINT** — the 75s build is the longest wait. Cut from clicking Approve to the
> steps appearing.

---

## Act 2 — the receipts (~2 min)

The workflow appears as a row of steps, none confirmed.

8. Hover a step. A green tick and red ✗ appear. Click the tick.

   **Say:** *"Every step has to be confirmed by a person before this can be tested. It
   shows you the real configuration — not a summary of it."*

   Read one card aloud. The AI step's card shows the **actual instruction**; the delivery
   card shows **where it goes** in plain words ("a new Google Doc").

9. Confirm the rest. The counter reaches **5 / 5 APPROVED · every step approved**.

10. **Point at the right-hand panel** before pressing anything:

    **Say:** *"This is the deal. In my words — and underneath, the machine-checkable
    version. This is what 'it works' is going to be measured against."*

11. Click **Run test**.

    **Say:** *"Nothing is sent. It runs the real engine with the sends turned into
    receipts — and it checks the destination really exists first."*

12. **~60s.** The checks list counts **0 of 1 → 1 of 1**.

13. Verdict: **Contract kept · every promise held — it's cleared to go live**, and
    **Go live** unlocks.

    **Say — this is the most important line in the demo:**
    > *"Go live was locked until that passed. If any promise had fallen short, or if
    > nothing had actually been proved, it would say so and stay locked. It will not
    > certify something it didn't check."*

---

## Act 3 — it actually did the thing (~1.5 min)

14. Click **Go live** → the review screen appears.

    **Point at "WHAT YOUR TEAM SEES"** — it contains the real briefing text it produced.

    **Say:** *"That's real output from a real search, not a mock-up."*

15. Click **Approve & go live →**. You land on the **dashboard**: green `active`,
    "Scheduled — Every weekday at 10:00 AM CDT".

16. Click **Run now**. **~30s.**

17. Switch to your **Google Drive tab** and refresh.

    **Say:** *"There's the document. Real content, titled with today's date. That's the
    same workflow that will run itself every weekday morning."*

    Open it. Scroll the three stories.

---

## If they ask "what happens when it goes wrong?"

Good question to get. Honest answers, all true:

- **A step breaks in testing** → the panel names the step and Go live stays locked.
- **Only some paths tested** → *"nothing went down one path"*, and it refuses to certify.
  A workflow that routes is only proved on the routes you test.
- **A destination doesn't exist** → the test says so before you go live, by reading the
  real service (Slack, Airtable, Google Sheets, Docs, Calendar).
- **A trigger can't be armed** → publishing is **refused**, with the fix named. A workflow
  that saves, shows as live and can never fire is the lie the product exists to prevent.

---

## Numbers you can quote (measured 2026-08-02, prod)

| Stage | Time |
|---|---|
| One sentence → plan | ~45s |
| Plan approved → steps ready | ~75s (`verify` itself: **4ms**) |
| Test, one sample | ~60s |
| Real run, end to end | ~30s |
| **Total, sentence → live automation** | **~4 minutes** |

A linear workflow is tested with **one** sample; a workflow that branches gets **one per
path** — because a different path is different wiring.

---

## Known-fragile, avoid on camera

- **Slack triggers** — have never fired in production. Console configuration, not code.
- **Long web-search tests** — ~60s per sample. Fine for one sample; don't demo a
  three-branch web-search workflow.
- **Don't reload mid-test.** It's survivable now (the panel resets to ready), but it looks
  like a stumble.
- **The tenant's first login after a deploy** shows the What's New modal. Dismiss before
  you hit record.
