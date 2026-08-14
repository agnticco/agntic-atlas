# BPMN / DMN foundations — and what they force on the converger

**Status:** research note · 2026-07-13 · **Prerequisite for** `converger-v2.md` (which this
document *revises* — see §7)

This is the study of the two standards before we build against them. It exists because
designing a "BPMN/DMN-shaped converger" from a vague memory of the standards would poison the
architecture. Sources at the bottom; the load-bearing claims are cited inline.

**We are not porting to BPMN/DMN.** The proprietary JSON spec stays (ENGINEERING-LOG.md, closed
decisions). We are stealing the *semantics* — because they contain a completeness theory we
cannot invent ourselves, and a division of labour that took the industry twenty years to
learn.

---

## 1. What each standard actually owns

The division is sharper than "process vs rules":

| | Owns | Does not own |
|---|---|---|
| **BPMN** | **Orchestration.** What happens, in what order, by whom, and what to do when it breaks. Service tasks (do a thing), *business rule tasks* (invoke a decision), gateways (route), boundary events (error/timer/escalation), sub-processes, multi-instance (iterate). | Business logic. |
| **DMN** | **All modeller-defined business logic** — and Bruce Silver is emphatic that this means *everything* requiring subject-matter expertise, "not just that related to decisions": calculations, validations, outcome determinations. | Sequencing, timing, who does it, what happens on failure. |

**Gateways route. Decisions decide.** This is the single most important sentence in the two
standards, and it is the one Atlas currently violates by having neither.

---

## 2. The dance — the integration pattern

The canonical shape, per Silver:

```
   ┌─────────────────────┐        ┌─────────┐
──▶│ Business Rule Task  │──────▶ │ Gateway │──▶ …
   │ (invokes a DMN      │ output │ (routes │
   │  decision service)  │  var   │  on it) │
   └─────────────────────┘        └─────────┘
```

The decision task takes process data in, invokes the decision, and its **output becomes a
process variable**. Then **one** gateway routes on that variable.

**The anti-pattern it replaces** is exactly the one a naive builder falls into: encoding the
logic as a *chain of gateways*. Silver: *"all decision models should be associated with a BPMN
business rule task and not with a BPMN decision gateway, as the latter is simply a routing
mechanism and does not represent business logic leading to a conclusion."* The failure mode is
that *"the decision remains hidden and scattered among the process steps"* — unreviewable,
untestable, and impossible to reuse.

The most useful mental model I found: **a decision is a "meta gateway"** — merging inputs
(events and data) and splitting outputs that direct the process. The gateway is its dumb
executor.

### 2.1 The mechanical rule this hands the converger

This gives shape-derivation a **decidable test** for every conditional the user utters:

> **Is the value the condition tests on already present in the data?**
>
> - **Yes** → it is a **gateway**. *"if budget > $50k"* — `budget` was extracted upstream; just route.
> - **No** → it requires **judgment or derivation** → emit a **decision** node that *produces*
>   the value, then a gateway that routes on it. *"if it looks urgent"* — `urgency` exists
>   nowhere; it must be decided.

That rule is implementable, and it structurally prevents the hidden-decision anti-pattern.

---

## 3. DMN's decision table — the part with actual mathematics

### 3.1 Anatomy
Inputs (each with a **type/domain**), outputs, rules (rows), and a **hit policy**.

### 3.2 Hit policies — and why one of them is an elicitation question we never ask

| | Policy | Semantics |
|---|---|---|
| **Single hit** | **U**nique | Rules must not overlap. Exactly one matches. *(the default)* |
| | **A**ny | Overlap permitted **only if all matching rules give the same output**. |
| | **P**riority | Overlap permitted; highest-priority *output* wins. |
| | **F**irst | Overlap permitted; **first matching rule by row order** wins. |
| **Multi hit** | **C**ollect | Returns all hits; optional aggregator `+` (sum), `<` (min), `>` (max), `#` (count). |
| | **O**utput order | All hits, ordered by output priority. |
| | **R**ule order | All hits, in row order. |

**"What happens if two of your rules both apply?"** is a question no user volunteers and every
real process has an answer to. DMN *forces* it. And overlap detection makes it concrete rather
than abstract: *"Rules 2 and 4 both fire when budget = 60k and tone = urgent. Which wins?"*

That is a genuinely new class of elicitation question for us, and it is exactly the "edge case
that lives in the exceptions" we currently never reach.

### 3.3 Completeness — the formal result, and its hard limit

From Calvanese et al., *Semantics and Analysis of DMN Decision Tables* (BPM 2016), which is the
basis of the gap analysis shipped in Camunda/Signavio/Trisotech:

