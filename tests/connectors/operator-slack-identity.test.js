/**
 * A LOGIN EMAIL IS NOT A SLACK ACCOUNT.
 *
 * WITNESSED ON PROD, 2026-07-29. The converger's system prompt said, unconditionally:
 *
 *     When they say "me", "DM me" … deliver via a Slack direct message:
 *     { channel:"slack_dm", user:"<their ATLAS LOGIN email>" }
 *
 * Nothing had ever checked that the login and the Slack account were the same
 * identity. They were not: two approval workflows addressed their DM to
 * `hello@agntic.co`, and the workspace's only Slack email is `charles@agntic.co`.
 * Every run failed the same way — "no Slack user matches" — which is exactly what
 * the destination probe is for and exactly what it reported. The probe was right;
 * the INSTRUCTION was wrong, and it blocked both builds from ever verifying.
 *
 * Diagnosed against the live workspace before any code changed: `users.list` ok,
 * 4 members, `users:read.email` present, no pagination needed — one email, and it
 * was not the login. So this is not a lookup bug.
 *
 * TWO RULES:
 *   · The DM target is resolved from the CONNECTED WORKSPACE, not from the login.
 *   · An unmatched login is never guessed at. DMing the nearest member sends this
 *     person's drafts and approvals to a colleague, so the converger is told to ASK.
 *
 * Also fixed in passing: `users.list` was read one page deep (`limit: 200`, no
 * cursor). Past 200 members the lookup silently resolves nobody, and "not found" is
 * indistinguishable from a wrong address.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSlackCapabilityProvider, listMembers, resolveUser } from '../../src/connectors/slack/index.js';
import { buildSystemPrompt } from '../../src/converger/prompts.js';

/** A workspace spread over three cursor pages, with a bot and a deactivated user. */
const PAGES = [
  { ok: true, members: [{ id: 'U1', profile: { email: 'sam@agntic.co', real_name: 'Sam' } }],
    response_metadata: { next_cursor: 'c1' } },
  { ok: true, members: [{ id: 'U2', profile: { email: 'charles@agntic.co', real_name: 'Charles' } }],
    response_metadata: { next_cursor: 'c2' } },
  { ok: true, members: [
      { id: 'USLACKBOT', profile: { email: 'bot@agntic.co', real_name: 'Slackbot' } },
      { id: 'U4', is_bot: true, profile: { email: 'app@agntic.co', real_name: 'An App' } },
      { id: 'U5', deleted: true, profile: { email: 'gone@agntic.co', real_name: 'Gone' } },
    ], response_metadata: { next_cursor: '' } },
];

/** A fetch double that walks the pages, one per users.list call. */
function stubFetch() {
  let i = 0;
  const f = async (url) => {
    if (String(url).includes('users.list')) {
      const p = PAGES[i++] ?? { ok: true, members: [], response_metadata: { next_cursor: '' } };
      return { json: async () => p };
    }
    return { json: async () => ({ ok: true }) };
  };
  f.reset = () => { i = 0; };
  return f;
}

const providerWith = (fetchImpl) => createSlackCapabilityProvider({ token: 'xoxb-test', fetchImpl });
const resolve = (fetchImpl, email) =>
  providerWith(fetchImpl).resolveOperatorSlackIdentity(null, email, { botToken: 'xoxb-test' });

describe('every page is read, not just the first', () => {
  test('members past the first cursor are found', () => {
    let i = 0;
    const api = { get: async () => PAGES[i++] };
    return listMembers(api).then(all => assert.equal(all.length, 5,
      'a single-page reader sees 1 of 5 and reports "no user found"'));
  });

  test('resolveUser finds someone on a later page', async () => {
    let i = 0;
    const api = { get: async () => PAGES[i++] };
    assert.equal(await resolveUser(api, 'charles@agntic.co'), 'U2');
  });

  test('a genuinely absent address still throws', async () => {
    let i = 0;
    const api = { get: async () => PAGES[i++] };
    await assert.rejects(() => resolveUser(api, 'nobody@agntic.co'), /no user found/);
  });

  test('pagination is bounded', async () => {
    // A workspace that never returns an empty cursor must not stall a build.
    let calls = 0;
    const api = { get: async () => { calls += 1; return { ok: true, members: [{ id: 'U' }], response_metadata: { next_cursor: 'always' } }; } };
    await listMembers(api);
    assert.ok(calls <= 10, `walked ${calls} pages`);
  });
});

