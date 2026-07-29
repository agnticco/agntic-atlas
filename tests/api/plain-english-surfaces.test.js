/**
 * ONE VOCABULARY, AND IT IS ENGLISH — ACROSS THE BUILDER, THE WORKFLOW PAGE AND
 * THE PROCEDURE DOCUMENT.
 *
 * Operator, 2026-07-29, after driving a 12-step build to go-live on prod: "fix
 * those plain english issues... we have barely touched the last screen before go
 * live and the live dashboard and the SOP document."
 *
 * WHAT WAS ACTUALLY WRONG. There were THREE type vocabularies for one set of
 * steps, and a customer met all three in one sitting:
 *   · the canvas + approval card said  `LLM · EXTRACT`, `CONNECTOR-ACTION`, `BRANCH`
 *   · the on-screen procedure document said `LLM PROMPT`, `EMAIL TRIGGER`
 *   · the EXPORTED procedure document said "AI step", "Wait for a person"
 * CLAUDE.md carried the first as an open residual ("_nodeShape reaches five
 * surfaces including the exported procedure document"); nobody had noticed the
 * other two existed. Plus, on screen, verbatim: `is:unread`, `urgent_complaint`,
 * `← classify_email`, `Instructions: … output EXACTLY: ERROR: required data not f…`,
 * and an evidence row naming one Slack channel twice.
 *
 * AND A HOLE THE CLEANUP EXPOSED: the procedure document described a routing step
 * in prose and never said which answer goes where, and never stated an approval's
 * terms — so the document a customer is HANDED was less informative than the card
 * they saw while building, on the two steps where being wrong is a silent
 * misdelivery.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SOPGEN = readFileSync(path.join(ROOT, 'src/workflows/sop-generator.js'), 'utf8');

function bodyFrom(i) {
  let j = HTML.indexOf('{', i), depth = 0;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}
function methodSrc(name) {
  const start = HTML.indexOf('\n  ' + name + '(');
  assert.notEqual(start, -1, `\`${name}\` is GONE — re-point this extraction, do not delete the test.`);
  return HTML.slice(start + 1, bodyFrom(start));
}

/** The real helpers, executed. */
const C = (() => {
  const names = ['_stepTypeWords', '_plainId', '_plainLabel', '_plainFilter', '_plainAge', '_plainTarget', '_plainInstruction', '_plainText', '_stringify', '_nodeShape'];
  return eval('({\n' + names.map(methodSrc).join(',\n') + '\n})');
})();

// ── THE VOCABULARY ───────────────────────────────────────────────────────────

describe('a step says what it does, in words', () => {
  test('none of the old jargon survives', () => {
    const jargon = /\bLLM\b|CONNECTOR[-_]ACTION|SEARCH_WEB|^BRANCH$|^HUMAN$|^DELIVER$|^STOP$/;
    for (const t of ['llm', 'summarize', 'extract', 'rewrite', 'classify', 'freeform',
                     'branch', 'human', 'deliver', 'stop', 'connector-action', 'search_web',
                     'decision', 'foreach', 'assemble', 'trigger']) {
      const w = C._stepTypeWords(t);
      assert.doesNotMatch(w, jargon, `"${w}" is the filing system, not English (${t})`);
    }
  });

  test('the words describe the action', () => {
    assert.equal(C._stepTypeWords('human'), 'ASKS A PERSON');
    assert.equal(C._stepTypeWords('branch'), 'PICKS A PATH');
    assert.equal(C._stepTypeWords('deliver'), 'SENDS IT');
    assert.equal(C._stepTypeWords('extract'), 'PULLS OUT DETAILS');
    assert.equal(C._stepTypeWords('stop'), 'ENDS HERE');
  });

  test('an unknown type says "STEP" rather than shouting its raw name', () => {
    // The old code did `(T || 'step').toUpperCase()`, so a type nobody had taught
    // it — every future node type — was rendered at the customer verbatim.
    assert.equal(C._stepTypeWords('quantum_flux'), 'STEP');
    assert.equal(C._stepTypeWords(''), 'STEP');
    assert.equal(C._stepTypeWords(null), 'STEP');
  });

  test('the canvas reads the same table, so it cannot drift again', () => {
    for (const t of ['human', 'branch', 'deliver', 'classify']) {
      assert.equal(C._nodeShape(t, '').typeLabel, C._stepTypeWords(t),
        'the canvas must not carry a second copy of the vocabulary');
    }
  });

  test('the shapes and icons still work — this was a wording change only', () => {
    assert.equal(C._nodeShape('branch', '').shape, 'diamond');
    assert.equal(C._nodeShape('human', '').shape, 'circle');
    assert.equal(C._nodeShape('deliver', '').shape, 'capsuleR');
    assert.equal(C._nodeShape('trigger', 'email').shape, 'capsuleL');
    assert.ok(C._nodeShape('trigger', 'email').icons.icoMail);
    assert.ok(C._nodeShape('trigger', 'schedule').icons.icoBolt);
  });

  test('the EXPORTED document uses the same words', () => {
    // Three vocabularies is what a customer used to get. The exported document is
    // a different medium (sentence case), but it must not be a different answer.
    for (const w of ['Asks a person', 'Picks a path', 'Sends it', 'Builds a document',
                     'Pulls out details', 'Writes a summary', 'Sorts it']) {
      assert.ok(SOPGEN.includes(w), `the exported procedure document is missing "${w}"`);
    }
    assert.ok(!SOPGEN.includes('Wait for a person'), 'the old wording must be gone, not merely joined');
    assert.ok(!SOPGEN.includes('Branch (routes one way)'));
  });
});

