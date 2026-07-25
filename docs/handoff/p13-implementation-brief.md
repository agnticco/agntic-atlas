# P13 — Connector-breadth adapter: implementation brief

**Companion to:** [`docs/architecture/mcp-capability-adapter.md`](../architecture/mcp-capability-adapter.md) (the decision + design).
**This doc:** the executable handoff — invariants, behavioral acceptance tests, gates.
**Written:** 2026-07-15, re-grounded live against `main` @ `3c87709`.
**RESCOPED 2026-07-24** — see "What P13 ships" below. MCP+CIMD is now primary; OpenAPI-autogen
is out of the phase; a fourth seam was added to P13-0.
**Branch:** build P13 off `main`, not off an unmerged branch.

---

## ⚠️ RESCOPE 2026-07-24 — what P13 ships, and what left the phase

**The operator's constraint:** Atlas is a no-code product for non-technical people, so a
customer must **never** be sent into a developer settings screen to mint a token. Exactly two
connector routes are acceptable, both ending at one Connect button:

1. **Route 1 — self-identifying.** No console work from *anyone*. Atlas self-publishes one
   **Client ID Metadata Document** (CIMD, SEP-991, MCP auth spec 2025-11-25) at a stable
   HTTPS URL on `atlas.agntic.co`; that URL *is* its `client_id` with every CIMD-supporting
   server. **Verified 2026-07-24:** Notion, Linear, Stripe, Asana, Sentry, Figma.
   **Blocked:** Atlassian (approved clients only), Google (rejects registration).
2. **Route 2 — Agntic registers once.** Developer account + app + scopes + callback + two
   secrets, once per service forever. Still one button for the customer.

**P13 ships ROUTE 1 ONLY.** That is the scope tightening. Consequences, stated plainly:

- **OpenAPI-autogen is OUT of P13.** An OpenAPI-generated capability always needs someone to
  register an OAuth app, i.e. it is always route 2. It is retained in the design doc as the
  mechanism for route-2 connectors taken **on demand after** the phase.
- **Microsoft 365, HubSpot and QuickBooks are OUT of P13.** All route 2. This is a real cost
  — they are arguably the highest-value services for the client base — and it is an accepted,
  deliberate trade, not an oversight. They are the first afternoons *after* P13 closes.
- **The connector setup screen is OUT of P13.** It exists to make route 2 cheap; with no
  route-2 connector in the phase it has nothing to serve. Build it alongside the Microsoft
  365 afternoon.
- **The MCP adapter moves from last (P13-C, "fallback") to first-after-the-seams.** It is no
  longer a fallback; it is the entire delivery mechanism of the phase.

**The spec's client-identity priority order — and the hard stop:** pre-registered creds →
CIMD → DCR → *prompt the user for credentials*. **Implement the first three and STOP.** A
naive implementation falls through to the fourth, which is precisely the banned behaviour. A
server exhausting all three is **"not supported yet"** → route-2 list. It never degrades into
asking a customer for a token.

---

## How to read this brief (standing rules — do not skip)

1. **Line numbers here are NON-AUTHORITATIVE provenance.** They were true at
   `3c87709` on 2026-07-15. The **invariant + the behavioral acceptance test** is the
   contract. **Re-ground every seam against current code before you touch it** — grep
   the symbol, don't trust the line.
2. ~~`outcome-oracle.js` is being edited by another session~~ — **resolved.** That work landed;
   re-ground against `main` as normal.
3. ~~**Mutation-testing hazard:** `mutation-sweep.mjs` …~~ — **VOID (2026-07-24).**
   `mutation-sweep.mjs` and `mutation-guard.mjs` were **deleted on 2026-07-19** by operator
   decision, along with the `test-adversary` agent. Do not look for them and **do not
   re-introduce them unasked** (CLAUDE.md, "Mutation testing was removed").
4. ~~**Spawn `test-adversary` after each increment**~~ — **VOID (2026-07-24).** That agent no
   longer exists. **Its replacement is the QA Manager handoff:** agents are treated as real
   positions, and the QA work order is written **at the start of the increment, from the
   stated guarantees, before the code exists** — then executed against the built increment in
   a headed browser, in parallel with the `verifier`. The Builder does not sign off their own
   work. See CLAUDE.md, "Agents & gate enforcement".
