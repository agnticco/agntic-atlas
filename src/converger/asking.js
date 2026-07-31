/**
 * ASKING A PERSON IS A TOOL, WITH RULES — NOT A FREE-TEXT STRING ANYONE CAN EMIT.
 *
 * Charles, 2026-07-30: *"The agent/converger/system should see the conversation as a
 * tool to fill gaps the user could fill with information."* This is the first increment
 * of that: before a question reaches a person it must pass the same kind of check any
 * other capability's output does.
 *
 * WHY, FROM THE DAY'S EVIDENCE. Every bad question observed had the same shape — Atlas
 * asking for something it could have found out, or something no person should be asked:
 *
 *   · **The spreadsheet-ID errand.** *"What is the spreadsheet ID for 'Pricing
 *     Enquiries'? You can find it in the URL of the sheet, between /d/ and /edit."* —
 *     after having offered "ID **or name**" and been given a name. A customer sent to
 *     dig an identifier out of a URL is the developer-settings errand P13 exists to
 *     forbid, wearing a chat bubble.
 *   · **The Slack identity question on an email workflow.** Asked because the prompt
 *     said to, about a workflow with no Slack in it — a question the person could not
 *     make sense of.
 *   · **The knowledge base that was never checked.** The opposite failure: it did NOT
 *     ask, and asserted instead.
 *
 * Slack and Airtable destination questions have always been good, and the reason is
 * instructive: they arrive carrying `options` the connector was actually queried for, so
 * the person picks from real things. Sheets had no discovery wired, so the same code
 * path produced an errand. **The difference was not the question — it was whether
 * anything had been looked up first.**
 *
 * THE FOUR RULES, in the order they are applied. Each refuses a question rather than
 * rewording it, because a question that should not be asked cannot be fixed by phrasing.
 *
 * WHAT THIS DELIBERATELY IS NOT: a way to ask MORE. The product's promise is that a
 * person can publish having answered nothing, so `MAX_QUESTIONS_PER_BUILD` is a ceiling
 * and `refuse` is the common outcome. A tool that made asking cheap would be a
 * regression dressed as a feature.
 */

/**
 * How many questions one build may put to a person, in total.
 *
 * Not a guess: the builds driven on 2026-07-30 that a person was happy with asked ONE or
 * TWO ("which sheet?", "what should it log?"). The build that asked three had begun to
 * feel like a form. Above that the interview stops being a conversation.
 */
export const MAX_QUESTIONS_PER_BUILD = 3;

/**
 * Does this look like a machine identifier rather than something a person knows?
 *
 * Deliberately narrow — it must catch the identifiers the connectors actually use and
 * nothing a person would reasonably be asked for. A false positive here silences a
 * legitimate question, which is worse than the errand it prevents.
 */
export function looksLikeAnIdentifier(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return false;
  return /\b(spreadsheet|base|table|channel|calendar|document|folder|file|workspace|record)\s*id\b/.test(t)
      || /\bid\b[^.?!]{0,40}\bfrom the url\b/.test(t)
      || /\bbetween \/d\/ and \/edit\b/.test(t)
      || /\bapp[a-z0-9]{14}\b/.test(t)      // an Airtable base id, quoted as an example
      || /\btbl[a-z0-9]{14}\b/.test(t);     // …or a table id
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Should this question be put to a person?
 *
 * @param {object} question
 *   @param {string}  question.text        what the person would be asked
 *   @param {string}  [question.about]     what it concerns, for de-duplication
 *   @param {Array}   [question.options]   real choices discovery found
 *   @param {boolean} [question.discoveryAttempted]  was a lookup even tried?
 *   @param {boolean} [question.discoverable]        could a capability have answered it?
 * @param {object} state
 *   @param {string[]} [state.alreadyAsked]  `about` values already put to this person
 *   @param {number}   [state.askedCount]    how many questions this build has asked
 * @returns {{ask: boolean, reason: string, code: string}}
 */
export function shouldAsk(question, state = {}) {
  const text = String(question?.text ?? '').trim();
  const about = norm(question?.about ?? text);
  const asked = (state.alreadyAsked ?? []).map(norm);
  const count = Number(state.askedCount ?? 0);

  if (!text) {
    return { ask: false, code: 'EMPTY', reason: 'there is no question to ask' };
  }

  // ── 1. NEVER ASK A PERSON FOR A MACHINE IDENTIFIER ────────────────────────
  // The one rule with no exception. P13's constraint is that a customer is never sent
  // into a developer settings screen; a chat bubble asking them to dig an id out of a
  // URL is the same errand with a friendlier font.
  if (looksLikeAnIdentifier(text)) {
    return { ask: false, code: 'IDENTIFIER',
      reason: 'this asks a person for a machine identifier — look it up, or offer the names they would recognise' };
  }

  // ── 2. NEVER ASK WHAT WAS NEVER LOOKED UP ─────────────────────────────────
  // The difference between the Slack question (good) and the Sheets question (an
  // errand) was not the wording — it was that one had queried the connector first.
  if (question?.discoverable === true && question?.discoveryAttempted !== true) {
    return { ask: false, code: 'UNDISCOVERED',
      reason: 'something connected could answer this — try that before asking a person' };
  }

  // ── 3. NEVER ASK THE SAME THING TWICE ─────────────────────────────────────
  // Being asked once and ignored is the defect recorded for the destination answer;
  // being asked twice is the one QA reported before it.
  if (asked.includes(about)) {
    return { ask: false, code: 'ALREADY_ASKED',
      reason: 'this has already been put to them once — use their answer' };
  }

  // ── 4. THE BUDGET ─────────────────────────────────────────────────────────
  // Last, so a question that is refused for a better reason is refused for THAT reason.
  // The promise is that a person can publish having answered nothing.
  if (count >= MAX_QUESTIONS_PER_BUILD) {
    return { ask: false, code: 'BUDGET',
      reason: `this build has already asked ${count} questions — decide the rest and let them correct it` };
  }

  return { ask: true, code: 'ASK', reason: 'it needs a person, and nothing else can answer it' };
}

/**
 * A question that offers real choices, when discovery found any.
 *
 * Returns the question unchanged when there is nothing to add. It never invents an
 * option and never reorders them — `options` are what a connector actually returned.
 */
export function withDiscoveredOptions(question) {
  const options = Array.isArray(question?.options) ? question.options.filter(Boolean) : [];
  if (!options.length) return question;
  const labels = options.map(o => (typeof o === 'string' ? o : o?.label ?? o?.value)).filter(Boolean);
  if (!labels.length) return question;
  return {
    ...question,
    discoveryAttempted: true,
    text: `${String(question.text ?? '').trim()} You have: ${labels.slice(0, 12).join(', ')}.`,
  };
}

/**
 * Every question this build wants to ask, filtered to the ones that should be.
 *
 * Returns BOTH halves. The refusals are not noise: "we did not ask because nothing had
 * been looked up" is exactly the finding that should reach a log, and silently dropping
 * them would hide the very behaviour this module exists to change.
 */
export function planQuestions(questions, state = {}) {
  const asked = [...(state.alreadyAsked ?? [])];
  let count = Number(state.askedCount ?? 0);
  const ask = [];
  const refused = [];

  for (const raw of (questions ?? [])) {
    const q = withDiscoveredOptions(raw);
    const verdict = shouldAsk(q, { alreadyAsked: asked, askedCount: count });
    if (verdict.ask) {
      ask.push(q);
      asked.push(q.about ?? q.text);
      count += 1;
    } else {
      refused.push({ question: q, ...verdict });
    }
  }
  return { ask, refused };
}
