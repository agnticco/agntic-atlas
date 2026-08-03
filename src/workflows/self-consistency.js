/**
 * DOES THIS BUILD CONTRADICT ITSELF?
 *
 * Almost every defect this product has shipped in the destination family was two
 * things Atlas already knew, disagreeing with each other, with nothing comparing them.
 * A sample from 2026-07-29/30, all found by a person reading a screen carefully:
 *
 *   · the promise said `gmail:hello@agntic.co`; the only send went to `charles@`
 *   · the promise said `sheets:Pricing Emails`; the sheet the user named was
 *     `Pricing Enquiries`
 *   · the promise said `google:Calendar`; the runtime checked Gmail
 *   · the contract said `google_drive:`; the delivery went via `docs_create`
 *   · a card said "review the draft below" with nothing below
 *
 * Each was fixed where it was found, and the next shape produced another. This file
 * asks the whole question once, of the finished build, and REPORTS — it never repairs.
 * Repair belongs to the specific mechanisms that understand each case
 * (`retargetStaleAssertion`, `autoRepairStructural`); a general fixer would be a
 * general way to make a build agree with itself by making it say less.
 *
 * WHAT IT IS NOT. It is not a validator: everything here is already valid, publishable
 * and internally well-formed. It is not a gate — nothing it returns blocks a build.
 * It is the answer to "we keep finding these one at a time, by eye".
 *
 * PRECISION OVER RECALL, DELIBERATELY. A check that cries wolf gets ignored, and an
 * ignored check is worse than none because it looks like cover. Every check below
 * fires only on evidence it can name on both sides, and anything undecidable — a
 * template, an opaque provider id, a destination nobody stated — is silence, not a
 * finding.
 */

import {
  nodeEffect, normalizeDelivery, satisfiesAssertion, checkAssertionAtRuntime,
  splitTarget, isOpaqueProviderId, humanAskTargets,
} from './outcome-oracle.js';

/** Every node in a spec, including those nested inside a `foreach`. */
function allNodes(spec) {
  const out = [];
  const walk = (nodes) => {
    for (const n of (nodes ?? [])) {
      if (!n || typeof n !== 'object') continue;
      out.push(n);
      if (n.type === 'foreach') walk(n.config?.steps);
    }
  };
  walk(spec?.nodes);
  return out;
}

/**
 * The steps that change the outside world, with what they write and where.
 *
 * A `foreach` is EXCLUDED even though it reports an effect. `nodeEffect` gives a loop
 * the effect of the first write inside it — correct, and deliberate — but the loop
 * itself never executes a delivery: its CHILDREN do, and they are walked separately.
 * Building a run receipt from the wrapper therefore invents a delivery production never
 * makes, and it showed up immediately as a false "the two halves disagree" on a
 * perfectly good loop. A check must construct its subject the way production does; that
 * rule is in CLAUDE.md because checks that don't have hidden real defects, and here it
 * nearly manufactured one.
 */
function writesOf(spec) {
  const out = [];
  for (const node of allNodes(spec)) {
    if (node.type === 'foreach') continue;
    const eff = nodeEffect(node);
    if (eff) out.push({ node, eff });
  }
  return out;
}

const isTemplate = (s) => typeof s === 'string' && s.includes('{{');
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/^#/, '');

/**
 * Destinations a PERSON would recognise in the promise's own sentence.
 *
 * High-precision tokens only — an email address, a #channel, or a Quoted Name. Free
 * prose is deliberately not mined: "the sheet" and "my calendar" name nothing that can
 * be compared, and guessing at them is how a check starts crying wolf.
 */
export function destinationsNamedIn(statement) {
  const s = String(statement ?? '');
  const out = new Set();
  // The trailing dot is NOT part of the address. Written as `[\w.]+` first, it swallowed
  // the full stop that ends the sentence, so "hello@agntic.co." was reported as
  // differing from "hello@agntic.co" — a contradiction invented by the checker itself,
  // on a build whose real defect it had already found. Precision is the whole promise
  // of this file, so a false positive here costs more than a miss.
  for (const m of s.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) out.add(m[0].replace(/\.+$/, ''));
  for (const m of s.matchAll(/#[A-Za-z0-9_-]{2,}/g)) out.add(m[0]);
  for (const m of s.matchAll(/['"“”']([A-Z][\w .&-]{2,60})['"“”']/g)) out.add(m[1]);
  return [...out];
}

/** Every literal string anywhere in a node's config — what the step actually carries. */
function configValues(node) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') { Object.values(v).forEach(walk); }
  };
  walk(node?.config);
  return out;
}

