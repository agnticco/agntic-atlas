/**
 * decision-analysis — DMN gap analysis over a decision table.
 *
 * P12 Increment C. This is the moat, mechanically: it is the thing a pure-LLM
 * builder cannot do. It answers two questions about a table, BEFORE it ships:
 *
 *   1. COVERAGE  — is there an input combination no rule matches? (a silent
 *                  no-op at 3am on the one input nobody thought about)
 *   2. OVERLAP   — under hitPolicy UNIQUE, do two rules match the same input?
 *                  (the table says one answer is guaranteed; it isn't)
 *
 * ── Box subtraction, never cross-product enumeration ────────────────────────
 *
 * A rule is an axis-aligned box over the input space (Calvanese et al.; see
 * bpmn-dmn-foundations.md §6). The uncovered region is the input space minus the
 * union of the rule boxes, computed by SUBTRACTING boxes — which is independent
 * of domain SIZE. Enumerating the cross-product instead is exponential in
 * cardinality and dies on a table a human would still consider small:
 * `scripts/checks/gap-analysis-bench.mjs` measures 10 inputs x 10 values = 10^10
 * combinations analysed in 1 ms by subtraction, and aborted by enumeration.
 *
 * ── The domain must be FINITE, or there is no proof ─────────────────────────
 *
 * Coverage is only decidable over domains we can partition:
 *
 *   enum     → each declared value is an atom
 *   boolean  → true / false
 *   number   → the rules' own endpoints partition the line into a finite set of
 *              intervals and points. (-inf, 10) [10,10] (10, 50) [50,50] (50, +inf)
 *   string   → INFINITE. Not decidable. Full stop.
 *
 * An undecidable input does not get a quietly-optimistic pass and it does not
 * get a fabricated gap. It gets `decidable: false`, and the only honest
 * resolution offered is a catch-all rule. **Never imply a completeness proof you
 * cannot make** — a false proof is worse than no proof, because the user stops
 * looking (converger-v2 §3).
 *
 * This is also why §11.7 (`LLM_INPUT_NOT_ENUM`) is non-negotiable: an LLM input
 * that emits free text has an infinite domain, so it makes the whole table
 * undecidable, which deletes the proof, which is the product.
 *
 * @module src/workflows/decision-analysis.js
 */

/** DMN's "irrelevant" marker: this rule does not care about this input. */
export const IRRELEVANT = '-';

/** The FEEL-A subset we accept (converger-v2 §12). Anything else is unparseable. */
const NUM = String.raw`-?\d+(?:\.\d+)?`;
const RE_CMP      = new RegExp(`^(<=|>=|<|>)\\s*(${NUM})$`);
const RE_INTERVAL = new RegExp(`^([\\[(])\\s*(${NUM})\\s*\\.\\.\\s*(${NUM})\\s*([\\])])$`);
const RE_NOT      = /^not\s*\(\s*(.+?)\s*\)$/i;

// ── Domains ──────────────────────────────────────────────────────────────────

/**
 * Partition one input's domain into a finite set of ATOMS. Every condition on
 * that input is then a subset of the atoms — which is what makes the set algebra
 * below exact rather than approximate.
 *
 * @returns {{ decidable: boolean, atoms: any[], reason?: string }}
 */