describe('the operator is resolved from the workspace', () => {
  test('a login that matches a member resolves to that member', async () => {
    const r = await resolve(stubFetch(), 'charles@agntic.co');
    assert.equal(r.resolved, true);
    assert.equal(r.email, 'charles@agntic.co');
    assert.equal(r.userId, 'U2');
  });

  test('THE PROD CASE: a login that matches nobody resolves to nobody', async () => {
    const r = await resolve(stubFetch(), 'hello@agntic.co');
    assert.equal(r.resolved, false);
    assert.equal(r.email, null, 'inventing an address here is the whole defect');
  });

  test('…and offers the members it CAN see, so the converger can ask', async () => {
    const r = await resolve(stubFetch(), 'hello@agntic.co');
    assert.deepEqual(r.candidates.map(c => c.email).sort(), ['charles@agntic.co', 'sam@agntic.co']);
  });

  test('bots and deactivated accounts are never offered', async () => {
    const r = await resolve(stubFetch(), 'hello@agntic.co');
    const emails = r.candidates.map(c => c.email);
    for (const junk of ['bot@agntic.co', 'app@agntic.co', 'gone@agntic.co']) {
      assert.ok(!emails.includes(junk), junk);
    }
  });

  test('a failure is not fatal — the build proceeds as before', async () => {
    const boom = async () => { throw new Error('slack is down'); };
    const r = await createSlackCapabilityProvider({ token: 'xoxb-test', fetchImpl: boom })
      .resolveOperatorSlackIdentity(null, 'charles@agntic.co', { botToken: 'xoxb-test' });
    assert.equal(r.resolved, false);
    assert.deepEqual(r.candidates, []);
  });

  test('no token means no claim', async () => {
    const r = await providerWith(stubFetch()).resolveOperatorSlackIdentity('some-other-tenant', 'charles@agntic.co', {});
    assert.equal(r.resolved, false);
  });
});

describe('what the converger is told', () => {
  const OP = { name: 'Charles Crepps', email: 'hello@agntic.co' };
  const promptFor = (slack) => buildSystemPrompt({ operator: { ...OP, ...(slack ? { slack } : {}) } });

  test('a verified Slack address is the DM target', () => {
    const p = promptFor({ resolved: true, email: 'charles@agntic.co', name: 'Charles' });
    assert.match(p, /user:"charles@agntic\.co"/);
  });

  test('and the login is explicitly ruled out as a DM target', () => {
    // The model sees both strings; without this it may still reach for the login.
    const p = promptFor({ resolved: true, email: 'charles@agntic.co', name: 'Charles' });
    assert.doesNotMatch(p, /user:"hello@agntic\.co"/);
    assert.match(p, /Never address a Slack DM to their login email/);
  });

  test('an unmatched login is NOT offered as a DM target', () => {
    // The exact prod defect: this string went into a spec and could not deliver.
    const p = promptFor({ resolved: false, candidates: [{ email: 'charles@agntic.co', name: 'Charles' }] });
    assert.doesNotMatch(p, /user:"hello@agntic\.co"/);
    assert.match(p, /CANNOT be delivered/);
  });

  test('…and the model is told to ask, with the real names to choose from', () => {
    const p = promptFor({ resolved: false, candidates: [{ email: 'charles@agntic.co', name: 'Charles' }, { email: 'sam@agntic.co', name: 'Sam' }] });
    assert.match(p, /ASK which of those is them/);
    assert.match(p, /Charles <charles@agntic\.co>, Sam <sam@agntic\.co>/);
  });

  test('guessing is named as the harm, not just discouraged', () => {
    const p = promptFor({ resolved: false, candidates: [{ email: 'sam@agntic.co', name: 'Sam' }] });
    assert.match(p, /delivers their private drafts and approvals to a colleague/);
  });

  test('with Slack unknown, the old behaviour is unchanged', () => {
    // No Slack connected, or the lookup never ran: the login is all we know, and
    // this must not start refusing to build.
    assert.match(promptFor(null), /user:"hello@agntic\.co"/);
  });

  test('no operator at all still produces a prompt', () => {
    assert.ok(buildSystemPrompt({}).length > 0);
    assert.doesNotMatch(buildSystemPrompt({}), /THE OPERATOR/);
  });
});

