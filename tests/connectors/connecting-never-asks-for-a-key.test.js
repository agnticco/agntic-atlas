/**
 * A CUSTOMER IS NEVER ASKED TO CREATE AN APP OR PASTE A KEY.
 *
 * This is the constraint the whole phase is built on, so it is pinned as a
 * PROPERTY of the code rather than as an intention in a comment: the fourth step
 * of the standard's identity chain — prompt the user for credentials — must be
 * unreachable, and a service that exhausts the first three must come back as a
 * refusal a person can act on.
 *
 * ── The two decisions most worth defending ──────────────────────────────────
 *
 * 1. WE NEVER NEGOTIATE DOWN TO `plain`. Notion's live metadata advertises
 *    `['plain','S256']` (measured 2026-08-03). `plain` sends the verifier as its
 *    own challenge and protects nothing — it is in the spec for legacy clients.
 *    Accepting what a server tolerates is exactly wrong here.
 *
 * 2. `resource` RIDES ON BOTH LEGS. Without it a token minted for one MCP server
 *    can be replayed against another trusting the same authorization server. On
 *    one leg only is not half-protection, it is none.
 *
 * ── Mutations, run by hand (2026-08-03) ─────────────────────────────────────
 *   M1  refusal removed — a CIMD-less server proceeds        → 2 red
 *   M2  `plain` accepted when the server offers it           → 1 red
 *   M3  `resource` dropped from the authorize leg            → 1 red
 *   M4  `resource` dropped from the token leg                → 1 red
 *   M5  state reusable (delete after the exchange succeeds)  → 1 red
 *   M6  state not bound to the person who started it         → 1 red
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

// A disposable cache path, set BEFORE the module reads it. Dynamic registration
// persists what a service issued, and a test that wrote to the real file would
// silently poison the next run — and the deployment's own clients file.
process.env.MCP_DCR_FILE = `${tmpdir()}/atlas-dcr-${process.pid}.json`;

import { createMcpConnectFlow, discoverAuthServer, resourceMetadataUrl } from '../../src/connectors/mcp-connect.js';
import { clientIdUrl } from '../../src/connectors/client-identity.js';

/**
 * A server that behaves the way the real ones do — measured against Notion and
 * Linear on 2026-08-03, including Notion's `plain` in the challenge list.
 */
function fakeService({ cimd = true, dcr = true, dcrWorks = true, challenges = ['plain', 'S256'], token = { access_token: 'tok_live', expires_in: 3600 } } = {}) {
  const calls = { authorizeUrl: null, tokenBody: null, tokenHeaders: null, registered: null };
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u === 'https://mcp.acme.test/mcp') {
      return { status: 401, ok: false, headers: { get: () => 'Bearer realm="OAuth", resource_metadata="https://mcp.acme.test/.well-known/oauth-protected-resource/mcp"' } };
    }
    if (u.includes('oauth-protected-resource')) {
      return { ok: true, status: 200, json: async () => ({ resource: 'https://mcp.acme.test', authorization_servers: ['https://auth.acme.test'], scopes_supported: ['default'] }) };
    }
    if (u.includes('oauth-authorization-server')) {
      return { ok: true, status: 200, json: async () => ({
        issuer: 'https://auth.acme.test',
        authorization_endpoint: 'https://auth.acme.test/authorize',
        token_endpoint: 'https://auth.acme.test/token',
        ...(dcr ? { registration_endpoint: 'https://auth.acme.test/register' } : {}),
        ...(cimd ? { client_id_metadata_document_supported: true } : {}),
        code_challenge_methods_supported: challenges,
      }) };
    }
    if (u === 'https://auth.acme.test/register') {
      calls.registered = JSON.parse(opts.body);
      return dcrWorks
        ? { ok: true, status: 201, json: async () => ({ client_id: 'dyn-client-42', client_secret: 'dyn-secret' }) }
        : { ok: false, status: 403, json: async () => ({}) };
    }
    if (u === 'https://auth.acme.test/token') {
      calls.tokenBody = new URLSearchParams(opts.body);
      calls.tokenHeaders = opts.headers ?? {};
      return { ok: true, status: 200, json: async () => token };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { fetchImpl, calls };
}

const START = { tenantId: 't1', userId: 'u1', connector: 'acme', mcpUrl: 'https://mcp.acme.test/mcp', serviceName: 'Acme' };

