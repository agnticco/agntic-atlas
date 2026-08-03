/**
 * A REMOTE SERVER'S TOOLS, PROJECTED INTO ATLAS'S OWN CATALOG. (P13-A, second half.)
 *
 * ── The invariant: ONE contract ─────────────────────────────────────────────
 *
 * There is a single internal capability shape, and a native registration and an
 * MCP tool both project INTO it. Nothing downstream — the converger, the engine,
 * the destination oracle, the write and approval guards, the plain-English step
 * words — may be able to tell where a capability came from. The moment a
 * consumer can, every one of them needs teaching about two kinds of capability,
 * and that is the fragmentation `CapabilityRegistry` was built to end.
 *
 * So this file is a PROJECTION, not a second registry.
 *
 * ── Effect fails CLOSED to `write`, and this is the load-bearing decision ────
 *
 * MCP's `readOnlyHint` is optional and, in practice, usually absent. Two guards
 * hang off a capability's declared effect: duplicate protection (idempotency) and
 * the approval-strength check. A capability that writes but is read as a read
 * SKIPS BOTH — so an un-flagged tool is treated as a write.
 *
 * The cost of being wrong each way is what decides it. Wrongly writing: a
 * spurious idempotency key and an approval step nobody needed — noise. Wrongly
 * reading: a duplicate charge, a duplicate email, a record deleted twice, with no
 * approval anywhere. This codebase already recorded the same asymmetry when
 * `airtable_delete_record` — its most destructive capability — escaped both
 * guards because a verb regex did not recognise it.
 *
 * ── No triggers, and that is a phase decision, not an oversight ─────────────
 *
 * MCP-sourced capabilities are `step` / `delivery` ONLY. A trigger has to be
 * ARMED — something must register a subscription, renew it, prove an inbound call
 * genuine and tear it down — and none of that is in the MCP tool contract. A
 * trigger Atlas cannot arm is a workflow that publishes, shows as live and never
 * fires, which is the exact lie the product exists to prevent and which cost six
 * defects to fix for Slack alone. The honest answer for every P13 connector is
 * "no trigger in this phase".
 *
 * ── Remote Streamable-HTTP only ────────────────────────────────────────────
 *
 * Never stdio, never a per-tenant subprocess. The archived stdio pool in
 * `agntic-prod` is deliberately NOT resurrected: a subprocess per tenant per
 * server is an operational burden this phase has no appetite for, and the remote
 * transport is what makes one-button connection possible at all.
 */

/** What MCP calls a tool's shape → what Atlas calls a config field. */
const JSON_TYPE_TO_FIELD = {
  string: 'string', number: 'number', integer: 'number',
  boolean: 'boolean', array: 'string', object: 'string',
};

/**
 * Project one MCP tool's `inputSchema` into a `configSchema`.
 *
 * Order is preserved from `properties`, because that is the order the server's
 * author chose and a form reads better in it than alphabetically. A property
 * whose type is unknown becomes a string rather than being dropped — dropping it
 * would silently remove a field the tool needs, and the run would fail at the
 * service with no clue why.
 */
export function projectInputSchema(inputSchema) {
  const props = inputSchema?.properties;
  if (!props || typeof props !== 'object') return [];
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  return Object.entries(props).map(([key, spec]) => ({
    key,
    label: String(spec?.title ?? key).replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
    type: JSON_TYPE_TO_FIELD[String(spec?.type ?? '')] ?? 'string',
    optional: !required.has(key),
    ...(spec?.description ? { hint: String(spec.description) } : {}),
  }));
}

/**
 * The effect a tool declares, resolved FAIL-CLOSED.
 *
 * Only an explicit `readOnlyHint: true` yields a read. Absent, false, or any
 * non-boolean is a write. `destructiveHint` can never soften it.
 */
export function projectEffect(annotations) {
  return annotations?.readOnlyHint === true ? 'read' : 'write';
}

/**
 * Where a capability may sit in a workflow.
 *
 * A read is a step. A write is a step AND a delivery — the same as every native
 * write capability, so `deliver` nodes can target it. Never a trigger.
 */
export function projectPositions(effect) {
  return effect === 'read' ? ['step'] : ['step', 'delivery'];
}

/**
 * One MCP tool → one capability definition, ready for `CapabilityRegistry.register`.
 *
 * The id is namespaced by connector so two servers exposing a tool of the same
 * name cannot collide — and so the id still answers "who does this belong to",
 * which is what credential resolution reads (seam #4).
 */
