/**
 * A DELIVERY CAN SIT IN THE MIDDLE OF A WORKFLOW.
 *
 * "Save it as a Google Doc and email me the link" was not expressible. The
 * converger's prompt said "Deliver nodes are always terminal (nothing runs after
 * them)", and the doc-creating step IS a delivery — so nothing could ever read
 * the link it returns. The model obeyed, reworded the email to say "open Google
 * Drive to read the full digest" (silently substituting what the user asked for),
 * and the sufficiency check then correctly objected that the promised link was
 * never sent. Unwinnable: five whole-spec regenerations, an identical 6-node
 * draft every time, then the cap.
 *
 * The rule was stricter than the engine. This suite pins that it always was:
 *
 *   1. the engine RUNS a chain that continues past a delivery,
 *   2. the delivery's return value is REFERENCEABLE downstream ({{id.field}}),
 *   3. the step after it still receives the real CONTENT, not the receipt,
 *   4. the graph DRAWS the connector out of a mid-chain delivery,
 *   5. …and still omits it for a genuinely terminal one.
 *
 * (4) and (5) are the rendering half: a connector arrow is a claim about the
 * EDGES, not about a node's type. Asserting only (1)-(3) would leave the graph
 * showing the chain broken exactly where it carries on.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import fs                 from 'node:fs';
import path               from 'node:path';
import { fileURLToPath }  from 'node:url';

import { FlowTester }       from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

/** write → make_doc(deliver) → compose(llm, references the doc link) → send(deliver) */
const chainSpec = () => ({
  name: 'Weekly digest',
  triggers: [{ type: 'schedule', config: { cron: '0 9 * * 1' } }],
  nodes: [
    { id: 'write',    type: 'llm',     config: { mode: 'freeform', prompt: 'write the digest' } },
    { id: 'make_doc', type: 'deliver', config: { channel: 'docs_create', title: 'Digest' } },
    { id: 'compose',  type: 'llm',     config: { mode: 'freeform', prompt: 'The doc is at {{make_doc.link}} — include it.' } },
    { id: 'send',     type: 'deliver', config: { channel: 'gmail_send', to: 'c@x.com', subject: 'Digest' } },
  ],
  edges: [{ from: 'write', to: 'make_doc' }, { from: 'make_doc', to: 'compose' }, { from: 'compose', to: 'send' }],
});

function harness() {
  const sent = [];
  const seen = {};
  const channelRegistry = {
    get: (id) => ({ id, available: true }),
    getHandler: (id) => async (args) => {
      sent.push({ id, args });
      // The real docs_create returns exactly this (src/connectors/google/index.js:570).
      if (id === 'docs_create') return { documentId: 'doc123', link: 'https://docs.google.com/document/d/doc123' };
      return { delivered: true, ts: '1.0' };
    },
  };
  const llm = { invoke: async (msgs) => {
    const text = JSON.stringify(msgs);
    const m = text.match(/The doc is at (\S+?) —/);
    if (m) seen.link = m[1];
    if (/The doc is at/.test(text)) { seen.composeSawContent = /THE DIGEST BODY/.test(text); return { content: 'EMAIL BODY' }; }
    return { content: 'THE DIGEST BODY' };
  } };
  return { sent, seen, ft: new FlowTester({ nodeTypes, llm, channelRegistry }) };
}

describe('a delivery in the middle of a chain', () => {
  test('the engine runs every step, in order, past the delivery', async () => {
    const h = harness();
    const ev = [];
    for await (const e of h.ft.run(chainSpec(), {})) ev.push(e);

    assert.equal(ev.find(e => e.type === 'run_failed'), undefined, 'the chain must not fail');
    assert.deepEqual(
      ev.filter(e => e.type === 'step_completed').map(e => e.nodeId),
      ['write', 'make_doc', 'compose', 'send'],
      'a delivery is not a full stop',
    );
  });

  test("the delivery's RETURN VALUE is referenceable downstream", async () => {
    const h = harness();
    for await (const _ of h.ft.run(chainSpec(), {})) { /* drain */ }
    assert.equal(h.seen.link, 'https://docs.google.com/document/d/doc123',
      '{{make_doc.link}} must resolve to what the handler returned — this is the whole ' +
      'reason "email me the link to the doc" is expressible');
  });

  test('the step after a delivery receives the CONTENT, not the receipt', async () => {
    // `deliver` is a CONTROL type: its receipt must never become `lastOutput`.
    // If it did, the email would be composed from {"documentId":…} instead of the digest.
    const h = harness();
    for await (const _ of h.ft.run(chainSpec(), {})) { /* drain */ }
    assert.equal(h.seen.composeSawContent, true,
      'the composing step must still see the digest body as its input');
    const email = h.sent.find(s => s.id === 'gmail_send');
    assert.ok(email, 'the email must be sent');
    const body = JSON.stringify(email.args);
    assert.ok(!/documentId/.test(body), 'the doc receipt must not be delivered to the customer');
  });
});

// ── the rendering half ──────────────────────────────────────────────────────

const HTML = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');

describe('the graph draws the connector out of a mid-chain delivery', () => {
  test('showConn is derived from the EDGES, not from the node type', () => {
    // Pinned at the source rather than by rendering the page: the expression must
    // consult the edge set, so a delivery that continues gets its arrow. Written
    // as a behavioural claim about the code the browser runs.
    const m = HTML.match(/showConn:[^\n]*/);
    assert.ok(m, 'showConn must exist');
    assert.match(m[0], /_hasOutEdge/,
      'a connector arrow is a claim about the edges; deriving it from `isDeliver` alone ' +
      'draws the chain as broken exactly where it carries on');
    assert.match(HTML, /this\._hasOutEdge = new Set\(/,
      'the outgoing-edge set must be built from spec.edges before cards are made');
  });

  test('the type default is still respected — additive only', () => {
    // The fix must not START drawing arrows off terminal deliveries or stops.
    const m = HTML.match(/showConn:[^\n]*/)[0];
    assert.match(m, /!isDeliver && !isStop/,
      'the original type default must remain as the base case, widened by the edge set — ' +
      'not replaced, or a terminal delivery grows a dangling arrow');
  });
});
