/**
 * Airtable connector (P7).
 *
 * Auth: Personal Access Token (PAT) — per-user, stored encrypted in the vault.
 * Users generate a PAT at airtable.com/create/tokens with the scopes:
 *   data.records:read  data.records:write  webhook:manage
 *
 * Webhook model: real Airtable webhook subscriptions. When a workflow with an
 * `airtable_record_changed` trigger is published, Atlas registers a webhook on
 * the Airtable base. Notifications fire to POST /connectors/airtable/events;
 * Atlas then fetches the actual payloads and dispatches matching workflows.
 *
 * Webhook routing is stored in a JSON file (AIRTABLE_WEBHOOKS_FILE env or
 * ./memory/airtable-webhooks.json) and rebuilt in memory on server start.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export { AIRTABLE_CONNECTOR_ID } from './oauth.js';
import { isAirtableOAuthConfigured } from './oauth.js';
// Allow tests to override so API calls can be intercepted by a stub server.
const API_BASE = process.env.AIRTABLE_API_URL ?? 'https://api.airtable.com/v0';

// ── API helper ────────────────────────────────────────────────────────────────

export function makeAirtableApi(pat, { fetchImpl = fetch } = {}) {
  if (!pat) throw new Error('airtable: no Personal Access Token — connect via /connectors/airtable/connect');
  return async function aapi(method, path, { body, params } = {}) {
    let url = `${API_BASE}${path}`;
    if (params) {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))
      ).toString();
      if (qs) url += `?${qs}`;
    }
    const res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${pat}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`airtable ${method} ${path} failed: ${err?.error?.message ?? err?.error ?? `HTTP ${res.status}`}`);
    }
    return res.status === 204 ? {} : res.json();
  };
}

// ── Webhook routing table ─────────────────────────────────────────────────────
// Maps webhookId → { tenantId, userId, baseId, macSecretBase64 }.
// Persisted to disk so it survives server restarts.

const _webhookMap = new Map();
let _storePath = null;

export function initWebhookStore(filePath) {
  _storePath = filePath;
  if (!existsSync(filePath)) return;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    for (const [id, entry] of Object.entries(data)) _webhookMap.set(id, entry);
  } catch { /* corrupt file — start fresh */ }
}

function _saveWebhookMap() {
  if (!_storePath) return;
  try {
    mkdirSync(dirname(_storePath), { recursive: true });
    writeFileSync(_storePath, JSON.stringify(Object.fromEntries(_webhookMap), null, 2));
  } catch { /* non-fatal */ }
}

export function registerWebhookRoute({ webhookId, tenantId, userId, baseId, macSecretBase64 }) {
  _webhookMap.set(webhookId, { tenantId, userId, baseId, macSecretBase64: macSecretBase64 ?? null });
  _saveWebhookMap();
}

export function unregisterWebhookRoute(webhookId) {
  _webhookMap.delete(webhookId);
  _saveWebhookMap();
}

export function lookupWebhook(webhookId) {
  return _webhookMap.get(webhookId) ?? null;
}

export function allWebhooks() {
  return _webhookMap.entries();
}

// ── HMAC verification ─────────────────────────────────────────────────────────

export function verifyAirtableSignature(req, macSecretBase64) {
  if (!macSecretBase64) return false;
  const mac = req.headers['x-airtable-content-mac'];
  if (!mac) return false;
  const secret = Buffer.from(macSecretBase64, 'base64');
  const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});
  const expected = 'hmac-sha256=' + createHmac('sha256', secret).update(raw).digest('base64');
  try { return mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected)); }
  catch { return false; }
}

// ── Record action handlers ────────────────────────────────────────────────────

export async function airtableListRecords(api, { baseId, tableId, filterByFormula, maxRecords = 100, view } = {}) {
  const params = { pageSize: Math.min(Number(maxRecords) || 100, 100) };
  if (filterByFormula) params.filterByFormula = filterByFormula;
  if (view) params.view = view;
  const data = await api('GET', `/${baseId}/${encodeURIComponent(tableId)}`, { params });
  return { records: (data.records ?? []).map(r => ({ id: r.id, fields: r.fields, createdTime: r.createdTime })) };
}

