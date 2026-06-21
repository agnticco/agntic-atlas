/**
 * Atlas Inbox — delivery capability + registration.
 *
 * Registers `inbox_deliver` in the CapabilityRegistry as a delivery position.
 * Handler reads `config._tenantId` / `config._userId` injected by
 * `injectInboxContext()` in server.js before each run, stores the message,
 * and optionally indexes the content in the tenant's RAG store so the chat
 * agent can retrieve past deliveries semantically.
 */

export function registerInboxCapability(registry, { inboxStore, getRag }) {
  registry.register({
    id:          'inbox_deliver',
    connector:   'atlas',
    name:        'Atlas Inbox',
    description: 'Deliver workflow output to the user\'s Atlas inbox',
    positions:   ['delivery'],
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

      // Index in RAG so the chat agent can surface this content semantically.
      // Non-fatal: if the RAG pipeline isn't ready, deliver still succeeds.
      try {
        const rag = await getRag(tenantId);
        await rag.ingest(content, {
          source:            'inbox',
          inbox_message_id:  msg.id,
          subject,
          user_id:           userId,
          tenant_id:         tenantId,
        });
      } catch { /* non-fatal */ }

      return { inbox_message_id: msg.id, subject, delivered: true };
    },
  });
}
