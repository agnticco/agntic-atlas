/**
 * Knowledge connector — the tenant's own documents, as capabilities.
 *
 * WHY THIS EXISTS. Charles, 2026-07-30, after a day of defects that clustered in one
 * place: *"We are not exposing the tools that are available to the agent, to the agent
 * properly… Knowledge should be writeable, readable, and contents able to be used in
 * workflows."* He was right, and Knowledge was the clearest case: the product has a
 * Knowledge page, a RAG index and per-tenant isolation, and **zero registered
 * capabilities**. Measured that day: `knowledge/rag capabilities: (NONE)`.
 *
 * The cost of that gap was not theoretical. Asked to build a support-reply workflow
 * grounded in company documents, Atlas answered *"Perfect — I can pull from your
 * Knowledge docs in the workflow"* — with an EMPTY knowledge base, having checked
 * nothing, because nothing in its picture of the world mentioned knowledge at all.
 *
 * WHAT REGISTERING IT BUYS, beyond the two handlers below: everything that reads the
 * capability catalog now sees Knowledge without being told about it separately — the
 * interview prompt, the destination oracle, the validator's write guards, the
 * declaration audit, the plain-English step vocabulary. That is the point of the
 * registry, and it is why this is a connector rather than a special case.
 *
 * ── DOES IT PHONE US? (required of every new connector, ENGINEERING-LOG.md 2026-07-24) ──
 * NO. Knowledge has no trigger and needs none: nothing happens "when a document
 * changes" — a workflow READS it when it runs, and WRITES to it as an action. There is
 * no subscription to register, nothing to renew, nothing to prove genuine and nothing
 * to tear down on delete. It therefore also has no publicly-reachable requirement and
 * is fully testable on a laptop.
 */

/**
 * @param {object} registry   the CapabilityRegistry
 * @param {object} deps
 *   @param {(tenantId:string)=>Promise<{query:Function, ingest:Function}>} deps.forTenant
 *          the per-tenant RAG handle (`spine.rag.forTenant`) — RAG is PHYSICALLY isolated
 *          per tenant (a closed decision), so the tenant id is not an optional filter.
 *   @param {(tenantId:string)=>Array}  [deps.readSources]  the tenant's knowledge sources
 */