// ── Schema handlers (P12 Increment F — "never ask for something we can read") ──
//
// The `schema.bases:read` scope has been REQUESTED SINCE THE CONNECTOR SHIPPED
// (oauth.js) and used by nothing. Every tenant who has ever connected Airtable has
// already granted it, so this needs no re-consent and no migration — the door was
// built, and nobody opened it.
//
// This is the difference between "just talk to it" working and not: without these,
// the user must paste an opaque `appXXXXXXXXXXXXXX` base id and an exact table
// name into a chat window, which is precisely where a conversational builder stops
// being conversational (converger-v2 §6.2.3).

/** Every base this token can see. */
export async function airtableListBases(api) {
  const data = await api('GET', '/meta/bases');
  return {
    bases: (data.bases ?? []).map(b => ({
      id: b.id, name: b.name, permissionLevel: b.permissionLevel,
    })),
  };
}

/**
 * A base's tables and THEIR FIELDS — names, types, and (for a single-select) the
 * closed set of options it accepts.
 *
 * The field TYPES are not decoration. A decision table routing on an Airtable
 * single-select can take its enum straight from `options.choices`, which is a
 * closed domain declared by the system of record rather than guessed by a model —
 * the strongest form of the thing §11.7 demands.
 */
export async function airtableDescribeBase(api, { baseId } = {}) {
  if (!baseId) throw new Error('airtable_describe_base: baseId is required.');
  const data = await api('GET', `/meta/bases/${baseId}/tables`);
  return {
    baseId,
    tables: (data.tables ?? []).map(t => ({
      id: t.id,
      name: t.name,
      primaryFieldId: t.primaryFieldId,
      fields: (t.fields ?? []).map(f => ({
        id: f.id,
        name: f.name,
        type: f.type,
        // The closed option set of a select field, when it has one. Everything else
        // has an open domain and says so by omitting `choices`.
        choices: (f.options?.choices ?? []).map(c => c.name).filter(Boolean),
      })),
    })),
  };
}

export async function airtableGetRecord(api, { baseId, tableId, recordId } = {}) {
  const data = await api('GET', `/${baseId}/${encodeURIComponent(tableId)}/${recordId}`);
  return { id: data.id, fields: data.fields, createdTime: data.createdTime };
}

export async function airtableSearchRecords(api, opts = {}) {
  return airtableListRecords(api, { ...opts, maxRecords: opts.maxRecords ?? 20 });
}

export async function airtableCreateRecord(api, { baseId, tableId, fields } = {}) {
  const parsed = typeof fields === 'string' ? JSON.parse(fields) : (fields ?? {});
  // R13: don't create an empty record when config/input is missing.
  if (!baseId || !tableId) throw new Error('airtable_create_record: baseId and tableId are required.');
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    throw new Error('airtable_create_record: needs fields — refusing to create an empty record.');
  }
  const data = await api('POST', `/${baseId}/${encodeURIComponent(tableId)}`, { body: { fields: parsed } });
  return { id: data.id, fields: data.fields };
}

export async function airtableUpdateRecord(api, { baseId, tableId, recordId, fields } = {}) {
  const parsed = typeof fields === 'string' ? JSON.parse(fields) : (fields ?? {});
  // R13: an update needs a target record + at least one field to change.
  if (!baseId || !tableId || !recordId) throw new Error('airtable_update_record: baseId, tableId and recordId are required.');
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    throw new Error('airtable_update_record: needs fields to update.');
  }
  const data = await api('PATCH', `/${baseId}/${encodeURIComponent(tableId)}/${recordId}`, { body: { fields: parsed } });
  return { id: data.id, fields: data.fields };
}

export async function airtableDeleteRecord(api, { baseId, tableId, recordId } = {}) {
  const data = await api('DELETE', `/${baseId}/${encodeURIComponent(tableId)}/${recordId}`);
  return { deleted: data.deleted ?? true, id: data.id ?? recordId };
}

// ── Webhook management ────────────────────────────────────────────────────────

export async function createAirtableWebhook(api, { baseId, notificationUrl, tableId } = {}) {
  const body = {
    notificationUrl,
    specification: {
      options: {
        filters: {
          fromSources: ['client'],
          dataTypes: ['tableData'],
          ...(tableId ? { recordChangeScope: tableId } : {}),
        },
      },
    },
  };
  const data = await api('POST', `/bases/${baseId}/webhooks`, { body });
  return { webhookId: data.id, macSecretBase64: data.macSecretBase64 ?? null, expirationTime: data.expirationTime ?? null };
}