- A rule is a **conjunction of conditions over inputs** → geometrically, an **axis-aligned
  hyper-rectangle** in the input space.
- **Gap** = a region of the input space no rule covers. **Overlap** = a region covered twice.
  Also defined: **subsumption** (one rule implies another), **equivalence**, and **masked
  rules** (rules that can never fire because an earlier one subsumes them under FIRST).
- **Completeness is computable — but only over finite / enumerable domains**: enums,
  booleans, bounded integer ranges.

> ### ⚠️ The constraint that shapes our entire design — CORRECTED 2026-07-13
>
> An earlier draft of this note said *"decidable only over enums / bounded ints"*. **That was
> too strict, and it would have crippled the design** (it would have banned `budget > 50000`,
> the canonical example). The correct statement:
>
> **Gap analysis is decidable when the domain is finitely PARTITIONABLE by the conditions used.**
>
> | Input | Conditions | Decidable? | Why |
> |---|---|---|---|
> | enum / boolean | equality, membership | **yes** | finite by construction |
> | **number** | `<`, `<=`, `>`, `>=`, intervals | **yes** | the rule boundaries cut the real line into finitely many intervals — this is exactly what the *geometric* (hyper-rectangle) method exploits, and it is why it beats enumeration |
> | string | equality / list only | **yes** | the listed values, plus one "everything else" region |
> | string | regex / pattern | **no** | not partitionable |
> | **free-text LLM judgment** | — | **no** | no domain at all |
>
> The "finite enumeration" limit in the literature applies to the *enumerative* algorithm, not
> the geometric one. **Use box subtraction, not cross-product enumeration** — see the measured
> numbers below.
>
> This does **not** weaken §6: an LLM-evaluated input still must be a **closed enum**, because a
> free-text judgment has no partitionable domain at all. Numbers are fine. Free text is not.

Two consequences we cannot design our way around:

1. **A free-text LLM judgment can never be gap-analysed.** `"sounds urgent"` has no finite
   domain.
2. **Big tables must be decomposed**, not widened — which is precisely what DMN's *Decision
   Requirements Graph* is for (§4).

DMN also explicitly does **not** handle temporal reasoning, probabilistic outcomes, or external
data dependencies. We should not imply otherwise.

### 3.4 The escape hatch that makes it work in practice
The catch-all rule: every input marked `-` ("irrelevant"), matching everything. Camunda's
guidance under FIRST is blunt — *"add a rule not accepting any other customers as a last row."*

**In Atlas the catch-all's output is `escalate → human`.** That is how "complete by
construction" becomes literally true rather than a slogan.

---

## 4. The DRG — the second graph, which we don't have

DMN's **Decision Requirements Graph** is a *data-dependency DAG*: decisions depend on
sub-decisions and on input data. It is **not** the process flow. It exists so that a wide,
unanalysable decision can be **decomposed into small, individually-provable ones** — the direct
answer to the exponential blow-up in §3.3.

So a complete model is **two graphs over overlapping elements**:

- **Process graph** (BPMN): control flow — sequence, branch, iterate, fail, escalate.
- **Decision graph** (DRG): data dependency — what this decision needs to know.

### The realisation about Atlas

**Atlas today has neither. It has a pipeline.**

`flow-tester.js` topologically sorts nodes and **runs every one of them**; data flows through
`{{nodeId.output}}`. That is a *dataflow DAG* — structurally much closer to a **DRG** than to a
BPMN process. Atlas has accidentally built the decision-dependency half and **zero** of the
control-flow half. There is no branch, no iteration, no failure path, no escalation.

That reframes the engine work: we are not "adding features to a workflow engine." **We are
adding the entire BPMN layer to something that is currently only a DRG.**

---

## 5. Modelling order — where I had it backwards

My first build doc proposed `outcome → shape → fill`: derive the whole process graph, then fill
in the judgment.

**Silver's methodology inverts this**, and he is right:

1. **Whiteboard concrete examples with the SME** (he uses Excel — rows of real cases with their
   expected outcomes, i.e. **test cases**).
2. **Build the decision model from those examples.** He calls this *"the hardest part of the
   project."*
3. **Then configure the process around the now-proven decision service.**

And critically: **"Discovery happens through examples. Each row represents a business event;
outcomes reveal which decisions and data transformations exist."**

Three things follow, and they are the most valuable findings in this document:

