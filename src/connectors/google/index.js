/**
 * Google / G-Suite connector (P2).
 *
 * Covers the full G-Suite: Gmail, Calendar, Drive, Sheets, Docs, Tasks.
 * Per-tenant OAuth via the existing OAuthClient (PKCE + refresh tokens).
 * Token stored encrypted in the vault; all API calls use the per-tenant token.
 *
 * See docs/connectors/google.md for the capability map and onboarding guide.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
// Some Google APIs have their own subdomain hosts and drop the service prefix.
// e.g. /docs/v1/documents → https://docs.googleapis.com/v1/documents
const GOOGLE_API_HOSTS = [
  { prefix: '/docs/',   host: 'https://docs.googleapis.com'   },
  { prefix: '/sheets/', host: 'https://sheets.googleapis.com' },
];
function googleApiUrl(path) {
  for (const { prefix, host } of GOOGLE_API_HOSTS) {
    if (path.startsWith(prefix)) return `${host}${path.slice(prefix.length - 1)}`;
  }
  return `https://www.googleapis.com${path}`;
}

export const googleCapabilities = JSON.parse(
  readFileSync(join(__dir, 'capabilities.json'), 'utf8')
);

export const GOOGLE_CONNECTOR_ID = 'google';

// ── Scope detection ──────────────────────────────────────────────────────────

/** Read the token's granted scopes from the vault row. */
export function getGrantedScopes(oauthTokenStore, tenantId, userId) {
  const row = oauthTokenStore.get({ tenantId, userId, connectorId: GOOGLE_CONNECTOR_ID });
  if (!row) return [];
  return (row.scope ?? '').split(/\s+/).filter(Boolean);
}

/** Annotate the capability map with availability based on granted scopes. */
export function resolveGoogleCapabilities(grantedScopes = []) {
  const granted = new Set(grantedScopes);
  const actions = googleCapabilities.actions.map((a) => {
    const missing = (a.requiredScopes ?? []).filter((s) => !granted.has(s));
    let available = false;
    let unavailableReason = null;
    if (!a.implemented)    unavailableReason = 'not yet implemented';
    else if (missing.length) unavailableReason = `token missing scope(s): ${missing.map(s => s.split('/').pop()).join(', ')}`;
    else available = true;
    return { ...a, available, unavailableReason };
  });
  return { connector: 'google', grantedScopes: [...granted], actions };
}

/** AI-readable summary of available G-Suite actions. */
export function describeGoogleForPrompt(resolved) {
  const lines = ['G-SUITE CAPABILITIES (only AVAILABLE actions work for this account)'];
  const byService = {};
  for (const a of resolved.actions) {
    const svc = a.service ?? 'other';
    if (!byService[svc]) byService[svc] = [];
    byService[svc].push(a);
  }
  for (const [svc, actions] of Object.entries(byService)) {
    lines.push(`  ${svc.toUpperCase()}:`);
    for (const a of actions) {
      const status = a.available ? 'available' : `unavailable (${a.unavailableReason})`;
      lines.push(`    - ${a.id} — ${a.label} [${status}]`);
    }
  }
  lines.push('Do not propose UNAVAILABLE actions.');
  return lines.join('\n');
}

// ── Per-tenant capability provider ───────────────────────────────────────────

export function createGoogleCapabilityProvider({ oauthTokenStore }) {
  const cache = new Map();
  return {
    async resolveForTenant(tenantId, userId) {
      const key = `${tenantId}:${userId}`;
      if (cache.has(key)) return cache.get(key);
      const scopes = getGrantedScopes(oauthTokenStore, tenantId, userId);
      const resolved = resolveGoogleCapabilities(scopes);
      cache.set(key, resolved);
      return resolved;
    },
    refresh(tenantId, userId) {
      cache.delete(`${tenantId}:${userId ?? ''}`);
    },
  };
}

// ── Google API helper ────────────────────────────────────────────────────────

/**
 * Build an authenticated Google API caller for a tenant.
 * Reads the decrypted token from the vault; auto-throws if not connected.
 */
