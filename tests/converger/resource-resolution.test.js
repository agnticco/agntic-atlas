/**
 * RESOURCE_NOT_FOUND resolution — create-or-pick through the REAL graph (Increment #25).
 *
 * Drives `createConverger` → run → resume the way builder.js does, with a live-session
 * `capabilities` (connectors + slackChannels) so the resource check is ON. Proves:
 *   · a build wiring to a non-existent Slack channel surfaces a `resource_fix`
 *     clarification with a Create chip AND existing-channel chips;
 *   · PICKING an existing channel repoints the node and converges (gap cleared);
 *   · CREATING re-uses the setup_action interrupt (a `proposal` for slack_create_channel),
 *     optimistically registers the channel, and converges.
 *
 * The two-interrupt CREATE path also exercises the resume mechanics: the clarification
 * and the setup proposal are in DIFFERENT node executions (gaps → resourceSetup), which
 * is required because resume() carries a single value per round-trip.
 */

import { test, describe, after } from 'node:test';
import assert                    from 'node:assert/strict';
import { mkdtempSync, rmSync }   from 'node:fs';
import { tmpdir }                from 'node:os';
import { join }                  from 'node:path';

import { createConverger } from '../../src/converger/index.js';
import { realCatalog }     from '../helpers/catalog.js';

const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-rr-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

const J = (o) => ({ content: JSON.stringify(o) });

const CAPS = () => ({
  channels: realCatalog().getAll().map(c => ({ ...c, available: true })),
  connectors: { slack: { connected: true }, airtable: { connected: false } },
  slackChannels: ['ops', 'general'],       // NOT '#does-not-exist'
});

// A stub model that builds: email trigger → summarize → Slack post to a MISSING channel.
const llm = { invoke: async (msgs) => {
  const p = String(msgs[msgs.length - 1].content);
  if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1',
    statement: 'UPS emails summarized to Slack.',
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#does-not-exist' }] }] });
  if (p.includes('What starts this workflow')) return J({ trigger: { type: 'email', filter: 'from:ups.com' } });
  if (p.includes('CONCRETE example cases'))    return J({ examples: [] });
  if (p.includes('Analyze this automation intent')) return J({ ready: true });
  if (p.includes('Is this workflow FINISHED'))      return J({ complete: true });
  if (p.includes('cases nobody has decided about')) {
    const ids = [...p.matchAll(/^ {2}- id: (\S+)$/gm)].map(m => m[1]);
    return J({ suggestions: ids.map(id => ({ gapId: id, answer: 'retry then tell a person' })) });
  }
  if (p.includes('Build the COMPLETE workflow')) {
    return J({ name: 'UPS digest', triggers: [{ type: 'email', filter: 'from:ups.com' }],
      nodes: [
        { id: 'sum',  type: 'llm', label: 'Summarize', config: { mode: 'summarize', instructions: 'Summarize the shipment update.' } },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#does-not-exist' } },
      ],
      edges: [{ from: 'sum', to: 'post' }] });
  }
  return J({});
} };

/** Drive the loop; `onResourceFix` picks the reply to the resource clarification. */
async function drive({ onResourceFix, onProposal = () => ({ type: 'approve' }) }) {
  const conv = createConverger({ llm, capabilities: CAPS(), invokeCapability: null, checkpointerDir: scratch() });
  const seen = [];
  const replyFor = (iv) => {
    switch (iv.type) {
      case 'outcome_check':   return { id: 'c1' };
      case 'example_request': return { type: 'skip' };
      case 'clarification':
        if (iv.kind === 'resource_fix') return onResourceFix(iv);
        return { answer: 'retry then tell a person' };      // gap_review / other
      case 'proposal':        return onProposal(iv);
      case 'ratify':          return { type: 'approve' };
      default:                return { type: 'accept' };
    }
  };

  let iv;
  try { await conv.run('g1', 'summarize UPS emails to slack'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  for (let i = 0; i < 60 && iv?.type !== 'done'; i++) {
    seen.push(iv);
    iv = await conv.resume('g1', replyFor(iv));
  }
  return { spec: iv?.spec ?? null, seen };
}

const postNode = (spec) => (spec?.nodes ?? []).find(n => n.id === 'post');

describe('the resource clarification is surfaced with create + pick chips', () => {
  test('carries a `choices` array: a Create option PLUS one chip per existing channel', async () => {
    let fix = null;
    const { spec } = await drive({ onResourceFix: (iv) => { fix = iv; return { answer: '#ops' }; } });
    assert.ok(fix, 'a resource_fix clarification must be surfaced');
    assert.ok(Array.isArray(fix.choices) && fix.choices.length,
      'the interrupt MUST carry a non-empty `choices` array so the client renders chips');
    const labels = fix.choices.map(c => c.label);
    assert.ok(labels.some(l => /create #does-not-exist/i.test(l)), `expected a Create chip; got ${labels.join(' | ')}`);
    // One chip per EXISTING channel (from capabilities.slackChannels), labelled #name.
    assert.ok(labels.includes('#ops'),     `expected a #ops chip; got ${labels.join(' | ')}`);
    assert.ok(labels.includes('#general'), `expected a #general chip; got ${labels.join(' | ')}`);
    assert.ok(spec, 'the build converged to a spec');
  });
});

// The REAL client (public/index.html:4802-4808) sends a chip click as
// { type:'clarification', answer: <chip label> } — NOT the chip id. So the resolution
// MUST work off the label text. These drive it exactly that way.
describe('PICK an existing channel (via the chip LABEL, as the client sends it)', () => {
  test('answering with "#ops" repoints the deliver node and converges', async () => {
    const { spec } = await drive({ onResourceFix: () => ({ answer: '#ops' }) });
    assert.ok(spec, 'converged');
    assert.equal(postNode(spec).config.target, '#ops', 'the target was repointed at the picked channel');
  });
});

describe('CREATE the channel via the chip LABEL (reuses the setup_action path)', () => {
  test('answering with "Create #does-not-exist" emits a slack_create_channel setup proposal, then converges', async () => {
    let setupProposal = null;
    const { spec } = await drive({
      onResourceFix: () => ({ answer: 'Create #does-not-exist' }),
      onProposal: (iv) => {
        if (iv.proposal?.component === 'setup_action') {
          setupProposal = iv.proposal;
          // Mimic the client: it POSTed to /setup and got the created channel back.
          return { type: 'setup_executed', result: { delivered: true, name: 'does-not-exist', channelId: 'C0999' } };
        }
        return { type: 'approve' };
      },
    });
    assert.ok(setupProposal, 'a setup_action proposal must be emitted for the create path');
    assert.equal(setupProposal.capabilityId, 'slack_create_channel');
    assert.equal(setupProposal.params.name, 'does-not-exist');
    assert.ok(spec, 'the build converged after the channel was created');
    // The (now-created) channel stays the target — creating fulfils the user's intent.
    assert.equal(postNode(spec).config.target, '#does-not-exist');
  });
});
