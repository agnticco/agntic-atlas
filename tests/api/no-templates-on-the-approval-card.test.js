/**
 * THREE THINGS A PERSON READS BEFORE LETTING ATLAS EMAIL A STRANGER.
 *
 * All three witnessed on prod, 2026-07-29, on a lead-intro build (Airtable record →
 * draft → approval → send → mark the row).
 *
 *  1. THE QUESTION ITSELF WAS A TEMPLATE. The approval card's `Asks` row printed
 *     `cfg.prompt` verbatim, DIRECTLY ABOVE the `They also see` row that had just
 *     been fixed for exactly this:
 *
 *       Review this intro email draft for {{extract_contact.contactName}} at
 *       {{extract_trigger.companyName}}. Approve to send it via Gmail, or reject…
 *
 *     An earlier build showed the same leak with Slack emphasis baked in
 *     (`*{{extract_email.sender_name}}*`). This is the last thing a person reads
 *     before agreeing that Atlas may write to someone on their behalf.
 *
 *  2. THE TRIGGER FILTER WAS QUERY SYNTAX. "Only when it matches:
 *     `table:Companies AND field:Relationship Status = Lead`" — on the one row that
 *     says when this workflow starts running against someone's data.
 *
 *  3. AND THE TRIGGER DESCRIPTION WAS FALSE. `_triggerDetail` returned "When a
 *     message is posted in Slack." for ANY event trigger, so an Airtable
 *     record-change trigger was described to the customer as a Slack message. Not
 *     unclear — wrong, about what starts the workflow.
 *
 * ONE RULE FOR REFERENCES. `preview` and `prompt` are two rows on the same card and
 * step instructions are a third surface; writing "what does {{this}} mean" more than
 * once is how this codebase has repeatedly ended up with two answers to one
 * question. `_refPhrase` is the single rule and both callers share it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/** The real helpers, lifted out of the client and run. */
const client = (() => {
  // One method, from its signature to the close at class-member indentation. Anchored
  // on the code rather than on the comments around it, so re-wording a comment cannot
  // silently change what this test is exercising.
  const method = (signature) => {
    const i = HTML.indexOf(signature);
    assert.ok(i > 0, `${signature} is gone — re-point this test`);
    const end = HTML.indexOf('\n  }\n', i);
    assert.ok(end > i, `could not find the end of ${signature}`);
    return HTML.slice(i, end + '\n  }'.length);
  };
  // Joined with COMMAS: these are class-body members in the page (no separators) and
  // object-literal members here. Concatenating them as-is parses in neither.
  const methods = [
    '_refPhrase(id, field, nodes) {',
    '_plainPreview(v, nodes) {',
    '_plainAsk(v, nodes) {',
    '_plainEventFilter(v) {',
  ].map(method);
  // eslint-disable-next-line no-eval
  return eval('({' + methods.join(',\n') + '})');
})();

const NODES = [
  { id: 'extract_contact', label: 'Extract contact name and email' },
  { id: 'draft_intro_email', label: 'Draft intro email' },
];

const PROD_ASK = 'Review this intro email draft for {{extract_contact.contactName}} at '
               + '{{extract_trigger.companyName}}. Approve to send it via Gmail, or reject to '
               + 'cancel (no email will be sent).';

describe('the question a person is asked', () => {
  test('THE PROD CASE: no template survives', () => {
    const r = client._plainAsk(PROD_ASK, NODES);
    assert.doesNotMatch(r, /\{\{|\}\}/);
  });

  test('the field is named, because that is what the sentence is about', () => {
    const r = client._plainAsk(PROD_ASK, NODES);
    assert.match(r, /the contact name/);
    assert.match(r, /the company name/);
  });

  test('every word the model wrote is still there', () => {
    // Subtractive only. A card that quietly rewrote the question would be worse
    // than one that reads awkwardly.
    const r = client._plainAsk(PROD_ASK, NODES);
    for (const kept of ['Review this intro email draft for', 'Approve to send it via Gmail',
                        'reject to cancel', 'no email will be sent']) {
      assert.ok(r.includes(kept), kept);
    }
  });

  test("Slack's emphasis is unwrapped, not printed", () => {
    const r = client._plainAsk('New pricing enquiry from *{{extract_contact.sender_name}}* (x).', NODES);
    assert.doesNotMatch(r, /\*/);
    assert.match(r, /the sender name/);
  });

  test('a generic field names the STEP instead', () => {
    // `output` says nothing; the step it came from does.
    assert.equal(client._plainAsk('Here it is: {{draft_intro_email.output}}', NODES),
      'Here it is: the result of “Draft intro email”');
  });

  test('a reference to a step we cannot find is described, not printed', () => {
    assert.equal(client._plainAsk('See {{ghost.output}}', NODES), 'See the result of the step before it');
  });

  test('a question with no templates is untouched', () => {
    const plain = 'Approve to send this reply, or reject to cancel.';
    assert.equal(client._plainAsk(plain, NODES), plain);
  });

  test('nothing to say yields nothing — no empty row', () => {
    for (const v of ['', '   ', null, undefined]) assert.equal(client._plainAsk(v, NODES), '');
  });

  test('it is wired into the card', () => {
    assert.match(HTML, /_fact\(facts, 'Asks', this\._plainAsk\(cfg\.prompt, nodes\)\)/);
  });
});

