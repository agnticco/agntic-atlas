/**
 * A PROMISE ONLY ONE BRANCH CAN KEEP MUST SAY SO — EVEN WHEN IT SAYS NOTHING.
 *
 * WITNESSED ON PROD 2026-07-31, `build-platform-1785510779068`, driving the Sheets shape.
 * A correct Gmail→Sheets logger — classify, append a row on the "yes" lane, end silently
 * on the "no" lane — reached *"Contract not met · 1 of 3 promises fell short"* and **could
 * not go live**, after two paid whole-spec Opus passes on a spec that was already right.
 *
 * Read from the build's own checkpoint, not inferred:
 *   · the single assertion was `{kind:'record_exists', target:'sheets:Sheet1'}` — **no
 *     `when` at all** — while the sentence a person reads was already gated: *"When a new
 *     email arrives THAT LOOKS LIKE A PRICING ENQUIRY…"*. The human half was conditional;
 *     the machine half claimed a row is written on every run.
 *   · the failing example was `{id:'19f8b9524a03773d', label:'[Action Required] Enable
 *     2-step verification … Google Cloud <CloudPlatform-noreply@google.com>'}` — no
 *     `expect`, no `shouldTrigger`. A REAL message sampled from the inbox.
 *   · the two GENERATED lane examples both declared themselves and were scored correctly
 *     (kept ✓ and not-exercised ○). Only the real one was failed.
 *
 * WHY NO EXISTING GUARD CATCHES IT, which is the reason this file exists:
 *   · the quiet-path rule (2026-07-29) excuses only an example that DECLARES itself
 *     negative — deliberately, because treating an undeclared example as negative is the
 *     F17 regression. A real message declares nothing, which is what makes it worth using.
 *   · `CONDITIONAL_MISSTATED` (2026-07-28) restates a `when` naming the WRONG route. The
 *     loop it lives in opened `if (!a?.when) continue`, so an ABSENT one was never looked
 *     at. **Absent and wrong were different things, and the missing case was unguarded** —
 *     the malformed-trigger shape inverted, and its fourth appearance in CLAUDE.md.
 *
 * The anti-false-positive cases matter more than the catch. Filling a condition onto a
 * genuinely unconditional promise would EXCUSE a real miss on every other lane — a promise
 * quietly weakened until it passes, which is the one thing the promise system may never do.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scoreGap } from '../../src/converger/gap-scorer.js';
import { autoRepairStructural } from '../../src/converger/elicitation-graph.js';

/**
 * The nodes PRODUCTION built, lifted verbatim from the prod build's own checkpoint
 * (`memory/converger/build-platform-1785510779068.jsonl`). A hand-written approximation was
 * tried first and was rejected by the validator on four counts before it ever reached the
 * check under test — a fixture shaped the way the author imagines is exactly what this
 * repo keeps paying for. Note `classify` carries `categories`, the branch's catch-all is a
 * `when: "*"` CASE rather than an `otherwise`, and the quiet lane is a `stop` node.
 */
const REAL_NODES = [
        {
              "id": "extract_email",
              "type": "llm",
              "label": "Extract email fields",
              "description": "Extracts the sender name, sender email address, received date/time, and full body text from the incoming email so later steps can reference each field individually.",
              "config": {
                    "mode": "extract",
                    "fields": "sender_name: The display name of the email sender (if only an email address is present use the part before the @)\nsender_email: The email address of the sender\nreceived_date: The date and time the email was received formatted as YYYY-MM-DD HH:mm\nbody: The complete body text of the email",
                    "instructions": "If there is no subject AND no body text at all, output EXACTLY: ERROR: required data not found \u2014 do not compose content. Otherwise extract every requested field from the email.",
                    "format": "json"
              }
        },
        {
              "id": "classify_enquiry",
              "type": "llm",
              "label": "Is it a pricing enquiry?",
              "description": "Classifies whether the email is a pricing enquiry (yes) or not (no) based on the extracted email content.",
              "config": {
                    "mode": "classify",
                    "categories": "yes\nno",
                    "instructions": "If the provided data is empty, missing, or contains the word ERROR, output 'no'. Otherwise examine the email body and any subject context. Classify as 'yes' if the sender is asking about pricing, costs, rates, quotes, fees, subscription tiers, plan pricing, or requesting a price estimate for a product or service. Classify as 'no' for everything else \u2014 newsletters, notifications, marketing blasts, security alerts, automated messages, support tickets, internal messages, receipts, confirmations, etc.",
                    "input": "{{extract_email.output}}"
              }
        },
        {
              "id": "route",
              "type": "branch",
              "label": "Route by classification",
              "description": "Sends pricing enquiries to the summary-and-append path; all other emails end silently.",
              "config": {
                    "on": "classify_enquiry.output",
                    "cases": [
                          {
                                "when": "yes",
                                "to": "summarize_body"
                          },
                          {
                                "when": "no",
                                "to": "do_nothing"
                          },
                          {
                                "when": "*",
                                "to": "do_nothing"
                          }
                    ]
              }
        },
        {
              "id": "summarize_body",
              "type": "llm",
              "label": "One-line summary",
              "description": "Writes a single-sentence plain-text summary of the pricing enquiry email body.",
              "config": {
                    "mode": "summarize",
                    "length": "short",
                    "style": "plain",
                    "instructions": "If the provided data is empty or contains ERROR, output EXACTLY: ERROR: required data not found \u2014 do not compose content. Otherwise produce exactly ONE concise sentence summarizing what the sender is asking about regarding pricing. Plain text only \u2014 no HTML tags, no markdown symbols, no bullet points.",
                    "input": "{{extract_email.output}}"
              }
        },
        {
              "id": "append_row",
              "type": "deliver",
              "label": "Append row to Agntic CRM Sheet",
              "description": "Appends a row to the Sheet1 tab of the Agntic CRM Google Sheet with the timestamp, sender name, sender email, one-line AI summary as the message, and Source set to 'Pricing Enquiry'.",
              "config": {
                    "channel": "sheets_append",
                    "spreadsheetId": "1DG5qZ9mHvTlTU34iGRKWf9-vPyegVufENVmoJLcdnSA",
                    "range": "Sheet1",
                    "values": [
                          [
                                "{{extract_email.received_date}}",
                                "{{extract_email.sender_name}}",
                                "{{extract_email.sender_email}}",
                                "",
                                "",
                                "{{summarize_body.output}}",
                                "Pricing Enquiry",
                                ""
                          ]
                    ]
              },
              "destinationIds": [
                    "d1"
              ]
        },
        {
              "id": "do_nothing",
              "type": "stop",
              "label": "No action",
              "description": "Ends the workflow silently when the email is not a pricing enquiry.",
              "config": {}
        }
  ];

