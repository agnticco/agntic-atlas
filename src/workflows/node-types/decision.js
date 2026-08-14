/**
 * decision node — a DMN decision table. (P12 Increment E.)
 *
 * The deciding, separated from the routing. A `branch` ROUTES on a value that
 * already exists; a `decision` PRODUCES that value, from a table whose coverage
 * can be proven before it ever runs. That separation is the whole reason the
 * completeness proof is possible: the branch's logic is a lookup, and the
 * table's logic is a finite, enumerable set of boxes over a finite domain
 * (decision-analysis.js — box subtraction, never cross-product enumeration).
 *
 * config (converger-v2 §2.2 — everything lives under `config`, see below):
 *   inputs:    [ { key, type: enum|number|integer|boolean, values?, evaluator?: 'llm',
 *                  evaluatorPrompt?, from?: '<stepId>[.<field>]' } ]
 *   output:    { key, type: 'enum', values: [ … ] }      // the closed set it can emit
 *   hitPolicy: 'UNIQUE' | 'FIRST' | 'COLLECT'
 *   rules:     [ { when: { <inputKey>: <FEEL-A condition> }, then: <one of output.values> } ]
 *
 * Output: { value, text, rule, rules?, hitPolicy, inputs } — `value` is what a
 * downstream `branch` routes on, `text` is what a template renders
 * ({{score.output}} → "P1", not a JSON blob), and `rule` is THE AUDIT TRAIL: which
 * row fired, on which resolved inputs. "Why did it decide that?" is answerable by
 * pointing at a row of a table the user reviewed — which is the thing a pure-LLM
 * builder cannot offer.
 *
 * ── THE MOAT (§11.7) ────────────────────────────────────────────────────────
 * An input with `evaluator: 'llm'` MUST be `type: 'enum'` with a closed `values`
 * list, and run() classifies into exactly that list — throwing on an off-enum
 * answer rather than passing free text into the table. A free-text input has an
 * infinite domain, coverage over an infinite domain is not provable, and an
 * unprovable table deletes the product. The validator enforces it
 * (LLM_INPUT_NOT_ENUM); this file is what makes the enforcement true at run time.
 *
 * ── NO RULE MATCHED ⇒ FAIL LOUDLY ───────────────────────────────────────────
 * An uncovered input combination THROWS. It does not return null, and it does not
 * quietly pick a default. A null would flow into the downstream branch, match no
 * case, and be swallowed by the mandatory catch-all — a silent no-op with
 * `run_completed`, which is the single failure mode this entire phase exists to
 * make impossible. Failing means the step escalates to a person (the gap scorer
 * offers exactly that resolution, and escalation.js materialises it), so an
 * unanticipated case reaches somebody instead of vanishing.
 *
 * ── WHY EVERYTHING IS UNDER `config` ────────────────────────────────────────
 * converger-v2 §2.2 originally drew `inputs`/`output`/`rules` at the NODE level.
 * The engine cannot run that shape: `run(cfg, ctx, services)` is handed
 * `node.config` and nothing else (flow-tester.js `_runNode`), so a table hung off
 * the node is a table the executor never sees. It would also sit outside
 * UNKNOWN_CONFIG_KEY and MISSING_CONFIG, i.e. outside every check that makes a
 * spec's shape true. `tableOf()` still READS the top-level spelling — so the moat
 * and the DMN analysis bite on it — but the validator rejects it (a table the
 * engine cannot see must never publish), and §2.2 is corrected.
 */

import { SystemMessage, HumanMessage } from '../../core/message.js';
import { resolveTransformInput }       from './_node-input.js';
import { matchesCondition, IRRELEVANT } from '../decision-analysis.js';
import { NO_MODEL_MESSAGE }            from '../../llm/no-model.js';

/**
 * The three the UI offers, in plain language (converger-v2 §6.4):
 *   UNIQUE  → "Only one rule should ever match"
 *   FIRST   → "First match wins"
 *   COLLECT → "Collect everything that matches"
 */
