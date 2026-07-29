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
import { CHECK_EVERY_CHOICES } from '../../workflows/trigger-frequency.js';
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

// `tableId` is part of the route because it is part of the webhook's IDENTITY:
// "base X, all tables" and "base X, table Y" are different subscriptions, and the
// reconcile in webhook-sync.js has to tell them apart to avoid creating a duplicate
// or pruning a live one. Routes written before this existed simply have it absent,
// which reads as null — the "all tables in the base" case they actually were.
export function registerWebhookRoute({ webhookId, tenantId, userId, baseId, tableId, macSecretBase64 }) {
  _webhookMap.set(webhookId, { tenantId, userId, baseId, tableId: tableId ?? null, macSecretBase64: macSecretBase64 ?? null });
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

/**
 * Add a column to an existing table.
 *
 * WHY THIS EXISTS. The builder can already READ a table's real columns, so it knows
 * when a workflow promises a field the table does not have — and until now the only
 * thing it could do about it was rebuild the workflow and hope. Observed live: a spec
 * promised a `Notes` column, the model believed the table had `Message`, and it
 * oscillated between the two spellings across two whole-spec rebuilds (425s + 237s)
 * because neither answer could ever satisfy both. The cheap resolution was always one
 * question — "your table has no Notes column; add one, or use Message?" — and that
 * question was unanswerable because nothing here could add a column.
 *
 * The permission was never the obstacle: `schema.bases:write` has been in the Airtable
 * scope set since the connector shipped, granted by every tenant who connected, and
 * used by nothing. Exactly the same shape as `schema.bases:read`, which sat unused
 * until the builder learned to read schemas.
 *
 * DEFAULTS TO A PLAIN TEXT FIELD. `singleLineText` accepts anything a workflow can
 * write and needs no options; a typed guess (a number, a select with invented choices)
 * would be a decision the user did not make, and a wrong type silently rejects writes.
 * A caller who knows better passes `type`.
 */
/**
 * WHAT AIRTABLE NEEDS TO KNOW BEFORE IT WILL MAKE A COLUMN.
 *
 * Most field types carry required `options`, and this connector never sent any —
 * so it could create exactly one kind of column, the `singleLineText` default, and
 * every other type failed. It looked like it worked because the only columns
 * anyone had asked for so far were text.
 *
 * WITNESSED ON PROD, 2026-07-29. Atlas read a real CRM table, correctly proposed
 * adding an "Intro Email Sent" CHECKBOX to mark contacted leads, showed it for
 * confirmation, was confirmed — and then:
 *
 *     Invalid options for Companies.Intro Email Sent:
 *     Failed schema validation: Intro Email Sent.options is missing
 *
 * It offered to do something it could not do, at the one moment the user had said
 * yes. Defaults here are the neutral choice for each type; a caller that knows
 * better passes `options` and those win.
 *
 * SELECT TYPES ARE DELIBERATELY ABSENT. A single/multi select with no choices is
 * both rejected and meaningless — the choices are the whole content of the column,
 * and inventing them would be guessing at someone's data. Those get a plain error
 * naming what is missing instead.
 */
const FIELD_OPTION_DEFAULTS = {
  checkbox: { icon: 'check', color: 'greenBright' },
  number:   { precision: 0 },
  percent:  { precision: 0 },
  currency: { precision: 2, symbol: '$' },
  rating:   { icon: 'star', max: 5, color: 'yellowBright' },
  date:     { dateFormat: { name: 'iso' } },
  dateTime: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' },
  duration: { durationFormat: 'h:mm' },
};
const FIELD_TYPES_NEEDING_CHOICES = new Set(['singleSelect', 'multipleSelects']);

export async function airtableCreateField(api, { baseId, tableId, name, type, description, options } = {}) {
  if (!baseId) throw new Error('airtable_create_field: baseId is required.');
  if (!tableId) throw new Error('airtable_create_field: tableId is required.');
  const fieldName = String(name ?? '').trim();
  if (!fieldName) throw new Error('airtable_create_field: name is required — a column needs a name.');

  // ── ADDING A COLUMN THAT IS ALREADY THERE IS A NO-OP, NOT A FAILURE ────────
  // This used to be a bare POST. Airtable refuses a duplicate field name, the api
  // helper throws on any non-2xx, and the step fails — so a workflow that adds a
  // column WORKED EXACTLY ONCE and failed on every run after.
  //
  // Witnessed on prod 2026-07-29: asked to write four fields into a table with
  // four different ones, Atlas correctly offered to add the two missing columns
  // and then put those two adds INSIDE the per-email workflow. Second email
  // onwards, the run dies at step 1 — before the record is written and before the
  // Slack post — with nothing delivered. It passes its own test, because the dry
  // run stubs writes, and goes live looking correct.
  //
  // The placement is wrong and is fixed separately (`oneTimeSetup`). This is the
  // part that has to be right REGARDLESS of placement: a build re-run, an edit, a
  // re-publish or a retry all call this again on a column that now exists, and
  // "make sure this column exists" is what the caller actually means. Returns the
  // existing column with `created: false` so a caller can still tell the
  // difference.
  // One schema read serves both: "does the column already exist?" and "which table
  // id does this name refer to?" — the schema endpoint below will not take a name.
  const table = await resolveTable(api, baseId, tableId);
  if (table) {
    const wanted = fieldName.toLowerCase();
    const hit = (table.fields ?? []).find(x => String(x.name ?? '').trim().toLowerCase() === wanted);
    if (hit) return { id: hit.id, name: hit.name, type: hit.type, baseId, tableId, created: false };
  }
  // Unresolved means we could not read the schema (a permissions or network
  // problem). Fall through with what the caller gave us rather than refusing —
  // the write is then the thing that decides, exactly as before.
  const tableRef = table?.id ?? tableId;

  const fieldType = type || 'singleLineText';
  const body = { name: fieldName, type: fieldType };
  if (description) body.description = String(description).slice(0, 20000);

  // Caller-supplied options win; otherwise the neutral default for this type. A
  // type that needs none (singleLineText, email, url, …) gets no `options` key at
  // all — sending an empty object is itself a schema violation.
  const opts = (options && typeof options === 'object' && Object.keys(options).length)
    ? options
    : FIELD_OPTION_DEFAULTS[fieldType];
  if (opts) body.options = opts;

  if (FIELD_TYPES_NEEDING_CHOICES.has(fieldType) && !Array.isArray(body.options?.choices)) {
    // Said before the request, in the words of the person who asked for it. The
    // alternative is Airtable's "Failed schema validation" reaching a chat card.
    throw new Error(
      `I can't add "${fieldName}" as a ${fieldType === 'singleSelect' ? 'single select' : 'multi select'} `
      + 'column without knowing its options — tell me the choices it should offer and I\'ll add it.');
  }

  // The api helper takes an OPTIONS object ({ body, params }), not a bare body —
  // passing the payload directly sends no body at all and Airtable rejects it.
  try {
    const data = await api('POST', `/meta/bases/${baseId}/tables/${encodeURIComponent(tableRef)}/fields`, { body });
    return { id: data.id, name: data.name, type: data.type, baseId, tableId, created: true };
  } catch (err) {
    // Two callers racing, or a column added between the check and the write. The
    // pre-check above is the common path; this is the one that makes it airtight,
    // because a check-then-act is never atomic.
    const again = /duplicate|already exists/i.test(String(err?.message ?? ''))
      ? await findExistingField(api, baseId, tableId, fieldName)
      : null;
    if (again) return { ...again, baseId, tableId, created: false };
    // ── WHAT A PERSON READS WHEN THE COLUMN CANNOT BE MADE ──────────────────
    // The confirm card shows this message verbatim. On prod it showed:
    //   "airtable POST /meta/bases/app0agE5SbNEnINMY/tables/tblIVdMFZz9UIb71z/
    //    fields failed: Invalid options for Companies.Intro Email Sent:
    //    Failed schema validation: Intro Email Sent.options is missing"
    // — an HTTP verb, two opaque provider ids, and Airtable's internal validator,
    // to someone who asked for a checkbox. Only the schema/options family is
    // reworded; every other failure (NOT_AUTHORIZED, rate limits, network) passes
    // through untouched, because a rewritten auth error sends people to the wrong
    // place.
    if (/NOT_FOUND|TABLE_NOT_FOUND/i.test(String(err?.message ?? ''))) {
      const e = new Error(
        `I couldn't find a table called "${tableId}" in that Airtable base, so there was nowhere to add `
        + `"${fieldName}". Check the table name and I'll try again.`);
      e.cause = err;
      throw e;
    }
    if (/failed schema validation|invalid options|unknown field type/i.test(String(err?.message ?? ''))) {
      const e = new Error(
        `Airtable wouldn't accept a "${fieldType}" column called "${fieldName}" — it needs more detail about how `
        + 'that kind of column should be set up. Add the column in Airtable and I\'ll use it, or tell me a '
        + 'simpler type (a text or checkbox column) and I\'ll add that.');
      e.cause = err;
      throw e;
    }
    throw err;
  }
}

/** The named column on that table, or null. Case-insensitive: Airtable's are. */
/**
 * THE TABLE, WHETHER YOU NAMED IT OR IDENTIFIED IT.
 *
 * The record endpoints accept either; the SCHEMA endpoint
 * (`/meta/bases/{base}/tables/{table}/fields`) accepts only the `tbl…` id. So a
 * caller who said "Companies" — which every other Airtable capability here
 * understands, and which is what a person types — got NOT_FOUND from the metadata
 * API. Witnessed on prod 2026-07-29, on the retry of a column the user had asked
 * for: the first attempt happened to carry the id and got as far as the options
 * error; the retry carried the name and failed differently.
 *
 * Resolved once, from the schema this function already had to fetch, and shared
 * with the write so the two cannot disagree about which table was meant.
 */
async function resolveTable(api, baseId, tableId) {
  let described;
  try {
    described = await airtableDescribeBase(api, { baseId });
  } catch {
    return null;   // cannot read the schema — fall through and let the write decide
  }
  const key = String(tableId ?? '').trim().toLowerCase();
  return (described.tables ?? []).find(t =>
    String(t.id ?? '').toLowerCase() === key || String(t.name ?? '').trim().toLowerCase() === key) ?? null;
}

async function findExistingField(api, baseId, tableId, fieldName) {
  const table = await resolveTable(api, baseId, tableId);
  if (!table) return null;
  const wanted = fieldName.trim().toLowerCase();
  const f = (table.fields ?? []).find(x => String(x.name ?? '').trim().toLowerCase() === wanted);
  return f ? { id: f.id, name: f.name, type: f.type } : null;
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
    effect: 'read',
    name: 'List Airtable Bases', icon: 'table',
    description: 'Lists the Airtable bases this workspace can see. Use it to find a base instead of asking the user for its ID.',
    requiredScopes: ['schema.bases:read'],
    configSchema: [],   // it takes nothing: the token IS the question
    isReady: ready,
    handle: makeHandle((api) => airtableListBases(api)),
  });

  capabilityRegistry.register({
    id: 'airtable_describe_base', connector: 'airtable', positions: ['step'],
    effect: 'read',
    name: 'Describe Airtable Base', icon: 'table',
    description: 'Lists a base\'s tables and their field names, types, and select options. Use it to map data onto real columns instead of guessing them.',
    requiredScopes: ['schema.bases:read'],
    configSchema: [
      { key: 'baseId', label: 'Base ID', type: 'string', optional: false, hint: 'appXXXXXXXXXXXXXX — from airtable_list_bases' },
    ],
    isReady: ready,
    handle: makeHandle((api, config) => airtableDescribeBase(api, config)),
    // P13-0 seam #3 — how the converger discovers where an Airtable write lands.
    // This used to be hardcoded in `elicitation-graph.js` as the literal strings
    // 'airtable', 'airtable_list_bases' and 'airtable_describe_base', so every other
    // connector fell back to "make the user paste an id". The connector now DECLARES
    // it and the converger reads the declaration, so a connector Atlas has never
    // hand-built gets click-to-pick for free.
    schemaDiscovery: {
      listCapability:    'airtable_list_bases',
      listResultKey:     'bases',
      describeArg:       'baseId',
      describeResultKey: 'tables',
      tableColumnsKey:   'fields',
      containerKey:      'baseId',
      tableKey:          'tableId',
      containerLabel:    'Airtable base',
      tableLabel:        'table',
    },
  });

  // The write half of schema awareness. Reading a table tells the builder a promised
  // column is missing; this is what lets it OFFER to add one instead of rebuilding the
  // workflow to work around it. Like its read siblings it is a `step` capability whose
  // real consumer is the BUILDER, at build time — a workflow that adds a column on
  // every run is almost never what anyone wants.
  capabilityRegistry.register({
    id: 'airtable_create_field', connector: 'airtable', positions: ['step'],
    name: 'Add Airtable Column', icon: 'table',
    // A column is something the workflow needs to EXIST, not work it does per run.
    oneTimeSetup: true,
    // It changes someone's schema, so it is a write for every guard that asks. Safe
    // to declare despite the assertion kind being a poor fit: `SETUP_ACTION_AS_STEP`
    // refuses it a place in the run path at all, so it can never be reached to
    // satisfy a promise.
    effect: 'write', locatorKeys: ['table', 'tableId', 'baseId'],
    description: 'Adds a column to an existing Airtable table. Use it when a workflow needs a field the table does not have yet — ask the user first, then add it, rather than writing to a column that does not exist.',
    requiredScopes: ['schema.bases:write'],
    configSchema: [
      { key: 'baseId',      label: 'Base ID',     type: 'string', optional: false, hint: 'appXXXXXXXXXXXXXX — from airtable_list_bases' },
      { key: 'tableId',     label: 'Table',       type: 'string', optional: false, hint: 'Table id or name — from airtable_describe_base' },
      { key: 'name',        label: 'Column name', type: 'string', optional: false, hint: 'Exactly as it should read in Airtable' },
      { key: 'type',        label: 'Column type', type: 'string', optional: true,  hint: 'Defaults to singleLineText, which accepts anything a workflow can write. checkbox / number / date / dateTime / percent / currency / rating / duration all work and are configured for you.' },
      { key: 'options',     label: 'Column options', type: 'object', optional: true, hint: 'Only if the defaults are wrong for you. REQUIRED for singleSelect / multipleSelects: { "choices": [{ "name": "…" }] } — those cannot be guessed.' },
      { key: 'description', label: 'Description', type: 'string', optional: true },
    ],
    isReady: ready,
    handle: makeHandle((api, config) => airtableCreateField(api, config)),
  });

  capabilityRegistry.register({
    id: 'airtable_list_records', connector: 'airtable', positions: ['step'],
    effect: 'read',
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
    effect: 'read',
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
    effect: 'read',
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
    // The table is the destination; `fields` is content. (The guess list already
    // happened to get this one right — declaring it stops that being luck.)
    effect: 'write', assertionKind: 'record_exists',
    locatorKeys: ['table', 'tableId', 'baseId'],
    requiredScopes: ['data.records:write'],
    configSchema: [
      { key: 'baseId',  label: 'Base ID',          type: 'string',   optional: false },
      { key: 'tableId', label: 'Table name or ID', type: 'string',   optional: false },
      { key: 'fields',  label: 'Fields',            type: 'object',   optional: false, hint: 'An OBJECT of column → value: { "Name": "{{extract.name}}" }. One template per column — a JSON string is refused, because its column names cannot be checked against the real table.' },
    ],
    isReady: ready,
    // Non-destructive reachability read for the dry-run test: does the target base
    // exist and actually contain the target table? (Airtable SILENTLY drops writes to a
    // table that isn't there.) It reads the base's schema — never writes. A definitive
    // "table not in this base" returns reachable:false (blocks); any other error (the
    // base is gone, a transient API/auth failure) RE-THROWS so the dry path marks
    // reachability inconclusive rather than failing a valid workflow.
    probe: async ({ config }) => {
      const api = makeAirtableApi(config.airtableToken);
      const schema = await airtableDescribeBase(api, { baseId: config.baseId });
      const wanted = String(config.tableId ?? '');
      const found = (schema?.tables ?? []).some(t => t.id === wanted || t.name === wanted);
      return found ? { reachable: true }
                   : { reachable: false, reason: `the Airtable table "${wanted}" wasn't found in that base` };
    },
    handle: makeHandle((api, config) => airtableCreateRecord(api, config)),
  });

  capabilityRegistry.register({
    id: 'airtable_update_record', connector: 'airtable', positions: ['step', 'delivery'],
    name: 'Update Airtable Record', icon: 'table',
    description: 'Update fields on an existing Airtable record.',
    outputFormat: 'plain',
    effect: 'write', assertionKind: 'record_exists',
    locatorKeys: ['table', 'tableId', 'baseId'],
    requiredScopes: ['data.records:write'],
    configSchema: [
      { key: 'baseId',   label: 'Base ID',          type: 'string',   optional: false },
      { key: 'tableId',  label: 'Table name or ID', type: 'string',   optional: false },
      { key: 'recordId', label: 'Record ID',        type: 'string',   optional: false },
      { key: 'fields',   label: 'Fields',            type: 'object',   optional: false, hint: 'An OBJECT of column → value: { "Name": "{{extract.name}}" }. One template per column.' },
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
    effect: 'read',
    name: 'Airtable Record Changed', icon: 'table',
    description: 'Fires when a record is created or updated in an Airtable table.',
    requiredScopes: ['webhook:manage'],
    configSchema: [
      { key: 'baseId',  label: 'Base ID',            type: 'string', optional: false, hint: 'appXXXXXXXXXXXXXX' },
      { key: 'tableId', label: 'Table ID (optional)', type: 'string', optional: true,  hint: 'tblXXXXXXXXXXXXXX — blank = all tables in base' },
      // Airtable PUSHES changes to Atlas, so this is not a polling interval — it is
      // a floor on how often this workflow may run. 0/blank = run on every change,
      // as soon as it happens. Enforced in dispatchAirtableEvent via the run gate;
      // a change inside the window is deferred to the end of it, never dropped.
      { key: 'checkEvery', label: 'Run at most', type: 'select', optional: true, default: 0,
        options: CHECK_EVERY_CHOICES.map((c) => c.minutes),
        optionLabels: CHECK_EVERY_CHOICES.map((c) => c.label),
        hint: 'Minutes. Blank or 0 runs the moment a record changes; a larger value batches busy tables into one run.' },
    ],
    isReady: ready,
  });
}