/**
 * EVERY FACT ABOVE IS ABOUT SLACK, AND SAYING SO IS LOAD-BEARING.
 *
 * WITNESSED ON PROD, 2026-07-30 (`build-platform-1785414984862`): a daily AI-news
 * briefing EMAILED to the operator, no Slack step anywhere in it. The block was
 * phrased as if "send it to me" always meant a Slack DM, so the CANDIDATES branch
 * handed the model a second address under "the workspace members you could DM" and
 * told it to ASK which of them is the user. Both halves leaked into an email-only
 * workflow: the promise was written for the login (`gmail:hello@agntic.co`) while
 * the delivery step was built to the Slack member address (`charles@agntic.co`), so
 * the contract and the only send named two different people — and the user was asked
 * a Slack identity question about a workflow with no Slack in it.
 *
 * Cost: three whole-spec Opus passes trying to reconcile a contradiction the prompt
 * had created, then the rebuild gate refusing the fourth. The instruction was not
 * wrong about Slack; it was wrong to be silent about which channel it governed.
 */
describe('the Slack address never becomes an email recipient', () => {
  const OP = { name: 'Charles Crepps', email: 'hello@agntic.co' };
  const promptFor = (slack) => buildSystemPrompt({ operator: { ...OP, ...(slack ? { slack } : {}) } });

  const CANDIDATES = { resolved: false, candidates: [{ email: 'charles@agntic.co', name: 'Charles' }] };
  const RESOLVED   = { resolved: true, email: 'charles@agntic.co', name: 'Charles' };

  test('THE PROD CASE: the login is named as the address to EMAIL them at', () => {
    // The half that was missing entirely. With only a Slack address on offer, the
    // model reached for it — and `to: "charles@agntic.co"` is what shipped.
    assert.match(promptFor(CANDIDATES), /by EMAIL → to: "hello@agntic\.co"/);
  });

  test('…in every one of the three states, not just this one', () => {
    // A branch that forgets it is the branch the next build lands on.
    for (const [label, slack] of [['candidates', CANDIDATES], ['resolved', RESOLVED], ['neither', null]]) {
      assert.match(promptFor(slack), /by EMAIL → to: "hello@agntic\.co"/, label);
    }
  });

  test('"send it to me" is a PERSON, not a transport', () => {
    // The root phrasing defect: the old block mapped the phrase straight to
    // slack_dm, so the channel the workflow actually used was never consulted.
    const p = promptFor(CANDIDATES);
    assert.match(p, /does not name a channel/);
    assert.match(p, /the channel the workflow actually delivers on/);
  });

  test('the promise and the step are required to name the SAME address', () => {
    // The invariant that was violated: contract said hello@, step said charles@.
    assert.match(promptFor(CANDIDATES), /PROMISE and the STEP name the SAME address/);
  });

  test('the member addresses are marked as Slack accounts, NOT email recipients', () => {
    const p = promptFor(CANDIDATES);
    assert.match(p, /Slack accounts, NOT email recipients/);
    assert.match(p, /sends this person's briefing to a colleague/);
  });

  test('the ask-which-is-you question is scoped to workflows that use Slack', () => {
    // Charles was asked which Slack account was his, about an email briefing.
    const p = promptFor(CANDIDATES);
    assert.match(p, /ONLY IF this workflow reaches them in Slack/);
    assert.match(p, /Do not raise the question at all/);
  });

  test('a verified Slack address is also barred from the email field', () => {
    const p = promptFor(RESOLVED);
    assert.match(p, /never email them at their Slack address/);
    assert.match(p, /If this workflow has no Slack step, their Slack account is irrelevant/);
  });

  test('and none of this weakened the Slack rules it is scoping', () => {
    // The scoping must not become an escape hatch: every guard the 2026-07-29 fix
    // put in is still stated. A "scoped" instruction that no longer forbids the
    // undeliverable DM would trade one silent failure for another.
    assert.match(promptFor(RESOLVED), /Never address a Slack DM to their login email/);
    const p = promptFor(CANDIDATES);
    assert.match(p, /CANNOT be delivered/);
    assert.match(p, /ASK which of those is them/);
    assert.match(p, /delivers their private drafts and approvals to a colleague/);
    assert.doesNotMatch(p, /user:"hello@agntic\.co"/);
  });
});