// ── VALUES ───────────────────────────────────────────────────────────────────

describe('a search query is rendered, not printed', () => {
  test('the prod case', () => {
    assert.equal(C._plainFilter('is:unread'), 'that are unread');
  });

  test('the operators a person actually uses', () => {
    assert.equal(C._plainFilter('from:bob@acme.com'), 'from bob@acme.com');
    assert.equal(C._plainFilter('has:attachment'), 'with an attachment');
    assert.equal(C._plainFilter('subject:"invoice"'), 'with "invoice" in the subject');
    assert.equal(C._plainFilter('newer_than:3d'), 'from the last 3 days');
    assert.equal(C._plainFilter('newer_than:1d'), 'from the last 1 day', 'singular, not "1 days"');
  });

  test('several terms read as one phrase', () => {
    assert.equal(C._plainFilter('is:unread has:attachment'), 'that are unread, with an attachment');
  });

  test('a negated term keeps its meaning', () => {
    assert.equal(C._plainFilter('-label:promotions'), 'not labelled promotions');
  });

  test('an operator we do not know keeps its value rather than vanishing', () => {
    // Dropping a filter silently would understate what the workflow watches — a
    // worse failure than reading a little oddly.
    assert.match(C._plainFilter('rfc822msgid:xyz'), /xyz/);
  });

  test('nothing in, nothing out', () => {
    assert.equal(C._plainFilter(''), '');
    assert.equal(C._plainFilter(null), '');
  });
});

describe('an identifier is plained; a sentence is left alone', () => {
  test('lane-named values become English', () => {
    assert.equal(C._plainLabel('urgent_complaint'), 'Urgent complaint');
    assert.equal(C._plainLabel('billing_question'), 'Billing question');
    assert.equal(C._plainLabel('junk'), 'Junk');
  });

  test('a real label survives EXACTLY — including its punctuation', () => {
    // The trap: `_plainId` turns every "-" into a space, so a blanket cleanup
    // would quietly rewrite "2-step" as "2 step" in a customer's own words.
    const real = '[Action Required] Enable 2-step verification';
    assert.equal(C._plainLabel(real), real);
    assert.equal(C._plainLabel('Multiple unread emails with varied senders'),
                 'Multiple unread emails with varied senders');
  });

  test('empty stays empty, so the caller can still fall back', () => {
    assert.equal(C._plainLabel(''), '');
    assert.equal(C._plainLabel(null), '');
  });
});

