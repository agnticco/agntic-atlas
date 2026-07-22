# Hardening session — 2026-07-22

Working tree is clean. Two commits landed. **Nothing is deployed** — production is
still v1.6.11; local is v1.6.27.

## The open bug — READ THIS FIRST

**Atlas asks the same set-up questions twice, and the second time it asks them the
answer still does not stick.** This was reproduced twice today on a three-lane
approval workflow ("classify an email as urgent / normal / spam; ask me on Slack
before saving the urgent ones"). What the user sees:

1. Atlas finishes building and asks three questions, with a **Use your suggestions**
   button.
2. They click it.
3. Atlas rebuilds the entire workflow — about 90 to 180 seconds of paid work — and
   then asks **the same three questions again, word for word**.

It is bounded, so it eventually gives up rather than looping forever, but a user has
no way to make the answer take effect, and every round costs a full rebuild.

The measured shape of it, from the event log:

```
gaps (asked) → answered → generate 89.7s → same defect survives
             → blocker_to_chat → gaps (asked again, identical)
```

Today's fix (below) removes one *cause* of this — the case where the missing piece
has only one possible answer. It does **not** fix the general case: when the answer
is genuinely a choice, the answer is still handed to a whole-workflow rebuild as a
hint, and the rebuild does not reliably apply it. **That is the next thing to fix.**

The right shape of the real fix is almost certainly the same as today's: *apply the
answer to the workflow directly, then re-check* — rather than regenerating and
hoping. The machinery for applying an answer already exists
(`autoRepairStructural` + `applyProposal`, `src/converger/elicitation-graph.js`);
what is missing is a repair for the case where the user has *chosen* between real
options.

## What was fixed today

**1. An interrupted build no longer declares your work lost** (`a17dc55`)

If Atlas restarted while someone was building, the page gave up after about fifteen
seconds — shorter than a restart or a deploy — and then printed two contradictory
things at once: "your work is saved" and "you can start over with + New workflow".
Told both, a reasonable person picks the destructive one. It now waits ninety
seconds of continuous silence before concluding anything, and says one thing:
*"The build was interrupted, but your work is saved — tell me what to change and
I'll carry on from here."* Verified live by killing the server mid-build.

Also in that commit: a raw JavaScript error (`alive is not defined`) was being shown
to the user as the explanation for their build failing. The real text now stays in
the log and the user gets a sentence.

**2. Atlas fills in its own blanks, and asks in plain English** (`7e043c2`)

When Atlas left a step incomplete and there was only one thing that blank could
mean, it now fills it in itself instead of spending a rebuild and asking. Kept
deliberately narrow — if there are two possible sources it still asks, because a
repair that guesses is worse than a question the user can see.

And the questions themselves were written in machine names. A user was being asked
to judge *"The outcome says inbox:Email Summary should happen only when
urgent_approved"*. It now reads *"You said this should only reach 'Email Summary'
in your Atlas inbox when the email is urgent approved"*. **Verified live** — that
exact sentence was seen in the browser after the fix.

## What was confirmed working, by watching it

Driven end to end in a visible browser, with the reasoning stream expanded on every
build:

- A simple scheduled workflow builds on the background path, reveals its steps, and
  reaches 4-of-4 approved with "Run test" unlocked.
- The plan review is good: every step, every route including the one Atlas inferred,
  a failure policy, and an honest "you said this" versus "I assumed this" mark on
  each line.
- Atlas offers Slack approval buttons when asked for an approval step (it used to
  claim it could not do that).
- Its reasoning explicitly avoids two known traps: it does not send the approval
  message twice, and it sets an unanswered approval to time out as a *rejection*.
- When a rebuild changes nothing, Atlas now stops rebuilding and takes the question
  to the conversation instead. Seen firing in the log on both builds.

## Next session

The operator's stated next step: **create a QA Manager agent** — one that knows how
the product is meant to behave, drives it live, and hands findings to a coder.
Today's session is the argument for it: every defect above was found by using the
product, not by reading it, and the test suite was green throughout.
