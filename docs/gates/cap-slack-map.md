# Gate: cap-slack-map — Scope-aware Slack capability map (P1-domain follow-up)

**Verdict: PASS**
**Date:** 2026-06-09
**Verified commit:** 3d3adc7 (`feat(p1-slack): declarative, scope-aware Slack capability map`)
**Branch:** feat/p1-slack-capability-map (based directly on main @ 714f4e6, the PR #2 merge)
**Verified by:** Verifier (independent; did not write this code)

This is a P1-domain capability follow-up, not a numbered phase. P1's gate stays closed/green.

## Done-when (the user's ask)

An easy-to-understand, editable Slack capability map the AI/converger can tap into,
adjustable per client as granted scopes vary. An action is AVAILABLE iff implemented
AND the client's bot token grants its requiredScopes; scopes auto-detected (not
hand-maintained); exposed via GET /capabilities.

## Objective check

```
$ bash scripts/gates/cap-slack-map.sh   → EXIT 0
cap-slack-map PASS: scope-gated Slack capability map resolves per client and is exposed via /capabilities
$ node scripts/checks/slack-capabilities.mjs → EXIT 0, "SLACK-CAP-PASS"
  menu: post_message✓ post_dm✗ reply_in_thread✗ add_reaction✗ upload_file✗
```

## Tree state
- `git status --porcelain` → clean (empty)
- HEAD = 3d3adc71cf73adbf42601a14bb9b61288346ac41 on feat/p1-slack-capability-map
- `git merge-base --is-ancestor main HEAD` → true; main HEAD == merge-base == 714f4e6
- Tracked: src/connectors/slack/capabilities.json, scripts/checks/slack-capabilities.mjs, scripts/gates/cap-slack-map.sh (all confirmed via git ls-files)
- Commit 3d3adc7 added cap-slack-map.sh only; did NOT touch scripts/gates/p0.sh or p1.sh (git show --stat)

## Criteria + evidence

1. **Declarative + editable** — src/connectors/slack/capabilities.json:1-69 is valid JSON
   (gate node -e JSON.parse passes). 5 actions, each with requiredScopes/config/implemented.
   Loaded as data via JSON.parse(readFileSync(...)) at src/connectors/slack/index.js:33. Data, not code.

2. **Availability = implemented AND requiredScopes ⊆ granted** — resolveSlackCapabilities,
   src/connectors/slack/index.js:65-77. !implemented sets reason first and never sets available
   (line 71); missing scopes block (line 72); only the else sets available=true (line 73).
   Unimplemented actions stay unavailable even when fully scoped.

3. **Scopes auto-detected** — detectGrantedScopes, index.js:42-58, reads the `x-oauth-scopes`
   header off Slack auth.test (lines 49-54). Returns [] with no token/on failure.

4. **AI can tap in** — GET /capabilities at src/api/server.js:239-246 returns
   `{ channels, connectors: { slack } }` where slack = provider.resolve() (grantedScopes +
   per-action available flags). describeSlackForPrompt (index.js:80-89) renders prompt text.

## Independent reproduction (Verifier-chosen, not the gate's)

**Scope-variance probe** (resolveSlackCapabilities called directly):
- `[]`               → post_message=false ("token missing scope(s): chat:write"); all others "not yet implemented"
- `[chat:write]`     → post_message=TRUE; post_dm/reply_in_thread/add_reaction/upload_file=false (not yet implemented)
- `[chat:write,im:write,reactions:write]`            → post_message=TRUE; all unimplemented stay false
- `[chat:write,im:write,reactions:write,files:write]`→ post_message=TRUE; upload_file STILL false despite files:write granted (unimplemented dominates)
- post_message flips to available ONLY with chat:write present. Confirmed.
- Unimplemented actions NEVER become available regardless of scopes. Confirmed.
- detectGrantedScopes({token:undefined}) → [] (honest no-token guard).

**My own stub auth.test** (scope set distinct from the gate's; includes files:write):
- stub header `chat:write,im:write,files:write,channels:read` → detectGrantedScopes returned
  exactly `["chat:write","im:write","files:write","channels:read"]` (exact-match true).
  Proves real header parsing, not a hardcoded list.

**Real spine end-to-end at my stub** (boot bootSpine/createApp, GET /capabilities):
- stub header `chat:write,files:write,groups:write` (no im:write/reactions:write — differs from gate)
- /capabilities echoed grantedScopes = ["chat:write","files:write","groups:write"] exactly
- menu: post_message=true, upload_file=false (files:write granted but unimplemented), rest false.
  Per-client resolution confirmed through the actual endpoint.

## Non-regression
- `bash scripts/gates/p0.sh` → EXIT 0 (engine+auth boot, /health 200, server.js clean UTF-8)
- `bash scripts/gates/p1.sh` → EXIT 0 (hand-authored spec ran through engine, posted to Slack, ts returned)
  The connector rewrite did not break posting.

## Honesty of record
Commit body matches reality: auto-detect via x-oauth-scopes (index.js:53); only post_message
implemented (capabilities.json:15 true; lines 27/40/53/66 false); docs/connectors/slack.md:89-123
"Capability map (what the AI may use)" section present and accurate.
