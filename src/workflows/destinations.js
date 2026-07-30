/**
 * ONE PLACE A WORKFLOW WRITES, NAMED ONCE, POINTED AT BY EVERYTHING.
 *
 * THE PROBLEM THIS EXISTS TO END. A destination lives in three vocabularies at once:
 * what the customer says ("my calendar", "Pricing Enquiries", "email me"), what the
 * spec stores (`calendar_create_event`, `spreadsheetId: 1BxiMVs0…`), and what the
 * promise states (`google:Calendar`). Until now those were bridged by comparing
 * STRINGS — through alias tables, guess lists and canonicalisation — in more than
 * thirty places. Every one of them is somewhere two vocabularies can disagree, and by
 * 2026-07-30 they had, nine times:
 *
 *   · the promise said `gmail:hello@agntic.co`; the only send went to `charles@`
 *   · the promise said `sheets:Pricing Emails`; the user had said `Pricing Enquiries`
 *   · the promise said `google:Calendar`; the runtime checked GMAIL, because
 *     `canonicalConnector('google')` is `gmail`
 *   · the contract said `google_drive:`; the delivery went via `docs_create`
 *   · a task's own NAME was reported as the place it was written
 *
 * Each cost paid Opus rebuilds and, twice, a workflow that could not go live at all.
 * Fixing them one at a time has not reduced the rate; the next shape produces another.
 *
 * THE CHANGE. A workflow now carries a small table of the destinations it uses. Each
 * entry is created ONCE and given an id; the step that writes there and the promise
 * about it both carry that id. Two things pointing at one entry cannot disagree about
 * where they mean — not because a rule keeps them in step, but because there is only
 * one of it.
 *
 * ADDITIVE ON PURPOSE — NOTHING STORED TODAY BREAKS. Every existing spec has string
 * targets and no ids, and keeps working exactly as before: the id is consulted only
 * when BOTH sides have one. A promise with an id and a step without falls back to the
 * string comparison, so this can tighten a verdict but never invent a new failure on a
 * workflow that already publishes. The string `target` also stays on every assertion,
 * because it is what a person reads.
 */

import { nodeEffect, splitTarget, canonicalConnector, isOpaqueProviderId, sameDestination, aliasesFor }
  from './outcome-oracle.js';

// Re-exported so callers reason about destinations from one module, while the imports
// stay one-directional: this module needs the oracle, and the oracle must not need it.
export { sameDestination };

