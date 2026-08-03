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