export const HIT_POLICIES = ['UNIQUE', 'FIRST', 'COLLECT'];

/**
 * The radio the user actually sees (converger-v2 §6.4). NEVER the DMN letter: "U"
 * means nothing to the person whose process this is, and a table they cannot read
 * is a table they cannot vouch for — which is the whole point of showing it to
 * them. One table, exported, so the converger, the UI and the SOP cannot describe
 * the same policy in three different ways.
 */
export const HIT_POLICY_LABELS = {
  UNIQUE:  'Only one rule should ever match',
  FIRST:   'First match wins',
  COLLECT: 'Collect everything that matches',
};

/**
 * DECOMPOSE AT >4 INPUTS. The limit is COGNITIVE, not computational: box
 * subtraction analyses 10 inputs × 10 values (10^10 combinations) in ~1 ms
 * (scripts/checks/gap-analysis-bench.mjs). But at 5+ inputs nobody reviews the
 * table, and a table nobody reviews is not auditable — which is the moat. A
 * decision the user cannot check is a decision they are merely trusting, and
 * trusting an LLM is the product we are competing with. (converger-v2 §12.)
 */
export const DECISION_MAX_INPUTS = 4;

export const decisionNodeType = {
  type: 'decision',
  label: 'Decision',
  description: 'Decides one value from a table of rules — the same inputs always give the same answer, and every case is provably covered.',
  icon: 'table_chart',
  family: 'control',
  configPolicy: 'closed',
  configSchema: [
    { key: 'inputs', label: 'Inputs', type: 'object',
      hint: 'What it decides on: [{ "key": "budget", "type": "number" }]. An AI-judged input must be { "type": "enum", "values": [...] , "evaluator": "llm" } — a closed list, or the table cannot be proven complete.' },
    { key: 'output', label: 'Output', type: 'object',
      hint: 'The closed set of answers: { "key": "priority", "type": "enum", "values": ["P1","P2","P3"] }.' },
    { key: 'rules', label: 'Rules', type: 'object',
      hint: 'The table: [{ "when": { "budget": ">50000" }, "then": "P1" }]. "-" means "don\'t care". A rule with every input "-" is the catch-all.' },
    { key: 'hitPolicy', label: 'Hit policy', type: 'select', options: HIT_POLICIES, optional: true, default: 'FIRST',
      hint: 'FIRST = first matching rule wins · UNIQUE = exactly one rule may ever match (overlaps are rejected) · COLLECT = every match is returned.' },
  ],
  previewTemplate: 'Decides {output} from a table of rules.',

  /**
   * Structural checks — the ones that need only the node. The DMN COVERAGE
   * analysis (gaps, overlaps, undecidable domains) needs `analyzeTable` and lives
   * in workflow-validator.js `_checkDecisionTables`, so that publish and the gap
   * scorer consult ONE oracle rather than two opinions.
   */
  validate: (node) => {
    const issues = [];
    const at = (code, message, field, hint, severity = 'error') =>
      issues.push({ severity, code, message, nodeId: node?.id ?? null, field, hint });
    const label = node?.label || node?.id;

    // The table hung off the NODE instead of its config. The engine hands run()
    // `node.config` and nothing else, so this table would never be read: the step
    // would throw at run time on an empty table — or, worse, be reasoned about by
    // the validator (which tolerates the spelling) and then not exist to the
    // executor. Say precisely what is wrong, rather than emitting three confusing
    // MISSING_CONFIGs.
    const cfg = node?.config ?? {};
    const misplaced = ['inputs', 'output', 'rules', 'hitPolicy'].filter(k => node?.[k] != null && cfg[k] == null);
    if (misplaced.length) {
      at('MISSING_CONFIG',
         `"${label}" declares ${misplaced.join(', ')} outside its config, where the engine never reads it — the table would not run.`,
         `config.${misplaced[0]}`,
         `Move ${misplaced.join(', ')} inside "config": { … }.`);
      return issues;
    }

    const { inputs, output, rules, hitPolicy } = tableOf(node);

    // ── inputs ────────────────────────────────────────────────────────────
    if (!inputs.length) {
      at('MISSING_CONFIG', `"${label}" is a decision but decides on nothing — it has no inputs.`,
         'config.inputs', 'Add at least one input, e.g. [{ "key": "budget", "type": "number" }].');
    }
    const seenKeys = new Set();
    for (const i of inputs) {
      const key = String(i?.key ?? '').trim();
      if (!key) {
        at('MISSING_CONFIG', `"${label}" has an input with no key.`, 'config.inputs',
           'Every input needs a key — the name the rules test.');
        continue;
      }
      if (seenKeys.has(key)) {
        // Two inputs wearing one key is a silent drop: `when: { tone: … }` can only
        // mean one of them, and the analysis partitions ONE domain. Whichever
        // loses is a dimension the user believes is being decided on and is not.
        at('DUPLICATE_DECISION_INPUT', `"${label}" declares the input "${key}" twice — the rules could only ever test one of them.`,
           'config.inputs', 'Give each input its own key.');
      }
      seenKeys.add(key);
      const type = String(i?.type ?? '').toLowerCase();
      if (!type) {
        at('MISSING_CONFIG', `"${label}" doesn't say what kind of value "${key}" is, so its possible values are unknown and coverage can't be checked.`,
           'config.inputs', 'Give it a type: enum (with values), number, integer, or boolean.');
      }
      const from = i?.from;
      if (from != null && !DECISION_FROM.test(String(from).trim().replace(/^\{\{\s*|\s*\}\}$/g, ''))) {
        at('DECISION_BAD_INPUT_REF', `"${label}" reads "${key}" from "${from}", which isn't a step reference.`,
           'config.inputs', 'Use "<stepId>" or "<stepId>.<field>" — e.g. "extract_fields.budget".');
      }
    }

    // DECOMPOSE AT >4 INPUTS (§12). A warning, not an error: a wide table is
    // unreviewable, not incorrect, and blocking publish on it would be
    // paternalistic about a table that might be perfectly right. But it is said
    // out loud, because an unreviewed table is one nobody can vouch for.
    if (inputs.length > DECISION_MAX_INPUTS) {
      at('DECISION_TOO_WIDE',
         `"${label}" decides on ${inputs.length} things at once (${[...seenKeys].join(', ')}). Past four, nobody can hold the table in their head — and a table nobody reviews is one nobody can vouch for.`,
         'config.inputs',
         `Split it into two decisions: decide the harder half first (e.g. "${[...seenKeys].slice(0, 2).join('" and "')}"), then feed that answer into a second table as one input.`,
         'warning');
    }

    // ── output ────────────────────────────────────────────────────────────
    const outValues = valuesOf(output);
    if (!output || !String(output.key ?? '').trim()) {
      at('MISSING_CONFIG', `"${label}" doesn't say what it decides — it has no output.`, 'config.output',
         'Add output: { "key": "priority", "type": "enum", "values": ["P1","P2","P3"] }.');
    } else if (outValues.length < 2) {
      // The output enum IS the closed domain a downstream branch routes on
      // (closedDomainOf). Fewer than two values decides nothing, and leaves the
      // branch's case check with nothing to check against.
      at('MISSING_CONFIG', `"${label}" lists fewer than two possible answers, so it isn't deciding anything.`,
         'config.output', 'List every value it can produce: { "values": ["P1","P2","P3"] }.');
    }

    // ── hit policy ────────────────────────────────────────────────────────
    if (hitPolicy && !HIT_POLICIES.includes(hitPolicy)) {
      at('DECISION_BAD_HIT_POLICY', `"${label}" uses the hit policy "${node.config?.hitPolicy ?? node.hitPolicy}", which doesn't exist.`,
         'config.hitPolicy', `Use one of: ${HIT_POLICIES.join(', ')}.`);
    }

    // ── rules ─────────────────────────────────────────────────────────────
    if (!rules.length) {
      at('MISSING_CONFIG', `"${label}" is a decision table with no rules.`, 'config.rules',
         'Add at least one { "when": { … }, "then": "<one of the output values>" }.');
    }
    rules.forEach((rule, i) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule) || !rule.when || typeof rule.when !== 'object') {
        at('DECISION_BAD_CONDITION', `Rule ${i + 1} of "${label}" has no readable conditions.`,
           'config.rules', 'Every rule is { "when": { "<input>": "<condition>" }, "then": "<value>" }.');
        return;
      }
      // A `when` naming an input the table never declared is READ BY NOBODY: the
      // analysis partitions the DECLARED inputs only, so the condition is
      // silently dropped and the rule is treated as broader than it is — it
      // covers boxes its author believed it excluded. The table's proof would be
      // about a different table.
      for (const k of Object.keys(rule.when)) {
        if (!seenKeys.has(k)) {
          at('DECISION_UNKNOWN_INPUT',
             `Rule ${i + 1} of "${label}" tests "${k}", which isn't one of its inputs — the condition would be ignored, and the rule would match more cases than you think.`,
             'config.rules',
             `Its inputs are: ${[...seenKeys].join(', ') || '(none)'}. Add "${k}" as an input, or remove the condition.`);
        }
      }
      // A `then` outside the declared output enum is the BRANCH_CASE_NOT_IN_ENUM
      // failure through the other door: closedDomainOf() tells the branch the
      // decision can only emit output.values, so a branch has no case for this
      // one — it matches nothing and the mandatory catch-all swallows it,
      // silently, forever. We closed the domain precisely so membership would be
      // decidable; not deciding it is a completeness claim nobody checked.
      const then = rule.then;
      if (then == null || String(then).trim() === '') {
        at('MISSING_CONFIG', `Rule ${i + 1} of "${label}" doesn't say what to decide when it matches.`,
           'config.rules', 'Add "then": "<one of the output values>".');
      } else if (outValues.length && !outValues.some(v => v === String(then))) {
        at('DECISION_OUTPUT_NOT_IN_ENUM',
           `Rule ${i + 1} of "${label}" decides "${then}", which isn't one of its possible answers (${outValues.join(', ')}) — anything routing on this decision would have no case for it and would silently fall through.`,
           'config.rules',
           `Use one of: ${outValues.join(', ')} — or add "${then}" to the output's values.`);
      }
    });

    return issues;
  },

  /**
   * Evaluate the inputs, match the rules, return the decision plus WHICH RULE
   * FIRED. One LLM call per fuzzy input (converger-v2 §12: "lean per-input for
   * the audit trail") — a single call for the whole table is cheaper and tells
   * you nothing about why it landed where it did.
   */
  run: async (cfg, ctx, services) => {
    const { inputs, output, hitPolicy, rules } = tableOf({ config: cfg });
    if (!inputs.length || !rules.length) {
      throw new Error('decision has no inputs or no rules — there is nothing to decide.');
    }

    // ── 1. Resolve every input to a value ─────────────────────────────────
    //
    // A malformed input or rule REFUSES TO RUN. It is not skipped, and the table
    // is not quietly evaluated without it: a dropped input is a dimension the
    // author believes is being decided on and is not, and a dropped rule makes
    // every remaining rule broader than it was written. Both would produce a
    // confident answer from a table nobody wrote. The engine does not rely on the
    // validator having run — a spec in the database predates every rule.
    const resolved = {};
    for (const input of inputs) {
      if (!input || typeof input !== 'object' || !String(input.key ?? '').trim()) {
        throw new Error(`decision has an input with no key (${JSON.stringify(input)}) — refusing to decide without it.`);
      }
      resolved[input.key] = String(input?.evaluator ?? '').toLowerCase() === 'llm'
        ? await classifyInput(input, ctx, services)
        : coerce(readInput(input, ctx), input);
    }

    // ── 2. Match, under the hit policy ────────────────────────────────────
    const matched = [];
    rules.forEach((rule, index) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule) || !rule.when || typeof rule.when !== 'object') {
        throw new Error(`decision rule ${index + 1} has no readable conditions — refusing to decide from a table it cannot read.`);
      }
      let hit = true;
      for (const input of inputs) {
        const cond = rule.when?.[input.key];
        const { ok, matched: m } = matchesCondition(cond, input, resolved[input.key]);
        // A condition the FEEL-A grammar cannot read is NOT a condition that
        // failed to match. Treating it as "no match" would let an unparseable
        // rule silently narrow the table at run time while the analyser — which
        // reports it as a bad condition — believed the table was covered.
        if (!ok) {
          throw new Error(
            `decision rule ${index + 1} tests "${input.key}" with "${cond}", which is not a condition this engine can evaluate ` +
            '(allowed: a literal, a comma list, < <= > >=, an interval like [10..50], not(...), or "-").',
          );
        }
        if (!m) { hit = false; break; }
      }
      if (hit) matched.push({ index, when: rule.when, then: rule.then });
    });

    // ── 3. No rule matched ⇒ FAIL LOUDLY (see the header) ─────────────────
    if (!matched.length) {
      const seen = Object.entries(resolved).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
      throw new Error(
        `decision "${output?.key ?? 'this table'}" has no rule for ${seen}. ` +
        'Refusing to guess: an uncovered case must reach a person, not silently do nothing.',
      );
    }

    if (hitPolicy === 'COLLECT') {
      const values = matched.map(m => m.then);
      return {
        value: values, text: values.join(', '),
        hitPolicy, rules: matched, rule: matched[0], inputs: resolved,
      };
    }

    if (hitPolicy === 'UNIQUE' && matched.length > 1) {
      // The table PROMISED exactly one rule would ever match. It didn't. Picking
      // one anyway would make the decision depend on rule order in a table whose
      // author was told order does not matter — the answer would be arbitrary and
      // would look deliberate.
      throw new Error(
        `decision matched ${matched.length} rules (${matched.map(m => m.index + 1).join(', ')}) but its hit policy is UNIQUE, ` +
        'which promises exactly one. Narrow the rules, or change the policy to FIRST.',
      );
    }

    const first = matched[0];
    return {
      value: first.then, text: String(first.then),
      hitPolicy, rule: first, inputs: resolved,
    };
  },
};