function pricingLogger({ when } = {}) {
  const assertion = { id: 'a1', kind: 'record_exists', target: 'sheets:Sheet1',
                      fields: ['Timestamp', 'Name', 'Email', 'Message', 'Source'] };
  if (when !== undefined) assertion.when = when;
  return {
    name: 'Pricing enquiry logger',
    triggers: [{"type": "email", "connector": "gmail", "filter": "is:unread"}],
    nodes: JSON.parse(JSON.stringify(REAL_NODES)),
    edges: [{"from": "extract_email", "to": "classify_enquiry"}, {"from": "classify_enquiry", "to": "route"}, {"from": "route", "to": "summarize_body"}, {"from": "route", "to": "do_nothing"}, {"from": "summarize_body", "to": "append_row"}],
    outcome: {
      statement: 'When a new email arrives that looks like a pricing enquiry, append a row to the Sheet1 tab of the Agntic CRM Google Sheet.',
      assertions: [assertion],
    },
  };
}

const gapsOf   = (spec) => (scoreGap(spec)?.gaps ?? []);
const findCode = (spec, code) => gapsOf(spec).find(g => g.code === code) ?? null;

describe('THE PROD DEFECT — a promise with no condition at all', () => {
  test('it is now noticed, where it used to be skipped outright', () => {
    const g = findCode(pricingLogger(), 'CONDITIONAL_UNSTATED');
    assert.ok(g, 'an assertion with no `when` is still being passed over — this is the prod defect');
  });

  test('it carries a fix naming the branch that really gates the write', () => {
    const g = findCode(pricingLogger(), 'CONDITIONAL_UNSTATED');
    assert.equal(g.fix?.op, 'set_assertion_when');
    assert.equal(g.fix.when, 'yes', 'the condition must be the route that gates the appending step');
    assert.equal(g.fix.index, 0);
  });

  test('and the repair applies it with no question, no model call, no rebuild', () => {
    // The same path `set_assertion_when` has always taken — this is why the fix is one
    // gap rather than new repair machinery.
    const spec = pricingLogger();
    const { draft } = autoRepairStructural(spec, gapsOf(spec));
    assert.equal(draft.outcome.assertions[0].when, 'yes');
  });

  test("the person's own words are left exactly as they were", () => {
    // Only how we CHECK the promise changes. Rewriting the sentence would be editing
    // what they asked for.
    const spec = pricingLogger();
    const { draft } = autoRepairStructural(spec, gapsOf(spec));
    assert.equal(draft.outcome.statement, spec.outcome.statement);
    assert.equal(draft.outcome.assertions[0].target, 'sheets:Sheet1');
    assert.deepEqual(draft.outcome.assertions[0].fields, spec.outcome.assertions[0].fields);
  });

  test('the message says which decision really decides it, in plain words', () => {
    const g = findCode(pricingLogger(), 'CONDITIONAL_UNSTATED');
    assert.match(g.message, /only runs after the "yes" decision/);
    assert.doesNotMatch(g.message, /assertion|CONDITIONAL|when:/i, 'no jargon on a line a person may read');
  });

  test('it never blocks the build', () => {
    // Everything reaching here is already valid. A repair that could block would be a
    // new way to fail a correct workflow, which is the defect this fixes.
    const g = findCode(pricingLogger(), 'CONDITIONAL_UNSTATED');
    assert.equal(g.blocking, false);
    assert.equal(g.severity, 'warning');
  });
});

