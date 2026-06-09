# Gate ledger

One file per closed phase gate, written **only** by the `verifier` subagent when
a phase's "Done when" is genuinely met (`p<phase>.md`). Each record states PASS,
the phase, the gate-closing commit sha, the Done-when text, and the concrete
evidence checked.

This is the human-readable companion to the enforcement: the objective check
lives in `scripts/gates/p<phase>.sh`, and `.githooks/pre-push` refuses to publish
a gate-closing commit whose check doesn't pass. `git log --grep "^Gate:"` is the
commit-level ledger; this directory is the verifier's signed record.

Do not hand-write these files. A gate is closed by an independent Verifier, not
by the author.