// ── Reading the table ────────────────────────────────────────────────────────

/** `from` is a REFERENCE (like a branch's `on`), never a template. */
const DECISION_FROM = /^([a-z0-9_-]+)(?:\.([a-z0-9_-]+))?$/i;

/**
 * The table, whether it is written under `config` (canonical — the only shape the
 * engine can run) or hung off the node (converger-v2 §2.2's original drawing).
 * ONE reader, used by run(), the validator, the gap scorer and the UI — so that
 * "what does this table say?" has exactly one answer everywhere.
 */
export function tableOf(node) {
  const cfg = node?.config ?? {};
  return {
    inputs:    listOf(cfg.inputs    ?? node?.inputs),
    output:    objOf(cfg.output     ?? node?.output),
    rules:     listOf(cfg.rules     ?? node?.rules),
    hitPolicy: normalizeHitPolicy(cfg.hitPolicy ?? node?.hitPolicy),
  };
}

/** The declared values of an enum-ish thing (an input or the output). */
export function valuesOf(x) {
  return Array.isArray(x?.values) ? x.values.filter(v => v != null).map(String) : [];
}

/**
 * FIRST is the default, and it is the safe one: it always yields exactly one
 * answer. An UNRECOGNISED policy is NOT defaulted — it is returned verbatim so
 * the validator can reject it. Quietly reading "UNIQE" as FIRST would run a table
 * under a policy its author did not choose, and the promise UNIQUE makes (that
 * overlaps are impossible) would never be checked.
 */
