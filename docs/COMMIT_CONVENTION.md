# Commit Convention

Atlas uses **Conventional Commits extended with phase/gate tags**, so the git
history doubles as a build ledger: every commit says what kind of change it is,
which build phase it belongs to, and — when it closes one — which "Done when"
gate it satisfies.

A `commit-msg` hook (`.githooks/commit-msg`) enforces the rules below. Merge,
revert, fixup, and squash commits are exempt.

## Format

```
<type>(<scope>): <subject>

<body>

Phase: <0-7>
Gate: <the "Done when" this commit satisfies>        # required only when closing a gate
Verified-by: <agent|self>                            # optional
```

### Header (line 1) — required, max 72 chars

```
<type>(<scope>): <subject>
```

**type** — one of:

| type | use for |
|---|---|
| `feat` | new capability (connector, trigger, converger behavior, UI surface) |
| `fix` | bug fix |
| `refactor` | restructure without behavior change (e.g. salvage cleanup) |
| `test` | adding or changing tests / harnesses |
| `chore` | tooling, deps, config, scaffolding |
| `docs` | documentation only |
| `build` | build system, packaging |
| `ci` | CI / hooks / automation |
| `perf` | performance |

**scope** — required for `feat`/`fix`/`refactor`. Use the **phase tag** or the
**component**, lowercase kebab. Preferred scopes:

- Phase tags: `p0` `p1` `p2` `p3` `p4` `p5` `p6` `p7`
- Components: `engine` `converger` `mcp` `auth` `vault` `slack` `gmail`
  `airtable` `triggers` `ui-builder` `ui-console` `launcher` `schema`

Combine when useful: `feat(p1-slack): ...`, `feat(p3-converger): ...`.

**subject** — imperative mood, no trailing period. "add", not "added"/"adds".

### Body — required for `feat`/`fix`

Explain *what changed and why*, not how. Wrap at ~72 columns. Reference the
frozen canonical spec by name when relevant (see CLAUDE.md).

### Trailers

- **`Phase:`** — required on every `feat`/`fix`/`refactor`/`test`. A single
  digit `0`–`7`. This is what makes the history filterable by build phase.
- **`Gate:`** — required **only** on the commit that closes a phase's "Done
  when" gate. Quote the gate text from the build plan. Pair it with a passing
  Verifier check (see CLAUDE.md gating rule).
- **`Verified-by:`** — optional. `self` or the verifying agent's name.
- **NO CLAUDE CODE ATTRIBUTION — enforced, not remembered.** No
  `Co-Authored-By: Claude …` trailer, and no `Generated with Claude Code` line, in
  a commit message, a PR body or an issue. The agent harness appends both **by
  default**, so every session is instructed to add them and has to remember not to.
  Remembering did not work: it drifted into **15 consecutive commits** before anyone
  noticed, each new session reasoning "the repo does it, so it must be right" from
  the evidence of the previous drift. `.githooks/commit-msg` now refuses both forms
  (rule 7), so being wrong about it is cheap.
  **History was deliberately NOT rewritten.** The commits already carrying the
  trailer are shipped and deployed, a force-push to `main` is the one operation that
  can eat a parallel session's work, and rewriting them buys two tidy messages at
  that price. The line is drawn here instead: everything from this commit on is
  clean, and the hook — not anyone's memory — is what keeps it that way.
  Both checks are **anchored to the start of a line**, so a message can still
  *describe* the rule in prose. Keep such a mention mid-line: a body line beginning
  `Co-Authored-By: …` is a real trailer as far as git is concerned, whatever you
  meant by it — the same trap as `Gate:` below.

> ⚠️ **NEVER BEGIN A BODY LINE WITH `Gate:` UNLESS YOU MEAN THE TRAILER.**
> `.githooks/pre-push` greps for `^Gate:[[:space:]]*[^[:space:]]` — **anywhere in the
> message, not just the last paragraph.** So a body line like
> `Gate: past C, stops at D` (a status note, meant innocently) makes the hook treat
> the commit as gate-closing, run the whole phase gate, and correctly **refuse the
> push** because the phase is not closed. It looks exactly like a broken gate and it
> is not: the hook is right and the message is wrong. This cost a P12-C session four
> failed pushes. Write "Gate status:" or "The gate now …" instead.

## Examples

Gate-closing commit:

```
feat(p2-triggers): fire workflows on inbound email matching a filter

Adds the event-trigger type to the engine and a Gmail "new email
matching filter" source. The hand-authored UPS->Slack spec now runs
on a real inbound message — no converger involved yet.

Phase: 2
Gate: a hand-authored "email from UPS -> post to Slack" spec fires on a real email
Verified-by: verifier-agent
```

Ordinary work-in-progress commit:

```
feat(p3-converger): measure spec completeness across the five gap dimensions

Phase: 3
```

Tooling commit (no Phase trailer required):

```
chore(ci): add commit-msg hook enforcing the phase/gate convention
```

## Why this shape

The orchestration plan runs the build as one deliverable per session, each
ending at a gate. Encoding `Phase:` and `Gate:` in the commit means
`git log --grep "Phase: 3"` reconstructs the converger's entire history, and
`git log --grep "^Gate:"` lists every milestone actually crossed — the history
becomes the source of truth for build progress, not a separate tracker.