describe('the approval card shows the instruction, minus the plumbing', () => {
  // The literal prod instruction, verbatim from the card the operator was asked to
  // approve at step 7 of 12.
  const PROD = [
    'If there is no subject AND no body text at all, output EXACTLY: ERROR: required data not found.',
    '',
    'Otherwise, compose a concise Slack message about this urgent complaint email. Structure it exactly like this:',
    '',
    '🚨 *Urgent Complaint*',
    '',
    '• *Sender:* the sender\'s name',
    '',
    '*Summary:*',
    'A short 2-3 sentence summary of the complaint and what the sender is asking for.',
    '',
    'Format output as Slack mrkdwn: *bold* for headers, • for list items, blank line between sections. No HTML tags of any kind.',
  ].join('\n');

  test('the missing-data sentinel never reaches the card', () => {
    const out = C._plainInstruction(PROD);
    assert.doesNotMatch(out, /ERROR: required data not found/,
      'a machine sentinel is not something a person can act on');
    assert.doesNotMatch(out, /output EXACTLY/i);
  });

  test('nor do the channel formatting directions', () => {
    const out = C._plainInstruction(PROD);
    assert.doesNotMatch(out, /mrkdwn/i);
    assert.doesNotMatch(out, /No HTML tags/i);
  });

  test('but what the step actually produces survives', () => {
    const out = C._plainInstruction(PROD);
    assert.match(out, /compose a concise Slack message/i,
      'the point of the card is to say what the step does — that must not be stripped too');
    assert.match(out, /2-3 sentence summary/);
  });

  test('an ordinary instruction is passed through untouched', () => {
    // The subtractive rule must not quietly invent a friendlier instruction than
    // the one the step will really follow.
    const plain = 'Read the email and answer with exactly one label.';
    assert.equal(C._plainInstruction(plain), plain);
  });

  test('nothing in, nothing out', () => {
    assert.equal(C._plainInstruction(''), '');
    assert.equal(C._plainInstruction(null), '');
  });
});

describe('a promise names its destination the way a person says it', () => {
  test('connector:locator becomes a phrase', () => {
    assert.equal(C._plainTarget('slack:#atlas-test-temp'), '#atlas-test-temp on Slack');
    assert.equal(C._plainTarget('airtable:Table 1'), 'Table 1 on Airtable');
  });

  test('a locator-less target still reads', () => {
    assert.equal(C._plainTarget('in_app:'), 'your Atlas inbox');
  });

  test('something with no connector prefix is passed through', () => {
    assert.equal(C._plainTarget('#ops'), '#ops');
    assert.equal(C._plainTarget(''), '');
  });
});

// ── THE SURFACES ─────────────────────────────────────────────────────────────

/**
 * Source assertions must read the CODE, not the comments explaining it. Every
 * entry below quotes the wording it removed, so an un-stripped assertion matches
 * the explanation and reports a defect that is not there.
 */