export function normalizeHitPolicy(raw) {
  if (raw == null || String(raw).trim() === '') return 'FIRST';
  const p = String(raw).trim().toUpperCase();
  const alias = { U: 'UNIQUE', F: 'FIRST', C: 'COLLECT' };
  return alias[p] ?? p;
}

/**
 * A LIST READER IS FAITHFUL. It parses the textarea's JSON and it does nothing
 * else — in particular it does NOT drop the entries it dislikes.
 *
 * It used to filter out anything that was not a plain object, which quietly
 * re-created Increment C's defect #2 one layer up. `decision-analysis.js` opens
 * with a guard whose whole purpose is that a rule it cannot read must never look
 * like a rule that covers everything — and a `null` stripped HERE never reached
 * that guard. The analyser was then handed a table with one fewer rule than the
 * author wrote, and certified ITS coverage: a clean bill of health for a table
 * nobody had. The same filter dropped an input with no `key`, so an input the user
 * declared simply vanished and the validator's own "an input with no key" check
 * became dead code.
 *
 * A malformed entry is a fact about the spec. Reporting it is the validator's job
 * (and refusing to run on it is the executor's). Hiding it is nobody's.
 */
function listOf(raw) {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(v) ? [...v] : [];
}

function objOf(raw) {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// ── Resolving an input's value ───────────────────────────────────────────────

/**
 * Where an input's value comes from:
 *
 *   from: "extract.budget"   an explicit reference — a step's output, or a field of it
 *   from: "extract"          that step's whole output
 *   (absent)                 the input's own KEY, looked up in the nearest upstream
 *                            structured output that has it (lastOutput first, then
 *                            ancestors in reverse topological order)
 *
 * A value that cannot be found THROWS. It does not default to null and it does
 * not default to "". A missing input silently becoming empty would match whatever
 * rule happened to test `-` on it, and the table would decide on a value nobody
 * supplied — a wrong answer that looks exactly like a right one.
 */
function readInput(input, ctx) {
  const key  = input.key;
  const from = input.from == null ? null : String(input.from).trim().replace(/^\{\{\s*|\s*\}\}$/g, '');

  if (from) {
    const m = DECISION_FROM.exec(from);
    if (!m) throw new Error(`decision input "${key}" has an unreadable source "${input.from}".`);
    const [, stepId, field] = m;
    if (!ctx?.outputs?.has(stepId)) {
      throw new Error(`decision input "${key}" reads from "${from}", but step "${stepId}" produced no output on this run.`);
    }
    const out = ctx.outputs.get(stepId);
    // `<id>.output` means THE STEP'S OUTPUT — the spelling every other reference in
    // the system uses (branch's ON_REF, {{id.output}} templates). Read as a field
    // literally named "output" it threw on the one form a user is most likely to
    // write. (Found by the test-adversary.)
    const v = (field && field !== 'output') ? pick(out, field) : out;
    if (v === undefined) {
      throw new Error(`decision input "${key}" reads "${from}", but step "${stepId}" produced no "${field}".`);
    }
    return v;
  }

  // Auto: the newest upstream object that carries this key.
  const candidates = [ctx?.lastOutput, ...[...(ctx?.ancestorOutputs ?? [])].reverse().map(a => a.output)];
  for (const c of candidates) {
    const v = pick(c, key);
    if (v !== undefined) return v;
  }
  throw new Error(
    `decision input "${key}" was not produced by any earlier step. ` +
    `Add a step that extracts "${key}", or point the input at one with "from": "<stepId>.${key}".`,
  );
}

/** A key of a plain object (or of a JSON string an upstream step returned). */
function pick(out, key) {
  let o = out;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { return undefined; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  return o[key];
}

/**
 * A value read out of an upstream step is text until proven otherwise — AND, for
 * an enum, it must be a member of the declared set or the run stops.
 *
 * ── THE MOAT'S OTHER DOOR (found by the test-adversary) ─────────────────────
 *
 * `classifyInput()` (the `evaluator: 'llm'` path) has always thrown on an
 * off-enum answer. This path — the ordinary one, where the value is READ from an
 * upstream step — did not: it `String()`d whatever arrived and handed it to the
 * table. So an input declared `type:'enum'` with NO evaluator, whose `from` points
 * at a freeform `llm`, carried a whole paragraph of prose into a table whose
 * coverage had been proven over {calm, urgent} — where it matched no rule but the
 * catch-all, and the workflow quietly decided P3 on an input that said
 * "EXTREMELY urgent". `analyzeTable` reported `decidable: true, uncovered: []`:
 * a completeness proof, with a receipt, for a decision nobody made.
 *
 * §11.7's property is "the value being decided on has a CLOSED, DECLARED domain" —
 * not "an LLM didn't type it". A value's domain is not bounded by who produced it,
 * so the check belongs where the value ENTERS the table, on every path in.
 * Membership is decidable precisely because we forced the domain closed; declining
 * to decide it is a completeness claim nobody checked.
 *
 * An off-enum value is the one case that MUST reach a person: it is exactly the
 * case the table's author never anticipated. So it throws, and the failure
 * escalates (escalation.js) rather than being absorbed by the catch-all.
 */
function coerce(value, input) {
  const type = String(input?.type ?? '').toLowerCase();

  // A NULL IS A MISSING VALUE, NOT A VALUE. `llm` in `extract` mode — the one
  // producer the converger is taught to put in front of a table — states in its
  // own system prompt that "if a field cannot be found, its value is null"
  // (llm.js). So the canonical upstream emits precisely this, and a `null` handed
  // to the table matches only `-` and decides via the catch-all: the table decides
  // on a value nobody supplied, which is a wrong answer that looks exactly like a
  // right one. readInput()'s docblock already forbade it; it only checked
  // `undefined`. (Found by the test-adversary.)
  if (value === null) {
    throw new Error(
      `decision input "${input.key}" came back empty from the step that produces it. ` +
      'Refusing to decide: an input nobody supplied is not a value, and the table would silently take its catch-all.',
    );
  }

  if (type === 'enum') {
    const values = valuesOf(input);
    const v = String(value).trim();
    const hit = values.find(d => d.toLowerCase() === v.toLowerCase());
    if (!hit) {
      throw new Error(
        `decision input "${input.key}" is ${JSON.stringify(String(value).slice(0, 80))}, which is not one of its ` +
        `declared values (${values.join(', ')}). Refusing to decide: the table was proven complete over those values, ` +
        'so anything else is a case nobody anticipated and must reach a person.',
      );
    }
    return hit;   // the DECLARED spelling, so the rules match it exactly
  }

  if (type === 'number' || type === 'integer') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) {
      throw new Error(`decision input "${input.key}" needs a number, but got ${JSON.stringify(value)}.`);
    }
    return type === 'integer' ? Math.trunc(n) : n;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    if (s === 'true' || s === 'yes')  return true;
    if (s === 'false' || s === 'no')  return false;
    throw new Error(`decision input "${input.key}" needs true or false, but got ${JSON.stringify(value)}.`);
  }
  return value == null ? value : String(value);
}

