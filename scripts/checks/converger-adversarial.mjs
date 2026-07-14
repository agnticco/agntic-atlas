#!/usr/bin/env node
/**
 * converger-adversarial — try to make the converger drop a promise.
 *
 * P12 Increment C. The defect this phase exists to kill (#1) is not a crash: it
 * is a workflow that quietly does LESS than it agreed to. The user asked for
 * Slack AND Gmail, confirmed both, and got Slack — no error, no warning, no
 * trace. The whole outcome-contract apparatus is built on one property:
 *
 *     AN ASSERTION IS NEVER SILENTLY DROPPED.
 *
 * Every assertion must end up in exactly one of three buckets — satisfied,
 * unsatisfied, or malformed — and the last two block publish. There is no fourth
 * bucket, and "we couldn't check it, so we let it through" is not an option: an
 * uncheckable promise reported as met is the same failure as a missing delivery,
 * just better hidden.
 *
 * This attacks that property from both ends:
 *   PART 1 (deterministic) — hostile SPECS through the oracle and the validator.
 *   PART 2 (live)          — hostile INTENTS through the real converger, because
 *                            a contract the model never emits cannot be dropped
 *                            by the checker; it was dropped upstream.
 *
 * Part 2 needs ANTHROPIC_API_KEY. It does NOT self-skip quietly — a skipped
 * check reporting PASS is exactly the trap that nearly closed P11 on a false
 * green (CLAUDE.md, P11 note). Without a key it fails closed and says why.
 *
 * Usage:  node scripts/checks/converger-adversarial.mjs
 * Output: CONVERGER-ADVERSARIAL-PASS, or a non-zero exit naming the leak.
 */

import { checkOutcome, satisfiesAssertion } from '../../src/workflows/outcome-oracle.js';
import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { scoreGap }                 from '../../src/converger/gap-scorer.js';

const validator = new WorkflowValidator({ nodeTypes: registerBuiltInNodeTypes(new NodeTypeRegistry()) });

let failures = 0;
const fail = (what, detail) => { failures++; console.error(`  ✗ ${what}\n      ${detail}`); };
const ok   = (what) => console.log(`  ok ${what}`);

const errorsOf = (def) => validator.validate(def).errors.map(e => e.code);
const spec = (nodes, outcome) => ({
  version: 2, name: 'Adversarial', outcome,
  triggers: [{ type: 'email' }], nodes, edges: [],
});

console.log('converger-adversarial — can a promise be made to disappear?\n');

// ─────────────────────────────────────────────────────────────────────────────
console.log('PART 1 — hostile SPECS: every assertion must land in a bucket.\n');

// 1. The original sin. Two destinations agreed; one built.
{
  const s = spec(
    [{ id: 'post', type: 'deliver', config: { channel: 'slack', target: '#sales' } }],
    { statement: 'Post to #sales and email the rep.', assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:#sales' },
      { id: 'a2', kind: 'message_sent', target: 'gmail:rep@acme.com' },
    ] },
  );
  errorsOf(s).includes('UNSATISFIED_ASSERTION')
    ? ok('defect #1: the dropped Gmail delivery blocks publish')
    : fail('defect #1 IS BACK: a promised delivery with no node PUBLISHED',
           `errors: ${errorsOf(s).join(', ') || '(none)'}`);
}