function code(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

describe('the procedure document on screen', () => {
  const i = HTML.indexOf('consoleSopNodes: (() => {');
  assert.ok(i > 0, 'the procedure document view-model moved — re-point this test');
  const src = code(HTML.slice(i, i + 6500));

  test('it reads the shared vocabulary instead of its own table', () => {
    assert.doesNotMatch(src, /LLM prompt|Email trigger|Summarize \(LLM\)/,
      'this is the private table that said "LLM PROMPT" while the canvas said "LLM · AI STEP"');
    assert.match(src, /_stepTypeWords/);
  });

  test('a step is referred to by NAME, never by its node id', () => {
    assert.doesNotMatch(src, /deps: up\.join/, '`← classify_email` is the spec\'s filing system');
    assert.match(src, /deps: up\.map\(nameOf\)/);
  });

  test('the prompt is not printed as the procedure', () => {
    assert.doesNotMatch(src, /k: "Instructions"/,
      'this printed the ERROR sentinel, clipped mid-word, into a customer document');
  });

  test('a routing step says where each answer goes', () => {
    assert.match(src, /_branchCases\(n\)/, 'the document must list the routes, not just mention them');
    assert.match(src, /Anything else/, 'the catch-all is a route a person must be able to see');
  });

  test('an approval states its terms', () => {
    assert.match(src, /They can answer/);
    assert.match(src, /If nobody answers/, 'a timeout that silently counts as reject must be written down');
  });

  test('the trigger filter is rendered, not printed', () => {
    assert.match(src, /_plainFilter/);
    assert.doesNotMatch(src, /"Watches for messages matching: " \+ t\.filter/);
  });
});

describe('the workflow page lands on the overview', () => {
  test('opening a workflow shows the overview, not the run log', () => {
    const i = HTML.indexOf("this.setState({ view: 'console', consoleWfId: wfId");
    assert.ok(i > 0, 'the workflow-open path moved — re-point this test');
    const body = HTML.slice(i, i + 700);
    assert.match(body, /consoleView: "profile"/);
  });

  test('and its figures are FETCHED on arrival', () => {
    // They used to load only on the tab click. Once the tab stopped being a tab,
    // landing would have shown empty time-saved, baseline and chart panels.
    const i = HTML.indexOf("this.setState({ view: 'console', consoleWfId: wfId");
    assert.match(HTML.slice(i, i + 900), /_loadConsoleProfile\(wfId\)/);
  });

  test('run history lives on that page, not behind its own tab', () => {
    assert.ok(!/>Run history<\/button>/.test(HTML), 'the tab should be gone');
    assert.ok(/Run history<\/div>/.test(HTML), '…because the module moved onto the overview');
    assert.equal((HTML.match(/<sc-for list="\{\{ consoleRunRows \}\}"/g) || []).length, 1,
      'exactly one run list — two copies of it is how they come to disagree');
  });

  test('nothing still points at the removed view', () => {
    for (const dead of ['consoleViewDash', 'onSwitchDash', 'consoleDashTabBg', 'consoleDashTabColor']) {
      assert.ok(!HTML.includes(dead), `${dead} is referenced but no longer defined`);
    }
  });
});

describe('the go-live review card and the live landing', () => {
  // These two share `draftNodes`, and it carried a FOURTH copy of the type
  // vocabulary — whose own comment claimed "no raw LLM/jargon" while it shipped
  // BRANCH, HUMAN, STOP and AI STEP, because anything outside its six-entry table
  // fell through to `titleCase(type).toUpperCase()`.
  test('the step tag comes from the shared vocabulary', () => {
    const i = HTML.indexOf('_nodeLabel(type)');
    assert.ok(i > 0, '`_nodeLabel` moved — re-point this test');
    const body = code(HTML.slice(i, i + 200));
    assert.match(body, /_stepTypeWords/);
    assert.doesNotMatch(body, /titleCase\(type/, 'the fall-through printed the raw node type');
    assert.doesNotMatch(body, /"AI Step"/, 'the private table must be gone, not merely bypassed');
  });

  test('the trigger title renders its filter instead of printing it', () => {
    const i = HTML.indexOf('_triggerTitle(t) {');
    assert.ok(i > 0);
    const body = code(HTML.slice(i, i + 1000));
    assert.match(body, /_plainFilter/, '"A new email arrives · is:unread" is on the live header');
    assert.doesNotMatch(body, /base \+ ' · ' \+ filter/);
  });

  test('twelve steps wrap instead of being crushed into one row', () => {
    // Each card was `flex:1` in a nowrap row, so 12 steps got ~50px each and the
    // headings ran into one another.
    const n = (HTML.match(/<sc-for list="\{\{ draftNodes \}\}"/g) || []).length;
    assert.equal(n, 2, 'the review card and the live landing both render this list');
    assert.equal((HTML.match(/flex:1 1 210px;min-width:210px/g) || []).length, n,
      'every card needs a width floor, or it collapses again on a long workflow');
    assert.ok(!/align-items:stretch">\s*<sc-for list="\{\{ draftNodes \}\}"/.test(HTML),
      'the row must be allowed to wrap');
  });
});

describe('the workflow page strip and status chip', () => {
  test('the strip reads the shared vocabulary — it was the FIFTH copy', () => {
    const i = HTML.indexOf('consoleDag: (() => {');
    assert.ok(i > 0, 'the workflow-page strip moved — re-point this test');
    const src = code(HTML.slice(i, i + 2000));
    assert.match(src, /_stepTypeWords/);
    assert.doesNotMatch(src, /et\.toUpperCase\(\)/,
      'the fall-through is what put `branch`, `human` and `stop` on screen raw');
    assert.doesNotMatch(src, /"CLASSIFY"|"EXTRACT"/, 'the private table must be gone');
  });

  test('and drops the lambda glyph', () => {
    const i = HTML.indexOf('consoleDag: (() => {');
    const src = code(HTML.slice(i, i + 2000));
    assert.doesNotMatch(src, /: "λ"/, 'a lambda means nothing to the person reading this page');
  });

  test('the status chip renders its filter and its schedule', () => {
    const i = HTML.indexOf('_getTriggerInfo(wf) {');
    assert.ok(i > 0);
    const src = code(HTML.slice(i, i + 1400));
    assert.match(src, /_plainFilter/, '"Gmail: is:unread" led the workflow page');
    assert.doesNotMatch(src, /'Gmail' \+ \(filter \?/);
    assert.match(src, /_humanCron/, 'a cron expression is not a caption');
    assert.doesNotMatch(src, /cron \? ' \(' \+ cron/);
  });
});

describe('the evidence row names a destination once', () => {
  test('duplicates are collapsed and the target is readable', () => {
    const i = HTML.indexOf("it took a path that doesn't cover");
    assert.ok(i > 0);
    const around = HTML.slice(i, i + 400);
    assert.match(around, /new Set\(/, 'two promises to the same place printed it twice');
    assert.match(around, /_plainTarget/, '`slack:#ops` is how a promise is filed, not how it is read');
  });
});