5. **The discipline that survived the tooling removal:** when you add a guard, re-introduce
   the bug **by hand** and watch the test go red. A green suite is evidence of nothing until
   you have watched it fail.

---

## The P13 contract (what "done" means for the whole phase)

A capability sourced **externally** (for P13: projected from a **CIMD-authenticated MCP
server** — see the rescope note; OpenAPI-autogen left the phase) is indistinguishable to the
converger/engine/oracle from a native one:

- **It connects with zero console work from anyone.** Atlas identifies itself by its
  self-published metadata document; the customer clicks Connect, approves on the service's
  own consent screen, and the returned tenant token lands in the existing vault. **No step
  of that flow may ever ask a customer for a credential** — if the identity chain
  (pre-registered → CIMD → DCR) is exhausted, the connector is *not supported yet*.

- **`complete ⇒ publishable` holds for it** — the gap scorer certifies it iff publish
  accepts it. (Same floor as P12; not lowered.)
- **The moat holds regardless of source** — a `branch`/`decision` refuses to route on
  it unless it declares a closed domain; a write gets idempotency + the approval gate;
  its outcome assertion is provable via its declared locators.
- **Effect is derived from a STRUCTURAL signal it declares, never from a regex on its
  id.** (This is the whole P13-0 correction — see below.)
- **Triggers are OUT OF SCOPE.** Externally-sourced capabilities are step/delivery
  only. Event triggers remain the hand-built track. Do not surface an external
  capability in a `trigger` position.

### Mandatory for EVERY new connector: can it phone us? (operator, 2026-07-24)

