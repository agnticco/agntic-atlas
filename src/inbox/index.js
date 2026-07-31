/**
 * Atlas Inbox — delivery capability + search capability + registration.
 *
 * Registers two capabilities in the CapabilityRegistry:
 *   inbox_deliver (positions: delivery) — writes artifact + indexes in the
 *     tenant's dedicated inbox RAG store (inbox.sqlite, separate from the
 *     company-knowledge store).
 *   search_inbox  (positions: step)    — semantic search over past inbox
 *     artifacts using the same per-tenant inbox.sqlite store.
 *
 * Both capabilities read `config._tenantId` injected by server.js context
 * injectors before each run.  inbox_deliver additionally needs `config._userId`.
 */

/** Capability IDs that need _tenantId stamped via injectInboxCapabilityContext. */
export const INBOX_CAPABILITY_IDS = new Set(['search_inbox']);

export function registerInboxCapability(registry, { inboxStore, getRagInbox }) {
  // ── Delivery ──────────────────────────────────────────────────────────────
  registry.register({
    id:           'inbox_deliver',
    connector:    'atlas',
    name:         'Atlas Inbox',
    description:  'Deliver workflow output to the user\'s Atlas inbox and index it for future retrieval',
    positions:    ['delivery'],
    outputFormat: 'plain',
    // ── DECLARED, 2026-07-30. It said nothing at all before. ──────────────────
    //
    // Undeclared, the oracle fell back to the hardcoded channel table, which lists
    // `locatorKeys: ['subject','title']` — so it believed this step wrote TO ITS OWN
    // SUBJECT LINE. Measured: a node with `subject: "Weekly digest for {{today}}"`
    // reported its destination as `"Weekly digest for {{today}}"`, a template. That is
    // the THIRD instance of title-as-destination (Google Tasks, Calendar, this), and
    // while the inbox is currently exempt from locator comparison so no promise failed,
    // it is what a PERSON is shown in the failure sentence: "this run delivered to
    // Weekly digest for {{today}}".
    //
    // The destination is FIXED — there is one inbox per person — so no locator keys and
    // a `defaultLocator` that names it, the shape the declaration audit now recognises.
    // The subject is CONTENT: what the message is called, not where it went.
    effect: 'write', assertionKind: 'message_sent',
    locatorKeys: [], defaultLocator: 'your Atlas inbox',
    configSchema: [
      { key: 'subject', label: 'Subject', type: 'text', optional: true,
        hint: 'Message title shown in the inbox list. Defaults to the workflow name.' },
    ],
    isReady:  () => true,
    handle:   async ({ config, body }) => {
      const tenantId = config._tenantId;
      const userId   = config._userId;
      if (!tenantId || !userId) {
        throw new Error('inbox_deliver: tenant + user context not injected — is injectInboxContext() called before this run?');
      }

      const subject = config.subject || 'Workflow output';
      const content = body || '';

      const msg = inboxStore.create({
        tenantId, userId,
        sourceWorkflowId: config._workflowId ?? null,
        sourceRunId:      config._runId ?? null,
        subject, content,
      });

      // Index into the dedicated per-tenant inbox vector store (inbox.sqlite).
      // Kept separate from the company-knowledge store so users can query them
      // independently. Non-fatal: delivery still succeeds if RAG is unavailable.
      try {
        const rag = await getRagInbox(tenantId);
        await rag.ingest(`${subject}\n\n${content}`, {
          source:           'inbox',
          inbox_message_id: msg.id,
          subject,
          user_id:          userId,
          tenant_id:        tenantId,
        });
      } catch { /* non-fatal */ }

      return { inbox_message_id: msg.id, subject, delivered: true };
    },
  });

  // ── Search ────────────────────────────────────────────────────────────────
  registry.register({
    id:          'search_inbox',
    connector:   'atlas',
    name:        'Search Inbox',
    description: 'Retrieve past workflow outputs from the Atlas Inbox using semantic search. Returns the most relevant artifacts as context for subsequent steps.',
    positions:   ['step'],
    // Declared rather than left to the verb regex. It happened to satisfy nothing
    // already — `search_inbox` matches no write verb — but "correct by accident" is what
    // the declaration audit exists to end: `gmail_get_message` matched the message_sent
    // verb and let READING mail satisfy a promise to SEND it.
    effect: 'read',
    configSchema: [
      { key: 'query',  label: 'Search query', type: 'text',   required: true,
        hint: 'What to look for in past inbox deliveries.' },
      { key: 'k',      label: 'Max results',  type: 'number', optional: true,
        hint: 'Number of results to return (default: 5).' },
    ],
    isReady:  () => true,
    handle:   async ({ config, lastOutput }) => {
      const tenantId = config._tenantId;
      if (!tenantId) throw new Error('search_inbox: missing _tenantId — is injectInboxCapabilityContext() called before this run?');

      const query = config.query || (typeof lastOutput === 'string' ? lastOutput : '') || '';
      if (!query.trim()) throw new Error('search_inbox: query is required');

      const k = Math.max(1, Math.min(Number(config.k ?? 5), 20));
      const rag = await getRagInbox(tenantId);
      const hits = await rag.query(query, k);

      const results = hits.map(h => ({
        score:    h.score,
        content:  h.pageContent ?? h.content ?? '',
        metadata: h.metadata ?? {},
      }));

      return { results, count: results.length, query };
    },
  });
}