/**
 * An LLM-judged input. THE MOAT, at run time: it classifies into the input's own
 * closed `values` and THROWS on anything else — never returning free text into a
 * table whose coverage was proven over that closed set. An off-enum answer is
 * exactly the case that must escalate to a person, and it is the one case where
 * being wrong quietly would be indistinguishable from being right.
 */
async function classifyInput(input, ctx, services) {
  const values = valuesOf(input);
  if (values.length < 2) {
    // LLM_INPUT_NOT_ENUM rejects this at build time. The engine does not rely on
    // the validator having run — refuse rather than ask a model an open question
    // and pretend the answer belongs to a closed set.
    throw new Error(
      `decision input "${input.key}" is judged by AI but declares no closed list of answers. ` +
      'Refusing to run: a free-text input has an unbounded domain, so the table cannot cover it.',
    );
  }
  if (!services?.llm) throw new Error(`The rule for "${input.key}" needs the AI to judge it. ${NO_MODEL_MESSAGE}`);

  const text = String(input.from ? readInput(input, ctx) : resolveTransformInput({}, ctx) ?? '');
  if (!text.trim()) throw new Error(`decision input "${input.key}" has nothing to judge — no upstream step produced any content.`);

  const guide = input.evaluatorPrompt ? `\n\nHow to decide:\n${input.evaluatorPrompt}` : '';
  const res = await services.llm.invoke([
    new SystemMessage('You are a classifier inside an automated workflow. You reply with EXACTLY ONE of the allowed values, verbatim — no punctuation, no explanation, no preamble. Never invent a value.'),
    new HumanMessage(
      `Judge "${input.key}" for the content below. Reply with exactly one of these values:\n` +
      `${values.map(v => `- ${v}`).join('\n')}${guide}\n\n---\n${text}`,
    ),
  ], ctx?.costConfig ?? undefined);

  const raw    = String(res?.content ?? '').trim();
  const picked = pickCategory(raw, values);
  if (!picked) {
    throw new Error(
      `decision input "${input.key}": the AI answered "${raw.slice(0, 80)}", which is not one of ${values.join(', ')}.`,
    );
  }
  return picked;
}