/** The comparison key for a destination: what it is, and where, ignoring spelling. */
export function destinationKey(connector, locator) {
  const c = canonicalConnector(String(connector ?? '').trim().toLowerCase());
  const l = String(locator ?? '').trim().toLowerCase().replace(/^#/, '');
  return `${c}::${l}`;
}

const isTemplate = (s) => typeof s === 'string' && s.includes('{{');

/**
 * Is this destination one we can pin an identity to?
 *
 * A template resolves only at run time and an empty locator names nowhere, so neither
 * can be an identity — giving them one would let two different run-time destinations
 * share an id, which is worse than having none. They keep the old string behaviour,
 * where "undecidable" is already handled honestly.
 */
export function isPinnable(locator) {
  const l = String(locator ?? '').trim();
  return !!l && !isTemplate(l);
}

/**
 * WHICH SERVICE does this step write to?
 *
 * From the capability id, NEVER from `eff.connectors`. That is an alias SET — for a
 * Sheets write it is `{google, sheets, drive, spreadsheet}` — and taking a member of it
 * is picking a spelling at random. The first cut of this did exactly that and produced
 * `gmail::leads` for a Google Sheets row, because the set begins with the vendor name
 * `google` and `canonicalConnector('google')` is **gmail**. That is the same trap that
 * made the runtime check a calendar promise against Gmail earlier the same day, caught
 * here by a test rather than by a build failing on prod.
 *
 * The id prefix is the one name that identifies the service unambiguously:
 * `sheets_append` → `sheets`, `calendar_create_event` → `calendar`.
 */
function serviceOf(node) {
  const id = String(node?.config?.action ?? node?.config?.channel ?? '').trim();
  const prefix = id.includes('_') ? id.split('_')[0] : id;
  return canonicalConnector(prefix.toLowerCase());
}

/**
 * Read the destinations a finished spec uses, and stamp every step and promise that
 * refers to one with its id.
 *
 * Deterministic and model-free: it reads what the build already decided. It never
 * invents a destination, never moves one, and never changes a locator — the only
 * thing it adds is the SHARED IDENTITY that was missing.
 *
 * @returns {{spec: object, destinations: object[], stamped: {nodes: number, assertions: number}}}
 */
export function indexDestinations(spec) {
  if (!spec || typeof spec !== 'object') return { spec, destinations: [], stamped: { nodes: 0, assertions: 0 } };

  const byKey = new Map();
  const add = (connector, locator) => {
    if (!isPinnable(locator)) return null;
    const key = destinationKey(connector, locator);
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: `d${byKey.size + 1}`,
        connector: canonicalConnector(String(connector ?? '').toLowerCase()),
        locator: String(locator).trim(),
        // An opaque provider id is a destination we can compare by IDENTITY but never
        // by name — recorded so a reader (and stage 3's resolver) knows which it is.
        opaque: isOpaqueProviderId(String(locator).trim()),
      });
    }
    return byKey.get(key).id;
  };

  // ── the steps ─────────────────────────────────────────────────────────────
  // Walked in the same shape the oracle uses, INCLUDING inside a `foreach`: three
  // separate P12 defects were "added to the top-level executor, not the sub-loop", and
  // a loop's write is exactly what the promise is usually about.
  let nodesStamped = 0;
  const stampNodes = (nodes) => (nodes ?? []).map((n) => {
    if (!n || typeof n !== 'object') return n;
    if (n.type === 'foreach') {
      const steps = stampNodes(n.config?.steps);
      return { ...n, config: { ...(n.config ?? {}), steps } };
    }
    const eff = nodeEffect(n);
    if (!eff) return n;
    // THE PRIMARY LOCATOR ONLY — the first one. `locatorKeys` are declared
    // destination-first (`spreadsheetId` before `range`, `table` before `baseId`), so
    // the first is the place and the rest narrow it. Indexing all of them put "A:E" in
    // the table as somewhere a workflow writes, which is noise today and wrong for
    // stage 3, where each entry is resolved against the real service — nobody can look
    // up a cell range as a destination.
    //
    // A promise that names one of the narrower parts simply stays unstamped and falls
    // back to the string rules, which already handle it.
    const ids = [];
    const id = add(serviceOf(n), eff.locators[0]);
    if (id) ids.push(id);
    if (!ids.length) return n;
    nodesStamped += 1;
    // ON THE NODE, NOT IN ITS CONFIG. A node's `config` keys are validated against its
    // type's `configSchema` and an undeclared key is a HARD publish failure
    // (`UNKNOWN_CONFIG_KEY`) — which is correct and must stay: a schema listing keys
    // nothing reads is what let `"model": "claude-opus-4-5"` ship. The first cut of this
    // put the ids in `config` and made every workflow in the product unpublishable.
    // The id is bookkeeping ABOUT the step, not a parameter OF it, and it belongs
    // beside `id`, `type` and `label` where the executor never looks.
    return { ...n, destinationIds: ids };
  });

  const nodes = stampNodes(spec.nodes);

  // ── the promises ──────────────────────────────────────────────────────────
  // A promise is matched to a destination the workflow ACTUALLY uses. One that matches
  // nothing is left alone — deliberately: inventing an entry for it would give a stale
  // promise an identity of its own and make it look settled, when "this promise names
  // somewhere no step goes" is exactly the finding that must survive.
  let assertionsStamped = 0;
  const outcome = spec.outcome;
  let nextOutcome = outcome;
  if (outcome && Array.isArray(outcome.assertions)) {
    const assertions = outcome.assertions.map((a) => {
      if (!a || typeof a !== 'object') return a;
      const { connector, locator } = splitTarget(String(a.target ?? ''));
      if (!connector || !isPinnable(locator)) return a;
      let hit = byKey.get(destinationKey(connector, locator));
      // A promise may name the VENDOR where the step names the service —
      // `google:Calendar` for a calendar write. Fall back to any destination whose
      // own aliases cover what the promise said, with the same locator.
      if (!hit) {
        const want = String(connector).toLowerCase();
        const lk = destinationKey('', locator).split('::')[1];
        for (const d of byKey.values()) {
          if (destinationKey('', d.locator).split('::')[1] !== lk) continue;
          if (aliasesFor(d.connector).has(want)) { hit = d; break; }
        }
      }
      if (!hit) return a;
      assertionsStamped += 1;
      return { ...a, destinationId: hit.id };
    });
    nextOutcome = { ...outcome, assertions };
  }

  return {
    spec: { ...spec, nodes, ...(nextOutcome ? { outcome: nextOutcome } : {}), destinations: [...byKey.values()] },
    destinations: [...byKey.values()],
    stamped: { nodes: nodesStamped, assertions: assertionsStamped },
  };
}