> **(a) Elicit by EXAMPLE, not by interrogation.**
> Instead of *"what should happen if the budget is missing?"* (an abstract question a user
> answers badly), ask: **"Show me three real cases. What came in, and what should have
> happened?"** The rules, the required inputs, and the decisions are all *induced* from the
> examples. This is also the thing LLMs are unusually good at — generalising rules from
> instances — so it plays to our executor's strength rather than against it.
>
> **(b) The examples ARE the test suite.** The SME's rows are acceptance cases. In Atlas they
> become the assertions the **test panel** checks — which turns our single best demo moment
> ("Run test → see real output") from a vibe check into a **contract check**, for free.
>
> **(c) Decisions before process.** The judgment is the hard, risky, valuable part; the
> orchestration is mechanical once the decisions are settled. Deriving the pipe before knowing
> what flows through it is backwards.

---

## 6. The bridge: how an LLM predicate survives the finite-domain constraint

This is the crux, and it is the thing that makes the whole "provable completeness + fuzzy
judgment" claim actually hold rather than merely sound good.

**The problem.** DMN needs finite domains (§3.3). LLM judgments are open-ended text. On the
face of it, the two are incompatible — which is why Camunda can prove completeness but can't
evaluate *"sounds urgent"*, and why a pure-LLM builder can evaluate anything and prove nothing.

**The move.** *Do not let the LLM be a judge. Make it a classifier into a declared, closed
domain.*

```jsonc
{ "key": "tone", "type": "enum", "values": ["calm", "neutral", "urgent"], "evaluator": "llm" }
```

The LLM's job is no longer *"is this urgent?"* (unbounded) but *"classify this into exactly one
of {calm, neutral, urgent}"* (a 3-valued finite domain).

And now the mathematics comes back:

- `tone` has **cardinality 3** → it is enumerable → **the table can be gap-analysed.**
- The predicate is still fuzzy — the *evaluator* is a language model — but the **domain is
  finite**, and completeness is a property of the domain, not the evaluator.
- Each cell is independently auditable: *"tone was classified `urgent`; rule 2 fired."*

**This is the whole trick, in one line:**

> **DMN gives the skeleton and the completeness proof. The LLM fills the cells — but only ever
> as a classifier into a domain the model declared.**

The moment we let an LLM emit free text into a decision input, we forfeit the proof and become
just another AI workflow builder. **The closed enum is the moat's load-bearing wall.**

---

## 7. What this revises in `converger-v2.md`

| # | v2 doc said | Corrected |
|---|---|---|
| 1 | `outcome → shape → fill` | **`outcome → examples → decisions → process`.** Decisions are derived from examples and proven *before* the process is wired. Silver: decisions are the hardest part. |
| 2 | Ask targeted gap questions | **Elicit by example first.** Induce rules from 3 concrete cases; only then ask about the gaps the induced table still has. Far fewer, far better questions. |
| 3 | `decision` node with LLM-evaluated inputs | Inputs must be **closed enums** (or bounded numerics). An LLM-evaluated input is a **classifier into a declared value set** — never free text. Without this, completeness is undecidable and the moat evaporates. |
| 4 | *(absent)* | **Hit policy is an elicitation question** — U/A/P/F/C. *"What if two rules both apply?"* Overlap detection makes it concrete. |
| 5 | *(absent)* | **Decision decomposition (DRG).** Gap analysis is exponential in input count; wide tables must be split into sub-decisions, not widened. |
| 6 | One graph | **Two graphs**: process (control flow) and decision-requirements (data dependency). Atlas today has only the latter, and doesn't know it. |
| 7 | Test panel checks assertions | Assertions **come from the elicited examples for free.** The SME's cases are the acceptance suite. |
| 8 | `branch` for every conditional | **Gateway only when the value already exists.** A conditional on a *derived* value ⇒ decision node first, then a gateway on its output. Prevents the hidden-decision anti-pattern. |

---

## 7b. MEASURED: the two open questions, answered

Benchmarked 2026-07-13 (`scratchpad/gap-bench.mjs`), two algorithms over realistic tables
(each rule pins 2 inputs, the rest `-`).

### (a) Where does gap analysis become unusable?

| dims × values | cross-product | **enumerative** | **rectangular (box subtraction)** |
|---|---|---|---|
| 5 × 4 | 1,024 | 1.2 ms | **0.3 ms** |
| 8 × 4 | 65,536 | 25.9 ms | **0.2 ms** |
| 10 × 4 | 1,048,576 | 474 ms | **7.3 ms** |
| 6 × 10 | 1,000,000 | 226 ms | **0.4 ms** |
| 8 × 10 | 100,000,000 | **ABORT** | **1.7 ms** |
| 10 × 10 | 10,000,000,000 | **ABORT** | **1.0 ms** |
| 12 × 10 | 10¹² | **ABORT** | **51 ms** |