export function atomsFor(input, rules = []) {
  const type = String(input?.type ?? '').toLowerCase();

  if (type === 'boolean') return { decidable: true, atoms: [true, false] };

  if (type === 'enum') {
    const values = Array.isArray(input?.values) ? input.values.filter(v => v != null) : [];
    if (values.length < 2) {
      return { decidable: false, atoms: [], reason: 'the enum declares fewer than two values, so it decides nothing' };
    }
    return { decidable: true, atoms: [...new Set(values.map(String))] };
  }

  if (type === 'number' || type === 'integer') {
    const isInt = type === 'integer';
    // The rules' own endpoints are the only places the answer can change, so
    // they are a sufficient partition of an infinite line into finite cells.
    const cuts = new Set();
    let unparseable = null;
    for (const rule of rules) {
      const cond = rule?.when?.[input.key];
      if (cond === undefined || String(cond).trim() === IRRELEVANT) continue;
      const parsed = parseNumeric(cond);
      if (!parsed) { unparseable = String(cond); break; }
      for (const e of parsed.endpoints) cuts.add(e);
    }
    if (unparseable) {
      return { decidable: false, atoms: [],
               reason: `the condition "${unparseable}" isn't one this system can analyse (allowed: a number, < <= > >=, an interval like [10..50], a comma list, or not(...))` };
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    const atoms = [];
    let prev = -Infinity;
    for (const c of sorted) {
      // An `integer` domain is NOT the real line. `<= 0` together with `>= 1`
      // is exhaustive over the integers, but partitioning over the reals leaves
      // the open cell (0, 1) uncovered — so the analyser invented a gap and asked
      // the user what to do about an integer strictly between 0 and 1. That is
      // this module's OTHER named failure mode ("invent a gap that isn't there"),
      // and it is the more corrosive one: a question with no real answer is what
      // teaches people to click past the questions. An open cell that contains no
      // integer does not exist, so it is not an atom. (Found by the test-adversary.)
      if (!isInt || openCellHasInteger(prev, c)) {
        atoms.push({ lo: prev, hi: c, loOpen: true, hiOpen: true });  // the open gap below the cut
      }
      atoms.push({ lo: c, hi: c, loOpen: false, hiOpen: false });     // the cut point itself
      prev = c;
    }
    if (!isInt || openCellHasInteger(prev, Infinity)) {
      atoms.push({ lo: prev, hi: Infinity, loOpen: true, hiOpen: true });
    }
    return { decidable: true, atoms, isInt };
  }

  // string / text / free-form / anything undeclared. An infinite domain cannot
  // be covered by a finite set of rules, so coverage is not provable. Say so.
  return {
    decidable: false, atoms: [],
    reason: type
      ? `"${type}" has an unbounded domain, so no finite set of rules can be proven to cover it`
      : 'it declares no type, so its domain is unknown',
  };
}

/**
 * Does the OPEN interval (a, b) contain an integer? Used only for `integer`
 * inputs, where a cell holding no integer is not a region of the domain — it is
 * nothing, and reporting it as an uncovered case is a fabricated gap.
 */
function openCellHasInteger(a, b) {
  if (a === -Infinity || b === Infinity) return true;   // unbounded ends always hold integers
  return Math.floor(a) + 1 < b;                         // the smallest integer strictly above `a`
}

/** A probe value strictly inside an open cell — an INTEGER one when the domain is integral. */
function probeInOpenCell(atom, isInt) {
  const { lo, hi } = atom;
  if (lo === -Infinity && hi === Infinity) return 0;
  if (lo === -Infinity) return isInt ? Math.ceil(hi) - 1 : hi - 1;
  if (hi === Infinity)  return isInt ? Math.floor(lo) + 1 : lo + 1;
  return isInt ? Math.floor(lo) + 1 : (lo + hi) / 2;
}

/** Endpoints a numeric FEEL-A condition introduces, and a test for membership. */
function parseNumeric(cond) {
  const raw = String(cond).trim();

  const not = RE_NOT.exec(raw);
  if (not) {
    const inner = parseNumeric(not[1]);
    if (!inner) return null;
    return { endpoints: inner.endpoints, test: (x) => !inner.test(x) };
  }

  if (raw.includes(',')) {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean).map(parseNumeric);
    if (parts.some(p => !p)) return null;
    return {
      endpoints: parts.flatMap(p => p.endpoints),
      test: (x) => parts.some(p => p.test(x)),
    };
  }

  const cmp = RE_CMP.exec(raw);
  if (cmp) {
    const n = Number(cmp[2]);
    const op = cmp[1];
    return {
      endpoints: [n],
      test: (x) => (op === '<' ? x < n : op === '<=' ? x <= n : op === '>' ? x > n : x >= n),
    };
  }

  const iv = RE_INTERVAL.exec(raw);
  if (iv) {
    const [, lb, a, b, rb] = iv;
    const lo = Number(a), hi = Number(b);
    const loOpen = lb === '(', hiOpen = rb === ')';
    return {
      endpoints: [lo, hi],
      test: (x) => (loOpen ? x > lo : x >= lo) && (hiOpen ? x < hi : x <= hi),
    };
  }

  if (new RegExp(`^${NUM}$`).test(raw)) {
    const n = Number(raw);
    return { endpoints: [n], test: (x) => x === n };
  }

  return null;   // not FEEL-A. Unparseable ⇒ undecidable ⇒ we say so.
}

