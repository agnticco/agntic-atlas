/**
 * NOBODY APPROVES WHAT THEY HAVE NOT BEEN SHOWN.
 *
 * WITNESSED ON PROD, 2026-07-29. A pricing-approval workflow: AI drafts a reply,
 * Charles gets a Slack DM, and the reply is sent to the enquirer only if he approves.
 * The step card for that approval read:
 *
 *     Asks   New pricing enquiry from … Please review the draft reply below.
 *            If you approve, it will be sent to the sender.
 *
 * — and showed nothing below it. The `human` node's own schema calls `preview`
 * "what they actually see", the generator had correctly set it to
 * `{{draft_reply.output}}`, and this card never rendered the field at all. So the
 * person confirming the step before it goes live could not tell whether the draft
 * would be attached or whether they were about to ship an approval request with
 * nothing in it.
 *
 * This is the same rule as the confirm-action card that once listed three identical
 * "Add Airtable Column" rows (`confirm-action-card.test.js`): the last gate before
 * Atlas acts must say what it is acting on.
 *
 * AND IT MUST BE SAID IN WORDS. `preview` is a template. Printing
 * `{{draft_reply.output}}` on a customer-facing card would swap one defect for
 * another — see `plain-english-surfaces.test.js`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/** The real `_plainPreview`, lifted out of the client and run. */
const plainPreview = (() => {
  const i = HTML.indexOf('_plainPreview(v, nodes) {');
  assert.ok(i > 0, '`_plainPreview` is gone — re-point this test');
  // Lift each method WHOLE — signature to its close at class-member indentation —
  // and join with commas. Slicing "up to the next named method" broke the moment
  // another method was added between them, and concatenating class members without
  // separators parses as neither a class body nor an object literal.
  const method = (signature) => {
    const at = HTML.indexOf(signature);
    assert.ok(at > 0, `${signature} is gone — re-point this test`);
    const end = HTML.indexOf('\n  }\n', at);
    assert.ok(end > at, `could not find the end of ${signature}`);
    return HTML.slice(at, end + '\n  }'.length);
  };
  // `_plainPreview` delegates the "what does this reference mean" rule to
  // `_refPhrase`, so both are needed to run it.
  const src = [method('_refPhrase(id, field, nodes) {'), method('_plainPreview(v, nodes) {')].join(',\n');
  // eslint-disable-next-line no-eval
  const host = eval('({' + src + '})');
  return (v, nodes) => host._plainPreview(v, nodes);
})();

const NODES = [
  { id: 'draft_reply', label: 'Draft acknowledgement reply' },
  { id: 'classify', label: 'Is this a pricing enquiry?' },
];

describe('the card renders it at all', () => {
  const humanBranch = (() => {
    const i = HTML.indexOf("} else if (ty === 'human') {");
    assert.ok(i > 0, 'the human step branch moved — re-point this test');
    return HTML.slice(i, i + 1800);
  })();

  test('the approval card shows what the approver will see', () => {
    assert.match(humanBranch, /_fact\(facts, 'They also see', this\._plainPreview\(cfg\.preview, nodes\)\)/,
      'the field the node type calls "what they actually see" was never rendered');
  });

  test('it still shows the question, the channel and the timeout', () => {
    // The addition must not have displaced anything: this card is the whole reason
    // an approval can be confirmed safely.
    for (const k of ['Asks', 'Who is asked', 'Asked in', 'Possible answers', 'If nobody answers']) {
      assert.ok(humanBranch.includes(`'${k}'`), k);
    }
  });
});

describe('and says it in words, not in a template', () => {
  test('THE PROD CASE: a reference becomes the step it names', () => {
    assert.equal(plainPreview('{{draft_reply.output}}', NODES), 'the result of “Draft acknowledgement reply”');
  });

  test('no raw {{…}} ever reaches the card', () => {
    const inputs = ['{{draft_reply.output}}', '{{draft_reply}}', '{{nobody.output}}',
                    'Here is the draft:\n{{draft_reply.output}}', '{{ classify . output }}'];
    for (const v of inputs) {
      assert.doesNotMatch(plainPreview(v, NODES), /\{\{|\}\}/, v);
    }
  });

  test('prose around a reference is kept, not thrown away', () => {
    // It is what the approver reads. Replacing the whole thing with a generic phrase
    // loses real content.
    const r = plainPreview('Here is the draft:\n{{draft_reply.output}}', NODES);
    assert.match(r, /Here is the draft:/);
    assert.match(r, /Draft acknowledgement reply/);
  });

  test('a reference to a step we cannot find is described, not printed', () => {
    assert.equal(plainPreview('{{nobody.output}}', NODES), 'the result of the step before it');
  });

  test('literal text is shown exactly as it will appear', () => {
    assert.equal(plainPreview('Approve to send this reply.', NODES), 'Approve to send this reply.');
  });

  test('nothing to show yields nothing — no empty row', () => {
    for (const v of ['', '   ', null, undefined]) assert.equal(plainPreview(v, NODES), '');
  });

  test('a missing node list does not throw', () => {
    // `_stepDetail` can be called before the spec's nodes are populated.
    assert.equal(plainPreview('{{draft_reply.output}}', null), 'the result of the step before it');
    assert.equal(plainPreview('{{draft_reply.output}}', undefined), 'the result of the step before it');
  });

  test('an unlabelled step falls back rather than showing its id', () => {
    // A node id is machine text; it is not what this card is for.
    const r = plainPreview('{{draft_reply.output}}', [{ id: 'draft_reply', label: '' }]);
    assert.equal(r, 'the result of the step before it');
    assert.doesNotMatch(r, /draft_reply/);
  });
});