**Computation is not the binding constraint.** With box subtraction, ten inputs over ten values
— ten *billion* combinations — is analysed in **1 ms**. Enumeration dies; geometry does not.

**The binding constraint is cognitive:**

| inputs (×4 values) | combinations | verdict |
|---|---|---|
| 3 | 64 | a human can read and sign this |
| 4 | 256 | borderline |
| **5+** | **1,024+** | **nobody reviews this** |

A decision table nobody can read is not auditable — and *auditable decision logic is the moat*.
So:

> **DECOMPOSITION RULE: the converger must split a decision into sub-decisions (a DRG) at
> > 4 inputs — because a human stops being able to review it, not because the maths fails.**

That is a better rule than the one I would have guessed, and it is why DMN has a Decision
Requirements Graph at all.

**Implementation directive: box subtraction, never cross-product enumeration.**

### (b) The FEEL subset — "FEEL-A"

DMN's *simple unary tests* grammar is small and closed. Adopt this subset for rule cells;
do not invent syntax.

| Form | Examples | Adopt? |
|---|---|---|
| irrelevant | `-` | **yes** — this is the catch-all mechanism |
| literal | `"urgent"` · `42` · `true` | **yes** |
| comparison | `< 10` · `<= 10` · `> 10` · `>= 10` | **yes** |
| interval | `[1..10]` · `(1..10]` · `[1..10)` · `(1..10)` | **yes** |
| disjunction | `3,5,7` · `<2,>10` · `10,[20..30]` | **yes** |
| negation | `not("Steak")` · `not(>10)` · `not([20..30])` | **yes** |
| **variable / qualified name** | `>= x` · `< customer.age` | **NO — excluded** |
| date/time expressions | `date and time("…")` | **defer** |

**Why variable references are excluded, on principle:** a cell like `>= x` has a domain that is
**unknown at build time**, so the covered region cannot be computed — it destroys decidability.
Excluding them is not a simplification; it is what keeps the completeness proof true.

Note `!=` does not exist in FEEL — negation is `not(...)`. Match that; don't invent `!=`.

---

## 8. What I still owe before implementing

1. **The validation-bypass bug.** I asserted in `converger-v2.md` that the validator misses
   `{{today}}`. **It does not** — I reproduced the exact node and it raises
   `BAD_TEMPLATE_REF` correctly. So a spec the validator *would have rejected* was executed
   against a live Google API anyway. **Something on the build/test path skips validation
   entirely.** That is a live hole and it must be found before any of this is built on top.
2. ~~FEEL subset~~ — **ANSWERED, §7b(b).**
3. ~~Practical table width~~ — **ANSWERED, §7b(a): decompose at >4 inputs, for cognitive
   reasons; box subtraction makes the maths free.**

---

## Sources

- [Semantics and Analysis of DMN Decision Tables — Calvanese, Dumas, Laurson, Maggi, Montali, Teinemaa (BPM 2016)](https://www.inf.unibz.it/~montali/papers/calvanese-etal-BPM2016-dmn.pdf) — the formal basis: geometric semantics, gap/overlap/subsumption/masking, and the finite-domain decidability limit.
- [Choosing the DMN hit policy — Camunda 8 Docs](https://docs.camunda.io/docs/components/best-practices/modeling/choosing-the-dmn-hit-policy/) — practical hit-policy selection; the catch-all-last-row rule.
- [A Methodology for Low-Code Business Automation with BPMN and DMN — Bruce Silver, Trisotech](https://www.trisotech.com/a-methodology-for-low-code-business-automation-with-bpmn-and-dmn/) — division of labour; decisions-before-process; discovery through examples.
- [Integrating BPMN and DMN — Modern Analyst](https://www.modernanalyst.com/Resources/Articles/tabid/115/ID/3189/Integrating-BPMN-and-DMN.aspx) — the business-rule-task → gateway pattern; the "decision as meta-gateway" model; the scattered-logic anti-pattern.
- [The Decision Model and Process Models with BPMN — Modern Analyst](https://www.modernanalyst.com/Resources/Articles/tabid/115/ID/1954/The-Decision-Model-and-Process-Models-with-BPMN.aspx) — Silver on why decisions belong in a business rule task, not a gateway.
- [DMN Hit Policy Explained — Bruce Silver, Trisotech](https://www.trisotech.com/dmn-hit-policy-explained/)
- [BPMN 2.0 Symbols reference — Camunda](https://camunda.com/bpmn/reference/) — boundary events (error/timer/escalation, interrupting vs non-interrupting), multi-instance.