/** Does a numeric condition cover a whole atom (an interval or a point)? */
function numericCovers(parsed, atom, isInt = false) {
  if (atom.lo === atom.hi) return parsed.test(atom.lo);
  // An open cell between two cuts: the condition either covers all of it or none
  // of it, because every place the answer could change IS a cut. So probing one
  // value inside settles it — but for an `integer` domain the probe must itself
  // be an integer, or we would be asking whether the rule covers a point the
  // domain does not contain.
  return parsed.test(probeInOpenCell(atom, isInt));
}

/** The atoms of `input` that `cond` covers. `-`/absent covers everything. */
function coveredAtoms(cond, input, atoms) {
  if (cond === undefined || cond === null || String(cond).trim() === IRRELEVANT) {
    return { atoms: new Set(atoms), ok: true };
  }
  const type = String(input?.type ?? '').toLowerCase();

  if (type === 'number' || type === 'integer') {
    const parsed = parseNumeric(cond);
    if (!parsed) return { atoms: new Set(), ok: false };
    const isInt = type === 'integer';
    return { atoms: new Set(atoms.filter(a => numericCovers(parsed, a, isInt))), ok: true };
  }

  if (type === 'boolean') {
    const want = String(cond).trim().toLowerCase();
    if (want !== 'true' && want !== 'false') return { atoms: new Set(), ok: false };
    return { atoms: new Set(atoms.filter(a => String(a) === want)), ok: true };
  }

  // enum: a literal, a comma disjunction, or not(...)
  const raw = String(cond).trim();
  const not = RE_NOT.exec(raw);
  if (not) {
    const inner = coveredAtoms(not[1], input, atoms);
    if (!inner.ok) return { atoms: new Set(), ok: false };
    return { atoms: new Set(atoms.filter(a => !inner.atoms.has(a))), ok: true };
  }
  const wanted = raw.split(',').map(s => s.trim()).filter(Boolean);
  const set = new Set(atoms.filter(a => wanted.some(w => String(w) === String(a))));
  // A literal naming a value the enum never declared covers nothing, and that is
  // a defect in the rule, not a gap in the table. Report it as unparseable so it
  // surfaces rather than quietly shrinking the covered region.
  if (!set.size) return { atoms: new Set(), ok: false };
  return { atoms: set, ok: true };
}

/**
 * Does `value` satisfy `cond` for this input? THE RUN-TIME half of the SAME
 * grammar the analysis above uses — deliberately in this file, and deliberately
 * built out of the same `parseNumeric` / literal / not() / comma-list code.
 *
 * A second, private implementation inside the `decision` node's run() would be a
 * copy of FEEL-A, and the day the two disagree is the day the coverage proof
 * describes a program nobody is running: the analyser certifies that every case
 * is covered, and the engine — reading the same table by different rules — falls
 * through to no rule at all. The proof is only worth what the executor's
 * agreement with it is worth. (converger-v2 §11.7; CLAUDE.md — one oracle,
 * consulted by both.)
 *
 * @returns {{ ok: boolean, matched: boolean }} — `ok:false` means the condition is
 *          not FEEL-A at all (unparseable). The caller must fail loudly: a
 *          condition nobody can read is not a condition that failed to match.
 */
