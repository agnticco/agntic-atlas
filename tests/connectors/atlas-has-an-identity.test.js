/**
 * WHO ATLAS IS, TO A SERVICE IT HAS NEVER MET. (P13-A, first half.)
 *
 * The phase's constraint, from the operator: a customer must NEVER be sent into a
 * developer settings screen to create an app, pick permissions and paste a secret.
 * That leaves two ways to connect a service, and this is the one that needs no
 * setup by anyone — Atlas publishes one identity document at an address it owns,
 * and that ADDRESS IS ITS IDENTITY with every service supporting the standard.
 *
 * ── The rule this file exists to hold ───────────────────────────────────────
 *
 * The standard's identity order is:
 *
 *   pre-registered → CIMD → dynamic registration → PROMPT THE USER
 *
 * IMPLEMENT THE FIRST THREE AND STOP. That fourth step IS the banned settings
 * screen, and a naive implementation of the spec falls through to it by default —
 * which is exactly why its absence is asserted here rather than left as an
 * omission someone later fills in helpfully.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  CIMD_PATH, clientIdUrl, clientIdMetadata, redirectUris, identityChain, unsupportedService,
} from '../../src/connectors/client-identity.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = readFileSync(path.join(ROOT, 'src/api/server.js'), 'utf8');

describe('the document IS the identity', () => {
  test('client_id equals the document\'s own URL', () => {
    // The whole mechanism. A server receives a URL as the client id, fetches it,
    // and reads this to learn who is asking. If the two disagree the identity is
    // unresolvable — and nothing else in the phase can work.
    assert.equal(clientIdMetadata().client_id, clientIdUrl());
    assert.ok(clientIdUrl().endsWith(CIMD_PATH));
  });

  test('it is served at that exact path, publicly', () => {
    // Unauthenticated by necessity: a remote server fetches this while deciding
    // whether to talk to us, long before a customer is involved. Requiring auth
    // would make Atlas unidentifiable to every service in the phase.
    assert.match(SERVER, /app\.get\(CIMD_PATH, \(_req, res\) => \{/,
      'the identity document must be served at the path that names it');
    const i = SERVER.indexOf('app.get(CIMD_PATH');
    const route = SERVER.slice(i, i + 260);
    assert.doesNotMatch(route, /requireAuth|requireActiveTenant|tenantGuard/,
      'a document a stranger must read cannot sit behind a login');
  });

  test('it declares a public client, and says so honestly', () => {
    const m = clientIdMetadata();
    // No secret because nothing registered us — that is the mechanism, not a gap.
    assert.equal(m.token_endpoint_auth_method, 'none');
    assert.deepEqual(m.code_challenge_methods_supported, ['S256'],
      'PKCE carries the security here; `plain` is in the spec and is not a protection');
    assert.ok(m.redirect_uris.length && m.redirect_uris.every(u => u.startsWith('https://') || u.startsWith('http://localhost')),
      'a redirect must be somewhere a code can actually come back to');
  });

  test('the redirect set is STABLE — it is part of the identity', () => {
    // One shared callback for MCP-sourced connectors, not a path per server. A
    // document that changes whenever a connector is added is not an identity.
    assert.equal(redirectUris().length, 1);
    assert.match(redirectUris()[0], /\/connectors\/mcp\/callback$/);
  });
});

describe('the chain stops before it reaches a customer', () => {
  test('the three permitted steps, in order', () => {
    assert.deepEqual(
      identityChain({ hasPreRegistered: true, supportsCimd: true, supportsDcr: true }),
      ['pre_registered', 'cimd', 'dcr']);
  });

  test('and NOTHING follows them — no fourth step exists to fall through to', () => {
    // Asserted as an ABSENCE by construction. The banned step is not filtered out
    // at the end of a longer list; it was never in one, so nothing downstream can
    // reach it by iterating one element further.
    const every = identityChain({ hasPreRegistered: true, supportsCimd: true, supportsDcr: true });
    assert.equal(every.length, 3);
    for (const step of every) {
      assert.doesNotMatch(step, /prompt|credential|secret|token|paste|manual/i,
        `"${step}" reads like asking the customer — that is the one thing this may never do`);
    }
  });

  test('a server supporting none of them yields "not supported yet", never a form', () => {
    const r = unsupportedService('Widgetly');
    assert.equal(r.supported, false);
    assert.match(r.message, /Widgetly/, 'name the service so the answer is actionable');
    assert.match(r.message, /won.t ever need to create an app or paste a key/i,
      'the promise the whole phase rests on must be restated where it is refused');
    assert.doesNotMatch(r.message, /client id|client secret|api key|developer|console|settings/i,
      'a refusal must not become the developer errand it exists to prevent');
  });

  test('each step appears only when the server actually offers it', () => {
    // The anti-overreach direction: claiming CIMD against a server that does not
    // support it would send an unresolvable id and fail late instead of early.
    assert.deepEqual(identityChain({}), []);
    assert.deepEqual(identityChain({ supportsCimd: true }), ['cimd']);
    assert.deepEqual(identityChain({ supportsDcr: true }), ['dcr']);
  });
});
