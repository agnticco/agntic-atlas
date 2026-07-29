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