export function matchesCondition(cond, input, value) {
  if (cond === undefined || cond === null || String(cond).trim() === IRRELEVANT) {
    return { ok: true, matched: true };     // `-` — this rule does not care
  }
  const type = String(input?.type ?? '').toLowerCase();
  const raw  = String(cond).trim();

  if (type === 'number' || type === 'integer') {
    const parsed = parseNumeric(raw);
    if (!parsed) return { ok: false, matched: false };
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) return { ok: true, matched: false };
    return { ok: true, matched: parsed.test(n) };
  }

  if (type === 'boolean') {
    const want = raw.toLowerCase();
    if (want !== 'true' && want !== 'false') return { ok: false, matched: false };
    return { ok: true, matched: String(value).trim().toLowerCase() === want };
  }

  // enum (and anything else): literal · comma disjunction · not(...)
  const not = RE_NOT.exec(raw);
  if (not) {
    const inner = matchesCondition(not[1], input, value);
    if (!inner.ok) return { ok: false, matched: false };
    return { ok: true, matched: !inner.matched };
  }
  const wanted = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!wanted.length) return { ok: false, matched: false };
  const v = String(value ?? '').trim().toLowerCase();
  return { ok: true, matched: wanted.some(w => w.toLowerCase() === v) };
}

// ── The analysis ─────────────────────────────────────────────────────────────

/**
 * @param {{ inputs: object[], rules: object[], hitPolicy?: string }} table
 * @param {{ maxReported?: number, maxBoxes?: number }} [opts]
 * @returns {{
 *   decidable: boolean,
 *   undecidable: { key: string, reason: string }[],
 *   uncovered:   object[],        // gap boxes, human-readable per input
 *   truncated:   number,          // gaps NOT reported (never silently dropped)
 *   overlaps:    { rules: number[], where: object }[],
 *   hasCatchAll: boolean,
 *   badConditions: { rule: number, key: string, condition: string }[],
 * }}
 */