export function makeGoogleApi({ oauthTokenStore, cipher, tenantId, userId }) {
  const row = oauthTokenStore.get({ tenantId, userId, connectorId: GOOGLE_CONNECTOR_ID });
  if (!row) throw new Error('google: this account has not connected Google — authorize via /connectors/google/authorize');
  const token = cipher.decrypt(row.access_token_enc);

  return async function gapi(method, path, { body, params } = {}) {
    let url = googleApiUrl(path);
    if (params) {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))
      ).toString();
      if (qs) url += `?${qs}`;
    }
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`google API ${path} failed: ${err?.error?.message ?? `HTTP ${res.status}`}`);
    }
    return res.status === 204 ? {} : res.json();
  };
}

/**
 * Build an authenticated Google API caller from a pre-decrypted access token.
 * Used by CONNECTOR_INJECTORS in server.js after vault lookup + decrypt.
 * Mirrors makeGoogleApi but skips the vault lookup.
 */
export function makeGoogleApiFromToken(token) {
  if (!token) throw new Error('google: no access token provided');
  return async function gapi(method, path, { body, params } = {}) {
    let url = googleApiUrl(path);
    if (params) {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))
      ).toString();
      if (qs) url += `?${qs}`;
    }
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`google API ${path} failed: ${err?.error?.message ?? `HTTP ${res.status}`}`);
    }
    return res.status === 204 ? {} : res.json();
  };
}

// ── Gmail helpers ────────────────────────────────────────────────────────────

/** Decode a base64url-encoded Gmail message part. */
function b64decode(s) {
  try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch { return ''; }
}

/** Extract plain text body from a Gmail message payload (recursive). */
function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return b64decode(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  if (payload.body?.data) return b64decode(payload.body.data);
  return '';
}

/** Parse a raw Gmail message into a clean object. */
function parseMessage(msg) {
  const headers = {};
  for (const h of (msg.payload?.headers ?? [])) headers[h.name.toLowerCase()] = h.value;
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: headers.subject ?? '(no subject)',
    from: headers.from ?? '',
    to: headers.to ?? '',
    date: headers.date ?? '',
    snippet: msg.snippet ?? '',
    body: extractBody(msg.payload),
    labelIds: msg.labelIds ?? [],
  };
}

// ── G-Suite action handlers ──────────────────────────────────────────────────

/** gmail_search — list messages matching a query. */
export async function gmailSearch(gapi, { query, maxResults = 10 }) {
  const list = await gapi('GET', '/gmail/v1/users/me/messages', {
    params: { q: query, maxResults },
  });
  const messages = [];
  for (const m of (list.messages ?? []).slice(0, maxResults)) {
    const full = await gapi('GET', `/gmail/v1/users/me/messages/${m.id}`, {
      params: { format: 'full' },
    });
    messages.push(parseMessage(full));
  }
  return { messages };
}

/** gmail_get_message — fetch a single message by ID. */
export async function gmailGetMessage(gapi, { messageId }) {
  const msg = await gapi('GET', `/gmail/v1/users/me/messages/${messageId}`, {
    params: { format: 'full' },
  });
  return parseMessage(msg);
}

/** gmail_send — send an email. */
export async function gmailSend(gapi, { to, subject, body }) {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body ?? '',
  ].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64url');
  const sent = await gapi('POST', '/gmail/v1/users/me/messages/send', {
    body: { raw: encoded },
  });
  return { messageId: sent.id, threadId: sent.threadId };
}

/** gmail_mark_read — remove UNREAD label. */
export async function gmailMarkRead(gapi, { messageId }) {
  await gapi('POST', `/gmail/v1/users/me/messages/${messageId}/modify`, {
    body: { removeLabelIds: ['UNREAD'] },
  });
  return { ok: true };
}

/** calendar_list_events — upcoming events. */
export async function calendarListEvents(gapi, { maxResults = 10, timeMin, calendarId = 'primary' }) {
  const params = { maxResults, singleEvents: true, orderBy: 'startTime',
    timeMin: timeMin ?? new Date().toISOString() };
  const data = await gapi('GET', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, { params });
  const events = (data.items ?? []).map((e) => ({
    id: e.id, title: e.summary, start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date, description: e.description ?? '',
    location: e.location ?? '', link: e.htmlLink,
  }));
  return { events };
}