/**
 * Everything the TRIGGER names — the places a workflow listens, not the places it writes.
 *
 * WITNESSED ON PROD 2026-07-30, the first build where the two differed: "when someone
 * posts in #atlas-test-temp with the word urgent, email me" produced
 * *"The promise tells the customer this workflow delivers to "#atlas-test-temp", but no
 * step in it does"* — on a completely correct workflow. The channel is the SOURCE. The
 * only destination is the email.
 *
 * That is the crying-wolf failure this file's header warns about, produced by this file,
 * on its second day. A destination named in the promise's sentence is only missing if
 * the workflow does not MENTION it at all; naming where it listens is not a contradiction.
 */
function triggerValues(spec) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      out.push(v);
      // ── A FILTER IS AN EXPRESSION, NOT A BARE VALUE ────────────────────────
      //
      // WITNESSED 2026-08-03, on the first Slack-triggered workflow the product
      // has ever been able to build. Its trigger is stored as
      // `{ type:'event', connector:'slack', filter:'channel:#atlas-test-temp' }`
      // — the channel lives INSIDE a filter expression. Pushing only the whole
      // string meant `channel:#atlas-test-temp` never matched the bare
      // `#atlas-test-temp` the promise names, so the check reported
      //
      //   The promise tells the customer this workflow delivers to
      //   "#atlas-test-temp", but no step in it does
      //
      // …about a correct workflow, where that channel is where it LISTENS.
      //
      // THIS IS THE SAME FALSE POSITIVE RECORDED ON 2026-07-30, arriving through
      // a door that fix did not cover: `triggerValues` was added then and was
      // right, but the trigger shape it was written against stored the channel
      // bare. A check that fires on a good build teaches people to ignore it —
      // and this one is now shown to every user at the walkthrough, so it can
      // afford that least of all.
      //
      // Values inside `key:value` are pulled out too. Deliberately generous: this
      // list only ever SUPPRESSES findings, and the check is precision-over-recall
      // by design — a missed finding is quiet, a false one is corrosive. An email
      // filter's `subject:(pricing|cost)` contributes `(pricing|cost)`, which
      // matches no destination and costs nothing.
      for (const m of String(v).matchAll(/(?:^|\s)[a-z_]+:(\S+)/gi)) out.push(m[1]);
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(spec?.triggers);
  for (const n of allNodes(spec)) if (n?.type === 'trigger') walk(n.config);
  return out;
}

const finding = (code, severity, message, detail) => ({ code, severity, message, ...detail });

/**
 * Every place this build disagrees with itself.
 *
 * @param {object} spec  the finished draft — nodes, edges, triggers, outcome
 * @returns {Array<{code, severity, message, …}>} most serious first, [] when consistent
 */
