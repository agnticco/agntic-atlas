/**
 * Chat artifact guard — the deterministic backstop that stops Atlas offering to
 * produce something the workflow it is about to build will not produce.
 *
 * WHY THIS EXISTS
 * ---------------
 * Operator, 2026-07-28, on seeing it happen: **"This can never happen, especially
 * if a google doc is a piece of the contract."**
 *
 * Witnessed on a two-source briefing build. Nobody asked for a Google Doc. Atlas
 * introduced one, unprompted, in the reply the user reads:
 *
 *   "…(3) summarise both into a single Google Doc with a section for each, and
 *    (4) post the doc (or its content) to #atlas-test-temp."
 *
 * The plan then said "Combine both results into a single briefing document", the
 * build produced an AI compose step and a Slack post, and no document was ever
 * created anywhere. Two Atlas screens describing the same workflow differently,
 * with the more concrete promise being the false one — and the hedge, "(or its
 * content)", is the tell that the sentence was never grounded in anything.
 *
 * Nothing the user asked for was lost, which is exactly why this is dangerous: it
 * fails the "looks like success" test. Someone who reads the offer and approves it
 * believes a document exists somewhere. It does not.
 *
 * THE RULE IS IN THE PROMPT; THIS IS THE BACKSTOP.
 * Same doctrine as `chat-navigation-guard.js`: a prompt rule is a belief about how
 * a model will behave and is pinned by nothing. This module is the part that can
 * be proved.
 *
 * DELIBERATELY CONSERVATIVE
 * -------------------------
 * A build offer is the most important sentence in the product, so a false positive
 * here is worse than a miss. An artifact promise is only flagged when ALL of:
 *
 *   1. the reply names a CREATED ARTIFACT ("a Google Doc", "a spreadsheet", "a
 *      PDF") — not merely a service, and not a thing being READ;
 *   2. the reply is CREATING it — "create/make/produce/save/write/compile into…";
 *   3. `build_intent` — the paragraph the workflow is actually built from — does
 *      not mention that artifact at all.
 *
 * (3) is what makes it safe. When the build really will produce the document, the
 * intent says so and the offer stands untouched. It is only the sentence that
 * promises something the build has no instruction to make that is caught.
 *
 * @module src/api/chat-artifact-guard.js
 */

/**
 * Artifacts a workflow can actually be built to CREATE, and the words a person
 * would recognise them by. Keyed to the noun, because the noun is what the reader
 * believes they are getting.
 */
const ARTIFACTS = [
  { id: 'google_doc',   words: ['google doc', 'google document', 'gdoc'] },
  { id: 'google_sheet', words: ['google sheet', 'google spreadsheet', 'gsheet'] },
  { id: 'spreadsheet',  words: ['spreadsheet'] },
  { id: 'pdf',          words: ['pdf'] },
  { id: 'slide_deck',   words: ['slide deck', 'google slides', 'presentation'] },
  { id: 'calendar',     words: ['calendar event', 'calendar invite'] },
];

/** Verbs that mean "this workflow will bring the thing into existence". */
const CREATE_VERBS =
  /\b(creat\w*|mak\w*|produc\w*|generat\w*|writ\w*|sav\w*|compil\w*|assembl\w*|build\w*|put\w*\s+(?:it|them|both)\s+(?:in|into)|combin\w*\s+\w*\s*(?:in|into)|summaris\w*\s+\w*\s*(?:in|into)|summariz\w*\s+\w*\s*(?:in|into))\b/i;

const norm = (s) => String(s ?? '').toLowerCase();

/**
 * Which artifacts does this reply promise that the build has no instruction to
 * make?
 *
 * @param {string} reply        the prose the user reads
 * @param {string} buildIntent  the paragraph the workflow is built from
 * @returns {{id: string, word: string}[]} empty when the offer is grounded
 */
export function unbackedArtifacts(reply, buildIntent) {
  const text = norm(reply);
  if (!text.trim()) return [];
  const intent = norm(buildIntent);
  const out = [];
  for (const art of ARTIFACTS) {
    for (const word of art.words) {
      if (!text.includes(word)) continue;
      // Named in the intent ⇒ the build really is meant to produce it. Stand down.
      if (art.words.some(w => intent.includes(w))) break;
      // Is this sentence CREATING it, or merely mentioning/reading it? Look at the
      // clause the noun sits in, not the whole message — a reply can legitimately
      // say "I can't make a PDF" in one breath and create a doc in another.
      const at = text.indexOf(word);
      const clause = text.slice(Math.max(0, at - 120), at + word.length);
      if (!CREATE_VERBS.test(clause)) break;
      out.push({ id: art.id, word });
      break;
    }
  }
  return out;
}

/**
 * WHY THIS DETECTS AND RE-ASKS RATHER THAN EDITING THE PROSE.
 *
 * The first cut of this module scrubbed the offending sentence, mirroring
 * `chat-navigation-guard.js`. It does not transfer, and the witnessed case is
 * exactly why: that guard rewrites a navigation directive, which is a
 * self-contained sentence. The artifact promise arrived as one clause of a single
 * numbered sentence —
 *
 *   "…(3) summarise both into a single Google Doc with a section for each, and
 *    (4) post the doc (or its content) to #atlas-test-temp."
 *
 * Cutting the sentence deletes the whole offer; cutting clause (3) leaves clause
 * (4) saying "post **the doc**", a reference to something no longer mentioned.
 * Either way the reader gets prose that reads as a bug — and a mangled offer is
 * not an improvement on a wrong one.
 *
 * So the enforcement is: catch it, tell the model precisely what was wrong, and
 * let it write the offer again. The correction below is handed back verbatim.
 */
export function artifactCorrectionFor(found) {
  if (!found?.length) return null;
  const names = [...new Set(found.map(f => f.word))].join(' and ');
  return `Your reply offers to create a ${names}, but the workflow you described in `
    + `build_intent does not create one. Rewrite the reply to describe ONLY what the `
    + `workflow will actually do. Either add the ${names} to build_intent because the `
    + `workflow genuinely should produce one, or stop mentioning it. Never offer the `
    + `user an output the build has no instruction to make.`;
}