/** calendar_create_event. */
export async function calendarCreateEvent(gapi, { title, start, end, description = '', attendees = '', calendarId = 'primary' }) {
  const event = {
    summary: title, description,
    start: { dateTime: start, timeZone: 'UTC' },
    end:   { dateTime: end,   timeZone: 'UTC' },
    attendees: attendees ? attendees.split(',').map((e) => ({ email: e.trim() })) : [],
  };
  const created = await gapi('POST', `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, { body: event });
  return { eventId: created.id, link: created.htmlLink };
}

/** drive_list_files. */
export async function driveListFiles(gapi, { query, maxResults = 10 }) {
  const params = { pageSize: maxResults, fields: 'files(id,name,mimeType,webViewLink,modifiedTime)' };
  if (query) params.q = query;
  const data = await gapi('GET', '/drive/v3/files', { params });
  return { files: (data.files ?? []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, link: f.webViewLink, modified: f.modifiedTime })) };
}

/** sheets_read. */
export async function sheetsRead(gapi, { spreadsheetId, range = 'Sheet1' }) {
  const data = await gapi('GET', `/sheets/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  return { values: data.values ?? [], rows: (data.values ?? []).length };
}

/** sheets_append — append rows. */
export async function sheetsAppend(gapi, { spreadsheetId, range = 'Sheet1', values }) {
  const rows = typeof values === 'string' ? JSON.parse(values) : values;
  const data = await gapi('POST',
    `/sheets/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append`,
    { body: { values: rows }, params: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' } }
  );
  return { updatedRange: data.updates?.updatedRange, updatedRows: data.updates?.updatedRows ?? 0 };
}

/** docs_read — extract plain text from a Doc. */
export async function docsRead(gapi, { documentId }) {
  const doc = await gapi('GET', `/docs/v1/documents/${documentId}`);
  let content = '';
  for (const el of (doc.body?.content ?? [])) {
    for (const pe of (el.paragraph?.elements ?? [])) {
      content += pe.textRun?.content ?? '';
    }
  }
  return { title: doc.title, content: content.trim() };
}

/** docs_create. */
export async function docsCreate(gapi, { title, content }) {
  const doc = await gapi('POST', '/docs/v1/documents', { body: { title } });
  if (content) {
    await gapi('POST', `/docs/v1/documents/${doc.documentId}:batchUpdate`, {
      body: { requests: [{ insertText: { location: { index: 1 }, text: content } }] },
    });
  }
  return { documentId: doc.documentId, link: `https://docs.google.com/document/d/${doc.documentId}` };
}

/** tasks_list. */
export async function tasksList(gapi, { tasklistId = '@default', showCompleted = false }) {
  const data = await gapi('GET', `/tasks/v1/lists/${tasklistId}/tasks`, {
    params: { showCompleted, maxResults: 50 },
  });
  return { tasks: (data.items ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status, due: t.due ?? null, notes: t.notes ?? '' })) };
}

/** tasks_create. */
export async function tasksCreate(gapi, { title, notes, due, tasklistId = '@default' }) {
  const task = { title };
  if (notes) task.notes = notes;
  if (due)   task.due = due;
  const created = await gapi('POST', `/tasks/v1/lists/${tasklistId}/tasks`, { body: task });
  return { taskId: created.id };
}

/**
 * Register all implemented Google actions on a CapabilityRegistry.
 * Handles receive config.googleToken (injected by CONNECTOR_INJECTORS in server.js).
 *
 * @param {import('../capability-registry.js').CapabilityRegistry} capabilityRegistry
 */
