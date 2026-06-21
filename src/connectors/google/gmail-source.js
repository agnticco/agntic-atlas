/**
 * Gmail polling source for the Atlas scheduler.
 *
 * Registered as fetcher('gmail', gmailSource) on the WorkflowScheduler.
 * The scheduler calls poll({ workflow, tenantId, auth, cipher }) on each tick
 * for every active flow-kind workflow with an `email` trigger. When new
 * messages arrive matching the trigger's filter, the flow fires with the
 * email content injected as the initial context.
 *
 * Watermark: stored as last-seen message internalDate in memory
 * (./memory/gmail/<tenantId>-<workflowId>.json). Persists across ticks,
 * resets to "24h ago" on first run.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeGoogleApi, makeGoogleApiFromToken, gmailSearch, GOOGLE_CONNECTOR_ID } from './index.js';

const WATERMARK_DIR = process.env.GMAIL_WATERMARK_DIR ?? './memory/gmail';

function watermarkPath(tenantId, workflowId) {
  return join(WATERMARK_DIR, `${tenantId}-${workflowId}.json`);
}

function loadWatermark(tenantId, workflowId) {
  try {
    return JSON.parse(readFileSync(watermarkPath(tenantId, workflowId), 'utf8'));
  } catch {
    // First run: look back 24h so we don't flood with history.
    return { lastInternalDate: Date.now() - 24 * 60 * 60 * 1000 };
  }
}

function saveWatermark(tenantId, workflowId, data) {
  try {
    mkdirSync(WATERMARK_DIR, { recursive: true });
    writeFileSync(watermarkPath(tenantId, workflowId), JSON.stringify(data));
  } catch { /* non-fatal */ }
}

/**
 * Poll Gmail for new messages matching a workflow's email trigger.
 *
 * @param {object} opts
 * @param {object} opts.workflow       — the workflow row (includes triggers[])
 * @param {string} opts.tenantId
 * @param {string} opts.userId         — the user whose Google token to use
 * @param {object} opts.oauthTokenStore
 * @param {object} opts.cipher
 * @returns {Promise<object[]>} — array of new message objects (empty = nothing new)
 */
export async function pollGmail({ workflow, tenantId, userId, oauthTokenStore, cipher, oauthClient }) {
  const trigger = (workflow.triggers ?? []).find((t) => t.type === 'email');
  if (!trigger) return [];

  // Prefer auto-refreshing via OAuthClient; fall back to sync vault read.
  let gapi;
  if (oauthClient) {
    let token;
    try {
      token = await oauthClient.getAccessToken({ userId, tenantId, connectorId: GOOGLE_CONNECTOR_ID });
    } catch {
      return []; // not connected or refresh failed — skip silently
    }
    gapi = makeGoogleApiFromToken(token);
  } else {
    const row = oauthTokenStore.get({ tenantId, userId, connectorId: GOOGLE_CONNECTOR_ID });
    if (!row) return [];
    gapi = makeGoogleApi({ oauthTokenStore, cipher, tenantId, userId });
  }
  const filter = trigger.filter ?? '';
  const wm = loadWatermark(tenantId, workflow.id);

  // Build query: filter + after watermark (Gmail uses epoch seconds).
  const afterSec = Math.floor(wm.lastInternalDate / 1000);
  const query = filter ? `${filter} after:${afterSec}` : `after:${afterSec}`;

  const { messages } = await gmailSearch(gapi, { query, maxResults: trigger.maxResults ?? 5 });
  if (!messages.length) return [];

  // Filter to only messages strictly newer than the watermark.
  const newMessages = messages.filter((m) => {
    const ts = new Date(m.date).getTime() || Date.now();
    return ts > wm.lastInternalDate;
  });
  if (!newMessages.length) return [];

  // Advance watermark to the newest message.
  const newest = Math.max(...newMessages.map((m) => new Date(m.date).getTime() || Date.now()));
  saveWatermark(tenantId, workflow.id, { lastInternalDate: newest });

  return newMessages;
}

/**
 * Format a Gmail message as the initial context injected into the flow.
 * The deliver node receives this as ctx.lastOutput.
 */
export function formatEmailContext(message) {
  return [
    `From: ${message.from}`,
    `Subject: ${message.subject}`,
    `Date: ${message.date}`,
    '',
    message.body || message.snippet,
  ].join('\n');
}