describe('one rule for what a reference means', () => {
  test('preview and prompt share it', () => {
    // Two rows on one card. Two rules would drift, which is the defect this
    // codebase keeps re-finding.
    const preview = HTML.slice(HTML.indexOf('_plainPreview(v, nodes) {'), HTML.indexOf('_plainAsk(v, nodes) {'));
    assert.match(preview, /this\._refPhrase\(/);
    const ask = HTML.slice(HTML.indexOf('_plainAsk(v, nodes) {'), HTML.indexOf('_plainEventFilter(v) {'));
    assert.match(ask, /this\._plainPreview\(/, 'the ask must go through the same resolution');
  });

  test('a named field beats the step label', () => {
    assert.equal(client._refPhrase('extract_contact', 'contactName', NODES), 'the contact name');
  });

  test('snake_case and camelCase both read as words', () => {
    assert.equal(client._refPhrase('x', 'sender_email', NODES), 'the sender email');
    assert.equal(client._refPhrase('x', 'companyName', NODES), 'the company name');
  });

  test('generic fields fall back to the step', () => {
    for (const f of ['output', 'text', 'body', 'result', 'value']) {
      assert.equal(client._refPhrase('draft_intro_email', f, NODES), 'the result of “Draft intro email”');
    }
  });

  test('an unlabelled step never shows its id', () => {
    const r = client._refPhrase('draft_intro_email', 'output', [{ id: 'draft_intro_email', label: '' }]);
    assert.doesNotMatch(r, /draft_intro_email/);
  });
});

describe('an event filter is not a sentence', () => {
  test('THE PROD CASE', () => {
    assert.equal(client._plainEventFilter('table:Companies AND field:Relationship Status = Lead'),
      'in the Companies table, when Relationship Status is Lead');
  });

  test('a table alone', () => {
    assert.equal(client._plainEventFilter('table:Leads'), 'in the Leads table');
  });

  test('a field that merely changes', () => {
    assert.equal(client._plainEventFilter('field:Status'), 'when Status changes');
  });

  test('values with spaces in them survive', () => {
    // `_plainFilter` splits on whitespace and would shred this — which is exactly
    // why this is a separate renderer rather than a new branch in that one.
    assert.match(client._plainEventFilter('field:Relationship Status = Lead'), /Relationship Status is Lead/);
  });

  test('anything that is not this shape is returned untouched', () => {
    // Losing a filter silently is worse than reading oddly.
    for (const v of ['#ops', 'a plain sentence someone wrote', '', 'U0B3LM5KRGV']) {
      assert.equal(client._plainEventFilter(v), v);
    }
  });

  test('…including one with AND in it that is NOT key:value', () => {
    // The case the guard actually exists for, and the only one that proves it: the
    // inputs above survive with or without it (they simply fail the per-part match
    // and pass through), so a mutation deleting the guard went unnoticed until this.
    // Without it, "Monday AND Friday" comes back as "Monday, Friday" — a filter
    // quietly reworded into something that reads like a list.
    assert.equal(client._plainEventFilter('Monday AND Friday'), 'Monday AND Friday');
  });

  test('an operator we do not recognise keeps its value', () => {
    assert.equal(client._plainEventFilter('view:Grid view'), 'view Grid view');
  });

  test('it is wired into the trigger card', () => {
    assert.match(HTML, /'Only when it matches', this\._plainEventFilter\(f\)/);
  });
});

describe('not every event is a Slack message', () => {
  const detail = (() => {
    const i = HTML.indexOf('_triggerDetail(t) {');
    assert.ok(i > 0, '`_triggerDetail` is gone — re-point this test');
    return HTML.slice(i, HTML.indexOf('\n  _nodeDetail', i));
  })();

  test('an Airtable record trigger is not described as Slack', () => {
    // The whole defect: this returned "When a message is posted in Slack." for ANY
    // event trigger.
    assert.match(detail, /conn === 'slack'/);
    assert.match(detail, /When something changes in/);
  });

  test('Slack keeps its own wording', () => {
    // Its filter IS a channel, so the old sentence is right for it.
    assert.match(detail, /When a message is posted/);
  });

  test('and the non-Slack filter is rendered in words', () => {
    assert.match(detail, /_plainEventFilter\(t\.filter\)/);
  });
});