export function registerGoogleChannels(capabilityRegistry) {
  const ready = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  function makeHandle(fn) {
    return async ({ config, body }) => {
      if (!config.googleToken) throw new Error('google: no access token — connect Google via /connectors/google/authorize');
      const gapi = makeGoogleApiFromToken(config.googleToken);
      return fn(gapi, config, body);
    };
  }

  capabilityRegistry.register({
    id: 'gmail_search', connector: 'google', positions: ['step'],
    name: 'Search Gmail', icon: 'mail',
    description: 'Search inbox messages with a Gmail query (e.g. from:ups.com is:unread).',
    configSchema: [
      { key: 'query',      label: 'Search query', type: 'string', optional: false, hint: 'Gmail search query, e.g. from:ups.com is:unread' },
      { key: 'maxResults', label: 'Max results',  type: 'number', optional: true,  hint: 'Default 10' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    isReady: ready,
    handle: makeHandle((gapi, config) => gmailSearch(gapi, { query: config.query, maxResults: config.maxResults })),
  });

  capabilityRegistry.register({
    id: 'gmail_get_message', connector: 'google', positions: ['step'],
    name: 'Get Gmail Message', icon: 'mail',
    description: 'Fetch the full content of a specific Gmail message by ID.',
    configSchema: [
      { key: 'messageId', label: 'Message ID', type: 'string', optional: false, hint: 'Gmail message ID' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    isReady: ready,
    handle: makeHandle((gapi, config) => gmailGetMessage(gapi, { messageId: config.messageId })),
  });

  capabilityRegistry.register({
    id: 'gmail_send', connector: 'google', positions: ['step', 'delivery'],
    name: 'Send Email (Gmail)', icon: 'mail',
    description: 'Send an email from the connected Gmail account.',
    configSchema: [
      { key: 'to',      label: 'To',      type: 'string',   optional: false },
      { key: 'subject', label: 'Subject', type: 'string',   optional: false },
      { key: 'body',    label: 'Body',    type: 'textarea', optional: true, hint: 'Email body; omit to use prior step output' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/gmail.send'],
    isReady: ready,
    handle: makeHandle((gapi, config, body) => gmailSend(gapi, { to: config.to, subject: config.subject, body: config.body ?? body })),
  });

  capabilityRegistry.register({
    id: 'gmail_mark_read', connector: 'google', positions: ['step'],
    name: 'Mark Gmail Read', icon: 'mail',
    description: 'Remove the UNREAD label from a message.',
    configSchema: [
      { key: 'messageId', label: 'Message ID', type: 'string', optional: false },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/gmail.modify'],
    isReady: ready,
    handle: makeHandle((gapi, config) => gmailMarkRead(gapi, { messageId: config.messageId })),
  });

  capabilityRegistry.register({
    id: 'calendar_list_events', connector: 'google', positions: ['step'],
    name: 'List Calendar Events', icon: 'calendar',
    description: 'Fetch upcoming events from the connected Google Calendar.',
    configSchema: [
      { key: 'maxResults', label: 'Max results',         type: 'number', optional: true, hint: 'Default 10' },
      { key: 'timeMin',    label: 'After (ISO datetime)', type: 'string', optional: true, hint: 'Defaults to now' },
      { key: 'calendarId', label: 'Calendar ID',          type: 'string', optional: true, hint: 'Defaults to primary' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/calendar'],
    isReady: ready,
    handle: makeHandle((gapi, config) => calendarListEvents(gapi, { maxResults: config.maxResults, timeMin: config.timeMin, calendarId: config.calendarId })),
  });

  capabilityRegistry.register({
    id: 'calendar_create_event', connector: 'google', positions: ['step', 'delivery'],
    name: 'Create Calendar Event', icon: 'calendar',
    description: 'Add an event to the connected Google Calendar.',
    configSchema: [
      { key: 'title',       label: 'Title',                            type: 'string', optional: false },
      { key: 'start',       label: 'Start (ISO datetime)',              type: 'string', optional: false },
      { key: 'end',         label: 'End (ISO datetime)',                type: 'string', optional: false },
      { key: 'description', label: 'Description',                       type: 'string', optional: true  },
      { key: 'attendees',   label: 'Attendees (comma-separated emails)', type: 'string', optional: true  },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/calendar'],
    isReady: ready,
    handle: makeHandle((gapi, config) => calendarCreateEvent(gapi, { title: config.title, start: config.start, end: config.end, description: config.description, attendees: config.attendees })),
  });

  capabilityRegistry.register({
    id: 'drive_list_files', connector: 'google', positions: ['step'],
    name: 'List Drive Files', icon: 'folder',
    description: 'List files in Google Drive, optionally filtered by name or type.',
    configSchema: [
      { key: 'query',      label: 'Drive query', type: 'string', optional: true, hint: "e.g. name contains 'report'" },
      { key: 'maxResults', label: 'Max results', type: 'number', optional: true  },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/drive'],
    isReady: ready,
    handle: makeHandle((gapi, config) => driveListFiles(gapi, { query: config.query, maxResults: config.maxResults })),
  });

  capabilityRegistry.register({
    id: 'sheets_read', connector: 'google', positions: ['step'],
    name: 'Read Google Sheet', icon: 'table',
    description: 'Read data from a spreadsheet range.',
    configSchema: [
      { key: 'spreadsheetId', label: 'Spreadsheet ID', type: 'string', optional: false },
      { key: 'range',         label: 'Range',           type: 'string', optional: true,  hint: 'e.g. Sheet1!A1:D10; defaults to first sheet' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/spreadsheets'],
    isReady: ready,
    handle: makeHandle((gapi, config) => sheetsRead(gapi, { spreadsheetId: config.spreadsheetId, range: config.range })),
  });

  capabilityRegistry.register({
    id: 'sheets_append', connector: 'google', positions: ['step', 'delivery'],
    name: 'Append to Google Sheet', icon: 'table',
    description: 'Add rows of data to a spreadsheet.',
    configSchema: [
      { key: 'spreadsheetId', label: 'Spreadsheet ID',    type: 'string', optional: false },
      { key: 'range',         label: 'Range / Sheet',      type: 'string', optional: true,  hint: 'Sheet name or range; defaults to first sheet' },
      { key: 'values',        label: 'Values (JSON array)', type: 'string', optional: false, hint: '[["a","b"],["c","d"]]' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/spreadsheets'],
    isReady: ready,
    handle: makeHandle((gapi, config) => sheetsAppend(gapi, { spreadsheetId: config.spreadsheetId, range: config.range, values: config.values })),
  });

  capabilityRegistry.register({
    id: 'docs_read', connector: 'google', positions: ['step'],
    name: 'Read Google Doc', icon: 'file-text',
    description: 'Read the text content of a Google Doc.',
    configSchema: [
      { key: 'documentId', label: 'Document ID', type: 'string', optional: false },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/documents'],
    isReady: ready,
    handle: makeHandle((gapi, config) => docsRead(gapi, { documentId: config.documentId })),
  });

  capabilityRegistry.register({
    id: 'docs_create', connector: 'google', positions: ['step', 'delivery'],
    name: 'Create Google Doc', icon: 'file-text',
    description: 'Create a new Google Doc with optional initial content.',
    configSchema: [
      { key: 'title',   label: 'Title',   type: 'string',   optional: false },
      { key: 'content', label: 'Content', type: 'textarea', optional: true, hint: 'Initial content; omit to use prior step output' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/documents'],
    isReady: ready,
    handle: makeHandle((gapi, config, body) => docsCreate(gapi, { title: config.title, content: config.content ?? body })),
  });

  capabilityRegistry.register({
    id: 'tasks_list', connector: 'google', positions: ['step'],
    name: 'List Tasks', icon: 'check-square',
    description: 'List tasks from a Google Tasks list.',
    configSchema: [
      { key: 'tasklistId',    label: 'Task list ID',   type: 'string',  optional: true, hint: 'Defaults to the default task list' },
      { key: 'showCompleted', label: 'Show completed', type: 'boolean', optional: true  },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/tasks'],
    isReady: ready,
    handle: makeHandle((gapi, config) => tasksList(gapi, { tasklistId: config.tasklistId, showCompleted: config.showCompleted })),
  });

  capabilityRegistry.register({
    id: 'tasks_create', connector: 'google', positions: ['step', 'delivery'],
    name: 'Create Task', icon: 'check-square',
    description: 'Add a task to a Google Tasks list.',
    configSchema: [
      { key: 'title',      label: 'Title',       type: 'string', optional: false },
      { key: 'notes',      label: 'Notes',       type: 'string', optional: true  },
      { key: 'due',        label: 'Due (ISO)',   type: 'string', optional: true  },
      { key: 'tasklistId', label: 'Task list ID', type: 'string', optional: true  },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/tasks'],
    isReady: ready,
    handle: makeHandle((gapi, config) => tasksCreate(gapi, { title: config.title, notes: config.notes, due: config.due, tasklistId: config.tasklistId })),
  });

  // Gmail trigger — polling stub; real Pub/Sub push upgradeable later
  capabilityRegistry.register({
    id: 'gmail_new_message', connector: 'google', positions: ['trigger'],
    name: 'New Gmail Message', icon: 'mail',
    description: 'Fires when a new Gmail message arrives matching a query (polling; upgradeable to Pub/Sub push).',
    configSchema: [
      { key: 'query', label: 'Gmail query', type: 'string', optional: true, hint: 'e.g. from:ups.com is:unread; blank = all new messages' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    isReady: ready,
  });
}

export default { googleCapabilities, resolveGoogleCapabilities, makeGoogleApi };
