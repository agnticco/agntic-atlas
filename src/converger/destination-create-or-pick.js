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

/** The choice id that means "make the one I named". Never a real container's id. */
export const CREATE_CHOICE_ID = '__atlas_create_destination__';

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
 * The container the build settled on that the tenant does not have — or null.
 *
 * Reads the WRITE NODES, which is where the build recorded what it decided. It does NOT
 * mine the conversation for a name: substring-matching free prose is how a one-word
 * destination comes to match almost any sentence, and that trap is already recorded
 * against `retargetStaleAssertion`.
 *
 * @param {object[]} writeNodes  the nodes writing to this connector
 * @param {object}   descriptor  the connector's declared `schemaDiscovery`
 * @param {{id:string,name:string}[]} containers  what the connector just listed
 * @returns {string|null} the name to offer to create
 */
export function nameToCreate(writeNodes, descriptor, containers) {
  // Rule 3: the connector must say it can create one.
  if (!descriptor?.createCapability) return null;
  // Rule 1: and we must have genuinely listed, or "they do not have it" is not a fact.
  if (!descriptor.listCapability) return null;

  const key = descriptor.containerKey;
  if (!key) return null;

  const known = new Set();
  for (const c of (containers ?? [])) {
    if (c?.id)   known.add(norm(c.id));
    if (c?.name) known.add(norm(c.name));
  }

  for (const n of (writeNodes ?? [])) {
    const raw = String(n?.config?.[key] ?? '').trim();
    if (!raw) continue;
    // A template is not a name — it is a value that does not exist until the run.
    if (raw.includes('{{') || raw.includes('<')) continue;
    if (looksLikeAnIdentifier(raw)) continue;          // rule 2
    if (known.has(norm(raw))) continue;                // they DO have it: pick, do not create
    return raw;
  }
  return null;
}

/**
 * The choices to put in front of a person.
 *
 * WHEN A NAMED CONTAINER IS ABSENT, CREATING IT IS THE DEFAULT. The alternative default
 * is `containers[0]` — an unrelated spreadsheet the person never mentioned — and writing
 * a customer's data into the wrong existing file is the worse mistake of the two. A new,
 * empty spreadsheet nobody wanted is noise; a row appended to their real CRM is not.
 * Fail toward the harmless option.
 */
export function pickerChoices({ containers, createName, containerLabel = 'destination' }) {
  const existing = (containers ?? []).map((c, i) => ({
    id: c.id, label: c.name, selected: !createName && i === 0,
  }));
  if (!createName) return existing;
  return [
    { id: CREATE_CHOICE_ID, label: `Create a new ${containerLabel} called "${createName}"`, selected: true },
    ...existing,
  ];
}

/**
 * What did they choose?
 *
 * Always answers — there is no "unreadable, so do nothing" branch, because the caller has
 * to write SOMETHING onto the node. An answer that matches nothing resolves to whatever
 * was on screen as the default, which is the one option the person had already been shown
 * as the outcome of pressing return.
 *
 * @returns {{create:string}|{container:object}}
 */
export function readPick(answer, { containers, createName }) {
  const list = containers ?? [];
  const fallback = createName ? { create: createName } : { container: list[0] };

  const id  = answer?.id;
  const txt = norm(answer?.answer);
  if (id === CREATE_CHOICE_ID) return { create: createName };
  if (createName && txt && txt === norm(createName)) return { create: createName };

  const hit = list.find(c => (id && c.id === id) || (txt && norm(c.name) === txt));
  return hit ? { container: hit } : fallback;
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