// 2. Hostile assertion SHAPES. Every one must be accounted for. A malformed
//    assertion that quietly vanishes is defect #1 wearing a disguise.
{
  const hostile = [
    { id: 'a1', kind: 'message_sent', target: 'slack:#ops' },  // satisfied
    { id: 'a2', kind: 'message_sent', target: 'gmail:x@y.com' }, // unsatisfied
    { id: 'a3', kind: 'vibes_improved', target: 'slack:#ops' }, // unknown kind
    { id: 'a4', kind: 'message_sent' },                          // no target
    { id: 'a5', target: 'slack:#ops' },                          // no kind
    { id: 'a6', kind: 'message_sent', target: '' },              // empty target
    { id: 'a7', kind: 'message_sent', target: ':::' },           // no connector
    null,                                                        // not an object
    'slack:#ops',                                                // a bare string
    { id: 'a8', kind: '__proto__', target: 'slack:#ops' },       // hostile key
    { id: 'a9', kind: 'MESSAGE_SENT', target: 'slack:#ops' },    // wrong case — NOT a kind
  ];
  const nodes = [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }];
  const { satisfied, unsatisfied, malformed } = checkOutcome({ assertions: hostile }, nodes);
  const accounted = satisfied.size + unsatisfied.length + malformed.length;

  accounted === hostile.length
    ? ok(`all ${hostile.length} hostile assertions accounted for (${satisfied.size} satisfied, ${unsatisfied.length} unsatisfied, ${malformed.length} malformed)`)
    : fail('AN ASSERTION WAS SILENTLY DROPPED',
           `${hostile.length} in, only ${accounted} accounted for — ${hostile.length - accounted} vanished`);

  // And a malformed one must BLOCK, not merely be noted.
  const s = spec(nodes, { assertions: hostile });
  const codes = errorsOf(s);
  codes.includes('MALFORMED_ASSERTION')
    ? ok('an uncheckable assertion blocks publish rather than passing quietly')
    : fail('an uncheckable assertion did not block publish', `errors: ${codes.join(', ')}`);
}

// 3. An outcome that needs a connector nobody has connected. The promise must
//    not evaporate: either it is never made, or it blocks. Never "met".
{
  const s = spec(
    [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }],
    { assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:#ops' },
      { id: 'a2', kind: 'record_exists', target: 'notion:Tasks' },   // no Notion connector exists
    ] },
  );
  errorsOf(s).includes('UNSATISFIED_ASSERTION')
    ? ok('an outcome needing an absent connector cannot publish')
    : fail('a promise against an absent connector was treated as met', `errors: ${errorsOf(s).join(', ')}`);
}

// 4. A READ does not satisfy a WRITE. The cheapest possible way to fake
//    satisfaction is to point at a node that touches the right connector.
{
  const reads = [
    { id: 'r1', type: 'connector-action', config: { action: 'airtable_list_records', tableId: 'Leads' } },
    { id: 'r2', type: 'connector-action', config: { action: 'gmail_search', query: 'x' } },
    { id: 'r3', type: 'connector-action', config: { action: 'slack_history', target: '#ops' } },
    { id: 'r4', type: 'llm', config: { mode: 'summarize' } },
    { id: 'r5', type: 'branch', config: { on: 'r4.output', cases: [{ when: '*', to: 'r1' }] } },
  ];
  const claims = [
    { id: 'a1', kind: 'record_exists',  target: 'airtable:Leads' },
    { id: 'a2', kind: 'message_sent',   target: 'gmail:x@y.com' },
    { id: 'a3', kind: 'message_sent',   target: 'slack:#ops' },
  ];
  const leaked = claims.filter(a => reads.some(n => satisfiesAssertion(a, n)));
  leaked.length === 0
    ? ok('no read-only step can satisfy a write assertion')
    : fail('a READ satisfied a WRITE assertion', `leaked: ${leaked.map(a => a.target).join(', ')}`);
}

