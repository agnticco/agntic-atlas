/**
 * WHAT THIS WORKSPACE IS CONNECTED TO — ONE ANSWER, NOT THREE.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * "Which services can this tenant use?" was written out by hand in THREE places:
 * `/capabilities`, the builder session endpoint (which is what the interview and
 * the chat read), and the credential resolver. Each was a literal naming the
 * connectors that happened to exist when it was written.
 *
 * P13-0 already fixed the third for exactly this reason — R22: a capability
 * missing from a hand-typed list gets no credential at run time even though the
 * customer IS connected — and it did not occur to anyone that the same sentence
 * was written twice more. So when Notion connected for the first time, its 20
 * tools were in the catalog and Atlas told the customer, twice, that Notion was
 * not connected and refused to build. Fixing the first literal changed nothing a
 * person could see, because the interview reads the second.
 *
 * This repo has recorded a rule living in two places nine times, and the entry
 * always ends the same way: collapse them. So rather than correct a third
 * literal, both callers now ask this.
 *
 * ── Connected but UNREADABLE is not connected, and that is deliberate ───────
 *
 * A grant proves the customer authorised us. It does not prove we could read the
 * service's catalog — and production hit exactly that state first: token stored,
 * catalog unreadable, zero tools. A workflow cannot be built on tools we could
 * not list, so offering the service as available would be promising what we
 * cannot do, which is the defect this whole area keeps producing.
 *
 * Requiring at least one capability also makes this FAIL CLOSED on the case that
 * matters: silence from the registry withholds a service rather than inventing
 * one.
 */

import { MCP_DIRECTORY } from './mcp-directory.js';
import { registerMcpCatalog } from './mcp-catalog.js';

/** The per-tenant owner key MCP grants are stored under. */
export const mcpOwnerId = (tenantId) => `wsinstall:${tenantId}`;

/** The connector id a grant is stored under, namespaced so it cannot collide. */
export const mcpConnectorId = (serverId) => `mcp:${serverId}`;

/**
 * Every service this tenant has connected AND whose tools we can actually offer.
 *
 * Shaped like the native connector status objects (`{connected, name, actions}`)
 * because every consumer already reads that shape — a second shape would be a
 * second thing to teach them, which is the fragmentation this ends.
 *
 * @param {object}  a
 * @param {object}  a.capabilityRegistry  the one catalog
 * @param {object}  a.oauthTokenStore     where grants live
 * @param {string}  a.tenantId
 */
export function mcpConnectedFor({ capabilityRegistry, oauthTokenStore, tenantId }) {
  const out = {};
  if (!capabilityRegistry || !oauthTokenStore || !tenantId) return out;

  for (const svc of MCP_DIRECTORY) {
    let granted = false;
    try {
      granted = !!oauthTokenStore.get({
        tenantId, userId: mcpOwnerId(tenantId), connectorId: mcpConnectorId(svc.id),
      });
    } catch { granted = false; }          // a store that cannot answer is a NO
    if (!granted) continue;

    const actions = capabilityRegistry.list()
      .filter((c) => c.connector === svc.id)
      .map((c) => ({ id: c.id, name: c.name, description: c.description, available: c.available !== false }));

    if (!actions.length) continue;        // connected but unreadable — see the header
    out[svc.id] = { connected: true, name: svc.name, actions };
  }
  return out;
}


/**
 * MAKE SURE A CONNECTED SERVICE'S TOOLS ARE ACTUALLY LOADED.
 *
 * ── Why this is not optional, and why it lives HERE ─────────────────────────
 *
 * The grant is on disk; the catalog is in memory. So after every restart the
 * token is still there and the tools are gone, and `mcpConnectedFor` above —
 * which requires at least one capability, deliberately — correctly reports the
 * service as unavailable.
 *
 * WITNESSED 2026-08-03: with everything else fixed, the chat still told the
 * customer Notion was not connected, and then agreed it WAS the moment
 * `/capabilities` had been called — because that endpoint was the only one that
 * loaded the catalog. So the answer depended on which page you had visited
 * first, and immediately after every deploy the first person to build was told
 * their service was missing.
 *
 * It sits beside `mcpConnectedFor` because the two are one thought: anything
 * that asks "what is connected" must first make sure it can see it. Splitting
 * them is how the question got six different answers in the first place.
 *
 * ── Cheap, and safe to call on every request ────────────────────────────────
 *
 * Loaded services are remembered per PROCESS (the tool list is a property of the
 * service, not of a tenant — only the token is per-tenant), so this costs one
 * request per service per restart. The memo is claimed BEFORE the await so two
 * concurrent requests cannot both fetch, and RELEASED on failure so an
 * unreachable service is retried rather than written off until the next deploy.
 */
const loaded = new Set();

export async function ensureMcpToolsLoaded({ capabilityRegistry, oauthTokenStore, tokenCipher, tenantId, onEvent }) {
  if (!capabilityRegistry || !oauthTokenStore || !tokenCipher || !tenantId) return;

  await Promise.all(MCP_DIRECTORY.map(async (svc) => {
    if (loaded.has(svc.id)) return;
    let grant = null;
    try {
      grant = oauthTokenStore.get({
        tenantId, userId: mcpOwnerId(tenantId), connectorId: mcpConnectorId(svc.id),
      });
    } catch { return; }
    if (!grant) return;

    loaded.add(svc.id);
    try {
      const token = tokenCipher.decrypt(grant.access_token_enc);
      const out = await registerMcpCatalog(capabilityRegistry, {
        url: svc.url, connector: svc.id, headers: { authorization: `Bearer ${token}` },
      });
      onEvent?.('mcp.catalog.loaded', { tenant: tenantId, server: svc.id, tools: out.count, skipped: out.skipped.length });
    } catch (err) {
      loaded.delete(svc.id);   // retryable — never silently unavailable until a deploy
      onEvent?.('mcp.catalog.failed', { tenant: tenantId, server: svc.id, error: String(err.message).slice(0, 200) });
    }
  }));
}

/** Test seam: forget what has been loaded, so a suite starts from cold. */
export function _resetMcpLoaded() { loaded.clear(); }