describe('the chain stops before it can ask a person for a credential', () => {
  test('a server offering NEITHER mechanism is REFUSED, in words', async () => {
    const { fetchImpl } = fakeService({ cimd: false, dcr: false });
    const out = await createMcpConnectFlow({ fetchImpl }).beginConnect(START);

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_identity_mechanism');
    assert.equal(out.authorizeUrl, undefined, 'it must not send the customer anywhere');
    // The refusal has to be usable by a non-technical person and must promise the
    // thing the phase exists for.
    assert.match(out.message, /doesn't yet work with Atlas/i);
    assert.match(out.message, /(never|won't ever) need to create an app or paste a key/i);
  });

  test('nothing anywhere in the flow asks for a secret, a key or a token', async () => {
    // A property, not a spot-check: the refusal path must be the ONLY exit, so
    // there is no shape of response carrying a credential field to fill in.
    const { fetchImpl } = fakeService({ cimd: false, dcr: false });
    const out = await createMcpConnectFlow({ fetchImpl }).beginConnect(START);
    for (const forbidden of ['clientSecret', 'client_secret', 'apiKey', 'api_key', 'token', 'credential'])
      assert.equal(forbidden in out, false, `the refusal must not offer a ${forbidden} field`);
  });

  test('a pre-registered service still connects even without CIMD', async () => {
    // Route 2 is not blocked by route 1's absence — otherwise this guard would
    // quietly kill the hand-registered connectors.
    const { fetchImpl } = fakeService({ cimd: false, dcr: false });
    const out = await createMcpConnectFlow({ fetchImpl })
      .beginConnect({ ...START, hasPreRegistered: true });
    assert.equal(out.ok, true);
    assert.ok(out.authorizeUrl);
  });
});

describe('step 3: Atlas registers ITSELF, and the customer still does nothing', () => {
  beforeEach(() => { try { rmSync(process.env.MCP_DCR_FILE); } catch { /* first run */ } });

  test('a CIMD-less server that offers registration is CONNECTED, not refused', async () => {
    // Measured 2026-08-03: this is the only way Asana and Stripe are reachable.
    // Refusing them for want of CIMD would write off two working services for a
    // reason that has nothing to do with the customer's experience.
    const svc = fakeService({ cimd: false, dcr: true });
    const out = await createMcpConnectFlow({ fetchImpl: svc.fetchImpl }).beginConnect(START);

    assert.equal(out.ok, true);
    assert.equal(new URL(out.authorizeUrl).searchParams.get('client_id'), 'dyn-client-42',
      'the id the service issued us, not our document URL');
    assert.equal(svc.calls.registered.client_name, 'Atlas by Agntic');
    assert.equal('client_id' in svc.calls.registered, false, 'you cannot claim an id while asking to be given one');
  });

  test('registration happens ONCE and is remembered', async () => {
    // Re-registering per restart leaves abandoned client records on the service's
    // side and eventually gets rate-limited.
    const a = fakeService({ cimd: false });
    await createMcpConnectFlow({ fetchImpl: a.fetchImpl }).beginConnect(START);
    const b = fakeService({ cimd: false });
    const second = await createMcpConnectFlow({ fetchImpl: b.fetchImpl }).beginConnect(START);

    assert.equal(b.calls.registered, null, 'the second connect must reuse the first registration');
    assert.equal(new URL(second.authorizeUrl).searchParams.get('client_id'), 'dyn-client-42');
  });

  test('a registration made on one deployment is NEVER reused on another', async () => {
    /**
     * A registration records the callback it was made with. Keyed by issuer
     * alone, the dev box's registration — carrying dev's callback — is reused in
     * production, where the service then sends the customer to a machine they
     * cannot reach. Silent, browser-only, and it looks like the service's fault.
     */
    const base = process.env.OAUTH_REDIRECT_BASE;
    try {
      process.env.OAUTH_REDIRECT_BASE = 'https://dev.example.test';
      const dev = fakeService({ cimd: false });
      await createMcpConnectFlow({ fetchImpl: dev.fetchImpl }).beginConnect(START);
      assert.ok(dev.calls.registered, 'dev registers');

      process.env.OAUTH_REDIRECT_BASE = 'https://prod.example.test';
      const prod = fakeService({ cimd: false });
      await createMcpConnectFlow({ fetchImpl: prod.fetchImpl }).beginConnect(START);

      assert.ok(prod.calls.registered, 'a different deployment must register in its own right');
      assert.deepEqual(prod.calls.registered.redirect_uris, ['https://prod.example.test/connectors/mcp/callback']);
    } finally {
      if (base === undefined) delete process.env.OAUTH_REDIRECT_BASE;
      else process.env.OAUTH_REDIRECT_BASE = base;
    }
  });

  test('a service that REFUSES to register us is refused back — never a credential prompt', async () => {
    const svc = fakeService({ cimd: false, dcrWorks: false });
    const out = await createMcpConnectFlow({ fetchImpl: svc.fetchImpl }).beginConnect(START);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_identity_mechanism');
    // This is the end of the chain. The standard's fourth step goes here, and
    // there is deliberately nothing here.
    assert.equal(out.authorizeUrl, undefined);
  });

  test('a secret the SERVICE issued is presented; one from a customer is never asked for', async () => {
    const svc = fakeService({ cimd: false });
    const flow = createMcpConnectFlow({ fetchImpl: svc.fetchImpl });
    const begun = await flow.beginConnect(START);
    await flow.completeConnect({ state: begun.state, code: 'c1', sessionUserId: 'u1' });
    assert.equal(svc.calls.tokenBody.get('client_secret'), 'dyn-secret',
      'a dynamically issued secret belongs to the deployment and must be presented');
  });
});

describe('S256 only — never what the server will tolerate', () => {
  test('a server offering plain AND S256 gets S256', async () => {
    const { fetchImpl } = fakeService({ challenges: ['plain', 'S256'] });
    const out = await createMcpConnectFlow({ fetchImpl }).beginConnect(START);
    const q = new URL(out.authorizeUrl).searchParams;
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.ok(q.get('code_challenge')?.length >= 40, 'a hashed challenge, not the verifier itself');
  });

  test('a server that can ONLY do plain is refused, not accommodated', async () => {
    const { fetchImpl } = fakeService({ challenges: ['plain'] });
    const out = await createMcpConnectFlow({ fetchImpl }).beginConnect(START);
    assert.equal(out.ok, false, 'plain sends the verifier as its own challenge — that is not a protection');
  });

  test('a server that lists nothing is taken at the spec default, not refused', async () => {
    const { fetchImpl } = fakeService({ challenges: undefined });
    assert.equal((await createMcpConnectFlow({ fetchImpl }).beginConnect(START)).ok, true);
  });
});

describe('the token is bound to the server it was issued for', () => {
  test('resource rides on the authorize leg AND the token leg', async () => {
    const svc = fakeService();
    const flow = createMcpConnectFlow({ fetchImpl: svc.fetchImpl });
    const begun = await flow.beginConnect(START);

    assert.equal(new URL(begun.authorizeUrl).searchParams.get('resource'), 'https://mcp.acme.test');
    await flow.completeConnect({ state: begun.state, code: 'c1', sessionUserId: 'u1' });
    assert.equal(svc.calls.tokenBody.get('resource'), 'https://mcp.acme.test',
      'on one leg only is not half a binding — it is none');
  });

  test('the client id is our published identity, and no secret is ever sent', async () => {
    const svc = fakeService();
    const flow = createMcpConnectFlow({ fetchImpl: svc.fetchImpl });
    const begun = await flow.beginConnect(START);

    assert.equal(new URL(begun.authorizeUrl).searchParams.get('client_id'), clientIdUrl());
    await flow.completeConnect({ state: begun.state, code: 'c1', sessionUserId: 'u1' });
    assert.equal(svc.calls.tokenBody.get('client_id'), clientIdUrl());
    assert.equal(svc.calls.tokenBody.get('client_secret'), null);
    assert.equal(svc.calls.tokenHeaders.authorization, undefined, 'nothing registered us; there is no secret to present');
  });
});

describe('the way back cannot be replayed or borrowed', () => {
  test('a code can be exchanged once', async () => {
    const svc = fakeService();
    const flow = createMcpConnectFlow({ fetchImpl: svc.fetchImpl });
    const begun = await flow.beginConnect(START);
    await flow.completeConnect({ state: begun.state, code: 'c1', sessionUserId: 'u1' });
    await assert.rejects(() => flow.completeConnect({ state: begun.state, code: 'c1', sessionUserId: 'u1' }),
      /already been used|expired/i);
  });

  test('a state is consumed even when the exchange FAILS', async () => {
    // Otherwise a failed attempt leaves a live state a replayed code can use.
    const svc = fakeService({ token: {} });
    const flow = createMcpConnectFlow({ fetchImpl: svc.fetchImpl });
    const begun = await flow.beginConnect(START);
    await assert.rejects(() => flow.completeConnect({ state: begun.state, code: 'c1', sessionUserId: 'u1' }));
    assert.equal(flow._pending.has(begun.state), false);
  });

  test('someone else\'s code is refused', async () => {
    const svc = fakeService();
    const flow = createMcpConnectFlow({ fetchImpl: svc.fetchImpl });
    const begun = await flow.beginConnect(START);
    await assert.rejects(() => flow.completeConnect({ state: begun.state, code: 'c1', sessionUserId: 'someone-else' }),
      /different person/i);
  });

  test('an unknown state is refused in plain words', async () => {
    const svc = fakeService();
    await assert.rejects(
      () => createMcpConnectFlow({ fetchImpl: svc.fetchImpl }).completeConnect({ state: 'made-up', code: 'c1' }),
      /already been used|expired/i);
  });
});

describe('an issuer with a path in it is still found', () => {
  /**
   * THE ONE DEFECT THIS FILE WAS SHIPPED WITH, caught against the live Stripe
   * server on 2026-08-03. RFC 8414 §3.1 inserts the well-known segment BETWEEN
   * THE HOST AND THE PATH; naive concatenation 404s and the service reads as
   * unconnectable when the truth is that we looked in the wrong place.
   *
   * The fixture answers at the CORRECT url only, because a fake that answers at
   * both cannot tell the two apart — which is exactly why the first version of
   * this suite let the mutation survive.
   */
  const pathIssuerService = () => async (url, opts = {}) => {
    const u = String(url);
    if (u === 'https://mcp.pathy.test/mcp' && opts.method === 'POST') {
      return { status: 401, ok: false, headers: { get: () => 'Bearer resource_metadata="https://mcp.pathy.test/.well-known/oauth-protected-resource"' } };
    }
    if (u.includes('oauth-protected-resource')) {
      return { ok: true, json: async () => ({ resource: 'https://mcp.pathy.test', authorization_servers: ['https://access.pathy.test/mcp'] }) };
    }
    // Answers ONLY where the RFC says to look.
    if (u === 'https://access.pathy.test/.well-known/oauth-authorization-server/mcp') {
      return { ok: true, json: async () => ({
        issuer: 'https://access.pathy.test/mcp',
        authorization_endpoint: 'https://access.pathy.test/mcp/oauth2/authorize',
        token_endpoint: 'https://access.pathy.test/mcp/oauth2/token',
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ['S256'],
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  test('the metadata is found where the RFC says, not where concatenation puts it', async () => {
    const d = await discoverAuthServer({ mcpUrl: 'https://mcp.pathy.test/mcp', fetchImpl: pathIssuerService() });
    assert.equal(d.authorizationEndpoint, 'https://access.pathy.test/mcp/oauth2/authorize',
      'the naive issuer+suffix url 404s — finding nothing there is not the same as there being nothing');
    assert.equal(d.supportsCimd, true);
  });

  test('and such a service therefore CONNECTS rather than being written off', async () => {
    const out = await createMcpConnectFlow({ fetchImpl: pathIssuerService() })
      .beginConnect({ ...START, mcpUrl: 'https://mcp.pathy.test/mcp' });
    assert.equal(out.ok, true, 'this is Stripe\'s exact shape');
  });
});

describe('discovery asks the service about itself', () => {
  test('the challenge header names where to look', () => {
    assert.equal(
      resourceMetadataUrl('Bearer realm="OAuth", resource_metadata="https://x.test/.well-known/oauth-protected-resource/mcp", error="invalid_token"'),
      'https://x.test/.well-known/oauth-protected-resource/mcp');
    assert.equal(resourceMetadataUrl('Bearer realm="OAuth"'), null);
    assert.equal(resourceMetadataUrl(undefined), null);
  });

  test('a server that answers without a challenge needs no sign-in at all', async () => {
    const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ result: { tools: [] } }) });
    const d = await discoverAuthServer({ mcpUrl: 'https://open.test/mcp', fetchImpl });
    assert.equal(d.needsAuth, false);
  });

  test('a non-https address is refused — this is not the stdio pool by another name', async () => {
    await assert.rejects(() => discoverAuthServer({ mcpUrl: 'stdio:///usr/bin/thing', fetchImpl: async () => ({}) }),
      /https/i);
  });
});