/**
 * Snap a model's answer to exactly one declared value — or to NOTHING, so the
 * caller throws and the case reaches a person.
 *
 * ── WHY THE OBVIOUS FALLBACK IS A SILENT WRONG DECISION ─────────────────────
 *
 * The old rule was: exact match, else the first declared value that appears
 * ANYWHERE in the answer. Both halves of that fallback are broken, and neither
 * fails loudly — it never returns free text, it returns the WRONG MEMBER OF THE
 * SET, which the table then decides on with complete confidence:
 *
 *   values ['approve','reject'], answer "I would reject this — do not approve."
 *     → substring scan hits 'approve' FIRST (declaration order) → APPROVE.
 *       It decides the exact opposite of what the model said. If that gates a
 *       refund, the refund goes out.
 *
 *   values ['ship','ship_hold'], answer "Decision: ship_hold"
 *     → 'ship' is a substring of 'ship_hold' → SHIP. A value that is a prefix of
 *       another becomes unreachable the moment the model adds a preamble.
 *
 * So: an exact answer wins; otherwise the answer must contain EXACTLY ONE
 * declared value, matched on WORD BOUNDARIES (which is what makes `ship_hold`
 * beat `ship` — `_` is a word character, so \bship\b does not match inside it).
 * Two candidates is an ambiguous answer, and an ambiguous answer to a closed
 * question is not an answer. Refuse, and let it escalate.
 *
 * (Found by the test-adversary. The identical fallback in `llm.js` mode
 * `classify` — the OTHER sanctioned way an LLM feeds a decision — had the same
 * defect and is fixed with this same function.)
 */
export function pickCategory(raw, values) {
  const answer = String(raw ?? '').trim();
  const exact = values.find(v => v.toLowerCase() === answer.toLowerCase());
  if (exact) return exact;

  const hits = values.filter(v => wordBoundary(v).test(answer));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A word boundary around a value, with the value's own regex metacharacters
 * escaped so a category like `P1+` or `v1.0` cannot act as a pattern.
 *
 * UNICODE-AWARE, deliberately: `\w` is ASCII-only, so an ASCII boundary treats
 * `urgentísimo` as `urgent` + a boundary + `ísimo` and the classifier returns
 * `urgent` — a member of the set the model did not name, which is the exact class
 * this function exists to kill. A workflow triaging Spanish or German mail is not
 * an edge case. (Found by the independent verifier, E-R8.)
 */
function wordBoundary(value) {
  const esc = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_-])${esc}(?:[^\\p{L}\\p{N}_-]|$)`, 'iu');
}

export { IRRELEVANT };