describe('IT MUST NOT WEAKEN A PROMISE THAT REALLY IS UNCONDITIONAL', () => {
  // The dangerous direction. A condition filled onto an ungated promise would excuse a
  // REAL miss on every other lane — a promise narrowed until it passes.

  test('a write on the main line, with no branch at all, is left alone', () => {
    const spec = {
      name: 'Logger', triggers: [{ type: 'email' }],
      nodes: [
        { id: 'sum', type: 'llm', config: { mode: 'summarize', length: 'short', style: 'plain' } },
        { id: 'append', type: 'deliver',
          config: { channel: 'sheets_append', spreadsheetId: '1DG5qZ9', range: 'Sheet1', values: '[["a"]]' } },
      ],
      edges: [{ from: 'sum', to: 'append' }],
      outcome: { statement: 'Every email is logged.',
                 assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Sheet1' }] },
    };
    assert.equal(findCode(spec, 'CONDITIONAL_UNSTATED'), null);
    const { draft } = autoRepairStructural(spec, gapsOf(spec));
    assert.equal(draft.outcome.assertions[0].when, undefined,
      'an unconditional promise was given a condition — it can now be excused on other lanes');
  });

  test('a write EVERY lane reaches is unconditional, even though a branch exists', () => {
    // `gatingRouteFor` only counts a branch whose lanes disagree about reaching the step.
    // A branch both of whose cases converge on the write decides nothing about whether it
    // runs, and treating it as a condition would invent a gate the user never made.
    const spec = {
      name: 'Logger', triggers: [{ type: 'email' }],
      nodes: [
        { id: 'classify', type: 'llm', config: { mode: 'extract', instruction: 'kind?', labels: ['a', 'b'] } },
        { id: 'route', type: 'branch',
          config: { on: '{{classify.output}}',
                    cases: [{ when: 'a', to: 'append' }, { when: 'b', to: 'append' }], otherwise: 'append' } },
        { id: 'append', type: 'deliver',
          config: { channel: 'sheets_append', spreadsheetId: '1DG5qZ9', range: 'Sheet1', values: '[["a"]]' } },
      ],
      edges: [{ from: 'classify', to: 'route' }, { from: 'route', to: 'append' }],
      outcome: { statement: 'Every email is logged.',
                 assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Sheet1' }] },
    };
    assert.equal(findCode(spec, 'CONDITIONAL_UNSTATED'), null);
  });

  test('TWO candidate gates are not guessed between', () => {
    // Choosing one would silently narrow the promise to half the runs it covers. Saying
    // nothing is the honest answer.
    const spec = pricingLogger();
    const route = spec.nodes.find(n => n.id === 'route');
    route.config.categories = undefined;
    spec.nodes.find(n => n.id === 'classify_enquiry').config.categories = 'yes\nmaybe\nno';
    route.config.cases = [
      { when: 'yes',   to: 'summarize_body' },
      { when: 'maybe', to: 'summarize_body' },
      { when: 'no',    to: 'do_nothing' },
      { when: '*',     to: 'do_nothing' },
    ];
    assert.equal(findCode(spec, 'CONDITIONAL_UNSTATED'), null,
      'a condition was guessed between two candidate gates — that silently narrows the promise');
  });

  test('a promise no step keeps is NOT quietly given a condition', () => {
    // With no owner there is no gate to read, and inventing one would put a condition on
    // a promise nothing fulfils — making "this names somewhere no step goes" harder to
    // see, which is a finding that must survive.
    const spec = pricingLogger();
    spec.outcome.assertions[0].target = 'sheets:Some Other Tab';
    assert.equal(findCode(spec, 'CONDITIONAL_UNSTATED'), null);
  });
});

describe('it does not disturb the check it sits beside', () => {
  test('a WRONG condition is still restated, as before', () => {
    // `CONDITIONAL_MISSTATED` is the 2026-07-28 fix and must keep working unchanged.
    const spec = pricingLogger({ when: 'urgent_complaint' });
    const g = gapsOf(spec).find(x => x.code === 'CONDITIONAL_MISSTATED' || x.code === 'CONDITIONAL_UNPROVEN');
    assert.ok(g, 'a `when` that names no real route no longer raises anything');
    assert.equal(g.fix?.when, 'yes');
  });

  test('a condition that ALREADY names its own gate raises nothing', () => {
    const spec = pricingLogger({ when: 'yes' });
    assert.equal(findCode(spec, 'CONDITIONAL_UNSTATED'), null);
    assert.equal(findCode(spec, 'CONDITIONAL_MISSTATED'), null);
  });

  test('the two codes are never raised about one assertion at once', () => {
    // They propose the same edit; two gaps would apply it twice and read as two problems.
    for (const w of [undefined, 'yes', 'no', 'urgent_complaint']) {
      const codes = gapsOf(pricingLogger({ when: w }))
        .filter(g => g.code === 'CONDITIONAL_UNSTATED' || g.code === 'CONDITIONAL_MISSTATED');
      assert.ok(codes.length <= 1, `both fired for when=${String(w)}`);
    }
  });
});