export function analyzeTable(table = {}, { maxReported = 12, maxBoxes = 50_000 } = {}) {
  const inputs = Array.isArray(table.inputs) ? table.inputs.filter(i => i?.key) : [];
  const rules  = Array.isArray(table.rules) ? table.rules : [];

  const out = {
    decidable: true, undecidable: [], uncovered: [], truncated: 0,
    overlaps: [], hasCatchAll: false, badConditions: [],
  };
  if (!inputs.length) {
    out.decidable = false;
    out.undecidable.push({ key: '(table)', reason: 'the table declares no inputs, so there is nothing to decide on' });
    return out;
  }

  // ── A MALFORMED RULE COVERS NOTHING, AND MUST NEVER LOOK LIKE IT COVERS ALL ──
  //
  // `rule?.when?.[key]` on a null rule — or a string, or one with no `when` —
  // yields `undefined`, which this module reads as IRRELEVANT, which means
  // "covers every value on this dimension". A single malformed rule therefore
  // covered the ENTIRE TABLE: analyzeTable reported `uncovered: []` and
  // `hasCatchAll: false` at the same time — simultaneously claiming no catch-all
  // exists and that nothing is uncovered, which cannot both be true.
  //
  // That is precisely the false proof this file's own header forbids, produced by
  // the one input most likely to occur: an LLM emitting one bad rule in an
  // otherwise good table. A rule we cannot read is a rule whose coverage nobody
  // has established. (Found by the test-adversary.)
  const malformed = [];
  rules.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { malformed.push(i); return; }
    if (!r.when || typeof r.when !== 'object' || Array.isArray(r.when)) malformed.push(i);
  });
  if (malformed.length) {
    out.decidable = false;
    for (const i of malformed) {
      out.badConditions.push({ rule: i, key: '(rule)', condition: 'the rule has no readable `when` conditions' });
    }
    return out;   // no coverage claim is made about a table we cannot read
  }

  // A catch-all rule: every input irrelevant. It is the honest answer to an
  // undecidable domain, and the only one.
  out.hasCatchAll = rules.some(r =>
    r && typeof r === 'object' &&
    inputs.every(i => {
      const c = r.when?.[i.key];
      return c === undefined || c === null || String(c).trim() === IRRELEVANT;
    }));

  const domains = inputs.map(i => ({ input: i, ...atomsFor(i, rules) }));
  for (const d of domains) {
    if (!d.decidable) {
      out.decidable = false;
      out.undecidable.push({ key: d.input.key, reason: d.reason });
    }
  }

  // Record unparseable conditions even on decidable inputs — a rule the analyser
  // cannot read is a rule whose coverage nobody has proven, and pretending
  // otherwise is exactly the false proof this module exists to refuse.
  rules.forEach((rule, ri) => {
    for (const d of domains) {
      if (!d.decidable) continue;
      const cond = rule?.when?.[d.input.key];
      if (cond === undefined || cond === null || String(cond).trim() === IRRELEVANT) continue;
      const { ok } = coveredAtoms(cond, d.input, d.atoms);
      if (!ok) {
        out.decidable = false;
        out.badConditions.push({ rule: ri, key: d.input.key, condition: String(cond) });
      }
    }
  });

  if (!out.decidable) return out;   // no coverage claim is made. None can be.

  // ── Box subtraction ────────────────────────────────────────────────────────
  // A region is a box: per dimension, the set of atoms still uncovered there.
  // Subtracting a rule yields at most D new boxes. The cross-product is never
  // materialised — that is the whole point (converger-v2 §12).
  const boxes = [domains.map(d => new Set(d.atoms))];
  let regions = boxes;

  for (const rule of rules) {
    const next = [];
    for (const region of regions) {
      const cov = domains.map((d, i) => {
        const { atoms } = coveredAtoms(rule?.when?.[d.input.key], d.input, [...region[i]]);
        return new Set([...region[i]].filter(a => atoms.has(a)));
      });
      if (cov.some(s => s.size === 0)) { next.push(region); continue; }   // rule misses this region entirely

      for (let i = 0; i < domains.length; i++) {
        const rest = new Set([...region[i]].filter(a => !cov[i].has(a)));
        if (!rest.size) continue;
        next.push(region.map((s, k) => (k < i ? new Set(cov[k]) : k === i ? rest : new Set(s))));
      }
      if (next.length > maxBoxes) {
        out.decidable = false;
        out.undecidable.push({ key: '(table)', reason: `the table is too complex to analyse (> ${maxBoxes} regions) — decompose it into smaller decisions` });
        return out;
      }
    }
    regions = next;
  }

  for (const region of regions) {
    if (out.uncovered.length >= maxReported) { out.truncated++; continue; }
    const box = {};
    domains.forEach((d, i) => { box[d.input.key] = describeAtoms([...region[i]], d.input); });
    out.uncovered.push(box);
  }

  // ── Overlap (UNIQUE) ───────────────────────────────────────────────────────
  // Two rules overlap iff their boxes intersect in EVERY dimension. Exact over
  // the atom partition, and O(R^2 * D) — cheap at any table a human would read.
  const policy = String(table.hitPolicy ?? 'FIRST').trim().toUpperCase();
  if (policy === 'UNIQUE' || policy === 'U') {
    const ruleAtoms = rules.map(rule =>
      domains.map(d => coveredAtoms(rule?.when?.[d.input.key], d.input, d.atoms).atoms));
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const where = {};
        let intersects = true;
        for (let k = 0; k < domains.length; k++) {
          const inter = [...ruleAtoms[i][k]].filter(a => ruleAtoms[j][k].has(a));
          if (!inter.length) { intersects = false; break; }
          where[domains[k].input.key] = describeAtoms(inter, domains[k].input);
        }
        if (intersects) out.overlaps.push({ rules: [i, j], where });
      }
    }
  }

  return out;
}

/** Render a set of atoms back into something a person can read. */
function describeAtoms(atoms, input) {
  const type = String(input?.type ?? '').toLowerCase();
  if (type !== 'number' && type !== 'integer') {
    const vals = atoms.map(String);
    const all  = Array.isArray(input?.values) ? input.values.map(String) : [];
    if (all.length && vals.length === all.length) return 'any';
    return vals.join(' or ');
  }
  return atoms.map(a => {
    if (a.lo === a.hi) return `= ${a.lo}`;
    if (a.lo === -Infinity && a.hi === Infinity) return 'any';
    if (a.lo === -Infinity) return `< ${a.hi}`;
    if (a.hi === Infinity)  return `> ${a.lo}`;
    return `between ${a.lo} and ${a.hi} (exclusive)`;
  }).join(' or ');
}
