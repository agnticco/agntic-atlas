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
import { googleProviderConfig } from '../../auth/oauth-client.js';

/** Strip HTML tags and decode common entities to plain text for non-HTML destinations. */
function stripHtml(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    // Drop non-content blocks WHOLE (contents included) before touching tags — otherwise
    // a marketing email's <style> rules and MSO conditional comments survive as pseudo-text
    // and drown the real prose (which is what makes an llm `extract` node read "no body").
    .replace(/<!--[\s\S]*?-->/g, ' ')                          // HTML comments (incl. <!--[if mso]>)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')                 // CSS blocks
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')              // scripts
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')                  // <head> (title/meta/link)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/**
 * Async token resolver with auto-refresh — mirrors getAirtableAccessToken.
 * Checks the stored expiry; if the token is stale, exchanges the refresh
 * token for a new one and persists it before returning.
 */
export async function getGoogleAccessToken({ oauthTokenStore, cipher, tenantId, userId }) {
  if (!userId) return null;
  const row = oauthTokenStore.get({ tenantId, userId, connectorId: GOOGLE_CONNECTOR_ID });
  if (!row) return null;

  const fresh = !row.expiry || row.expiry - REFRESH_SKEW_MS > Date.now();
  if (fresh) {
    try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
  }

  if (!row.refresh_token_enc) {
    // No refresh token — return stale, let the API call surface the 401.
    try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
  }

  try {
    const cfg          = googleProviderConfig();
    const refreshToken = cipher.decrypt(row.refresh_token_enc);
    const res = await fetch(cfg.tokenEndpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
    });
    if (!res.ok) {
      try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
    }
    const tok = await res.json();
    if (!tok.access_token) {
      try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
    }
    const expiry = tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : 0;
    oauthTokenStore.updateTokens({
      tenantId, userId, connectorId: GOOGLE_CONNECTOR_ID,
      accessTokenEnc:  cipher.encrypt(tok.access_token),
      refreshTokenEnc: tok.refresh_token ? cipher.encrypt(tok.refresh_token) : null,
      expiry,
    });
    return tok.access_token;
  } catch {
    // Refresh attempt threw — fall back to stale token.
    try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
  }
}

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
      const connected = oauthTokenStore.has({ tenantId, userId, connectorId: GOOGLE_CONNECTOR_ID });
      const scopes = getGrantedScopes(oauthTokenStore, tenantId, userId);
      const resolved = { connected, ...resolveGoogleCapabilities(scopes) };
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
  // Fail fast if not connected at all.
  const row = oauthTokenStore.get({ tenantId, userId, connectorId: GOOGLE_CONNECTOR_ID });
  if (!row) throw new Error('google: this account has not connected Google — authorize via /connectors/google/authorize');

  return async function gapi(method, path, { body, params } = {}) {
    // Resolve (and auto-refresh if expired) per call so long-running routes
    // never hit the 1-hour expiry silently.
    const token = await getGoogleAccessToken({ oauthTokenStore, cipher, tenantId, userId });
    if (!token) throw new Error('google: could not obtain access token — user may need to reconnect Google');

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
  // No text/plain part anywhere — fall back to the HTML body, but STRIP it to readable
  // prose. An HTML-only email (common for marketing/notification mail) otherwise hands
  // the workflow raw MJML/CSS, which an llm `extract`/`summarize` node reads as "no
  // usable body" and — per the guard clause the converger writes into every content
  // node — emits the `ERROR: required data not found` sentinel, failing a correctly
  // wired workflow both in the build self-test AND at run time. Stripping here fixes
  // BOTH (same parser), so the test can never pass on text the real run won't see.
  if (payload.mimeType === 'text/html' && payload.body?.data) return stripHtml(b64decode(payload.body.data));
  if (payload.body?.data) {
    const raw = b64decode(payload.body.data);
    return /<[a-z][\s\S]*?>/i.test(raw) ? stripHtml(raw) : raw;
  }
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

/** gmail_send — send an email. Auto-detects HTML body and wraps it in a styled shell. */
export async function gmailSend(gapi, { to, subject, body }) {
  // Strip markdown code fences — LLMs commonly wrap HTML output in ```html...```
  // which renders as literal text in the email client and cuts off the content.
  const bodyText = (body ?? '').replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const isHtml = /<[a-z][\s\S]*>/i.test(bodyText);
  // Wrap HTML content in a responsive email shell unless it already has one.
  // The shell gives every email a consistent professional base (max-width, fonts,
  // base typography) so the LLM only needs to write the inner content.
  const finalBody = isHtml && !/^\s*<!DOCTYPE|^\s*<html/i.test(bodyText)
    ? _wrapEmailHtml(bodyText)
    : bodyText;
  const contentType = isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  // RFC 2047: encode Subject header when it contains non-ASCII (emoji, accents, etc.)
  const subjectEncoded = /^[\x00-\x7F]*$/.test(subject ?? '')
    ? (subject ?? '')
    : `=?UTF-8?B?${Buffer.from(subject ?? '').toString('base64')}?=`;
  const raw = [
    `To: ${to}`,
    `Subject: ${subjectEncoded}`,
    `Content-Type: ${contentType}`,
    '',
    finalBody,
  ].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64url');
  const sent = await gapi('POST', '/gmail/v1/users/me/messages/send', {
    body: { raw: encoded },
  });
  return { messageId: sent.id, threadId: sent.threadId };
}

function _wrapEmailHtml(content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{margin:0;padding:0;background:#f2f2f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
    .wrap{max-width:600px;margin:24px auto;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .body{padding:36px 44px 40px}
    h1{color:#0d0d0d;font-size:26px;font-weight:700;margin:0 0 16px;line-height:1.25}
    h2{color:#0d0d0d;font-size:20px;font-weight:600;margin:28px 0 10px;line-height:1.3}
    h3{color:#222;font-size:16px;font-weight:600;margin:22px 0 8px}
    p{color:#333;font-size:15px;line-height:1.7;margin:0 0 16px}
    a{color:#0055cc;text-decoration:none}
    a:hover{text-decoration:underline}
    ul,ol{color:#333;font-size:15px;line-height:1.7;padding-left:22px;margin:0 0 16px}
    li{margin-bottom:6px}
    hr{border:none;border-top:1px solid #e8e8e8;margin:28px 0}
    strong{color:#111;font-weight:600}
    em{color:#444}
    code{background:#f5f5f5;color:#c7254e;font-size:13px;padding:2px 6px;border-radius:4px;font-family:'SFMono-Regular',Consolas,monospace}
    blockquote{border-left:3px solid #ddd;margin:0 0 16px;padding:8px 0 8px 18px;color:#555;font-style:italic}
    .card{background:#f8f9fa;border-radius:8px;padding:18px 22px;margin:18px 0}
    .callout{background:#eef4ff;border-left:4px solid #0055cc;border-radius:0 6px 6px 0;padding:14px 18px;margin:18px 0}
    @media(max-width:640px){.body{padding:24px 22px 28px}.wrap{margin:0;border-radius:0}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="body">
${content}
    </div>
  </div>
</body>
</html>`;
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
  if (!String(title ?? '').trim() || !start) throw new Error('calendar_create_event: needs a title and a start time.');
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
  const params = {
    pageSize: maxResults,
    fields: 'files(id,name,mimeType,webViewLink,webContentLink,thumbnailLink,modifiedTime)',
    // Search personal Drive + all Shared Drives the user has access to.
    supportsAllDrives:        true,
    includeItemsFromAllDrives: true,
  };
  // Always exclude trashed files; append caller's query if provided.
  const trashClause = 'trashed = false';
  params.q = query ? `(${query}) and ${trashClause}` : trashClause;
  const data = await gapi('GET', '/drive/v3/files', { params });
  return {
    files: (data.files ?? []).map((f) => ({
      id:           f.id,
      name:         f.name,
      mimeType:     f.mimeType,
      link:         f.webViewLink,       // browser view URL
      downloadLink: f.webContentLink,    // direct download / embed URL for images
      thumbnail:    f.thumbnailLink,
      modified:     f.modifiedTime,
    })),
  };
}

/** sheets_read. */
export async function sheetsRead(gapi, { spreadsheetId, range = 'Sheet1' }) {
  const data = await gapi('GET', `/sheets/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  return { values: data.values ?? [], rows: (data.values ?? []).length };
}

/**
 * sheets_describe — the spreadsheet's SHAPE: its sheet/tab names, and the COLUMN
 * HEADERS of each. (P12 Increment F.)
 *
 * `sheets_append` takes a raw `values` array of arrays — positional, and therefore
 * unwritable by anyone who cannot see the header row. Asking a user to tell us
 * their column order in a chat window is asking for something we can simply READ
 * (converger-v2 §6.2.3), and it is the reason the write story stalls on Sheets the
 * same way it stalls on Airtable's base id.
 *
 * Returns a header list per sheet, so the converger can map "the customer's
 * budget" onto the column that is actually there — and can tell the user when the
 * column they named does not exist, rather than silently appending it into the
 * wrong position.
 */
export async function sheetsDescribe(gapi, { spreadsheetId }) {
  if (!spreadsheetId) throw new Error('sheets_describe: spreadsheetId is required.');
  // One call: the sheet names + the first row of each, which is the header row by
  // universal convention. `includeGridData` with a 1-row window keeps the payload
  // small on a spreadsheet with 100k rows.
  const meta = await gapi('GET', `/sheets/v4/spreadsheets/${spreadsheetId}`, {
    params: { fields: 'properties.title,sheets.properties.title' },
  });
  const sheets = (meta.sheets ?? []).map(s => s.properties?.title).filter(Boolean);

  const described = [];
  for (const title of sheets) {
    // A sheet with no header row (or an empty sheet) reports [] rather than
    // inventing column names — an empty answer is honest; a guessed one is not.
    let headers = [];
    try {
      const row = await gapi('GET', `/sheets/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`${title}!1:1`)}`);
      headers = (row.values?.[0] ?? []).map(h => String(h).trim()).filter(Boolean);
    } catch { /* an unreadable tab is not a fatal error for the others */ }
    described.push({ sheet: title, headers });
  }
  return { spreadsheetId, title: meta.properties?.title ?? null, sheets: described };
}

/** sheets_append — append rows. */
export async function sheetsAppend(gapi, { spreadsheetId, range = 'Sheet1', values }) {
  const rows = typeof values === 'string' ? JSON.parse(values) : values;
  if (!spreadsheetId) throw new Error('sheets_append: spreadsheetId is required.');
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('sheets_append: needs values to append.');
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

/**
 * docs_create — uploads markdown content to Drive and converts it to a Google Doc.
 * Uses the Drive multipart upload API (uploadType=multipart) with mimeType=text/markdown,
 * which Drive auto-converts to a formatted Google Doc (headings, bold, lists rendered).
 * Takes `token` directly because gapi() only supports JSON bodies.
 */
export async function docsCreate(token, { title, content }) {
  // R13: don't create an empty "Untitled" doc when config/input is missing. Also
  // reject the empty-input sentinels a step passes when there's no upstream data.
  const c = String(content ?? '').trim();
  const emptyContent = c === '' || c === '{}' || c === '[object Object]' || c === 'null' || c === 'undefined';
  if (emptyContent && !String(title ?? '').trim()) {
    throw new Error('docs_create: needs a title or content — refusing to create an empty document.');
  }
  const boundary = 'atlas_docs_upload_boundary';
  const metadata = JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document' });
  const multipart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: text/markdown',
    '',
    content ?? '',
    `--${boundary}--`,
  ].join('\r\n');

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body: multipart,
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`docs_create: Drive upload failed: ${err?.error?.message ?? `HTTP ${res.status}`}`);
  }
  const file = await res.json();
  return { documentId: file.id, link: `https://docs.google.com/document/d/${file.id}` };
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
  if (!String(title ?? '').trim()) throw new Error('tasks_create: needs a title.');
  const task = { title };
  if (notes) task.notes = notes;
  if (due)   task.due = due;
  const created = await gapi('POST', `/tasks/v1/lists/${tasklistId}/tasks`, { body: task });
  // Return the LIST as well as the task. A real run's receipt is what the outcome
  // check matches against, and returning only `taskId` left it with nothing to say
  // about where the task landed — so the answer came from config alone, and a real
  // run could not correct a wrong declaration. '@default' is the provider's sentinel
  // for the list Google names "My Tasks"; it identifies nothing to a reader.
  return { taskId: created.id, tasklistId: tasklistId === '@default' ? 'My Tasks' : tasklistId };
}

/**
 * Register all implemented Google actions on a CapabilityRegistry.
 * Handles receive config.googleToken (injected by CONNECTOR_INJECTORS in server.js).
 *
 * @param {import('../capability-registry.js').CapabilityRegistry} capabilityRegistry
 */
export function registerGoogleChannels(capabilityRegistry) {
  const ready = () => !!(
    (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID) &&
    (process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET)
  );

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
    // A READ. Undeclared, this fell through to the oracle's verb regex, whose
    // `message_sent` pattern matches any id ending in `_message` — so FETCHING a
    // message counted as SENDING one, and a workflow that merely read mail could
    // satisfy an outcome promising a message was sent.
    effect: 'read',
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
    effect: 'write', assertionKind: 'message_sent', locatorKeys: ['to'],
    outputFormat: 'html',
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
    // The event's own title IS its identity here — this capability takes no
    // calendar id, so it always writes to the connected primary calendar.
    effect: 'write', assertionKind: 'record_exists',
    locatorKeys: ['title'], defaultLocator: 'your calendar',
    outputFormat: 'plain',
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
    id: 'drive_create_folder', connector: 'google', positions: ['step'],
    name: 'Create Drive Folder', icon: 'folder',
    effect: 'write', assertionKind: 'document_exists',
    locatorKeys: ['name'], defaultLocator: 'your Drive',
    description: 'Create a new folder in Google Drive. Returns folderId and link — use these in downstream docs_create or drive_list_files configs.',
    configSchema: [
      { key: 'name',     label: 'Folder name', type: 'string', optional: false },
      { key: 'parentId', label: 'Parent folder ID', type: 'string', optional: true, hint: 'Leave blank to create in My Drive root' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/drive'],
    isReady: ready,
    handle: makeHandle(async (gapi, config) => {
      if (!String(config.name ?? '').trim()) throw new Error('drive_create_folder: needs a folder name.');
      const metadata = { name: config.name, mimeType: 'application/vnd.google-apps.folder' };
      if (config.parentId) metadata.parents = [config.parentId];
      const file = await gapi('POST', '/drive/v3/files', { body: metadata });
      return { folderId: file.id, name: file.name, link: `https://drive.google.com/drive/folders/${file.id}` };
    }),
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
    id: 'sheets_describe', connector: 'google', positions: ['step'],
    name: 'Describe Google Sheet', icon: 'table',
    description: 'Lists a spreadsheet\'s tabs and their column headers. Use it to map data onto real columns instead of asking the user for their column order.',
    configSchema: [
      { key: 'spreadsheetId', label: 'Spreadsheet ID', type: 'string', optional: false },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/spreadsheets'],
    isReady: ready,
    handle: makeHandle((gapi, config) => sheetsDescribe(gapi, { spreadsheetId: config.spreadsheetId })),
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
    effect: 'write', assertionKind: 'record_exists',
    locatorKeys: ['spreadsheetId', 'range'],
    outputFormat: 'plain',
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
    effect: 'write', assertionKind: 'document_exists',
    locatorKeys: ['title'], defaultLocator: 'your Drive',
    description: 'Create a new Google Doc from markdown content (headings, bold, lists render properly).',
    outputFormat: 'markdown',
    configSchema: [
      { key: 'title',   label: 'Title',   type: 'string',   optional: false },
      { key: 'content', label: 'Content', type: 'textarea', optional: true, hint: 'Markdown content; omit to use prior step output' },
    ],
    requiredScopes: ['https://www.googleapis.com/auth/drive'],
    isReady: ready,
    handle: makeHandle((_gapi, config, body) => docsCreate(config.googleToken, { title: config.title, content: config.content ?? body })),
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
    outputFormat: 'plain',
    // THE DESTINATION IS THE LIST, NOT THE TASK'S OWN NAME. `title` is content —
    // reporting it as the destination is the defect that cost three Opus rebuilds
    // on prod (see `declaredWriteEffect`). `tasklistId` is optional because the
    // handler defaults to '@default', which is the list named "My Tasks".
    effect: 'write', assertionKind: 'record_exists',
    locatorKeys: ['tasklistId'], defaultLocator: 'My Tasks',
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
