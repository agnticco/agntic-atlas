# Contributing to Atlas

Thanks for being here. This document is short on ceremony and long on the two or
three habits that actually matter in this codebase.

## Getting it running

```bash
git clone https://github.com/agnticco/agntic-atlas.git
cd agntic-atlas
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY=sk-ant-...
npm start
```

Atlas prints a one-time setup code on first boot — you need it to create your admin
account at `http://localhost:3000`.

```bash
npm test                    # ~2,500 tests, about 8 seconds
```

The suite needs **no API key and no network**. If you write a test that does, it
will pass for you and fail for everyone else. Keep it that way: a test that
quietly needs a secret works for whoever wrote it and for nobody else.

**Run this before opening a pull request.** CI does not run it for you — see
below.

## The one rule worth reading twice

**A green test proves nothing until you have watched it go red.**

When you add a guard, put the bug back by hand and confirm the test fails. Then
restore it. This takes about a minute and is the difference between a test that
protects something and a test that is decoration.

This is not a general nicety — it is written here because this codebase has
repeatedly shipped guards that were pinned by nothing, behind a fully green suite,
and each one was found later by a person using the product. There used to be
automated mutation tooling; it was removed because it rewrote files in place and
caused more damage than it caught. So the discipline now depends on you doing it.

If you can't make a test fail by breaking the code, say so in the pull request. An
honestly unpinned change is fine. A change described as pinned when it isn't is not.

## What good work looks like here

**Fix the cause, not the symptom you happened to see.** A striking number of bugs in
this project's history were one rule written in two places that drifted apart, or a
check scoped to the *shape* of a value rather than what it *means*. If you find
yourself adding a second copy of a rule, collapse them into one instead.

**Make failures say what to do.** "LLM unavailable" is true and useless. Error text
is read by people who did not write the code and do not know its vocabulary. Name
the thing they have to change.

**Never let something fail silently.** If a check cannot decide, it must refuse and
say so — never wave the thing through. A workflow that looks like it succeeded and
did not is the specific failure this product exists to prevent.

**Write comments that explain why, not what.** The code says what. The expensive
knowledge is why it is written that way and what breaks if you 'simplify' it. You'll
see long comments throughout; they are load-bearing, and they are usually the record
of something that already went wrong once.

**Keep the docs true in the same commit.** A design doc that disagrees with `main`
is worse than no doc, because it reads as authoritative and the next person builds
on it.

## Pull requests

- Branch off `main`.
- One coherent change per PR. If you can't describe it in a sentence, it's probably
  two PRs.
- Say what you did, why, and — plainly — what you verified versus what you believe.
  "I ran this and saw X" and "I think this is right but didn't test it" are both
  welcome; blurring them is not.
- **Run `npm test` yourself — CI does not.** The test job was removed on
  2026-08-14 after repeated hangs on GitHub's Ubuntu runners that could not be
  reproduced locally or on macOS CI (a file taking 0.07s locally hit a 120-second
  timeout, most likely starvation from several suites booting the whole
  application at once). The tests are unaffected and still pass; they are just not
  a gate. CI still checks the lockfile and that the Docker image builds and boots.
- If a maintainer asks whether you ran the suite, the honest answer matters more
  than the green tick you would otherwise have had.

## Commit messages

Conventional commits — `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
Write the subject for someone reading the log in a year:

```
fix: a workflow that set itself up on every run worked exactly once
```

beats `fix: idempotency bug`. There's more detail in
[`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md).

## Where things are

| Path | What lives there |
| --- | --- |
| `src/converger/` | The interviewer — turns a conversation into a workflow. The hard part. |
| `src/workflows/` | The execution engine — runs a workflow, threads data between steps. |
| `src/connectors/` | Services Atlas can talk to, as one capability catalog. |
| `src/api/` | HTTP surface. `server.js` is the spine; `builder.js` is the build/chat API. |
| `src/auth/` | Accounts, sessions, tenants, the encrypted token vault. |
| `public/index.html` | The entire front end, in one file. Yes, really. |
| `tests/` | Mirrors `src/`. Test names are sentences describing the behaviour. |

## Adding a connector

Two things are asked of every new connector, up front, in its own header comment:

1. **Can the service call us, or must we poll it?** If it pushes: who registers the
   subscription and when, does it expire, how do we prove an inbound call is
   genuine, and how is it torn down. If it polls: how often, and what does that cost
   across every active workflow.
2. **Does it need Atlas to be publicly reachable?** If so, that trigger cannot be
   proven on a laptop, and a green local suite must not stand in for a live check.

Capabilities must **declare** what they do — whether they write, what kind of thing
they produce, and which config key names the destination. Do not rely on the name
being guessable from the id. Guessing from names has been the root cause here more
often than any other single mistake, and there is a test
(`tests/workflows/capability-declarations-audit.test.js`) that will fail if you skip
the declaration.

## A note on scope

Atlas is deliberately a **general** workflow engine. If you find yourself adding a
branch that special-cases one particular workflow shape or one connector, that is a
sign the mechanism is wrong. Add a generic branch instead.

## Licence

Contributions are accepted under the [AGPL-3.0](LICENSE), the same licence the
project uses. By opening a pull request you agree your contribution is licensed
that way.