// 5. The moat (§11.7). An LLM decision input with an open domain must be
//    rejected — from BOTH shapes that can express it.
{
  const dec = spec(
    [{ id: 'score', type: 'decision',
       inputs: [{ key: 'tone', type: 'string', evaluator: 'llm' }],
       rules: [{ when: { tone: '-' }, then: 'P2' }], hitPolicy: 'FIRST' },
     { id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }],
    { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
  );
  const br = spec(
    [{ id: 'think', type: 'llm', config: { mode: 'freeform', prompt: 'urgent?' } },
     { id: 'route', type: 'branch', config: { on: 'think.output', cases: [{ when: 'yes', to: 'd' }, { when: '*', to: 'd2' }] } },
     { id: 'd',  type: 'deliver', config: { channel: 'slack', target: '#ops' } },
     { id: 'd2', type: 'deliver', config: { channel: 'inbox_deliver', subject: 'x' } }],
    { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
  );
  const both = errorsOf(dec).includes('LLM_INPUT_NOT_ENUM') && errorsOf(br).includes('LLM_INPUT_NOT_ENUM');
  both
    ? ok('THE MOAT holds: no LLM decision input without a closed enum (decision AND branch)')
    : fail('THE MOAT LEAKED — an LLM decision input with an unbounded domain was accepted',
           `decision: ${errorsOf(dec).join(',')} | branch: ${errorsOf(br).join(',')}`);
}

// 6. `complete` must never outrun `publishable`. If the converger thinks a spec
//    is finished but publish rejects it, the user is in a dead end they cannot
//    argue their way out of: the builder says done, the save button says no.
{
  const corpus = [
    spec([{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }],
         { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] }),
    spec([{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops', model: 'x' } }],
         { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] }),
    spec([{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#nope' } }],
         { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] }),
    spec([], { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] }),
  ];
  const bad = corpus.filter(s => scoreGap(s).complete && !validator.validate(s).ok);
  bad.length === 0
    ? ok('complete ⇒ publishable holds across the corpus')
    : fail('THE CONVERGER WOULD RATIFY A SPEC THAT CANNOT PUBLISH',
           `${bad.length} spec(s) scored complete but failed validation`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — hostile INTENTS, through the real model.
//
// Part 1 proves the CHECKER never drops an assertion. It cannot prove the
// converger EMITS one in the first place: a promise the model never writes down
// was dropped before any checker saw it, which is precisely where defect #1
// actually happened.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nPART 2 — hostile INTENTS, through the live converger.\n');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('  ✗ ANTHROPIC_API_KEY is not set.');
  console.error('    This check FAILS CLOSED rather than skipping: the half that proves the');
  console.error('    converger does not drop a destination BEFORE anything can check it is the');
  console.error('    half that matters, and a skipped check reporting PASS is how P11 was nearly');
  console.error('    closed on a false green (CLAUDE.md, P11 note).');
  process.exit(1);
}

const { ChatModel }          = await import('../../src/llm/chat-model.js');
const { buildOutcomePrompt } = await import('../../src/converger/prompts.js');
const { buildSystemPrompt }  = await import('../../src/converger/prompts.js');
const { SystemMessage, HumanMessage } = await import('../../src/core/message.js');

// The SAME model the converger's `balanced` tier actually runs (server.js:507).
// Probing a different one would prove something about a model nobody uses.
const model = new ChatModel({
  provider: 'anthropic', model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY, maxTokens: 2048,
});

/** Slack + Gmail connected. Notion, deliberately, does not exist anywhere. */
const CAPS = {
  connectors: {
    slack:  { actions: [{ id: 'slack_post' }, { id: 'slack_dm' }] },
    google: { actions: [{ id: 'gmail_send' }, { id: 'gmail_search' }] },
  },
  channels: [
    { id: 'slack',      description: 'Post to a Slack channel', available: true, configSchema: [{ key: 'target' }] },
    { id: 'slack_dm',   description: 'DM a person',             available: true, configSchema: [{ key: 'user' }] },
    { id: 'gmail_send', description: 'Send an email',           available: true, configSchema: [{ key: 'to' }, { key: 'subject' }] },
  ],
};

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const obj = text.match(/(\{[\s\S]*\})/);
  return obj ? obj[1].trim() : text.trim();
}

async function outcomeFor(intent) {
  const res = await model.invoke([
    new SystemMessage(buildSystemPrompt(CAPS)),
    new HumanMessage(buildOutcomePrompt({ intent, capabilities: CAPS })),
  ]);
  try { return JSON.parse(extractJson(res?.content ?? '')); } catch { return null; }
}

const targets = (cand) => (cand?.assertions ?? []).map(a => String(a.target ?? '').toLowerCase());

// A. TWO DESTINATIONS. This is defect #1 at its source. Both must survive into
//    the contract — if the model drops one HERE, no downstream check can save it.
{
  const parsed = await outcomeFor(
    'When a lead email arrives, post a summary to the #sales Slack channel AND email it to rep@acme.com.',
  );
  const cands = parsed?.candidates ?? [];
  const best  = cands[0];
  const t     = targets(best);
  const hasSlack = t.some(x => x.startsWith('slack:'));
  const hasMail  = t.some(x => x.startsWith('gmail:'));

  if (!cands.length)      fail('two-destination intent produced NO outcome candidates', JSON.stringify(parsed)?.slice(0, 200));
  else if (hasSlack && hasMail) ok(`both destinations survive into the contract (${t.join(' · ')})`);
  else fail('A DESTINATION WAS DROPPED AT THE SOURCE — this is defect #1',
            `pre-selected candidate asserts only: ${t.join(' · ') || '(nothing)'}`);
}

// B. ABSENT CONNECTOR. The user asks for Notion. Nothing connects to Notion.
//    Acceptable: don't promise it (and say so). Also acceptable: promise it and
//    block publish. NOT acceptable: promise it and call it satisfied, or drop it
//    without a word.
{
  const parsed = await outcomeFor(
    'When a lead email arrives, save it to my Notion database and post it to #sales in Slack.',
  );
  const best = (parsed?.candidates ?? [])[0];
  const t    = targets(best);
  const promisesNotion = t.some(x => x.startsWith('notion:'));

  if (!best) {
    ok('absent connector: no contract offered (the converger will ask) — nothing was faked');
  } else if (promisesNotion) {
    // It promised it. Then it MUST be unsatisfiable — no node can deliver to a
    // connector that does not exist, so publish must refuse.
    const s = spec([{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#sales' } }],
                   { assertions: best.assertions });
    errorsOf(s).includes('UNSATISFIED_ASSERTION')
      ? ok('absent connector: promised, and correctly unpublishable — never silently "met"')
      : fail('a promise against a connector that does not exist was treated as MET',
             `errors: ${errorsOf(s).join(', ') || '(none)'}`);
  } else {
    const said = String(best.statement ?? '').toLowerCase();
    /notion|not connected|isn't connected|unavailable|can't|cannot|only/.test(said)
      ? ok('absent connector: not promised, and the statement says so')
      : fail('THE NOTION REQUEST VANISHED WITHOUT A WORD',
             `statement: "${best.statement}" — the user asked for Notion and was never told it is not connected`);
  }
}

// C. CONTRADICTORY / UNSTATEABLE. "Make my business better" cannot be turned
//    into a checkable contract. The right answer is to ask — NOT to invent an
//    assertion nobody agreed to, which would then be "verified" against itself.
{
  const parsed = await outcomeFor('Make my business better. Also do not send anything anywhere.');
  const cands  = parsed?.candidates ?? [];
  const invented = cands.flatMap(targets)
    .filter(x => x && !x.startsWith('slack:') && !x.startsWith('gmail:') && !x.startsWith('inbox:'));

  invented.length === 0
    ? ok('unstateable intent: no assertion invented against a connector we do not have')
    : fail('an unstateable intent produced assertions against connectors that do not exist',
           `invented: ${invented.join(', ')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
if (failures) {
  console.error(`CONVERGER-ADVERSARIAL FAIL: ${failures} leak(s). A promise can still be made to disappear.`);
  process.exit(1);
}
console.log('CONVERGER-ADVERSARIAL-PASS: every assertion is satisfied, unsatisfied, or malformed — none silently dropped.');