export function projectMcpTool(tool, { connector }) {
  if (!tool?.name) throw new Error('projectMcpTool: the tool has no name');
  if (!connector) throw new Error(`projectMcpTool "${tool.name}": a connector id is required`);

  const effect = projectEffect(tool.annotations);
  return {
    id: `${connector}_${tool.name}`,
    connector,
    positions: projectPositions(effect),
    effect,
    name: String(tool.annotations?.title ?? tool.title ?? tool.name),
    description: String(tool.description ?? ''),
    icon: 'plug',
    configSchema: projectInputSchema(tool.inputSchema),
    outputFormat: 'plain',
    // WHAT IT CAME FROM, recorded but never consulted for a DECISION. Kept for
    // diagnosis — "which server gave us this" is the first question when a
    // capability misbehaves — and deliberately not read by any guard, because a
    // consumer that branches on provenance is the fragmentation this ends.
    source: { kind: 'mcp', tool: tool.name },
  };
}

/**
 * ONE REPLY, TWO WIRE FORMATS — AND THE REAL SERVER USES THE SECOND.
 *
 * "Streamable HTTP" lets a server answer a JSON-RPC call EITHER as a plain JSON
 * body or as a Server-Sent Event stream, and it picks. Notion picks the stream:
 *
 *     event: message
 *     data: {"jsonrpc":"2.0","id":1,"result":{"tools":[…]}}
 *
 * Calling `res.json()` on that throws `Unexpected token 'e'`, which is what
 * production did on the very first real connect — the sign-in succeeded, the
 * catalog read failed, and the workspace showed CONNECTED WITH ZERO TOOLS.
 *
 * WHY NO TEST CAUGHT IT: the fixture answered in JSON, because that is the shape
 * the author imagined. This codebase's own rule — a check must construct its
 * subject the way PRODUCTION does — and it was broken here by the person who
 * keeps writing it down. The pinning test now serves BOTH framings, and the SSE
 * one is modelled on the bytes Notion actually sent.
 *
 * The LAST data frame wins: a server may send progress notifications before the
 * result, and taking the first would return a notification as the answer.
 */
export function parseRpcBody(text, method = 'request') {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error(`${method} failed: the server sent an empty reply`);

  if (!/^(event|data|id|retry):/m.test(raw)) return JSON.parse(raw);

  let last = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    // A frame that is not JSON is a keep-alive or a comment, not the answer —
    // skipping it must not lose a real result that came earlier.
    try { const p = JSON.parse(payload); if (p && (p.result !== undefined || p.error)) last = p; } catch { /* not the answer */ }
  }
  if (!last) throw new Error(`${method} failed: the server streamed no result`);
  return last;
}

/** JSON-RPC over Streamable HTTP. One request, one response. */
async function rpc(url, method, params, { fetchImpl = fetch, headers = {}, timeoutMs = 15000 } = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl?.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (!res.ok) throw new Error(`${method} failed: HTTP ${res.status}`);
    const body = parseRpcBody(await res.text(), method);
    if (body?.error) throw new Error(`${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body?.result ?? {};
  } finally { clearTimeout(timer); }
}

/**
 * Read a remote server's catalog and project it. Registers nothing — the caller
 * decides, so a load can be inspected before it changes the registry.
 *
 * A tool that cannot be projected is DROPPED AND REPORTED, never guessed at: a
 * capability half-understood is worse than one absent, because the absent one
 * cannot be put in a workflow.
 */
export async function loadMcpCatalog({ url, connector, fetchImpl = fetch, headers = {}, timeoutMs = 15000 }) {
  if (!url) throw new Error('loadMcpCatalog: url is required');
  if (!/^https:\/\//i.test(url) && !/^http:\/\/localhost/i.test(url)) {
    // Remote Streamable-HTTP only. A non-HTTP transport here would be the stdio
    // pool by another name, which this phase deliberately does not resurrect.
    throw new Error(`loadMcpCatalog: ${url} is not an https endpoint — MCP servers are remote-only in Atlas`);
  }
  const result = await rpc(url, 'tools/list', {}, { fetchImpl, headers, timeoutMs });
  const tools = Array.isArray(result?.tools) ? result.tools : [];

  const capabilities = [];
  const skipped = [];
  for (const t of tools) {
    try { capabilities.push(projectMcpTool(t, { connector })); }
    catch (e) { skipped.push({ tool: t?.name ?? '(unnamed)', reason: String(e.message) }); }
  }
  return { capabilities, skipped, count: capabilities.length };
}

/**
 * Project and register in one step.
 *
 * Registers through the SAME `CapabilityRegistry.register` every native
 * capability uses, so a projection that does not satisfy the contract throws
 * here rather than producing a capability nothing downstream can read.
 */
export async function registerMcpCatalog(registry, opts) {
  const loaded = await loadMcpCatalog(opts);
  for (const cap of loaded.capabilities) registry.register(cap);
  return loaded;
}
