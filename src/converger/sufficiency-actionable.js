/**
 * A CRITIC'S COMPLAINT MUST BE ACTIONABLE BEFORE IT IS WORTH A WHOLE-SPEC REBUILD.
 *
 * The sufficiency critic is a FAST-TIER opinion asked *after* the validator and
 * contract-coverage checks have both passed. It exists to catch what the outcome cannot
 * express — a real and useful job. But it is also, measurably, the single largest source
 * of paid Opus passes in the product.
 *
 * MEASURED 2026-08-01, driving two workflows as a new customer on a fresh tenant:
 * **it ordered 3 of the 5 total rebuild passes across both builds.**
 *
 *   · Build 1 — *"branch node config: the branch must route on `classify_inquiry` output
 *     with cases for 'pricing_inquiry' (to `compose_summary`) and 'none' (to
 *     `stop_no_action`)"*. The branch did **exactly that already**; the walkthrough card
 *     listed those very cases. A whole pass was bought to add what was there. On the
 *     round after, the same complaint was correctly discarded as already-covered — so the
 *     product already knew, one pass too late.
 *   · Build 2 — *"the workflow lacks the actual connector-action configs for
 *     `search_inbox` and `search_sent`"*. **`search_sent` is not a capability.** It does
 *     not exist in the catalog, so no rebuild could ever add it. That pass could not have
 *     succeeded no matter what the model did.
 *
 * Both are the same failure in different clothes: **the critic asserted something about
 * the spec that the spec itself can answer**, and nobody asked the spec.
 *
 * ── THE TWO QUESTIONS, BOTH MECHANICAL ───────────────────────────────────────
 *
 *   1. **Does everything it names already exist?** If a complaint names identifiers and
 *      every one is already in the workflow, it is describing what is there. Discard.
 *   2. **Does it name something that exists nowhere?** A capability that is neither in
 *      the spec nor in the catalog cannot be added by regenerating — the model has no
 *      such tool. The pass is unwinnable before it starts. Discard.
 *
 * This is the existing principle — *"an unverified opinion may not overrule a passing
 * check"* — extended from destinations (`sufficiencyClaimAlreadyCovered`, which reads
 * assertion locators only) to the structure the complaint actually talks about.
 *
 * ── AND IT FAILS TOWARD SPENDING THE PASS ────────────────────────────────────
 * A complaint naming nothing checkable — *"a step that extracts individual email
 * metadata"*, the third of the three, which may well have been right — is untouched.
 * Discarding a legitimate gap ships a workflow with a real deficiency; buying an
 * unnecessary pass costs time and money. The first is worse, so every uncertain case
 * keeps today's behaviour.
 */

/**
 * The identifier-shaped tokens in a complaint.
 *
 * `snake_case` is how this codebase names both node ids (`classify_inquiry`) and
 * capability ids (`gmail_search`), and a critic quoting the spec quotes them verbatim.
 * Ordinary prose does not contain underscores, so the class is precise without being a
 * guess about wording — which is the distinction this repo keeps paying to relearn.
 */
export function namedIdentifiers(text) {
  const out = String(text ?? '').match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
  return [...new Set(out)];
}

/**
 * Every identifier-shaped token the spec CONTAINS, anywhere.
 *
 * Deliberately the whole spec and not just node ids. A critic quoting the workflow quotes
 * branch case values (`pricing_inquiry`), extracted field names (`sender_name`) and
 * config keys as readily as it quotes node ids, and all of them are equally "already
 * there". Scanning only ids sent Build 1's complaint — which named the branch's own case
 * values — down the phantom-capability path instead of the already-present one: the right
 * verdict for the wrong reason, which is a bug waiting to be believed.
 */
export function identifiersInSpec(draft) {
  let blob = '';
  try { blob = JSON.stringify(draft ?? {}); } catch { blob = ''; }
  return new Set(namedIdentifiers(blob));
}

/**
 * Why this complaint cannot justify a rebuild — or `null` if it can.
 *
 * @param {string} missing  the critic's own words
 * @param {object} draft    the spec it is complaining about
 * @param {object} catalog  the live CapabilityRegistry (optional; without it rule 2 is skipped)
 * @returns {string|null}   a log-ready reason, or null to let the rebuild proceed
 */
export function sufficiencyUnactionable(missing, draft, catalog = null) {
  const named = namedIdentifiers(missing);
  if (!named.length) return null;                   // nothing checkable ⇒ spend the pass
  const inSpec = identifiersInSpec(draft);

  // ── 1. EVERYTHING IT NAMES IS ALREADY THERE ────────────────────────────────
  // It is describing the workflow back to itself. Build 1's branch complaint is this
  // case exactly: every id it quoted was in the spec, and the cases it demanded were
  // already the branch's cases.
  if (named.every(id => inSpec.has(id))) return 'names_only_what_already_exists';

  // ── 2. IT NAMES SOMETHING THAT EXISTS NOWHERE ──────────────────────────────
  // Not in the spec and not a capability this deployment has. A regenerate cannot
  // conjure a tool that does not exist, so the pass is unwinnable before it starts.
  // Requires the catalog: without it, absence is unknowable and this must not guess.
  if (catalog?.get) {
    // ANY phantom is enough, and that is deliberate. A complaint that asks for something
    // which does not exist can never be fully satisfied, so the critic will raise it
    // again on the next pass and the one after — the same "a rebuild that provably cannot
    // converge is not bought" reasoning as `_lastMissingKey`, established one pass earlier.
    const phantom = named.find(id => !inSpec.has(id) && !catalog.get(id));
    if (phantom) return `names_something_that_does_not_exist:${phantom}`;
  }

  return null;
}
