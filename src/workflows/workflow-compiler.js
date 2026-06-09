/**
 * WorkflowCompiler — Translates structured proposal fields into a workflow.
 *
 * This is intentionally thin. The LLM handles negotiation; the compiler
 * just stamps the result into a workflow object and validates it.
 *
 * @module src/workflows/workflow-compiler.js
 */

import { WorkflowStore } from './workflow-store.js';

/** Patterns that suggest recurring/automated intent in user messages. */
const RECURRING_PATTERNS = [
  /\bevery\s+(day|morning|evening|night|week|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(daily|weekly|hourly|nightly)\b/i,
  /\bwhenever\b/i,
  /\beach\s+(day|morning|evening|night|week)\b/i,
  /\bbefore\s+(i|my)\s+(wake|get up|start|leave)\b/i,
  /\bremind\s+me\s+to\b/i,
  /\bschedule\b/i,
  /\bautomatically\b/i,
  /\brecurring\b/i,
  /\bevery\s+\d+\s*(minutes?|hours?|days?)\b/i,
];

/**
 * Detect whether a user message implies recurring/automated intent.
 * @param {string} text — the user's message
 * @returns {boolean}
 */
export function detectRecurringIntent(text) {
  return RECURRING_PATTERNS.some(re => re.test(text));
}

/**
 * Parse a natural-language schedule into the internal "daily HH:MM" format.
 * Returns null if unparseable.
 * @param {string} text — e.g., "every morning at 6", "daily at 7:30 AM"
 * @returns {string|null} — e.g., "daily 06:00"
 */
export function parseSchedule(text) {
  // "at HH:MM AM/PM" or "at HH AM/PM"
  const timeMatch = text.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2] ?? '0', 10);
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return `daily ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // "every morning" / "before I wake up" → default 6:00
  if (/\b(morning|wake|sunrise)\b/i.test(text)) return 'daily 06:00';
  // "every evening" → default 18:00
  if (/\b(evening|night|sunset)\b/i.test(text)) return 'daily 18:00';
  // "daily" with no time → default 07:00
  if (/\b(daily|every\s+day)\b/i.test(text)) return 'daily 07:00';

  return null;
}

/**
 * Build a workflow proposal from conversational fields.
 * Does NOT save — returns the structured object for confirmation.
 *
 * @param {object} fields
 * @param {string} fields.userIntent — what the user asked for
 * @param {string} fields.sourceId — which source to use
 * @param {string} fields.schedule — "daily HH:MM"
 * @param {object} [fields.config] — source-specific params
 * @param {string} [fields.outputFormat] — "summary" | "full" | "briefing"
 * @returns {object} — proposal object ready for frontend confirmation
 */
export function buildProposal({ userIntent, sourceId, schedule, config = {}, outputFormat = 'summary' }) {
  return {
    slug: WorkflowStore.slugify(userIntent),
    userIntent,
    sourceId,
    schedule,
    outputFormat,
    delivery: 'in_app',
    config,
  };
}
