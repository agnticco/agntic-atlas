/**
 * CREATE-OR-PICK: THE DESTINATION A PERSON NAMED MAY NOT EXIST YET.
 *
 * Witnessed on a fresh tenant, 2026-08-01. The Sheets picker shipped the day before is
 * good — it lists the customer's real spreadsheets by name and never asks for an id. But
 * it can only ever offer what they ALREADY HAVE. Told *"don't touch that one — create a
 * fresh sheet called Buyer Inquiries for this instead"*, the build asked *"Which Google
 * Sheet should this write to?"* and listed ten existing spreadsheets, **none of them
 * Buyer Inquiries**. A question with no correct answer, sitting in the middle of a build.
 *
 * Slack has had create-or-pick since 2026-07-24 — CLAUDE.md records it as *"a genuinely
 * un-defaultable choice (a destination that doesn't exist) is still asked conversationally
 * and applied DIRECTLY — create-or-pick, no rebuild"*. Sheets got the pick half and never
 * got the create half.
 *
 * ── WHAT WAS TRIED FIRST, AND WHY IT WAS WRONG ────────────────────────────────
 * The obvious fix is to skip the picker and carry the named sheet through. It turns eight
 * destination-adversarial tests red, one of them named *"a base id the connector never
 * listed cannot survive into the spec"*, whose comment reads *"a guess writes the
 * customer's lead into a base that does not exist."* That guard is right: a workflow bound
 * to a spreadsheet nobody has writes a customer's data nowhere and reports success. It
 * trades a dead end for a silent failure, which is strictly worse.
 *
 * So the invariant is KEPT, not weakened: an unlisted container still may not reach the
 * spec. It reaches the spec by being CREATED — after which the connector does list it, it
 * has a real id, and every existing check passes for the ordinary reason.
 *
 * ── THREE RULES, and each is a way this could have been made dangerous ─────────
 *  1. **Only when we genuinely LOOKED.** "The tenant does not have it" is a claim, and it
 *     is only supportable when the connector was actually asked. A connector with no list
 *     capability has one implicit container and nothing to compare against.
 *  2. **Only a NAME, never an identifier.** Offering to create a spreadsheet called
 *     `1DG5qZ9mHvTlTU34iGRKWf9-vPyegVufENVmoJLcdnSA` is nonsense; a value shaped like a
 *     machine id is a model's guess at an id, not a person's name for a thing.
 *  3. **Only when the connector says it CAN.** Declared on `schemaDiscovery`, never
 *     inferred — Airtable creates no bases here (it needs a workspace id nobody has been
 *     asked for), so it declares nothing and its picker is untouched.
 *
 * Nothing is created without a person clicking it. This module only decides what to OFFER
 * and how to read the answer; the creating is done by the connector's own capability.
 */

/**
 * ── AND THEN THE QUESTION ITSELF WAS THE DEFECT (Charles, 2026-08-01) ─────────
 *
 * The above shipped, the create option appeared first in the picker, and the spreadsheet
 * really was created. Watching it, Charles: *"It did it again. All questions and details
 * should be worked out before the build commences."* He is right, and it is his own call
 * from 2026-07-28, carried since as the top open item: **table-shaped destinations must be
 * settled before the plan, for every connector.** The fix above changed WHICH ANSWERS the
 * question offers. It did not change that the build stops and asks.
 *
 * So the question is not asked at all when the build already knows the answer:
 *
 *   · **They have it** → use it. This alone removes the interruption in the common case,
 *     and it was a real bug: `isKnownBase` compared IDS ONLY. Airtable's model writes an
 *     id (it learned one from `airtable_describe_base`); a Sheets user says a NAME. So for
 *     Google Sheets the "already answered" test could never fire and the picker asked
 *     **every single time**, even when the person had named a spreadsheet they own and the
 *     plan card had quoted it back to them.
 *   · **They named one they do not have** → create it. The plan card names the
 *     spreadsheet, they approved that plan, and Request a change is the door if the name
 *     is wrong. Creating is the only way to honour a plan they have already accepted.
 *   · **They named nothing** → ask, exactly as before. That is a real ambiguity and the
 *     only one left.
 *
 * The picker's create option is deliberately GONE rather than left unreachable: with a
 * name present the build never reaches the picker, so an option that could not be shown
 * would be code claiming to do something it cannot.
 */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Does this read as a machine identifier rather than a name a person would say?
 *
 * Two shapes, both taken from identifiers this product actually handles: Airtable's
 * `app…`/`tbl…` keys, and the 25+ character opaque Drive/Sheets file id — the same
 * threshold the step card already uses to decide it must never print one to a customer
 * (`_destinationOf` in `public/index.html`).
 *
 * Whitespace settles it either way: no real Google file id contains a space, and almost
 * every name a person says does.
 */
