/**
 * Connector demand store — records tenant "request access" votes for connectors
 * Atlas hasn't built yet, so the team can prioritise what to build next.
 *
 * JSON-backed (low volume), mirroring the ./memory/*.json store pattern used for
 * web-disabled / airtable-webhooks. Demand is DEDUPED PER TENANT: a connector's
 * count is the number of DISTINCT tenants that asked for it (one company = one
 * vote), not raw click volume. A repeat request from the same tenant refreshes
 * its note/timestamp but never inflates the count.
 *
 * Adding or removing a request-access tile is a one-line edit to
 * REQUESTABLE_CONNECTORS below — no other change needed (UI reads it via the
 * /connectors/requestable endpoint).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Connectors a user can request but that aren't built yet. `id` is a stable slug. */
export const REQUESTABLE_CONNECTORS = [
  { id: 'notion',     name: 'Notion' },
  { id: 'hubspot',    name: 'HubSpot' },
  { id: 'salesforce', name: 'Salesforce' },
  { id: 'ms_teams',   name: 'Microsoft Teams' },
  { id: 'outlook',    name: 'Outlook / M365' },
  { id: 'discord',    name: 'Discord' },
  { id: 'stripe',     name: 'Stripe' },
  { id: 'jira',       name: 'Jira' },
  { id: 'linear',     name: 'Linear' },
  { id: 'github',     name: 'GitHub' },
  { id: 'zendesk',    name: 'Zendesk' },
  { id: 'shopify',    name: 'Shopify' },
];

const REQUESTABLE_IDS = new Set(REQUESTABLE_CONNECTORS.map((c) => c.id));

/** True if `id` is a known requestable (unbuilt) connector. */
export function isRequestable(id) { return REQUESTABLE_IDS.has(id); }

export class ConnectorDemandStore {
  constructor(file = process.env.CONNECTOR_DEMAND_FILE ?? './memory/connector-demand.json') {
    this.file = file;
    this._data = this._load();
  }

  _load() {
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  _save() {
    try { mkdirSync(dirname(this.file), { recursive: true }); } catch { /* ignore */ }
    writeFileSync(this.file, JSON.stringify(this._data, null, 2));
  }

  /**
   * Record a tenant's request for a connector. Deduped per tenant. Returns the
   * connector's new unique-tenant count.
   */
  record(connectorId, { tenantId, userId, note } = {}) {
    if (!tenantId) throw new Error('connector demand: tenantId required');
    const entry = this._data[connectorId] ?? (this._data[connectorId] = { tenants: {} });
    entry.tenants[tenantId] = {
      userId: userId ?? null,
      note: String(note ?? '').slice(0, 500),
      at: new Date().toISOString(),
    };
    this._save();
    return this.countFor(connectorId);
  }

  /** Unique-tenant demand count for a connector. */
  countFor(connectorId) {
    return Object.keys(this._data[connectorId]?.tenants ?? {}).length;
  }

  /** Has this tenant already requested the connector? */
  hasRequested(connectorId, tenantId) {
    return !!this._data[connectorId]?.tenants?.[tenantId];
  }

  /**
   * Per-tenant view for the Connections UI: every requestable connector with its
   * count and whether THIS tenant has already asked.
   */
  listFor(tenantId) {
    return REQUESTABLE_CONNECTORS.map((c) => ({
      id: c.id,
      name: c.name,
      requestCount: this.countFor(c.id),
      youRequested: this.hasRequested(c.id, tenantId),
    }));
  }

  /** Platform-admin aggregate: connectors ranked by demand (which to build next). */
  all() {
    return REQUESTABLE_CONNECTORS
      .map((c) => ({
        id: c.id,
        name: c.name,
        count: this.countFor(c.id),
        tenants: Object.keys(this._data[c.id]?.tenants ?? {}),
      }))
      .sort((a, b) => b.count - a.count);
  }
}
