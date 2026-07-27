/**
 * SAID WORDS — the mechanical check behind "you said", and the word-level marking
 * that makes it usable.
 *
 * THE INVARIANT: **no span of text is displayed as the customer's own words unless
 * those words appear in what the customer actually typed.** When anything is in
 * doubt it fails toward the WEAKER claim. A false amber is safe; a false "you said"
 * is the bug.
 *
 * Why this exists. `plan-provenance.js` (2026-07-26) closed the SET of labels the
 * plan may carry, so an unrecognised value falls to the weaker mark. That works, and
 * it is why the `#ops` case stopped recurring — but it validates the label's
 * VOCABULARY, not its TRUTH. A perfectly well-formed `confidence:"stated"` attached
 * to content nobody said passes by construction, and the model is then the laundering
 * hop: a check scoped to *who produced the value* rather than *what the value can be*
 * is the exact shape CLAUDE.md warns about, four defects deep. QA saw all three of:
 *
 *   · "Runs every morning at 8:00 AM local time" — YOU SAID. The tester said "every
 *     morning" and never named a time; 8:00 AM was Atlas's own suggestion.
 *   · "non-urgent emails … the workflow ends silently" — YOU SAID. Never mentioned.
 *   · a trigger's "unread" and "Gmail" specifics — YOU SAID. Neither was typed.
 *
 * ONE MECHANISM, TWO JOBS. Matching the plan line's words against the customer's
 * actual typed words gives BOTH answers at once: which spans are theirs (the
 * highlighting), and whether the line's badge is supportable at all (the demotion).
 * They ship together on purpose — a per-line check alone demotes a whole mixed line
 * the moment one word is unmatched, which would turn most of the card amber and teach
 * people to ignore it. Word-level marking is what makes the strict check readable.
 *
 * WHAT COUNTS AS THE CUSTOMER'S WORDS — the corpus, and why it is an ALLOWLIST.
 * The corpus is built ONLY from text a human's own keystrokes produced. It is passed
 * in; this module never goes looking for it. In particular the converger's
 * `clarifications[]` is NOT a corpus and is never read: the graph pushes entries whose
 * `a` is its OWN output (`q:'(setup: …)'` with a JSON-stringified result,
 * `q:'(still missing)'`, and the whole `gaps` node's model-suggested answers at
 * `elicitation-graph.js`), so proving a claim against it would be Atlas proving a
 * claim against itself — the same laundering hop one level down. Anything not
 * positively known to be typed by a person is simply absent, and absence demotes.
 *
 * FAIL-CLOSED CASES, all of which land on the weaker claim:
 *   · an empty corpus certifies NOTHING (not "everything passes");
 *   · a line with no content words of its own certifies nothing — "all matched" over
 *     zero words is the certifying-the-absence-of-evidence trap;
 *   · stopwords never certify. "the", "and", "to" appearing in the corpus must not
 *     make a span the customer's — that is the vacuous match;
 *   · this check only ever DEMOTES. A line the plan marked `inferred` is never
 *     promoted to `stated`, however well it matches.
 *
 * PURE, AND SEPARATE FROM THE RENDERER, on purpose (CLAUDE.md, 2026-07-26): a
 * derivation inside a render closure is unreachable from outside the render pass, and
 * that is precisely how the destination fix reverted in silence. The browser renders
 * the spans this module computed server-side and, if they are absent, marks nothing.
 */