export function looksLikeAnIdentifier(value) {
  const s = String(value ?? '').trim();
  if (!s || /\s/.test(s)) return false;
  if (/^(app|tbl|rec|fld|viw)[A-Za-z0-9]{14}$/.test(s)) return true;
  return s.length >= 25 && /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * WHAT THE BUILD ALREADY KNOWS ABOUT WHERE THIS WRITES.
 *
 * Reads the WRITE NODES, which is where the build recorded what the conversation decided.
 * It does NOT mine the conversation for a name: substring-matching free prose is how a
 * one-word destination comes to match almost any sentence, and that trap is already
 * recorded against `retargetStaleAssertion`.
 *
 * Three answers, and the caller must treat them as three:
 *   · `{container}` — they have it, matched by id OR by name. Use it and ask nothing.
 *   · `{create}`    — they named one they do not have, and this connector can make it.
 *   · `null`        — nothing usable was recorded. A real ambiguity: ASK.
 *
 * @param {object[]} writeNodes  the nodes writing to this connector
 * @param {object}   descriptor  the connector's declared `schemaDiscovery`
 * @param {{id:string,name:string}[]} containers  what the connector just listed
 */
export function resolveNamedContainer(writeNodes, descriptor, containers) {
  const key = descriptor?.containerKey;
  if (!key) return null;
  const list = containers ?? [];

  for (const n of (writeNodes ?? [])) {
    const raw = String(n?.config?.[key] ?? '').trim();
    if (!raw) continue;
    // A template is not a name — it is a value that does not exist until the run.
    if (raw.includes('{{') || raw.includes('<')) continue;

    // ── THEY HAVE IT ────────────────────────────────────────────────────────
    // BY NAME AS WELL AS BY ID. Matching ids only is true of Airtable, whose model
    // learned real base ids from `airtable_describe_base`, and false of Google Sheets,
    // where a person says "Agntic CRM" and that is what gets recorded — so the picker
    // asked every time, about a spreadsheet they had already named and the plan card
    // had already quoted back to them.
    const hit = list.find(c => c?.id === raw || (c?.name && norm(c.name) === norm(raw)));
    if (hit) return { container: hit };

    // ── THEY NAMED ONE THEY DO NOT HAVE ─────────────────────────────────────
    // Rule 2: a value shaped like a machine identifier is a model's guess at an id, not
    // a person's name for a thing. Offering to create `1DG5qZ9mHvTl…` is nonsense, and
    // an unresolvable id must still fall through to the question.
    if (looksLikeAnIdentifier(raw)) continue;
    // Rule 3: the connector must DECLARE it can create one — Airtable declares nothing,
    // because a base needs a workspace id nobody has been asked for.
    // Rule 1: and we must genuinely have listed, or "they do not have it" is not a fact.
    if (!descriptor.createCapability || !descriptor.listCapability) continue;
    return { create: raw };
  }
  return null;
}

/**
 * The column names a freshly created container should start with.
 *
 * Taken from what the build has ALREADY promised and configured — never invented. An empty
 * answer means "write no header row", which is honest; guessing column names would put the
 * model's vocabulary into someone's spreadsheet where they would have to live with it.
 */
export function headersFor(writeNodes, outcome, readFields) {
  const out = [];
  const seen = new Set();
  const add = (name) => {
    const s = String(name ?? '').trim();
    if (!s || seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    out.push(s);
  };
  for (const n of (writeNodes ?? [])) {
    const f = typeof readFields === 'function' ? readFields(n?.config) : null;
    if (f) for (const k of Object.keys(f)) add(k);
  }
  for (const a of (outcome?.assertions ?? [])) {
    if (Array.isArray(a?.fields)) for (const f of a.fields) add(f);
  }
  return out;
}