export async function deleteAirtableWebhook(api, { baseId, webhookId } = {}) {
  await api('DELETE', `/bases/${baseId}/webhooks/${webhookId}`);
}

export async function refreshAirtableWebhook(api, { baseId, webhookId } = {}) {
  await api('POST', `/bases/${baseId}/webhooks/${webhookId}/refresh`);
}

export async function fetchWebhookPayloads(api, { baseId, webhookId, cursor } = {}) {
  const params = cursor ? { cursor } : {};
  const data = await api('GET', `/bases/${baseId}/webhooks/${webhookId}/payloads`, { params });
  return { payloads: data.payloads ?? [], cursor: data.cursor ?? null, mightHaveMore: data.mightHaveMore ?? false };
}

// ── CapabilityRegistry registration ──────────────────────────────────────────

export function registerAirtableChannels(capabilityRegistry) {
  const ready = () => isAirtableOAuthConfigured();

  function makeHandle(fn) {
    return async ({ config }) => {
      if (!config.airtableToken) throw new Error('airtable: not connected — authorize via /connectors/airtable/oauth/start');
      const api = makeAirtableApi(config.airtableToken);
      return fn(api, config);
    };
  }

  // ── Schema capabilities (P12 Increment F) ──────────────────────────────────
  //
  // NOT positioned as `delivery`: they read, they never write. They are `step`
  // capabilities so a workflow CAN use them mid-flow, but their real consumer is
  // the BUILDER — the converger calls them at build time to render "which base?"
  // and "which table?" as CLICKABLE CHOICES, and to map "the customer's budget" to
  // the `Deal Size` column itself instead of asking a human to paste an id.
  capabilityRegistry.register({
    id: 'airtable_list_bases', connector: 'airtable', positions: ['step'],
    name: 'List Airtable Bases', icon: 'table',
    description: 'Lists the Airtable bases this workspace can see. Use it to find a base instead of asking the user for its ID.',
    requiredScopes: ['schema.bases:read'],
    configSchema: [],   // it takes nothing: the token IS the question
    isReady: ready,
    handle: makeHandle((api) => airtableListBases(api)),
  });

  capabilityRegistry.register({
    id: 'airtable_describe_base', connector: 'airtable', positions: ['step'],
    name: 'Describe Airtable Base', icon: 'table',
    description: 'Lists a base\'s tables and their field names, types, and select options. Use it to map data onto real columns instead of guessing them.',
    requiredScopes: ['schema.bases:read'],
    configSchema: [
      { key: 'baseId', label: 'Base ID', type: 'string', optional: false, hint: 'appXXXXXXXXXXXXXX — from airtable_list_bases' },
    ],
    isReady: ready,
    handle: makeHandle((api, config) => airtableDescribeBase(api, config)),
  });

  capabilityRegistry.register({
    id: 'airtable_list_records', connector: 'airtable', positions: ['step'],
    name: 'List Airtable Records', icon: 'table',
    description: 'Fetch records from an Airtable table, optionally filtered by a formula.',
    requiredScopes: ['data.records:read'],
    configSchema: [
      { key: 'baseId',          label: 'Base ID',          type: 'string', optional: false, hint: 'appXXXXXXXXXXXXXX' },
      { key: 'tableId',         label: 'Table name or ID', type: 'string', optional: false },
      { key: 'filterByFormula', label: 'Filter formula',   type: 'string', optional: true,  hint: "{Status}='Active'" },
      { key: 'maxRecords',      label: 'Max records',      type: 'number', optional: true,  hint: 'Default 100' },
      { key: 'view',            label: 'View name',        type: 'string', optional: true  },
    ],
    isReady: ready,
    handle: makeHandle((api, config) => airtableListRecords(api, config)),
  });

  capabilityRegistry.register({
    id: 'airtable_get_record', connector: 'airtable', positions: ['step'],
    name: 'Get Airtable Record', icon: 'table',
    description: 'Fetch a single Airtable record by ID.',
    requiredScopes: ['data.records:read'],
    configSchema: [
      { key: 'baseId',   label: 'Base ID',          type: 'string', optional: false },
      { key: 'tableId',  label: 'Table name or ID', type: 'string', optional: false },
      { key: 'recordId', label: 'Record ID',        type: 'string', optional: false, hint: 'recXXXXXXXXXXXXXX' },
    ],
    isReady: ready,
    handle: makeHandle((api, config) => airtableGetRecord(api, config)),
  });

  capabilityRegistry.register({
    id: 'airtable_search_records', connector: 'airtable', positions: ['step'],
    name: 'Search Airtable Records', icon: 'table',
    description: 'Search records in an Airtable table using a formula filter.',
    requiredScopes: ['data.records:read'],
    configSchema: [
      { key: 'baseId',          label: 'Base ID',          type: 'string', optional: false },
      { key: 'tableId',         label: 'Table name or ID', type: 'string', optional: false },
      { key: 'filterByFormula', label: 'Filter formula',   type: 'string', optional: false, hint: "{Status}='Pending'" },
      { key: 'maxRecords',      label: 'Max results',      type: 'number', optional: true  },
    ],
    isReady: ready,
    handle: makeHandle((api, config) => airtableSearchRecords(api, config)),
  });

  capabilityRegistry.register({
    id: 'airtable_create_record', connector: 'airtable', positions: ['step', 'delivery'],
    name: 'Create Airtable Record', icon: 'table',
    description: 'Create a new record in an Airtable table.',
    outputFormat: 'plain',
    requiredScopes: ['data.records:write'],
    configSchema: [
      { key: 'baseId',  label: 'Base ID',          type: 'string',   optional: false },
      { key: 'tableId', label: 'Table name or ID', type: 'string',   optional: false },
      { key: 'fields',  label: 'Fields (JSON)',     type: 'textarea', optional: false, hint: '{"Field Name": "value"}' },
    ],
    isReady: ready,
    handle: makeHandle((api, config) => airtableCreateRecord(api, config)),
  });

  capabilityRegistry.register({
    id: 'airtable_update_record', connector: 'airtable', positions: ['step', 'delivery'],
    name: 'Update Airtable Record', icon: 'table',
    description: 'Update fields on an existing Airtable record.',
    outputFormat: 'plain',
    requiredScopes: ['data.records:write'],
    configSchema: [
      { key: 'baseId',   label: 'Base ID',          type: 'string',   optional: false },
      { key: 'tableId',  label: 'Table name or ID', type: 'string',   optional: false },
      { key: 'recordId', label: 'Record ID',        type: 'string',   optional: false },
      { key: 'fields',   label: 'Fields (JSON)',     type: 'textarea', optional: false, hint: '{"Field Name": "new value"}' },
    ],
    isReady: ready,
    handle: makeHandle((api, config) => airtableUpdateRecord(api, config)),
  });

  capabilityRegistry.register({
    id: 'airtable_delete_record', connector: 'airtable', positions: ['step'],
    name: 'Delete Airtable Record', icon: 'table',
    description: 'Delete a record from an Airtable table.',
    requiredScopes: ['data.records:write'],
    configSchema: [
      { key: 'baseId',   label: 'Base ID',          type: 'string', optional: false },
      { key: 'tableId',  label: 'Table name or ID', type: 'string', optional: false },
      { key: 'recordId', label: 'Record ID',        type: 'string', optional: false },
    ],
    isReady: ready,
    handle: makeHandle((api, config) => airtableDeleteRecord(api, config)),
  });

  capabilityRegistry.register({
    id: 'airtable_record_changed', connector: 'airtable', positions: ['trigger'],
    name: 'Airtable Record Changed', icon: 'table',
    description: 'Fires when a record is created or updated in an Airtable table.',
    requiredScopes: ['webhook:manage'],
    configSchema: [
      { key: 'baseId',  label: 'Base ID',            type: 'string', optional: false, hint: 'appXXXXXXXXXXXXXX' },
      { key: 'tableId', label: 'Table ID (optional)', type: 'string', optional: true,  hint: 'tblXXXXXXXXXXXXXX — blank = all tables in base' },
    ],
    isReady: ready,
  });
}