export function selfContradictions(spec) {
  const findings = [];
  const outcome = spec?.outcome ?? null;
  const assertions = Array.isArray(outcome?.assertions) ? outcome.assertions : [];
  const writes = writesOf(spec);

  // ── 1. THE TWO HALVES OF THE PROMISE CHECK DISAGREE ────────────────────────
  //
  // The most expensive shape there is: build time says the promise is kept, run time
  // says it is broken (or the reverse). One of them gates "go live" and the other
  // decides what the customer is told after a run, so a disagreement means the product
  // certifies a workflow it will later fail, or fails one it certified. Eight instances
  // to date, every one costing paid rebuilds.
  for (const a of assertions) {
    for (const { node, eff } of writes) {
      const build = satisfiesAssertion(a, node);
      const run   = checkAssertionAtRuntime(a, [normalizeDelivery(node, { dryRun: true, wouldDeliver: true })]).ok;
      if (build === run) continue;
      findings.push(finding('HALVES_DISAGREE', 'error',
        `The check that clears this workflow to go live and the check that reads a real run disagree about "${a.target}" and the step "${node.label || node.id}": one says the promise is kept, the other says it is broken.`,
        { assertion: a.id ?? null, target: a.target ?? null, nodeId: node.id, build, run, kind: eff.kind }));
    }
  }

  // ── 2. THE SENTENCE NAMES A DESTINATION NO STEP USES ───────────────────────
  //
  // The half a person reads, against the steps that were built. Witnessed twice on
  // 2026-07-30: a briefing whose promise said `hello@agntic.co` while the only send
  // went to `charles@agntic.co`, and a logger promising a sheet called "Pricing Emails"
  // that nobody had ever mentioned.
  // AN APPROVAL STEP'S QUESTION IS A DELIVERY. The `human` node sends the DM itself —
  // which is exactly why a workflow with an approval has no separate send for it, and
  // was established on 2026-07-28 when a kept promise was certified as unproven for the
  // same reason. It has no `nodeEffect`, so without this the commonest approval shape
  // reports its own approver as "a destination no step uses": a false positive on a
  // correct workflow, found by mutation before this check ever ran on prod.
  //
  // It reuses the oracle's own `humanAskTargets` rather than reading `config.channels`
  // here — a second copy of that rule is how the two halves of this system have drifted
  // eight times.
  const askValues = allNodes(spec).flatMap(n => humanAskTargets(n).map(t => norm(t.locator)));
  const stepValues = new Set([
    ...writes.flatMap(({ node }) => configValues(node).map(norm)),
    ...askValues,
  ]);
  // A place the workflow LISTENS to is not a place it should be writing.
  const sourceValues = new Set(triggerValues(spec).map(norm));
  for (const named of destinationsNamedIn(outcome?.statement)) {
    if (stepValues.has(norm(named))) continue;
    if (sourceValues.has(norm(named))) continue;   // it is the trigger, not a destination
    // Excused when a step's destination is undecidable — a template resolves at run
    // time and an opaque id cannot be compared with a human name.
    const undecidable = writes.some(({ eff }) =>
      eff.locators.some(l => isTemplate(l) || isOpaqueProviderId(l)));
    if (undecidable) continue;
    findings.push(finding('STATEMENT_NAMES_ELSEWHERE', 'error',
      `The promise tells the customer this workflow delivers to "${named}", but no step in it does — every step names somewhere else.`,
      { named, stepDestinations: [...new Set(writes.flatMap(({ eff }) => eff.locators))] }));
  }

  // ── 3. THE PROMISE AND ITS OWN SENTENCE NAME DIFFERENT PLACES ──────────────
  //
  // The machine-checkable half against the human half. These are written by the same
  // model in the same pass and are meant to be two statements of one deal; when they
  // drift, whichever the reader happens to look at is the one they act on.
  //
  // ONLY WHEN THE PAIRING IS UNAMBIGUOUS: exactly one destination named in the
  // sentence and exactly one promise. With two promises and one name there is nothing
  // to pair — and guessing produced a FALSE POSITIVE on prod (2026-07-30, an
  // escalating-approval workflow): the sentence named `#atlas-test-temp`, which the
  // SECOND promise covered exactly, and this compared it against the FIRST promise's
  // locator and reported a contradiction. That was the second false positive from this
  // one check in a day, which is why it is now the narrowest of the five.
  //
  // Recall is deliberately sacrificed. The case it was built for — the Sheets logger
  // whose sentence said "Pricing Enquiries" and whose only promise said "Pricing
  // Emails" — is exactly this shape and still fires.
  // A name the TRIGGER uses is not a destination the promise got wrong — the same
  // exclusion `STATEMENT_NAMES_ELSEWHERE` applies above, and for the same reason.
  // Witnessed 2026-08-03: a Slack-triggered workflow whose statement opens "Every
  // time any message is posted in #atlas-test-temp…" had that channel compared
  // against its inbox destination and reported as a contradiction. The channel is
  // where it LISTENS. Reusing `sourceValues` rather than re-deriving it, so the two
  // checks cannot come to different views of what the trigger is.
  const saidRaw = destinationsNamedIn(outcome?.statement).filter(n => !sourceValues.has(norm(n)));
  if (saidRaw.length === 1 && assertions.length === 1) {
    const a = assertions[0];
    const { locator } = splitTarget(String(a?.target ?? ''));
    const named = saidRaw[0];
    const decidable = locator && !isTemplate(locator) && !isOpaqueProviderId(locator);
    // An address and a channel are not rival spellings of one place.
    const sameShape = named.includes('@') === locator.includes('@');
    if (decidable && sameShape && norm(named) !== norm(locator)) {
      findings.push(finding('PROMISE_AND_SENTENCE_DIFFER', 'error',
        `The promise a person reads names "${named}", but the machine-checkable version of the same promise names "${locator}".`,
        { assertion: a.id ?? null, target: a.target ?? null, statementNames: saidRaw }));
    }
  }

  // ── 4. A PROMISE NOTHING CAN EVER CHECK ────────────────────────────────────
  //
  // A target that is a template, or names a connector with no destination after it,
  // cannot be compared with anything — so the workflow can be certified against it
  // without a single thing having been proved. "Not exercised" is a verdict; a promise
  // that can never be exercised is a defect in the promise.
  for (const a of assertions) {
    const target = String(a?.target ?? '');
    const { connector, locator } = splitTarget(target);
    if (isTemplate(target)) {
      findings.push(finding('PROMISE_UNCHECKABLE', 'error',
        `The promise "${target}" contains a placeholder that is only filled in when the workflow runs, so nothing can check it before going live.`,
        { assertion: a.id ?? null, target }));
    } else if (connector && !locator) {
      findings.push(finding('PROMISE_UNCHECKABLE', 'warning',
        `The promise "${target}" names ${connector} but not where in it, so any delivery to ${connector} satisfies it.`,
        { assertion: a.id ?? null, target }));
    }
  }

  // ── 5. A STEP CHANGES THE WORLD AND NOTHING PROMISED IT ────────────────────
  //
  // Not necessarily wrong — a workflow may legitimately do more than it promises —
  // but it is exactly what an unnoticed extra send looks like, and the promise is what
  // the customer was shown. Reported as a note, never as an error.
  for (const { node, eff } of writes) {
    const covered = assertions.some(a => satisfiesAssertion(a, node));
    if (covered) continue;
    findings.push(finding('WRITE_UNPROMISED', 'note',
      `The step "${node.label || node.id}" sends or writes something, and none of the promises mention it — so it is not covered by anything the customer was shown.`,
      { nodeId: node.id, kind: eff.kind, destinations: eff.locators }));
  }

  // ── A READ THAT RETURNS MANY THINGS, FED TO ONE AI STEP ────────────────────
  //
  // MEASURED ON PROD, 2026-08-02. A weekly digest asked Gmail for `maxResults: 100`
  // and handed every message to a single `llm` step. The search alone took ~260
  // seconds and the AI step then blew its own 120s ceiling. The workflow was
  // correct in shape and could not finish — in a test OR at 8am on a Monday — and
  // NOTHING said so until the person had done the whole interview, approved a
  // plan, and confirmed every step.
  //
  // That is the cost this finding exists to remove: it is knowable from the spec
  // alone, and it is knowable BEFORE anyone spends twenty minutes on the build.
  //
  // A NOTE, NEVER AN ERROR. The workflow may be perfectly fine — the connector now
  // caps its own fetch, models get faster, and a person who wants twenty items
  // summarised together is asking for something reasonable. Blocking would be the
  // "a check that fires on a good build teaches people to ignore it" trap this
  // file has already been caught by twice. It tells them; it does not decide.
  //
  // Scoped to a read that DECLARES how many it can return and says "a lot", so a
  // single-record read (`airtable_get_record`, `gmail_get_message`) is silent.
  const BULK = 25;
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec?.edges) ? spec.edges : [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const insideLoop = new Set();
  for (const n of nodes) {
    if (n?.type === 'foreach') for (const s of (n.config?.steps ?? [])) if (s?.id) insideLoop.add(s.id);
  }
  for (const n of nodes) {
    const many = Number(n?.config?.maxResults ?? n?.config?.limit ?? 0);
    if (!many || many < BULK) continue;
    // Walk forward to the first AI step, stopping at a loop — a `foreach` is
    // exactly the right answer to this shape, so a workflow that uses one is fine.
    const seen = new Set([n.id]);
    let queue = edges.filter(e => e.from === n.id).map(e => e.to);
    let hit = null;
    while (queue.length && !hit) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const step = byId.get(id);
      if (!step || step.type === 'foreach' || insideLoop.has(id)) continue;
      if (step.type === 'llm') { hit = step; break; }
      queue = queue.concat(edges.filter(e => e.from === id).map(e => e.to));
    }
    if (!hit) continue;
    findings.push(finding('TOO_MUCH_FOR_ONE_STEP', 'note',
      `"${n.label || n.id}" can return up to ${many} items, and they all go to "${hit.label || hit.id}" in one go. That step may run out of time before it finishes. Reading fewer, or handling them one at a time, would make this quicker and more reliable.`,
      { nodeId: n.id, aiStep: hit.id, items: many }));
  }

  const RANK = { error: 0, warning: 1, note: 2 };
  return findings.sort((x, y) => RANK[x.severity] - RANK[y.severity]);
}

/** A one-line summary for the build log. */
export function summariseContradictions(findings) {
  if (!findings.length) return 'this build agrees with itself';
  const by = findings.reduce((m, f) => ({ ...m, [f.severity]: (m[f.severity] ?? 0) + 1 }), {});
  return Object.entries(by).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(', ');
}