export function registerKnowledgeCapabilities(registry, { forTenant, readSources } = {}) {
  if (!registry || typeof forTenant !== 'function') return registry;

  // ── WHY `isReady` IS NOT "DOES THIS TENANT HAVE DOCUMENTS" ─────────────────
  //
  // The registry calls `isReady()` with NO ARGUMENTS — it is a DEPLOYMENT-level question
  // ("is this subsystem wired?"), not a per-tenant one. The first version of this file
  // asked "does this tenant have any documents", which with no tenant in scope resolved
  // to `readSources(undefined)` → `[]` → **permanently unavailable for everyone**.
  // Measured before shipping: a tenant holding a document still got `available: false,
  // reason: 'dependency not ready'`. Registering a capability nobody can ever use would
  // have been a quieter version of the very defect this connector exists to fix.
  //
  // Per-tenant emptiness travels the channel built for it instead: `capabilities.knowledge`
  // (builder.js) carries the document count, and the interview is told in words when it
  // is zero. That is tenant-aware, and it is what a person actually needs to hear.
  //
  // Being REGISTERED is itself the readiness signal: `registerKnowledgeCapabilities`
  // returns without registering anything when there is no RAG handle to call.

  // THE TENANT ID IS NOT OPTIONAL AND MUST NOT FAIL OPEN.
  //
  // RAG is physically isolated per tenant (closed decision, 2026-06-09) and the stores
  // throw on a missing tenant rather than returning unscoped rows. `_tenantId` is
  // stamped into node config before each run by the same injector the filesystem
  // connector uses. Refusing to run without it is the fail-closed half of that decision:
  // a silent default here would search one tenant's documents on another's behalf.
  const tenantOf = (config) => {
    const t = config?._tenantId;
    if (!t) throw new Error('knowledge: no tenant in scope — refusing to search or write');
    return t;
  };

  registry.register({
    id: 'knowledge_search', connector: 'knowledge', positions: ['step'],
    name: 'Search Knowledge', icon: 'book',
    description: "Search this workspace's own documents and return the passages that match. Use it to ground a reply or a summary in the company's real material rather than the model's general knowledge.",
    effect: 'read',
    configSchema: [
      { key: 'query',      label: 'What to look for', type: 'string', optional: false },
      { key: 'maxResults', label: 'How many passages', type: 'number', optional: true },
    ],
    isReady: () => true,
    handle: async ({ config }) => {
      const rag = await forTenant(tenantOf(config));
      const k = Number.isFinite(Number(config?.maxResults)) ? Number(config.maxResults) : 6;
      const hits = (await rag.query(String(config?.query ?? ''), Math.max(1, Math.min(20, k)))) ?? [];
      // A miss is NOT an error and must not read as one. An empty result is the honest
      // answer to "is this in our documents?", and the step that consumes it is already
      // instructed to say so rather than invent.
      const passages = hits.map(h => ({
        label:   h.metadata?.subject || h.metadata?.source_path || h.metadata?.source || 'knowledge',
        content: String(h.pageContent ?? h.content ?? ''),
        score:   h.score ?? null,
      }));
      return {
        found: passages.length,
        passages,
        text: passages.map(p => `[${p.label}]\n${p.content}`).join('\n\n---\n\n'),
      };
    },
  });

  registry.register({
    id: 'knowledge_write', connector: 'knowledge', positions: ['step', 'delivery'],
    name: 'Save to Knowledge', icon: 'book',
    description: "Save text into this workspace's Knowledge so later workflows and chats can find it.",
    // Declared, never inferred — `knowledge_write` matches no verb in the guess regex,
    // which is exactly how `airtable_delete_record` escaped both write guards.
    effect: 'write', assertionKind: 'document_exists',
    // The destination is FIXED: there is one Knowledge base per workspace. Declaring no
    // locator keys says so; `defaultLocator` is then the whole answer. Declaring
    // `['title']` instead would make the document's own NAME the place it was written —
    // the defect that cost three rebuilds on Google Tasks and two on Calendar.
    locatorKeys: [], defaultLocator: 'your Knowledge',
    outputFormat: 'markdown',
    configSchema: [
      { key: 'title', label: 'Title', type: 'string', optional: false },
      { key: 'body',  label: 'Body (defaults to the previous step)', type: 'textarea', optional: true },
    ],
    isReady: () => true,
    handle: async ({ config, body }) => {
      const tenantId = tenantOf(config);
      const rag = await forTenant(tenantId);
      const text = String(body ?? config?.body ?? '').trim();
      if (!text) throw new Error('knowledge_write: nothing to save — the step produced no content');
      const title = String(config?.title ?? '').trim() || 'Untitled note';
      const chunks = await rag.ingest(text, {
        source: 'workflow', subject: title, source_path: `knowledge/${title}`, tenant_id: tenantId,
      });
      return { saved: true, title, chunks, target: 'your Knowledge' };
    },
  });

  return registry;
}

/**
 * What the interview should be TOLD about this workspace's Knowledge.
 *
 * Returned even when empty — that is the whole point. Silence about an empty knowledge
 * base is not neutral: on 2026-07-30 it read as confirmation, and Atlas told the
 * operator it would use documents that did not exist.
 */
export function knowledgeState(readSources, tenantId) {
  let sources = [];
  try { sources = readSources?.(tenantId) ?? []; } catch { sources = []; }
  return {
    documentCount: sources.length,
    // A source is usable BY A WORKFLOW when its path is absolute — which includes
    // uploads, since `/rag/upload` persists them and records that path. Only an upload
    // where nothing was persisted (image-only) has a bare name.
    names: sources.map(s => s.name || s.path).filter(Boolean).slice(0, 20),
  };
}
