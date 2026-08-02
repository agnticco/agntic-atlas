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
  const names = ['_stepTypeWords', '_plainId', '_plainLabel', '_plainFilter', '_plainAge', '_plainTarget', '_plainInstruction', '_plainText', '_stringify', '_nodeShape', '_routeDomainOf', '_answersAPersonCanGive', '_plainQuery'];
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

describe('a search step shows what it looks for, not its syntax', () => {
  // Witnessed on the approval card, 2026-07-29: `Query: is:unread newer_than:1d`.
  // `_plainFilter` covered the TRIGGER's filter; a connector-action's `query` went
  // through the generic config loop, which prints whatever it is given.
  test('a mail query is rendered', () => {
    assert.equal(C._plainQuery('is:unread newer_than:1d'), 'unread, from the last 1 day');
  });

  test('a web search query is a sentence and is left EXACTLY alone', () => {
    // The same config key on a different capability. Running this through the
    // filter renderer would mangle a phrase the person wrote themselves.
    const sentence = 'best CRM for small teams 2026';
    assert.equal(C._plainQuery(sentence), sentence);
  });

  test('a colon inside prose is not mistaken for an operator', () => {
    const prose = 'pricing: what do competitors charge';
    assert.equal(C._plainQuery(prose), prose, 'the tell is `word:value` with no space after the colon');
  });

  test('nothing in, nothing out', () => {
    assert.equal(C._plainQuery(''), '');
    assert.equal(C._plainQuery(null), '');
  });

  test('every site that shows a query routes through it', () => {
    assert.match(HTML, /k === 'query' \? this\._plainQuery\(v\)/, 'the approval card');
    assert.match(HTML, /k: "Looks for", v: this\._plainQuery\(cfg\.query\)/, 'the procedure document');
  });

  test('and the trigger card no longer prints its filter raw', () => {
    // "Only when it matches: is:unread" — the one site the earlier sweep missed.
    assert.ok(!HTML.includes("this._fact(facts, 'Only when it matches', full.filter)"));
    assert.match(HTML, /this\._fact\(facts, 'Only', this\._plainFilter\(full\.filter\)/);
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

describe('nobody can answer "timeout"', () => {
  // The approval card and the procedure document both read "They can answer:
  // Approve · Reject · Timeout". A timeout is what happens when a person answers
  // NOTHING, and it is already stated on the next line ("If nobody answers…"). A
  // safety screen listing an impossible answer is a small lie in the one place the
  // product asks a person to check its work.
  const HUMAN = { type: 'human', config: { decisions: 'approve, reject' } };

  test('the choosable answers exclude it', () => {
    assert.deepEqual(C._answersAPersonCanGive(HUMAN), ['approve', 'reject']);
  });

  test('but the ROUTE domain still includes it — do not narrow that', () => {
    // `_unroutedValues` uses this to catch a workflow whose timeout falls through
    // the catch-all silently. Narrowing it here would delete a real safety check
    // to fix a wording problem.
    assert.ok(C._routeDomainOf(HUMAN).includes('timeout'),
      'the branch below really can receive a timeout, and that must stay provable');
  });

  test('a declared answer genuinely called something else is untouched', () => {
    const three = { type: 'human', config: { decisions: 'approve, reject, escalate' } };
    assert.deepEqual(C._answersAPersonCanGive(three), ['approve', 'reject', 'escalate']);
  });

  test('a classifier is not a person and is left alone', () => {
    const cls = { type: 'llm', config: { mode: 'classify', categories: 'urgent, timeout' } };
    assert.deepEqual(C._answersAPersonCanGive(cls), ['urgent', 'timeout'],
      'a category that happens to be NAMED timeout is a real answer here');
  });

  test('every surface that lists answers uses it', () => {
    assert.equal((HTML.match(/_answersAPersonCanGive\(/g) || []).length, 5,
      'the definition plus all four render sites — the card, the two other panels, and the document');
    assert.ok(!/'Possible answers', this\._routeDomainOf/.test(HTML),
      'a render site still reading the raw domain would print "Timeout" again');
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
  // Bounded by the NEXT view-model key rather than a character count — the block
  // has outgrown a fixed slice twice while this change was being written, and a
  // too-short slice reports a defect that is not there.
  const i = HTML.indexOf('consoleSopNodes: (() => {');
  assert.ok(i > 0, 'the procedure document view-model moved — re-point this test');
  const end = HTML.indexOf('// run drawer', i);
  assert.ok(end > i, 'the marker that ends the procedure-document block moved');
  const src = code(HTML.slice(i, end));

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

  test('and reads the timeout the way the approval card does', () => {
    // A first cut invented a flat `timeout_hours`, so on the real live workflow —
    // which nests it under `config.timeout` — the document silently omitted the
    // deadline while the card three clicks away stated it. Caught in the browser,
    // not by the suite.
    assert.match(src, /const to = cfg\.timeout;/, 'the nested shape is the one production writes');
    assert.doesNotMatch(src, /timeout_hours/);
    assert.match(src, /_answersAPersonCanGive\(n\)/,
      'the answers must come from the same derivation as the card, not a hardcoded default');
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
    // ONE renderer now: the live landing that shared this list was deleted on
    // 2026-07-29, when publishing started going straight to the dashboard.
    const n = (HTML.match(/<sc-for list="\{\{ draftNodes \}\}"/g) || []).length;
    assert.equal(n, 1, 'the go-live review card is the only screen that draws this list');
    assert.equal((HTML.match(/flex:1 1 210px;min-width:210px/g) || []).length, n,
      'every card needs a width floor, or it collapses again on a long workflow');
    assert.ok(!/align-items:stretch">\s*<sc-for list="\{\{ draftNodes \}\}"/.test(HTML),
      'the row must be allowed to wrap');
  });
});

describe('the workflow page draws the real graph', () => {
  // It was a flat row of name chips that could not show a branch at all, so the
  // screen you land on after publishing was the one place the SHAPE of a five-lane
  // approval workflow was invisible. The flat renderer — which was also the fifth
  // copy of the type vocabulary — is gone entirely.
  test('the flat strip and its private vocabulary are deleted, not bypassed', () => {
    assert.ok(!HTML.includes('consoleDag'),
      'a dead second renderer is how they drift back — delete it');
  });

  test('it shares the builder\'s layout engine', () => {
    const i = HTML.indexOf('consoleGraph: (() => {');
    assert.ok(i > 0, 'the workflow-page graph moved — re-point this test');
    const src = code(HTML.slice(i, i + 1800));
    assert.match(src, /_liveGraphLayout\(/,
      'one engine must know how to draw a workflow, or the two pictures disagree');
    assert.match(src, /_liveNodesFromSpec\(wf\)/);
  });

  test('a settled workflow shows no approval chrome', () => {
    const i = HTML.indexOf('consoleGraph: (() => {');
    const src = code(HTML.slice(i, i + 1800));
    // confirmed === every node, nothing pending, nothing flashing, not `ready`.
    assert.match(src, /nodes\.length, -1, false, false, nodes\.length/,
      'nothing on a published workflow is awaiting approval');
    assert.ok(!/consoleGraph\.card/.test(HTML), 'there is no step being approved here');
  });

  test('the drawn markup carries no confirm or reject control', () => {
    const i = HTML.indexOf('<sc-if value="{{ consoleGraph }}"');
    assert.ok(i > 0, 'the workflow-page graph markup moved');
    const j = HTML.indexOf('<!-- SUB-NAV TABS -->', i);
    const markup = HTML.slice(i, j);
    assert.ok(markup.includes('{{ an.icoPerson }}'), 'it must still be the real diagram');
    assert.ok(!markup.includes('an.check'), 'a published workflow cannot be approved again');
    assert.ok(!markup.includes('an.decide'));
  });

  test('it sits under the figures and above the baseline', () => {
    // Operator's order, 2026-07-29: the numbers you came for first, then the
    // picture of the workflow, then the baseline setup and the run log.
    const cards    = HTML.indexOf('<!-- STAT CARDS -->');
    const graph    = HTML.indexOf('<sc-if value="{{ consoleGraph }}"');
    const baseline = HTML.indexOf('<!-- BASELINE RECORDING PLAYER');
    const empty    = HTML.indexOf('<!-- NO BASELINE / EMPTY STATE -->');
    const runs     = HTML.indexOf('<!-- RUN HISTORY —');
    for (const [n, v] of [['stat cards', cards], ['graph', graph], ['baseline', baseline],
                          ['baseline empty state', empty], ['run history', runs]]) {
      assert.ok(v > 0, `${n} is gone from the overview`);
    }
    assert.ok(cards < graph, 'the time-saved figures come first');
    assert.ok(graph < baseline && graph < empty, 'the workflow sits above the baseline modules');
    assert.ok(empty < runs, 'run history stays last');
  });

  test('it scrolls away instead of owning the top of the page', () => {
    // It was in the page's FIXED header, above the tabs, so ~350px of every screen
    // was the diagram whether you wanted it or not and no amount of scrolling got
    // past it. It belongs inside the overview's own scroll pane.
    const tabs  = HTML.indexOf('<!-- SUB-NAV TABS -->');
    const pane  = HTML.indexOf('<sc-if value="{{ consoleViewProfile }}"');
    const graph = HTML.indexOf('<sc-if value="{{ consoleGraph }}"');
    assert.ok(tabs > 0 && pane > 0 && graph > 0);
    assert.ok(graph > pane, 'the graph must render inside the scrolling overview pane');
    assert.ok(graph > tabs, 'and below the fixed header, not in it');
  });

  test('it is capped small and centred', () => {
    const i = HTML.indexOf('_fitConsoleGraph() {');
    // Bounded by the next method, not a character count — the explanatory comments
    // in here have outrun a fixed slice twice already.
    const body = code(HTML.slice(i, HTML.indexOf('_cgWheel(e) {', i)));
    assert.match(body, /MAX_H = 260/, 'a share of the viewport is the builder\'s rule, not this one');
    assert.doesNotMatch(body, /window\.innerHeight/);
    // `scale()` shrinks the painted box, not the laid-out one, so without this the
    // graph hugs the left edge with all the slack piled up on the right. Centring
    // moved into the view's own `tx` when pan/zoom landed, so it is one number that
    // the auto-fit and the user's dragging both write.
    assert.match(body, /tx: Math\.max\(0, \(o\.clientWidth - w \* k\) \/ 2\)/,
      'a scaled graph does not centre itself');
  });

  test('it wears the builder\'s dotted canvas', () => {
    const i = HTML.indexOf('<sc-if value="{{ consoleGraph }}"');
    const markup = HTML.slice(i, HTML.indexOf('{{ consoleGraph.edges }}', i));
    // The exact field the builder uses, so the two read as one canvas.
    assert.match(markup, /radial-gradient\(rgba\(255,255,255,\.05\) 1px,transparent 1px\)/);
    assert.match(markup, /background-size:16px 16px/);
    assert.match(markup, /cursor:grab/);
    assert.match(markup, /overflow:hidden/, 'a pannable canvas must clip, not spill');
    assert.match(markup, /user-select:none/,
      'left-drag would otherwise select the node titles instead of panning');
  });

  test('the wheel zooms about the pointer and does not scroll the page', () => {
    const i = HTML.indexOf('_cgWheel(e) {');
    assert.ok(i > 0, '`_cgWheel` is gone — re-point this test');
    const body = code(HTML.slice(i, i + 900));
    assert.match(body, /e\.preventDefault\(\)/, 'without this the page scrolls behind the zoom');
    // Keeping the point under the cursor fixed is what makes zoom feel attached to
    // the mouse rather than to the corner of the box.
    assert.match(body, /cx - \(cx - v\.tx\) \* \(k2 \/ v\.k\)/);
    assert.match(body, /Math\.min\(2\.5, Math\.max\(0\.15/, 'zoom must have stops at both ends');
    const w = HTML.indexOf('this._cgOuter = el;');
    assert.ok(w > 0, 'the console graph ref moved — re-point this test');
    assert.match(HTML.slice(w, w + 900), /'wheel',[^\n]*\{ passive: false \}/,
      'a passive wheel listener cannot preventDefault, so the page would scroll too');
  });

  test('panning is left OR middle drag, and survives leaving the box', () => {
    const i = HTML.indexOf('_cgDown(e) {');
    assert.ok(i > 0);
    const body = code(HTML.slice(i, HTML.indexOf('_cgResetView()', i)));
    assert.match(body, /e\.button !== 0 && e\.button !== 1/,
      'left-drag is what most people reach for; nothing in the published graph is clickable');
    // On middle this stops Chrome's autoscroll cursor; on LEFT it stops the drag
    // starting a text selection, which would highlight every node title in blue and
    // make the canvas look like it was not moving at all.
    assert.match(body, /e\.preventDefault\(\)/);
    // Bound to the window: a listener on the box alone leaves the canvas stuck to
    // the pointer when the drag ends outside it.
    assert.match(body, /window\.addEventListener\('mousemove'/);
    assert.match(body, /window\.addEventListener\('mouseup'/);
    assert.match(body, /window\.removeEventListener\('mousemove'/, 'a drag listener that is never removed leaks');
    assert.match(body, /window\.removeEventListener\('mouseup'/);
  });

  test('it re-fits once the fonts land', () => {
    // The fit reads `scrollHeight`, driven by the node TITLES — absolutely
    // positioned, so their wrapping changes the scroll extent without changing any
    // border-box the ResizeObserver watches. Measured on prod: first frame 480px,
    // settled 428, so the graph opened at 0.54 when 0.61 fits, and double-clicking
    // to reset was the only way to see the right size.
    const i = HTML.indexOf('fitInnerRef: (el) => {\n            this._cgInner');
    assert.ok(i > 0, 'the console graph inner ref moved — re-point this test');
    const body = HTML.slice(i, i + 1400);
    assert.match(body, /document\.fonts\.ready/);
    assert.match(body, /_cgFontFit/, 'the ref fires every render — this must arm once');
  });

  test('a view the person set is not yanked back by a resize', () => {
    const i = HTML.indexOf('_fitConsoleGraph() {');
    const body = code(HTML.slice(i, i + 500));
    assert.match(body, /if \(this\._cgUserView\) \{ this\._cgApply\(\); return; \}/,
      'the ResizeObserver fires on every layout change and would undo the pan');
    assert.match(HTML, /_cgResetView\(\)\s*\{/, 'panning with no way home is a trap');
    assert.match(HTML, /'dblclick', \(\) => this\._cgResetView\(\)/);
  });

  test('the view does not follow you to the next workflow', () => {
    const i = HTML.indexOf("this.setState({ view: 'console', consoleWfId: wfId");
    const body = HTML.slice(i, i + 1400);
    assert.match(body, /_cgUserView = false/,
      'a different graph would otherwise open off-screen at someone else\'s zoom');
  });

  test('it fits itself without fighting the builder canvas over the same handles', () => {
    // One ResizeObserver pair watching both surfaces would let a resize of one
    // rescale the other.
    assert.match(HTML, /_fitConsoleGraph\(\)\s*\{/);
    assert.ok(HTML.includes('this._cgOuter') && HTML.includes('this._lgOuter'));
    const i = HTML.indexOf('_fitConsoleGraph() {');
    assert.doesNotMatch(code(HTML.slice(i, i + 500)), /_lgOuter|_lgInner/);
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

describe('the evidence row names a destination readably', () => {
  // RE-POINTED 2026-08-02, and HALF OF IT NO LONGER HAS A SUBJECT — said out loud
  // rather than quietly dropped.
  //
  // This used to guard the "not exercised" row, which listed every promise the
  // sample's lane did not cover: two promises to the same place printed it twice
  // ("doesn't cover slack:#ops, slack:#ops"), hence the `new Set(`. That row is
  // gone with the contract oracle (src/workflows/delivery-verdict.js) — a row now
  // names AT MOST ONE destination, the delivery that did not land — so there is
  // no longer a list that can contain a duplicate. **Do not re-add a dedupe
  // assertion here unless a row starts printing a list again.**
  //
  // The half that survives is the half that mattered: a destination reaching a
  // reader goes through `_plainTarget`. `slack:#ops` is how a delivery is filed,
  // not how it is read.
  test('a failed delivery names where it was going, in words', () => {
    const i = HTML.indexOf('This one fell short');
    assert.ok(i > 0, 'the broken-row explanation must be findable');
    const around = HTML.slice(i - 500, i + 500);
    assert.match(around, /_plainTarget/, '`slack:#ops` is how a delivery is filed, not how it is read');
  });
});
