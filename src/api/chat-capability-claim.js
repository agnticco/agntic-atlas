/**
 * ATLAS MAY NOT AFFIRM A CAPABILITY IT DOES NOT HAVE.
 *
 * ── The defect ───────────────────────────────────────────────────────────────
 *
 * Twice in one QA campaign, asked for something the product cannot do, Atlas did
 * not check and did not refuse. It agreed, then explained the mechanism in
 * confident detail:
 *
 *   "Perfect — I can pull from your Knowledge docs in the workflow."
 *       …the workspace had NO documents. Verified in the browser and on the box.
 *
 *   "your form POSTs to a webhook URL that Atlas generates when the workflow is
 *    built. That URL becomes the trigger…"
 *       …no part of that exists. There is no webhook trigger and no URL generation.
 *
 * ENGINEERING-LOG.md calls this "the most demo-dangerous behaviour found", and the reason
 * is structural: it happens on the FIRST turn, in the most confident register,
 * before the plan, the promise, the self-check or the publish guard can act. Every
 * one of those mechanisms is downstream of a claim that has already been made.
 * The product's whole thesis is that it does not lie about what it DID; this is
 * lying about what it CAN DO, and no existing guard covers it.
 *
 * ── Why a prompt rule is not the fix ────────────────────────────────────────
 *
 * Both cases already had prompt coverage. The Knowledge one had a block saying
 * "if asked, say none are set up" — and the user had not ASKED, they had described
 * a workflow. The webhook one was removed from the trigger list entirely and the
 * model can still describe it, because it is a plausible thing for a product like
 * this to do. A prompt is a belief about model behaviour and is pinned by nothing;
 * this is the mechanism that makes being wrong about it harmless.
 *
 * ── Precision over recall, deliberately ─────────────────────────────────────
 *
 * This CANNOT be "detect any false claim" — that is unbounded, and a guard that
 * fires on a correct answer is worse than none (this codebase has been caught by
 * that twice in one week). So it checks a CLOSED list of things the product
 * demonstrably cannot do, each with its own ground truth:
 *
 *   · a webhook / callback URL that Atlas generates → `RUNNABLE_TRIGGER_TYPES`
 *     has no webhook, and nothing in the codebase mints one.
 *   · using the customer's Knowledge documents → the tenant's own document count.
 *
 * Anything outside that list is left alone. A missed invention is quiet; a false
 * accusation over a correct answer teaches people to ignore the product.
 *
 * ── It WITHDRAWS, never appends ─────────────────────────────────────────────
 *
 * The connector-gap fix learned this the hard way and it is recorded: appending a
 * correction leaves the model's confident design ON SCREEN ABOVE it, and the
 * reader believes the confident part. So an affirmed claim replaces the reply.
 */

import { RUNNABLE_TRIGGER_TYPES } from '../workflows/trigger-runnable.js';

/**
 * Does this reply AFFIRM the thing, rather than merely mention or refuse it?
 *
 * The distinction is the whole guard. "Atlas can't generate a webhook URL" and
 * "your form POSTs to a webhook URL Atlas generates" both contain the words; only
 * one is a claim. Refusals are the sentence we WANT, so mistaking one for a
 * violation would punish the correct behaviour.
 */
