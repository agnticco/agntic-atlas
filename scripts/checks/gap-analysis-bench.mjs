/**
 * Where does DMN gap analysis actually become unusable?
 *
 * Calvanese et al. model a rule as an axis-aligned hyper-rectangle over the input
 * space; a GAP is a region no rule covers. Cost is exponential in the number of
 * input dimensions. This measures WHERE that exponential actually bites, so the
 * converger knows when it must DECOMPOSE a decision instead of widening it.
 *
 * Two algorithms, because they have very different limits:
 *   1. ENUMERATIVE  — expand the full cross-product of input domains, mark covered
 *                     cells. Exact, dead simple, and dies on cardinality.
 *   2. RECTANGULAR  — subtract rule-boxes from the input space, keep the uncovered
 *                     regions as boxes. Independent of domain SIZE; sensitive to
 *                     the number of DIMENSIONS and rules.
 */

// ── Enumerative ────────────────────────────────────────────────────────────────
function gapsEnumerative(inputs, rules, { cap = 5_000_000 } = {}) {
  const size = inputs.reduce((a, i) => a * i.values.length, 1);
  if (size > cap) return { ok: false, reason: `cross-product ${size.toLocaleString()} > cap`, size };

  const matches = (rule, point) =>
    inputs.every((inp, d) => {
      const cond = rule.when[inp.key];
      if (cond === undefined || cond === '-') return true;   // '-' = irrelevant (DMN)
      return Array.isArray(cond) ? cond.includes(point[d]) : cond === point[d];
    });

  let uncovered = 0;
  const point = new Array(inputs.length);
  const walk = (d) => {
    if (d === inputs.length) {
      if (!rules.some(r => matches(r, point))) uncovered++;
      return;
    }
    for (const v of inputs[d].values) { point[d] = v; walk(d + 1); }
  };
  walk(0);
  return { ok: true, size, uncovered };
}

// ── Rectangular (box subtraction) ──────────────────────────────────────────────
// A region is a box: for each dimension, the SET of values still uncovered there.
function gapsRectangular(inputs, rules, { maxBoxes = 200_000 } = {}) {
  let regions = [inputs.map(i => new Set(i.values))];      // start: the whole space

  for (const rule of rules) {
    const next = [];
    for (const region of regions) {
      // The part of `region` this rule covers, per dimension.
      const covered = inputs.map((inp, d) => {
        const cond = rule.when[inp.key];
        if (cond === undefined || cond === '-') return new Set(region[d]);
        const want = Array.isArray(cond) ? cond : [cond];
        return new Set([...region[d]].filter(v => want.includes(v)));
      });
      if (covered.some(s => s.size === 0)) { next.push(region); continue; }  // no overlap

      // Subtract: for each dim, the slab where that dim is OUTSIDE the rule but
      // earlier dims are INSIDE it. Standard box-subtraction; yields ≤ D new boxes.
      for (let d = 0; d < inputs.length; d++) {
        const rest = new Set([...region[d]].filter(v => !covered[d].has(v)));
        if (rest.size === 0) continue;
        const box = region.map((s, k) => (k < d ? new Set(covered[k]) : k === d ? rest : new Set(s)));
        next.push(box);
      }
      if (next.length > maxBoxes) return { ok: false, reason: `box explosion > ${maxBoxes}` };
    }
    regions = next;
  }
  const uncovered = regions.reduce((a, r) => a + r.reduce((p, s) => p * s.size, 1), 0);
  return { ok: true, boxes: regions.length, uncovered };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────
const mkInputs = (d, card) =>
  Array.from({ length: d }, (_, i) => ({
    key: `i${i}`, type: 'enum',
    values: Array.from({ length: card }, (_, j) => `v${j}`),
  }));

// Realistic table: each rule pins a couple of dims, leaves the rest '-' (irrelevant).
const mkRules = (inputs, n, pinned = 2) =>
  Array.from({ length: n }, (_, r) => {
    const when = {};
    for (let p = 0; p < pinned; p++) {
      const inp = inputs[(r + p) % inputs.length];
      when[inp.key] = inp.values[(r + p) % inp.values.length];
    }
    return { when, then: `out${r % 3}` };
  });

const ms = (fn) => { const t = process.hrtime.bigint(); const out = fn(); return { out, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };

console.log('DMN GAP ANALYSIS — where does it stop being usable?\n');
console.log('Realistic shape: each rule pins 2 inputs, rest "-" (irrelevant).\n');
console.log('  dims  card   cross-product   rules |  enumerative      | rectangular');
console.log('  ' + '-'.repeat(76));

for (const [dims, card] of [[2,4],[3,4],[4,4],[5,4],[6,4],[7,4],[8,4],[10,4],[5,8],[6,10],[8,10],[10,10],[12,10]]) {
  const inputs = mkInputs(dims, card);
  const rules  = mkRules(inputs, Math.max(4, dims * 2));
  const size   = inputs.reduce((a, i) => a * i.values.length, 1);

  const e = ms(() => gapsEnumerative(inputs, rules));
  const r = ms(() => gapsRectangular(inputs, rules));

  const eTxt = e.out.ok ? `${e.ms.toFixed(1).padStart(7)}ms` : '  ABORT '.padStart(9);
  const rTxt = r.out.ok ? `${r.ms.toFixed(1).padStart(7)}ms (${String(r.out.boxes).padStart(5)} boxes)` : `  ABORT (${r.out.reason})`;

  console.log(
    `  ${String(dims).padStart(4)}  ${String(card).padStart(4)}  ${size.toLocaleString().padStart(13)}  ${String(rules.length).padStart(6)} | ${eTxt}          | ${rTxt}`
  );
}

console.log('\n\nHOW MANY INPUTS CAN A HUMAN ACTUALLY REVIEW?');
console.log('(the real limit is cognitive, not computational — a table nobody reads is not auditable)\n');
for (const d of [2, 3, 4, 5, 6, 7]) {
  const inputs = mkInputs(d, 4);
  const combos = 4 ** d;
  const verdict = combos <= 64 ? 'reviewable by a human' : combos <= 256 ? 'borderline' : 'nobody reads this';
  console.log(`  ${d} inputs x 4 values = ${String(combos).padStart(6)} combinations   ${verdict}`);
}