/**
 * Words that may never, on their own, certify a span as the customer's.
 *
 * Deliberately short and structural — articles, pronouns, prepositions, auxiliaries,
 * conjunctions. It is NOT a list of "unimportant words": "email", "urgent", "morning"
 * and "Slack" all carry meaning a person can check and are all content words here.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours',
  'it', 'its', 'they', 'them', 'their', 'theirs', 'he', 'she', 'him', 'her', 'his',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'having',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'and', 'or', 'but', 'nor', 'so', 'if', 'then', 'than', 'as', 'because',
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto',
  'up', 'out', 'off', 'over', 'under', 'about', 'between',
  'not', 'no', 'yes', 'also', 'just', 'too', 'very',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how',
  'there', 'here', 'each', 'any', 'some', 'all', 'both',
]);

/** A word token: letters/digits, plus the punctuation that lives INSIDE real words. */
const WORD_RE = /[#@]?[A-Za-z0-9][A-Za-z0-9'’._:@/+-]*/g;

/**
 * Fold one raw token to the form both sides are compared in.
 *
 * Lowercase, drop the punctuation that only ever decorates an edge (a trailing full
 * stop, a wrapping quote), and keep what is load-bearing INSIDE a token — `#ops`,
 * `8:00`, `charles@agntic.co` are single words a person typed, not three.
 *
 * @param {string} raw
 * @returns {string} '' when nothing usable survives
 */
export function normalizeToken(raw) {
  let t = String(raw ?? '').toLowerCase().replace(/[’]/g, "'");
  // Strip decoration from the EDGES only.
  t = t.replace(/^[^a-z0-9#@]+/, '').replace(/[^a-z0-9]+$/, '');
  // A possessive is the same word: "manager's" ≡ "manager".
  t = t.replace(/'s$/, '');
  return t;
}

/**
 * The one bit of morphology allowed: a plain plural.
 *
 * Kept this narrow deliberately. Every stemming rule ADDS matches, and every added
 * match is a STRONGER claim about a person — the direction this module must not lean
 * in. But refusing "emails" against a customer who typed "email" would demote almost
 * every honest line, and a screen that always warns is a screen nobody reads. So:
 * plurals fold, nothing else does. No -ing, no -ed, no prefix stripping.
 *
 * @param {string} t an already-normalized token
 * @returns {string|null} the singular form, or null when the rule does not apply
 */
function depluralize(t) {
  const out = [];
  if (t.length > 4 && t.endsWith('ies')) out.push(`${t.slice(0, -3)}y`);
  // Both readings of an -es ending, because English has both: "boxes" → "box" and
  // "invoices" → "invoice". Trying only one silently refuses half the honest lines.
  if (t.length > 4 && t.endsWith('es') && !t.endsWith('ses')) out.push(t.slice(0, -2));
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) out.push(t.slice(0, -1));
  return out;
}

/**
 * Every form one token may be indexed or looked up under. BOTH sides are expanded, so
 * a customer who typed "invoice" is matched by a plan that says "invoices" and the
 * other way round, without either side needing to guess which way the fold goes.
 */
function formsOf(t) {
  return [t, ...depluralize(t)];
}

/**
 * Build the lookup of what the customer actually typed.
 *
 * @param {string[]} typedTurns raw text of turns a HUMAN typed — nothing else
 * @returns {Set<string>} normalized content words; empty when nothing was typed
 */
export function buildSaidCorpus(typedTurns) {
  const corpus = new Set();
  for (const turn of Array.isArray(typedTurns) ? typedTurns : []) {
    if (typeof turn !== 'string') continue;
    for (const raw of turn.match(WORD_RE) ?? []) {
      const t = normalizeToken(raw);
      if (!t) continue;
      // A stopword IS indexed — it costs nothing and keeps the two sides symmetrical.
      // It still cannot certify anything: the plan side never asks about one, because
      // a stopword there is glue (see `isContent`).
      for (const f of formsOf(t)) corpus.add(f);
    }
  }
  return corpus;
}

/** Does this exact token appear in what the customer typed? Membership only. */
function inCorpus(token, corpus) {
  const t = normalizeToken(token);
  if (!t) return false;
  return formsOf(t).some(f => corpus.has(f));
}

/**
 * THE VACUOUS-MATCH RULE, AND IT LIVES IN EXACTLY ONE PLACE.
 *
 * A stopword may never certify anything. Every corpus in the world contains "the",
 * "and", "to", so a span certified by one is certified by nothing — the vacuous match
 * this codebase has hit before in other forms. Only a CONTENT word can be counted, and
 * only a content word can start or end a highlighted phrase; a stopword takes the
 * colour of the content words on either side of it (see `markSaidSpans`).
 *
 * It was briefly written twice — here, and again as an early return in the corpus
 * lookup — and the second copy was DEAD: a stopword's span is decided by its
 * neighbours, so deleting that guard changed no output at all and no test noticed.
 * A rule in two functions is the shape that has cost this repo twice already
 * (the decision-table grammar). One place, and this is it.
 */
function isContent(token) {
  const t = normalizeToken(token);
  return !!t && !STOPWORDS.has(t);
}

/**
 * Split one plan line into coloured spans and say whether the WHOLE line is the
 * customer's words.
 *
 * A span is `{ text, said }`. Runs of the same kind are merged so the reader sees
 * phrases, not flickering words; the gap between two said words is itself said, so
 * "every morning" highlights as one phrase rather than two.
 *
 * @param {string} text
 * @param {Set<string>} corpus
 * @returns {{ spans: {text:string,said:boolean}[], contentWords:number, saidWords:number, allSaid:boolean }}
 */
export function markSaidSpans(text, corpus) {
  const src = typeof text === 'string' ? text : '';
  const use = corpus instanceof Set ? corpus : new Set();

  // Tokenize into (word | gap) pieces, preserving every character so the rendered
  // spans concatenate back to the original line exactly.
  //
  // Decoration on a token's EDGES is split off as its own piece — `#ops.` is the word
  // `#ops` followed by a full stop. The customer typed the channel, not the sentence's
  // punctuation, and a highlight that runs one character past the last proven word is
  // a claim about a character they did not type. Small, but this is the one module
  // where "close enough" is the bug.
  const pieces = [];
  let last = 0;
  WORD_RE.lastIndex = 0;
  for (let m = WORD_RE.exec(src); m; m = WORD_RE.exec(src)) {
    if (m.index > last) pieces.push({ text: src.slice(last, m.index), word: false });
    const tok  = m[0];
    const lead = (/^[^A-Za-z0-9#@]+/.exec(tok) ?? [''])[0];
    const core = tok.slice(lead.length).replace(/[^A-Za-z0-9]+$/, '');
    const tail = tok.slice(lead.length + core.length);
    if (lead) pieces.push({ text: lead, word: false });
    if (core) pieces.push({ text: core, word: true });
    else if (!lead && !tail) pieces.push({ text: tok, word: false });
    if (tail) pieces.push({ text: tail, word: false });
    last = m.index + tok.length;
  }
  if (last < src.length) pieces.push({ text: src.slice(last), word: false });

  let contentWords = 0, saidWords = 0;
  for (const p of pieces) {
    if (!p.word) { p.said = false; p.glue = true; continue; }
    // A stopword is GLUE: it is never counted, so it can never be the reason a line
    // keeps its claim, and whether it is painted is decided below by the content words
    // on either side of it. Only a content word's own corpus membership matters.
    p.glue = !isContent(p.text);
    p.said = !p.glue && inCorpus(p.text, use);
    if (!p.glue) {
      contentWords += 1;
      if (p.said) saidWords += 1;
    }
  }

  // GLUE TAKES THE COLOUR OF WHAT IT JOINS. A stopword or a space sitting BETWEEN two
  // of the customer's words belongs to their phrase — "Summarize the shipping emails"
  // must read as one quoted sentence, not three highlights with holes punched in it.
  // Glue on the OUTSIDE edge of a run takes no colour: extending a highlight past the
  // last proven word would overstate the claim, and this module leans the other way on
  // principle. Resolved outward-in so a run of glue between two said words is filled.
  for (let i = 0; i < pieces.length; i++) {
    if (!pieces[i].glue) continue;
    let a = i - 1; while (a >= 0 && pieces[a].glue) a--;
    let b = i + 1; while (b < pieces.length && pieces[b].glue) b++;
    pieces[i].said = !!(a >= 0 && pieces[a].said && b < pieces.length && pieces[b].said);
  }

  // Merge adjacent runs of the same kind.
  const spans = [];
  for (const p of pieces) {
    const tail = spans[spans.length - 1];
    if (tail && tail.said === p.said) tail.text += p.text;
    else spans.push({ text: p.text, said: p.said });
  }

  return {
    spans,
    contentWords,
    saidWords,
    // FAIL CLOSED. A line with no content words of its own has proved nothing —
    // "every word matched" over zero words is certifying an empty set, which is the
    // trap this codebase has paid for more than once.
    allSaid: contentWords > 0 && saidWords === contentWords,
  };
}

/**
 * Attach spans to one plan item and demote a `stated` claim the words do not support.
 *
 * DEMOTION ONLY, and only of the claim about the USER:
 *   · `stated` survives only when EVERY content word on the line was typed by the
 *     customer. One invented word ("at 8:00 AM") and the badge falls to `inferred`,
 *     while the words they DID type stay highlighted as theirs.
 *   · `found` is a claim about a live TOOL, not about the person, and this check has
 *     no evidence about tools — so it is left exactly as it is.
 *   · `inferred` is already the weakest mark and is never raised.
 *
 * @param {object} item a plan item carrying `text` (or `when`/`then`) and `confidence`
 * @param {Set<string>} corpus
 * @returns {object} a copy with `spans` (and, for a branch, `whenSpans`/`thenSpans`)
 */
function markItem(item, corpus) {
  if (!item || typeof item !== 'object') return item;
  const out = { ...item };

  // A branch is two independent pieces of prose; both are marked, and BOTH must be
  // fully the customer's for the line to keep a claim about them.
  const fields = [];
  if (typeof item.text === 'string') fields.push(['text', 'spans']);
  if (typeof item.when === 'string') fields.push(['when', 'whenSpans']);
  if (typeof item.then === 'string') fields.push(['then', 'thenSpans']);

  let anyContent = false, allSaid = true;
  for (const [src, dest] of fields) {
    const r = markSaidSpans(item[src], corpus);
    out[dest] = r.spans;
    if (r.contentWords > 0) anyContent = true;
    if (!r.allSaid) allSaid = false;
  }

  if (out.confidence === 'stated' && !(anyContent && allSaid)) out.confidence = 'inferred';
  return out;
}

/**
 * THE CORPUS, DECIDED IN ONE PLACE: what, out of a whole converger state, counts as
 * the customer's own words.
 *
 * This function exists so the decision is NAMED and can be exercised. Written inline
 * at the call site it would have been one expression nothing could reach, and a
 * later hand adding `state.clarifications` to it — which looks entirely reasonable,
 * because that array is called "clarifications" and is full of answers — would pass
 * every test in the tree. It is exactly the mutation this module is here to stop.
 *
 * IN: `humanTurns` — seeded from the chat turns the customer typed into the composer,
 * appended to only where a person composed free prose (the typed plan change).
 *
 * OUT, and deliberately: **`clarifications` is never read.** It looks like a corpus of
 * user answers and is partly written by the graph itself —
 *   · the `gaps` node pushes the MODEL's own suggested answers,
 *     `{ q: g.message, a: String(suggestionFor(g.id)) }`;
 *   · `resourceSetup` pushes `{ q: '(setup: <capability>)', a: JSON.stringify(result) }`;
 *   · the sufficiency route pushes `{ q: '(still missing)', a: <Atlas's own note> }`.
 * Certifying a plan line against those would be Atlas proving its own words are the
 * customer's — the laundering hop, one level down from the one this file closes.
 * A clarification ANSWER is not admitted either, even when a person did send it: the
 * zero-typing path means Enter accepts Atlas's own pre-selected default, so "the user
 * submitted it" is not "the user typed it".
 *
 * An ALLOWLIST, not a filter. Nothing is admitted by failing to look machine-written;
 * a field is admitted because it is known to hold keystrokes. Anything new in the state
 * is absent until someone deliberately adds it here, and absence demotes.
 *
 * @param {{ humanTurns?: string[] }} state the converger state at the plan node
 * @returns {string[]}
 */
export function saidCorpusFrom(state) {
  return Array.isArray(state?.humanTurns) ? state.humanTurns : [];
}

/**
 * Mark a whole plan against what the customer actually typed.
 *
 * Applied SERVER-SIDE, in the `plan` node, so a client that never ran this — an old
 * cached slice, a renderer written later — cannot be handed a strong claim nobody
 * checked. The browser's second line is simpler and equally fail-closed: a plan that
 * arrives with no spans marks nothing as the customer's.
 *
 * @template T
 * @param {T} plan
 * @param {string[]} typedTurns text a HUMAN typed — see the corpus note in the header
 * @returns {T} the same shape, with spans attached and unsupported claims demoted
 */
export function markPlanSaidWords(plan, typedTurns) {
  if (!plan || typeof plan !== 'object') return plan;
  const corpus = buildSaidCorpus(typedTurns);
  const out = { ...plan };
  if (Array.isArray(plan.steps))    out.steps    = plan.steps.map(s => markItem(s, corpus));
  if (Array.isArray(plan.branches)) out.branches = plan.branches.map(b => markItem(b, corpus));
  if (plan.trigger        && typeof plan.trigger === 'object')        out.trigger        = markItem(plan.trigger, corpus);
  if (plan.error_handling && typeof plan.error_handling === 'object') out.error_handling = markItem(plan.error_handling, corpus);
  // The card states plainly that this ran, so "nothing is marked as yours" reads as a
  // finding rather than as a feature that quietly failed to load.
  out.saidWordsChecked = true;
  return out;
}