function affirms(reply, subject) {
  const s = String(reply ?? '');
  if (!subject.test(s)) return false;
  // A refusal anywhere in the sentence carrying the subject clears it. Sentence
  // scope, not whole-reply, so a refusal about one thing cannot excuse a claim
  // about another later in the same message.
  const sentences = s.split(/(?<=[.!?])\s+/);
  const carrying = sentences.filter((x) => subject.test(x));
  if (!carrying.length) return false;
  const REFUSAL = /\b(can'?t|cannot|can not|don'?t|do not|doesn'?t|does not|no way to|not able|unable|isn'?t|is not|aren'?t|are not|not supported|not something|no such|instead)\b/i;
  return carrying.some((x) => !REFUSAL.test(x));
}

/** Atlas mints no URLs. Derived from the runnable set, not asserted beside it. */
const HAS_WEBHOOK_TRIGGER = RUNNABLE_TRIGGER_TYPES.includes('webhook');

/**
 * A URL the CUSTOMER points something at, that Atlas is said to provide. Narrow
 * on purpose: "post it to a webhook" is a real delivery channel and must not
 * match — what does not exist is Atlas HANDING OUT an address.
 */
const WEBHOOK_CLAIM = new RegExp([
  // (a) an address Atlas is said to hand out — the 2026-07-30 wording
  String.raw`\b(webhook|callback|endpoint)\b[^.!?]{0,80}\b(url|address|link)\b`,
  String.raw`\b(url|address|endpoint)\b[^.!?]{0,60}\b(atlas|we|i)\b[^.!?]{0,30}\b(generate|create|provide|give|mint|issue)\b`,
  // (b) A WEBHOOK AS A WAY TO START A WORKFLOW, in any wording.
  //
  // WITNESSED 2026-08-03, in a browser, MINUTES AFTER SHIPPING THIS GUARD:
  //   "Great use case — a webhook trigger is exactly the right fit for this."
  // Clause (a) alone missed it, because it demanded the word "URL" near
  // "webhook" — it was tuned to the exact sentence recorded on 2026-07-30.
  //
  // That is this codebase's oldest recorded mistake — a rule scoped to the FORM
  // the words took rather than what they MEAN — made inside the guard written to
  // stop it. The thing that does not exist is a webhook STARTING a workflow, so
  // that is what is matched, however it is phrased.
  String.raw`\b(webhook|callback)\b[^.!?]{0,40}\b(trigger|triggers|start|starts|starting|fire|fires|kick off|kicks off)\b`,
  String.raw`\b(trigger|triggered|start|started|fire|fired)\b[^.!?]{0,40}\bby a? ?(webhook|callback)\b`,
].join('|'), 'i');

/** Using the customer's own uploaded documents. */
const KNOWLEDGE_CLAIM =
  /\b(your|the)\s+(knowledge|uploaded|company)\b[^.!?]{0,40}\b(doc|docs|document|documents|base|files)\b|\bknowledge base\b/i;

/**
 * @param {string} reply            what Atlas is about to say
 * @param {object} capabilities     the same object the interview is given
 * @returns {{ok:true} | {ok:false, code:string, reply:string}}
 */
/**
 * ── THE REQUEST IS THE RELIABLE SIGNAL, NOT THE REPLY ────────────────────────
 *
 * Matching the REPLY was whack-a-mole and lost twice in ten minutes, live:
 *
 *   v1.6.143 → "a webhook trigger is exactly the right fit for this."
 *   v1.6.144 → "a webhook intake that emails you each submission."
 *
 * Each time the pattern was widened to the sentence just seen, and the model
 * simply phrased it a third way. The space of ways to affirm something is
 * unbounded; the space of ways to ASK for it is not, because the customer names
 * the mechanism they have in mind. "Our form POSTs to Atlas", "a webhook",
 * "send an HTTP request to you" — that is the whole vocabulary, and it is theirs.
 *
 * So the trigger for this correction is the PERSON'S ask. Atlas cannot receive an
 * inbound HTTP request that starts a workflow, whoever describes it and however
 * the reply is worded. The reply patterns are KEPT as a second net for the case
 * where the model volunteers it unprompted.
 */
//
// DIRECTION IS THE DISCRIMINATOR. A bare `\bwebhook\b` also matched "post the
// result to our webhook when done" — a real DELIVERY capability, and refusing it
// would be the guard breaking something that works. What Atlas cannot do is
// RECEIVE. So every clause below requires the data to be coming IN.
const WEBHOOK_REQUEST = new RegExp([
  String.raw`\bwebhooks?\b[^.!?]{0,40}\b(trigger|triggers|start|starts|kick off|into atlas|to atlas)\b`,
  String.raw`\b(trigger|start|kick off|receive|accept|incoming|inbound)\b[^.!?]{0,40}\bwebhooks?\b`,
  String.raw`\bcallback url\b`,
  String.raw`\bpost(s|ing)? (to|into) (atlas|you|us)\b`,
  String.raw`\bhttp (request|post)\b[^.!?]{0,40}\b(atlas|you|us)\b`,
  String.raw`\b(form|site|website|app|system)\b[^.!?]{0,50}\b(posts?|sends?) (to|into) (atlas|you|us)\b`,
].join('|'), 'i');

/**
 * @param {string} reply            what Atlas is about to say
 * @param {object} capabilities     the same object the interview is given
 * @param {string} [ask]            what the PERSON said this turn
 * @returns {{ok:true} | {ok:false, code:string, reply:string}}
 */
export function capabilityClaimDecision(reply, capabilities = {}, ask = '') {
  const text = String(reply ?? '');
  if (!text.trim()) return { ok: true };

  // The person asked for an inbound HTTP trigger. Correct it however Atlas
  // replied — UNLESS Atlas already refused, which is the answer we want and must
  // never be overwritten with another refusal.
  const askedForWebhook = !HAS_WEBHOOK_TRIGGER && WEBHOOK_REQUEST.test(String(ask ?? ''));
  const alreadyRefused = /\b(can'?t|cannot|don'?t|do not|no way to|not able|unable|not supported|no such)\b/i.test(text);

  if (askedForWebhook && !alreadyRefused) {
    return {
      ok: false,
      code: 'NO_WEBHOOK_TRIGGER',
      reply:
        "Before we go further — I can't do that part, and I'd rather say so now than after you've built something.\n\n" +
        "Atlas doesn't give out a web address for another system to send data to. A workflow starts one of three ways: on a schedule, when an email arrives, or when something happens in a connected app like Slack or Airtable.\n\n" +
        "Most contact forms can email you on submission — if yours does, point it at your connected inbox and I'll build the whole thing from there. Where does an enquiry end up today?",
    };
  }

  if (!HAS_WEBHOOK_TRIGGER && affirms(text, WEBHOOK_CLAIM)) {
    return {
      ok: false,
      code: 'NO_WEBHOOK_TRIGGER',
      reply:
        "I got ahead of myself there — I can't do that part, and I'd rather say so now than after you've built something.\n\n" +
        "Atlas doesn't give out a web address for another system to send data to. A workflow starts one of three ways: on a schedule, when an email arrives, or when something happens in a connected app like Slack or Airtable.\n\n" +
        "If the data you want to act on lands somewhere Atlas can already see — an inbox, a spreadsheet, a table — I can build the whole thing around that. Tell me where it ends up and we'll start there.",
    };
  }

  // Only when we KNOW the count. Silence is not evidence of an empty shelf, and
  // refusing on a number we do not have would be the mirror of the defect.
  const known = capabilities?.knowledge && typeof capabilities.knowledge.documentCount === 'number';
  if (known && capabilities.knowledge.documentCount === 0 && affirms(text, KNOWLEDGE_CLAIM)) {
    return {
      ok: false,
      code: 'NO_KNOWLEDGE_DOCUMENTS',
      reply:
        "One correction before we go further: there are no documents in this workspace's Knowledge yet, so I can't ground anything in them.\n\n" +
        "If you've uploaded files somewhere else, they haven't reached Atlas — Knowledge is in the left sidebar and that's where they'd need to be.\n\n" +
        "I can still build this using what's in the messages themselves, and you can add documents later to sharpen it. Want me to carry on that way?",
    };
  }

  return { ok: true };
}
