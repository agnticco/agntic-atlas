# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/agnticco/agntic-atlas/security/advisories/new).
That opens a private advisory only the maintainers can see, and it works without
email.

You should get an acknowledgement within a week. If you have not heard anything in
two weeks, please open a public issue that says only *"awaiting a response on a
private report"* — no details — so we know the private channel failed.

We will credit you in the advisory unless you ask us not to.

## What is in scope

Atlas is software you run yourself, so the interesting boundary is what one
workspace, one user, or one workflow can reach that it should not:

- **Cross-tenant leakage.** One workspace seeing another's workflows, runs, tokens,
  documents or costs. Isolation is meant to be structural and fail-closed — the
  stores throw when a tenant is missing rather than returning unscoped rows — so a
  way around that is the highest-value bug in the codebase.
- **Credential exposure.** OAuth tokens are AES-256-GCM encrypted at rest. Anything
  that reveals a token, an API key, or the key that decrypts them — in a log, an
  error message, an API response, a run record — counts.
- **Authentication and session handling.** Bypassing sign-in, forging or reusing a
  session, escalating to platform admin, or defeating the single-use approval links.
- **Approval bypass.** A workflow performing an action that should have required a
  person's approval. Approvals are deliberately not accepted from email replies —
  a `From:` header is forgeable — so a path that reintroduces that is in scope.
- **Injection through workflow content.** Atlas reads untrusted text (emails, web
  pages, records) and feeds it to models and connectors. A path from that content
  to arbitrary code execution, an unintended write, or a message sent somewhere the
  workflow never promised is in scope.
- **Sandbox escape on file access.** The filesystem connector is limited to folders
  a tenant has approved. Reading outside them is in scope.

## What is not in scope

- **A model producing wrong or unhelpful output.** That is a quality problem —
  please open a normal issue.
- **Anything requiring you to already be the platform administrator** of the
  deployment. That account is trusted by design; it can create and delete
  workspaces.
- **Missing hardening on a deployment you have configured insecurely** — no HTTPS,
  a guessable admin password, a `.env` committed to a public repo. Tell us if the
  *documentation* led you there, though; that is a real bug and we will fix it.
- **Vulnerabilities in an upstream dependency** with no Atlas-specific path to
  exploit. Report those upstream. If Atlas's particular use makes it exploitable,
  that is in scope — say so.

## Supported versions

Atlas is developed on `main`. Fixes land there first, and there is no long-term
support branch. If you run a pinned version, expect to update to pick up a fix.

## Running Atlas safely

A few things matter more than the rest, and all of them are your responsibility as
the operator rather than something the code can enforce:

- **Set `JWT_SECRET` and `OAUTH_TOKEN_KEY` explicitly** for anything beyond local
  use. Left unset, Atlas generates them and writes them under `./memory/` — fine
  for a laptop, but they must be backed up, and losing `OAUTH_TOKEN_KEY` makes every
  stored connector token permanently unreadable.
- **Put it behind HTTPS** if it is reachable from anywhere but your own machine.
  Session cookies are marked `Secure` outside development.
- **Back up `./memory/`.** It holds every account, workflow, run record and
  encrypted token. Atlas snapshots the databases at boot, to the same disk — which
  is not a backup.
- **Treat the platform admin account as root.** It can create, suspend and archive
  every workspace.
- **Consider `TENANT_DAILY_USD_LIMIT`** if anyone but you can sign in. Atlas spends
  real money per run against your API key, and by default a self-hosted install has
  no ceiling.