**Answer this before writing the connector, and write the answer down.** It is not an
afterthought — it decides what the connector can promise a user, what "how often does
this check?" even means for it, and whether it can be tested anywhere but a public
host. Getting it wrong has already produced a trigger that published, showed as live,
and could never fire (see the Airtable entry in `CLAUDE.md`'s recorded edits).

Today: **Slack and Airtable push to us. Gmail does not — Atlas polls it every 60s**,
even though Google offers push via Pub/Sub; it was never built. Web and filesystem have
no trigger at all. So the answer genuinely differs per connector and cannot be assumed.

Four questions, recorded in the connector's own header comment:

1. **Does the service publish a subscription mechanism** (webhook, event stream, push
   notification)? If not, the only honest trigger is a poll, and say so out loud.
2. **If it pushes: what is the full lifecycle?** Who registers the subscription and
   *when* (it must be armed on publish — nothing arms itself); does it expire and need
   renewing; how is an inbound call proved genuine (signature/HMAC); and how is it torn
   down when the workflow is deleted or paused. **A create with no renewal is a trigger
   that dies quietly a week later** — that exact defect shipped.
3. **If it polls: what interval, and what does it cost** to have every active workflow
   wake up on it? This is the number the user's "how often should this check?" setting
   moves (`src/workflows/trigger-frequency.js`).
4. **Does push need Atlas publicly reachable?** If yes, the connector's trigger
   **cannot be proven on a laptop** — plan the live verification on the real host, and
   do not let a green local suite stand in for it.

**Publishing must fail closed** if a trigger needs something set up on the other side
and it could not be set up. Not a warning — a refusal. See `CLAUDE.md`.

---

## Increment P13-0 — generalize the converger seams (PREREQUISITE, build first)

**Why first:** these three seams are hardwired to the current connectors (mostly the
literal string `'airtable'` and a token-regex on ids). Bolt an adapter on top of them
and every new connector inherits the silent write-misclassification in seam #1. These
are **pre-existing F-era debt** — the already-built `sheets_describe`
(`google/index.js:709`) is unwired for the same reason, so **fixing seam #3 also fixes
native Google Sheets today.** That's the tell that this is debt repayment, not new scope.

~~The three files are **already in `mutation-sweep.mjs` TARGETS**~~ *(void — the sweep was
deleted 2026-07-19; hand-mutate instead)* (validator +
outcome-oracle + gap-scorer from C, elicitation-graph from F) — so the sweep will grade
these fixes. Good.

### Seam #1 — effect must come from structure, not an id-regex *(the dangerous silent one)*

- **Current state (re-ground before touching):** `outcome-oracle.js` `nodeEffect()` for
  a `connector-action` derives write-vs-read by testing the capability id against
  `WRITE_VERBS` regexes (`~line 225`: `if (!WRITE_VERBS[kind].test(action)) continue;`).
  A write whose id contains no known verb token (`notion_create_page` — "page" isn't in
  the set) is misclassified as a **read** → silently skips idempotency and the approval
  gate.
- **Invariant:** a capability's read/write effect is a property the capability
  **declares**, read from the catalog — not inferred from its name. A write capability
  with an unfamiliar id is still a write. The id-regex survives only as a last-resort
  fallback for legacy native caps that declare no effect.
- **Design:** add `effect: 'read' | 'write'` to the `CapabilityRegistry.register()`
  contract (today's def has `positions` but no `effect` — verify). `nodeEffect()` reads
  `registry.get(id).effect` first; `WRITE_VERBS` is consulted only when a cap declares
  none. **Fail closed: an external capability with no declared effect is treated as a
  write** (skipping idempotency on a real write is unrecoverable; a spurious idempotency
  key on a read is harmless). Native connector registrations declare their effect
  explicitly in this increment.
- **Behavioral acceptance test (line-independent):** register a synthetic capability
  `x_create_page` with `effect:'write'` and **no** entry added to `WRITE_VERBS`. Assert
  `nodeEffect({type:'connector-action', config:{action:'x_create_page'}})` returns a
  write (non-null, kind=write), so a node using it is assigned an idempotency key and
  the approval gate fires.
- **Mutation to confirm the test bites:** revert `nodeEffect` to id-regex-only → the
  synthetic write classifies as read → the idempotency/approval assertion goes **red**.

### Seam #2 — `deliver` nodes need the same effect fallback as `connector-action` *(loud, blocks publish)*

- **Current state:** `nodeEffect()`'s `deliver` branch (`~line 194-196`) reads
  `CHANNEL_EFFECTS[channel]` and returns `null` if absent — **no** verb/effect fallback,
  unlike the `connector-action` branch (`~line 206+`). A correctly-configured `deliver`
  to a new delivery capability → effect `null` → its outcome assertion can never be
  satisfied → **`UNSATISFIED_ASSERTION` blocks publish**. (The runtime oracle
  `normalizeDelivery` `~line 540` is NOT affected — it has a `collectLocators` fallback
  `~line 561` — so only the build-time publish gate hard-fails.)
- **Invariant:** `nodeEffect` returns a correct effect for a `deliver` node targeting
  **any** registered delivery capability, using the same catalog-declared effect source
  as `connector-action`. A correctly-configured delivery never produces a false
  `UNSATISFIED_ASSERTION`.
- **Behavioral acceptance test:** synthetic delivery cap `x_create_page`
  (`positions:['delivery']`, `effect:'write'`, locator `['id']`). Spec: content step →
  `deliver`(channel `x_create_page`) with outcome assertion `record_exists → x:Pages`.
  Assert the validator does **not** raise `UNSATISFIED_ASSERTION` and publish succeeds.
- **Mutation:** restore the `CHANNEL_EFFECTS`-only `deliver` path → assertion
  unsatisfiable → publish blocked → test **red**.

### Seam #3 — destination schema-discovery must be connector-generic *(UX regression)*

> **⚠️ CORRECTION 2026-07-24 — "also fixes native Sheets" was WRONG, and the
> `sheets_describe` wiring below is NOT the proof of this seam.**
>
> Grounded live before implementing. Airtable and Sheets have structurally different
> write models, so this is not a literal-swap:
> - **Sheets has no capability that lists containers.** Airtable's flow opens with
>   `airtable_list_bases` → chips. Nothing equivalent is registered for spreadsheets
>   (`grep sheets_list src/connectors/google/index.js` → nothing).
> - **Sheets has no named fields.** `sheets_append` takes `values`, a positional array
>   of arrays (`google/index.js`, its `configSchema`). The entire mapping machinery —
>   `mapFieldsToColumns` → `config.fields` → `rewriteAssertionFields` — is built for a
>   NAMED-column write. Sheets needs name → column **index** and positional emission.
> - **A Sheets tab is not a config key.** It lives inside a `range` string
>   (`Sheet1!A:D`). Writing `config.tableId` at a Sheets node would fail
>   `UNKNOWN_CONFIG_KEY` at publish, since `sheets_append` does not declare it.
>
> **What was built instead:** the mechanism is generalized and proven by a **synthetic
> connector** — which is what the P13-0 gate actually asks for ("register a synthetic
> write capability with NO code special-casing it… (c) it offers click-to-pick"). A
> connector declares `schemaDiscovery` on its describe capability
> (`capability-registry.js`) and the node drives entirely off that declaration,
> config-key names included. Airtable declares it and behaves exactly as before.
>
> **Carried, not fixed:** Sheets click-to-pick. It needs name→column-index mapping and
> range parsing — a distinct feature, not this seam. Folding it in here would double
> the increment and risk a half-built path that appends into the wrong column while
> reporting success. **Do not re-add the "also fixes Sheets" claim without building
> that.**

- **Current state:** `elicitation-graph.js`'s `destinations` node fires only for
  Airtable — `usesConnector(n,'airtable')` (`~line 195, ~900`), hardcoded
  `airtable_list_bases` (`~964`) / `airtable_describe_base` (`~990`),
  `rewriteAssertionFields` gated on `/airtable/i` (`~line 122`). The dead
  `AIRTABLE_ID_KEYS = { baseId:'airtable', spreadsheetId:'sheets' }` (`~line 889`,
  declared, never referenced) is the abandoned generalization. `sheets_describe` is a
  real registered capability (`google/index.js:709`) with **zero** converger references
  — so native Sheets writes already get no click-to-pick and must paste an id/range,
  violating F's own "never ask for what we can read" rule (`prompts.js` §6.2.3).
- **Invariant:** the destinations node (read the real schema → offer click-to-pick →
  map fields to real columns → rewrite the outcome's `fields`) fires for **any** write
  capability whose connector exposes a schema-read capability, not only `airtable`.
- **Design:** replace the literal `'airtable'` checks with a catalog lookup: for a write
  target's connector, resolve its schema-read capability (a connector declares which of
  its capabilities is the `*_describe` / list-containers action, and how to map that
  output to `{destination options, columns}`). Wiring `sheets_describe` is the required
  proof the generalization is real. `rewriteAssertionFields` keys off the actual target
  connector, not `/airtable/i`.
- **Behavioral acceptance test:** with a stubbed `sheets_describe` returning
  tabs+headers, a spec writing to Google Sheets (`sheets_append`) runs the destinations
  node: the user is offered a tab/column pick and `rewriteAssertionFields` updates the
  Sheets-target outcome — **without** any code path naming `'airtable'`. (Function-level
  test on `fillDestination`/`rewriteAssertionFields` is sufficient; full LLM-graph
  drive is optional.)
- **Mutation:** restore the `/airtable/i` gate (and the `usesConnector(n,'airtable')`
  literal) → the Sheets path gets no resolution → test **red**.

### P13-0 GATE (adversarial, this is the whole point)

Register a synthetic write capability with **no** code special-casing it anywhere, and
prove the catalog is genuinely source-agnostic:
- (a) it classifies as a **write** → gets idempotency + approval gate (seam #1).
  **⚠️ This is the one claim that was FALSE when first shipped, and it is worth knowing
  why.** Seam #1 made the outcome *oracle* read the declaration, but the two guards that
  actually protect a customer — `WRITE_WITHOUT_IDEMPOTENCY` and `WEAK_APPROVAL_FOR_WRITE`
  — were driven by a **second, untouched** id-regex, `isWritingAction()` in
  `workflow-validator.js`. Its own docstring said it existed "so the approval rules and
  the idempotency rule cannot drift apart about what a write is"; making one side
  declaration-aware and not the other drifted them exactly as feared. `notion_create_page`
  AND `notion_update_page` — the canonical shapes P13-A imports — escaped both guards
  while the oracle knew perfectly well they wrote. Found by the independent verifier, not
  by the Builder or his suite. **Now fixed:** `isWritingAction` consults the declaration
  first, via one shared `declaresWrite()` in the oracle so a *third* copy of "what is a
  write" cannot appear. The declaration can only ever **ADD** a write, never remove a
  guard — a declared read whose name matches the regex stays guarded, because a spurious
  idempotency key costs nothing and a missing one loses data. Pinned by
  `source-agnostic-catalog.test.js` §(e), mutation-verified;
- (b) as a `deliver` node it **satisfies** a `record_exists` assertion and publishes
  (seam #2);
- (c) it offers **click-to-pick** destination resolution via its connector's declared
  schema-read capability (seam #3);
- (d) **every** capability of a connected connector receives its tenant credential —
  proving credential resolution is driven by the connector the capability *declares*, not
  by a hand-maintained id list (seam #4).

Each pinned by a test, and **each mutation-killed by hand** — revert the seam, watch the
test go red. (`test-adversary` and the sweep are gone; this is now the Builder's own
discipline plus the verifier's independent hand-mutation.) Only when this gate is green does
an adapter get built on top.

### Seam #4 — credential resolution must be catalog-driven, not a hand-typed id list *(added 2026-07-24)*

- **Current state (re-ground before touching):** `CONNECTOR_INJECTORS` in `src/api/server.js`
  is a hand-maintained array whose `ownsNode` predicates test membership of per-connector
  `Set`s of literal capability ids (`SLACK_ACTION_IDS`, `AIRTABLE_ACTION_IDS`,
  `GOOGLE_ACTION_IDS`). The code carries its own warning at the Google set: *"A capability
  missing here gets no googleToken injected → 'no access token' at run time even though it's
  connected (this is how drive_create_folder broke, R22)."*
- **Why it blocks the phase:** an imported server exposing 40 tools would require 40 literal
  strings hand-added, with a run-time failure for each one missed — on a connector the
  customer has correctly connected. Same silent-failure class as seams #1–#3.
- **Invariant:** the credential for a node is resolved from the **`connector` field the
  capability already declares in the catalog**. Adding a capability to a connected connector
  never requires editing a list. **Fail closed on a missing tenant** — throw, never
  `?? default`.
- **Behavioral acceptance test:** register a synthetic capability on an existing connected
  connector *without* adding its id anywhere; assert the tenant credential is injected.
- **Mutation:** restore the literal-`Set` membership test → the synthetic capability gets no
  credential → test **red**.

---

## Increment P13-A — capability contract + MCP catalog loader + CIMD identity

*(Was P13-C "MCP adapter (fallback)". Promoted 2026-07-24: it is no longer a fallback, it is
the phase's entire delivery mechanism. The OpenAPI adapter that used to be P13-A has left the
phase — see the rescope note.)*

- **Invariant — one contract:** a single internal capability shape that a native
  registration and an MCP tool both project into. `McpCatalogLoader` connects to a **remote
  Streamable-HTTP** server (never stdio, never a per-tenant subprocess), lists tools, projects
  `inputSchema → configSchema`, applies the annotation layer, and registers into the same
  `CapabilityRegistry`. Effect **fails closed to `write`** when `readOnlyHint` is unset — an
  un-flagged write would skip idempotency and the approval gate.
- **Invariant — identity without registration:** Atlas serves **one CIMD document** at a
  stable HTTPS URL on `atlas.agntic.co`; that URL is its `client_id`. The client-identity
  chain is **pre-registered → CIMD → DCR → STOP**. Reaching the spec's fourth step (prompt
  the user for credentials) is a **defect**, not a fallback: a server that exhausts the chain
  is surfaced as *"not supported yet"*.
- **Invariant — no triggers.** MCP-sourced capabilities are `step`/`delivery` only, never
  `trigger`. The four trigger questions above still get answered and written down, and for
  every P13 connector the honest answer is "no trigger in this phase."
- **Gate:** a real tool from a real CIMD-supporting server (**Notion** or **Linear**) appears
  in `/capabilities` and `CapabilityRegistry.list()` beside native capabilities with correct
  `effect`/`positions`/`configSchema`, and passes the P13-0 synthetic gate's four checks for
  real (not a stub). **Plus:** the CIMD document is served, and a forced walk of the identity
  chain proves step 4 is unreachable.

## Increment P13-B — outbound execution + per-tenant token persistence

- **Invariant:** `makeMcpHandle` opens the session and injects the **tenant's** token on the
  transport, resolved through the *same* `oauthTokenStore` + `token-cipher` path as a native
  connector — CIMD changes only *our* client identity, never the customer's credential
  handling. **Fail closed on missing tenant** (throw, never `?? default`). Refresh/rotation
  uses the existing vault logic.
- **Invariant:** the connect flow is one button end to end — Connect → the service's own
  consent screen → back → connected. No screen in that flow asks for a credential.
- **Gate:** a workflow with one MCP-sourced **read** step + one native `deliver` runs green
  through the real engine; **two tenants isolated** — tenant B never reaches tenant A's
  credential (adversarial, mirrors the P12 cross-tenant tests). An **MCP write inside a
  `foreach`** is exercised — the highest-risk shape, where three separate P12 defects lived.

## Increment P13-C — the moat, adversarial

*(Was P13-D. "Both sources" collapses to one source now that OpenAPI is out of the phase.)*

- **Invariant:** every P12 moat invariant holds identically whether a capability came from
  native code or from MCP. `LLM_INPUT_NOT_ENUM`, `complete ⇒ publishable`,
  `WEAK_APPROVAL_FOR_WRITE`, idempotency-on-write — none weakened.
- **Gate:** re-run the P12 moat suite (`moat-adversarial.test.js`, `gate-adversarial`,
  `decision-adversarial`) with an **MCP-sourced write capability** substituted into the
  fixtures. The moat holds regardless of source. Nothing in the P12 floor is lowered to
  accommodate P13.

---

## Cross-cutting failure modes to avoid (from the P12 ledger — these WILL recur)

- **Denylist on a security property is wrong by construction.** Effect/domain checks
  must be **allowlists over declared structure**, not "is the producer an LLM / does the
  id lack a verb". A value's domain is bounded by what it declares, not by who made it —
  the exact hole the C moat-bypass and E's second-door defect exploited.
- **Never declare a config key `run()` doesn't read**, and never leave one it does read
  undeclared. Prove the consumer with a word-boundary grep before declaring
  (`UNKNOWN_CONFIG_KEY`). An external adapter must project only keys the handler consumes.
- **A new control/effect rule is not done until it's in BOTH executors** — the top-level
  loop (`flow-tester.js`) and the `foreach` sub-loop (`foreach.js`). Three P12 defects
  were "added to one set, not the other." An external write inside a `foreach` is the
  highest-risk shape; test it there.
- **`??`/`||` default on a tenant-scoped or effect value is the bug, not a safety net.**
  Fail closed.
- **A green suite proves nothing until watched go red.** Mutation-test every guard you
  add in the FIX. Don't quote a mutation score in a doc — state the rule, let the
  verifier re-derive the number.

## Test & gate wiring

- **New gate:** `scripts/gates/p13.sh`, **progressive** like `p12.sh` (runs increments
  **0 → A → B → C** in order, stops at the first unbuilt one, so `bash scripts/gate.sh 13`
  answers both "closed?" and "which increment next?"). Fail-closed; unimplemented check does
  not pass.
- ~~**`mutation-sweep.mjs`:** …~~ **VOID (2026-07-24)** — deleted 2026-07-19 by operator
  decision, along with `mutation-guard.mjs` and the `test-adversary` agent. There is no
  sweep, no TARGETS list and **no coverage floor** in this phase. What replaces it: the
  Builder hand-mutates each new guard (revert the bug, watch the test go red) and the
  **verifier independently hand-mutates the increment's NEW guards** — the one thing a log
  cannot fake. Do not re-introduce the tooling unasked.
- **`scripts/` diffs:** any change to a check or gate is recorded here and in CLAUDE.md.
  Checks are ADDED, never weakened — a silent `scripts/` diff is how a verifier detects a
  builder weakening their own gate.
- **CLAUDE.md:** on close, add the P13 block (the seams generalized, the contract, the
  adapters) in the same commit as the code, per the doc-is-the-memory rule.

## What the gate proves (calibration — operator, 2026-07-15)

P12's timeline was destroyed by an aggregate mutation-sweep **coverage floor** blocking
the phase *close* over a non-functional gap. **P13 does not repeat that.** The gate proves
**exactly two things**, and nothing else blocks the close:

1. **The backend works** — the behavioral acceptance tests in this brief pass (the moat
   holds, **all four** seams are generalized, a real MCP-sourced connector reads/writes
   end-to-end for a tenant, cross-tenant isolation holds).
2. **The UI/UX works for the phase's expected outcome** — a **live, headed** browser run
   the operator can watch: **connect a service Atlas never hand-built — with no developer
   console work by anyone — build a workflow with it by talking, run it, and see the real
   read/write happen.** Narrate each step, save screenshots to disk (CLAUDE.md → Working
   rules: visible UI verification). The verifier attests this in `docs/gates/p13.md`.
   **The connect step is half the proof**: one button, the service's own consent screen,
   back to Atlas connected — and at no point is the customer asked for a credential.

**No aggregate mutation-coverage floor is a blocking bar in P13.** Mutation-testing stays
an **internal technique** — each new guard must fail when its bug is reverted, so the
acceptance tests actually bite — but the survivor **percentage is an informational report,
never a pass/fail number to chase.** That chase is the specific thing that stalled P12.

**Apply the INCREMENT-loop review calibration** (CLAUDE.md, already approved): the verifier
**blocks only on user-reachable, silent (or destructive) defects** — everything else is a
**residual**, recorded and carried forward, not a merge-blocker. The gate is run **once, by
the builder** (the verifier confirms the SHA/log, doesn't re-run a 20-min deterministic
result). The **QA Manager** and the **verifier** run **in parallel**, not in series — the QA
work order is written at the START of the increment from its stated guarantees, before the
code exists, and executed against the built increment in a headed browser. (This replaces the
deleted `test-adversary`; agents are treated as positions, and the Builder does not sign off
their own work.) And the operator may **ship ahead of the formal close** (flag once with
facts, defer the debt, never fake it — the `ship-over-gate-ceremony` rule).

## Git shape for this phase (branch-per-increment)

Each increment is its own branch off `main`, PR'd and squash-merged back — the same shape
every prior phase has in the history:

```
main:  …─ (P13 planning #22) ─ (P13-0 #xx) ────── (P13-A #xx) ────── (P13-B #xx) ────── (P13-C + Gate: P13 close)
                 \                  \                  \                  \                  \
                (docs, merged)   p13-0/seams-      feat/p13-a-mcp-    feat/p13-b-        feat/p13-c-
                                 generalize        catalog-cimd       outbound-auth      moat-adversarial
                                 (4 seams)         (contract+loader   (tenant token,     (moat holds with
                                                    +identity)         foreach write)     an MCP source)
```

- **One increment = one branch = one session, ending at that increment's gate.** Rehydrate
  from this brief + the design doc, not from scrollback. **Do not span a gate boundary in
  one session**, and **do not branch the next increment off an unmerged one** — branch off
  `main` after the previous increment merges.
- **Re-ground at the start of every increment.** Line numbers in this brief are
  non-authoritative; grep the symbol. In particular P13-0 touches `outcome-oracle.js`,
  which was mid-edit by another session at brief time — verify its current state on `main`
  before editing.
- **The phase closes only** when the final increment is **merged to `main`** with a passing
  `scripts/gates/p13.sh`, the live UI/UX verification attested in `docs/gates/p13.md`, and a
  `Gate: P13` + `Phase:` trailer + `Verified-by:` from a fresh verifier who did not write
  the code. Increments themselves do **not** carry a `Gate:` trailer.
