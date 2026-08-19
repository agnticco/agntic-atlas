/**
 * MCP server — Atlas's workflow API, spoken as Model Context Protocol.
 *
 * Mounted via mountMcpRoutes(app, { spine, requireActiveTenant })
 *
 *   POST /mcp   — JSON-RPC 2.0 over Streamable HTTP
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Atlas already CONSUMES MCP: `connectors/mcp-catalog.js` reads a remote server's
 * `tools/list` and projects its tools into the capability registry, so a workflow can
 * call a service nobody hand-built. This is the mirror. It lets any MCP client — Claude
 * Desktop, Claude Code, an agent harness — list and run Atlas automations, without each
 * one writing a bespoke REST client and re-deriving what a workflow is.
 *
 * ── THIS GRANTS NOTHING THE CALLER DID NOT ALREADY HAVE ─────────────────────
 *
 * Every route here sits behind `requireActiveTenant`, exactly like the console API, and
 * every tool resolves the workflow through the same tenant check the REST handlers use.
 * A token that can call `POST /api/console/workflows/:id/run` can already run that
 * workflow; this endpoint gives it a second vocabulary for doing so, not a second set of
 * permissions. That is the reason there is no separate write flag here: a gate that only
 * covers one of two doors into the same room is decoration.
 *
 * Where a gate DOES belong is the client. `run_workflow` performs real actions through
 * live connectors — messages sent, documents written — so an agent harness should surface
 * it for approval. `readOnlyHint` is set truthfully on every tool so a client can tell
 * which are which without parsing descriptions.
 *
 * ── WIRE FORMAT ─────────────────────────────────────────────────────────────
 *
 * Streamable HTTP permits a JSON body or an SSE stream, and the server chooses. This
 * answers with JSON: every method here is a single request/response with no progress to
 * report, and a stream would be ceremony. Clients that send
 * `accept: application/json, text/event-stream` handle both — Atlas's own catalog reader
 * does, which is how we know.
 *
 * A JSON-RPC notification (no `id`) gets 202 and an empty body, per spec. Returning a
 * result to a notification is the most common way a hand-rolled server confuses a
 * client into hanging.
 */

import { logEvent, errFields } from '../utils/event-log.js';
import { setWorkflowStatus, deleteWorkflow } from '../workflows/lifecycle.js';
import { generateSopMarkdown } from '../workflows/sop-generator.js';
import { SCOPES, ALL_SCOPES } from '../auth/oauth-provider.js';

/** Protocol revisions this server implements; the first is what it offers by default. */
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = [PROTOCOL_VERSION, '2025-03-26'];
const SERVER_INFO = { name: 'atlas', version: '1.0.0' };

/** JSON-RPC error codes we actually emit. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export function mountMcpRoutes(app, { spine, requireActiveTenant, tenantGuard = null,
                                     oauth = null, issuer = null }) {
  // Same default as mountBuilderRoutes: a passthrough when none is supplied, so a test
  // or a self-hosted boot without the guard behaves exactly as before.
  const guard = tenantGuard ?? ((_req, _res, next) => next());
  const store = spine.engine.workflowStore;
  const scheduler = spine.engine.workflowScheduler;
  const { tokenService, userStore } = spine.auth;

  /**
   * Two credentials, one door.
   *
   * A SESSION token is the app's own: it already grants everything its holder can do, so
   * it arrives with every scope. An OAUTH ACCESS TOKEN is what a client obtained through
   * the consent screen, and it carries only what was approved there.
   *
   * The access-token path is checked first and does NOT delegate to requireActiveTenant,
   * because an access token has no session row and would be rejected by it. It equally
   * cannot be spent anywhere else in the app: it has no `jti`, and `authenticate()`
   * requires one. A scoped credential must not open a door that has never heard of scopes.
   */
  function mcpAuth(req, res, next) {
    const header = req.headers?.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (bearer && oauth) {
      const claims = tokenService.verify(bearer);
      // `aud` IS CHECKED HERE, not only when the token was minted. The authorization
      // server binds a token to one resource (RFC 8707) so it cannot be replayed against
      // another service trusting the same issuer — a guarantee that means nothing unless
      // the resource itself refuses tokens addressed elsewhere. `verify()` does not check
      // audience, so without this line the binding was advertised and never enforced.
      const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
      const addressedToUs = !issuer || audience.includes(issuer);
      // AND THE GRANT BEHIND IT MUST STILL EXIST. A JWT is only a claim about the moment
      // it was signed; without this, revoking a connection — or the reuse detection in
      // oauth-provider deciding a refresh token has been copied — left the attacker
      // working normally for the rest of the access token's 8 hours.
      const live = claims?.gid ? oauth.grantIsLive(claims.gid) : false;
      if (claims?.typ === 'access' && claims.sub && claims.tid && addressedToUs && live) {
        const user = userStore.findById(claims.sub);
        if (user && !user.disabled_at && user.tenant_id === claims.tid) {
          req.user = user;
          req.tenant = { id: claims.tid };
          req.scopes = String(claims.scope ?? '').split(/\s+/).filter(Boolean);
          req.viaOAuth = true;
          return next();
        }
      }
    }

    // Fall back to the session path — the real check, not a copy of it. The challenge is
    // set first so a 401 from that chain carries it, and removed when it does not fire:
    // a spec-compliant client 401-probes to find out where to authenticate, and a 401
    // with nowhere to look reads as "this server does not support being connected".
    if (issuer) {
      res.set('WWW-Authenticate',
        `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
    }
    const chain = Array.isArray(requireActiveTenant) ? requireActiveTenant : [requireActiveTenant];
    let i = 0;
    const step = (err) => {
      if (err) return next(err);
      if (i >= chain.length) {
        res.removeHeader('WWW-Authenticate');
        req.scopes = ALL_SCOPES;      // a session already grants everything
        return next();
      }
      chain[i++](req, res, step);
    };
    step();
  }

  /**
   * Resolve a workflow for this caller, or throw.
   *
   * The same two-step the console handlers use: fetch scoped to the user, then check the
   * tenant. Cross-tenant access has to be structurally impossible here too — an MCP
   * caller is not a lesser client, it is the same tenant through a different door.
   */
  function ownedWorkflow(id, req) {
    const wf = store.get(id, { userId: req.user.id });
    if (!wf || wf.tenant_id !== req.tenant.id) {
      // Thrown, not returned: `tools/call` turns any throw into an isError result, so a
      // marker property would be a second mechanism nothing reads.
      throw new Error(`No workflow "${id}" in this workspace.`);
    }
    return wf;
  }

  // ── the tool surface ──────────────────────────────────────────────────────
  //
  // Descriptions are written for a model deciding whether to call them, not for a
  // developer reading a reference: each says when to reach for it, and `run_workflow`
  // says plainly that it is not a simulation.

  const TOOLS = [
    {
      name: 'list_workflows',
      scope: SCOPES.READ,
      description:
        'List the automations in this Atlas workspace. Returns id, name and status for '
        + 'each. Call this first for any question about existing automations.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'filter: draft | active | paused' },
        },
      },
      run: (args, req) => store.list({
        status: args.status || null,
        kind: null,
        userId: req.user.id,
        tenantId: req.tenant.id,
      }).map(w => ({ id: w.id, name: w.name, status: w.status, updated_at: w.updated_at })),
    },

    {
      name: 'get_workflow',
      scope: SCOPES.READ,
      description:
        'Read one automation in full, including its steps. Use after list_workflows when '
        + 'you need to know what an automation actually does.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'workflow id' } },
        required: ['id'],
      },
      run: (args, req) => ownedWorkflow(args.id, req),
    },

    {
      name: 'get_workflow_sop',
      scope: SCOPES.READ,
      description:
        'Read an automation as a plain-language standard operating procedure. Better than '
        + 'get_workflow when the answer is for a person rather than for further tool calls.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: async (args, req) => {
        const wf = ownedWorkflow(args.id, req);
        let provenance = null;
        // Best-effort, exactly as the REST handler treats it: a SOP must never fail to
        // render because the provenance store hiccuped.
        try {
          if (wf.session_id) {
            provenance = spine.interactionStore?.getProvenance(req.tenant.id, wf.session_id) ?? null;
          }
        } catch { /* a bonus, not a dependency */ }
        return { markdown: await generateSopMarkdown(wf, { provenance }) };
      },
    },

    {
      name: 'list_workflow_runs',
      scope: SCOPES.READ,
      description:
        'List past runs of an automation, newest first. Use to answer whether something '
        + 'ran, when, and whether it succeeded.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          limit: { type: 'integer', description: 'default 20, max 200' },
        },
        required: ['id'],
      },
      run: (args, req) => {
        ownedWorkflow(args.id, req);
        const limit = Math.min(Number(args.limit) || 20, 200);
        return store.getRuns(args.id, limit, { userId: req.user.id, tenantId: req.tenant.id });
      },
    },

    {
      name: 'run_workflow',
      scope: SCOPES.RUN,
      // The only tool here that spends money: a run executes LLM steps and connector
      // calls. Everything else is a store read.
      costly: true,
      description:
        'Run an automation now and wait for it to finish. THIS PERFORMS REAL ACTIONS — it '
        + 'sends messages, writes documents and creates records through whatever services '
        + 'the automation is connected to. It is not a simulation or a dry run. Returns the '
        + 'completed run. May take minutes.',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: async (args, req) => {
        ownedWorkflow(args.id, req);
        await scheduler.runNow(args.id, { trigger: 'mcp' });
        logEvent('mcp.workflow.run', { workflowId: args.id, tenant: req.tenant.id });
        return store.getLastRun(args.id, { userId: req.user.id });
      },
    },
    {
      name: 'pause_workflow',
      scope: SCOPES.MANAGE,
      description:
        'Stop an automation from running on its schedule or trigger. It keeps everything '
        + 'it has — history, configuration, steps — and can be resumed. Use this rather '
        + 'than deleting when the automation should stop for now.',
      readOnly: false,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (args, req) => lifecycleResult(await setWorkflowStatus(spine, {
        workflowId: args.id, userId: req.user.id, tenantId: req.tenant.id, to: 'paused',
      })),
    },
    {
      name: 'resume_workflow',
      scope: SCOPES.MANAGE,
      description:
        'Make a PAUSED automation live again, and re-arm its trigger. Only a paused '
        + 'automation can be resumed: one that is a draft, or that is in an error state, '
        + 'has to be published from the Atlas builder instead, because that is the path '
        + 'that verifies it works.',
      readOnly: false,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (args, req) => lifecycleResult(await setWorkflowStatus(spine, {
        workflowId: args.id, userId: req.user.id, tenantId: req.tenant.id, to: 'active',
      })),
    },
    {
      name: 'delete_workflow',
      scope: SCOPES.MANAGE,
      description:
        'Delete an automation. It stops immediately and stays recoverable for 30 days, '
        + 'after which it is purged. Prefer pause_workflow if the automation may be '
        + 'wanted again — this is not how you temporarily switch something off.',
      readOnly: false,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (args, req) => lifecycleResult(await deleteWorkflow(spine, {
        workflowId: args.id, userId: req.user.id, tenantId: req.tenant.id,
      })),
    },
  ];

  /**
   * Turn a lifecycle refusal into a TOOL result, not a protocol error.
   *
   * "This workflow has never been published" is the answer, and it is addressed to
   * whoever asked. Raising it as a JSON-RPC error would replace a sentence that says what
   * to do next with a transport failure, and a model that receives one retries.
   */
  function lifecycleResult(out) {
    if (!out.ok) throw new Error(out.error);   // tools/call turns a throw into isError
    return out;
  }

  const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

  const permitted = (req, tool) => !req.scopes || req.scopes.includes(tool.scope);

  /**
   * The `tools/list` projection — nothing internal (`run`) crosses the wire.
   *
   * Filtered by scope, so a read-only client is not shown a tool it would be refused.
   * Advertising everything and failing on use is how a model spends a turn discovering
   * a permission boundary it could have been told about.
   */
  const advertised = (req) => TOOLS.filter(t => permitted(req, t)).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly },
  }));

  /**
   * Ask the tenant guard whether an expensive call may proceed.
   *
   * ── WHY NOT JUST PUT IT ON THE ROUTE ────────────────────────────────────
   * The guard holds a per-tenant concurrency slot for the life of a request and refuses
   * outright once the daily ceiling is hit. Applied to `/mcp` wholesale that would gate
   * `initialize` and `tools/list` as well — a client could not connect at all once a
   * workspace was over budget, and a chatty listing client would consume the six slots
   * meant for actual work. So it gates the one tool that spends money.
   *
   * ── WHY THE SHIM ────────────────────────────────────────────────────────
   * The guard is express middleware: it either calls next() or writes a 429 with a REST
   * error body. Letting it write that body directly would hand an MCP client a bare
   * transport failure — a model that receives an opaque 429 retries, where one that can
   * read "daily limit reached, resets at midnight UTC" stops and says so. The shim
   * captures the refusal so it can be returned as a tool result instead.
   *
   * `on` forwards to the real response because that is where the guard registers its
   * slot release; intercepting it would leak a concurrency slot per call.
   */
  function tenantAllows(req, res) {
    return new Promise((resolve) => {
      let decided = false;
      const settle = (verdict) => { if (!decided) { decided = true; resolve(verdict); } };
      const shim = {
        _code: 429,
        status(code) { this._code = code; return this; },
        json(body) { settle({ ok: false, message: body?.error ?? 'Rate limited.' }); return shim; },
        on: (...args) => res.on(...args),
      };
      try {
        guard(req, shim, () => settle({ ok: true }));
      } catch {
        // Fail open, matching the guard's own posture: a broken brake must not stop
        // legitimate work.
        settle({ ok: true });
      }
    });
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });

  /** Tool results are text content; a structured value is stringified once, here. */
  const asContent = (value) => ({
    content: [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  });

  async function handle(message, req) {
    const { id, method, params = {} } = message ?? {};

    switch (method) {
      case 'initialize':
        return rpcOk(id, {
          // Echo the client's revision only if it is one we actually implement.
          // Echoing whatever arrived meant a client asking for a version this server has
          // never heard of was told yes, and would then frame requests we cannot read.
          // Answering with ours instead is what lets it decide to disconnect.
          protocolVersion: SUPPORTED_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion
            : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });

      case 'ping':
        return rpcOk(id, {});

      case 'tools/list':
        return rpcOk(id, { tools: advertised(req) });

      case 'tools/call': {
        const tool = BY_NAME.get(params.name);
        if (!tool) return rpcError(id, INVALID_PARAMS, `No tool named "${params.name}".`);
        if (!permitted(req, tool)) {
          return rpcOk(id, { ...asContent(
            `This connection was granted ${(req.scopes ?? []).join(', ') || 'no scopes'} and `
            + `"${tool.name}" needs ${tool.scope}. Reconnect and approve that access.`), isError: true });
        }
        try {
          return rpcOk(id, asContent(await tool.run(params.arguments ?? {}, req)));
        } catch (err) {
          // A tool's OWN failure is a RESULT with isError, not a transport error. A
          // client that gets a JSON-RPC error cannot tell the model what went wrong;
          // one that gets isError can hand it the message and let it try something else.
          logEvent('mcp.tool.error', { tool: params.name, ...errFields(err) });
          return rpcOk(id, { ...asContent(err.message ?? String(err)), isError: true });
        }
      }

      default:
        return rpcError(id, METHOD_NOT_FOUND, `Unknown method "${method}".`);
    }
  }

  /**
   * Streamable HTTP lets a client open a GET for server-initiated messages. This server
   * has none to send — every method is request/response — so it says 405 rather than
   * letting the request fall through to the 404 handler. The distinction matters to a
   * client: 405 means "this transport, no stream", while 404 means "no such endpoint"
   * and reads as a wrong URL.
   */
  app.get('/mcp', (_req, res) => {
    res.set('Allow', 'POST').status(405).json({ error: 'This MCP endpoint is POST-only.' });
  });

  app.post('/mcp', mcpAuth, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json(rpcError(null, PARSE_ERROR, 'Body must be a JSON-RPC message.'));
    }

    // ONE MESSAGE PER REQUEST. NOT A BATCH.
    //
    // JSON-RPC allows an array of messages, and the first version of this accepted one.
    // With the global 4 MB body limit that is roughly fifty thousand `run_workflow`
    // calls in a single POST, executed in sequence while the connection is held open —
    // an amplification factor no other route in Atlas offers, since every REST run
    // endpoint is one run per request. The scheduler's monthly budget check would stop
    // it eventually, having spent the tenant's entire month first.
    //
    // Batching buys nothing here: every method is a cheap round trip, and MCP clients
    // send one message per request in practice. Refusing arrays is a smaller surface
    // than policing the size of them.
    if (Array.isArray(body)) {
      return res.status(400).json(
        rpcError(null, INVALID_REQUEST, 'Send one JSON-RPC message per request; batches are not accepted.'));
    }

    try {
      if (body.jsonrpc !== '2.0') {
        return res.status(400).json(rpcError(body.id ?? null, INVALID_REQUEST, 'jsonrpc must be "2.0".'));
      }
      // No id means a notification: acknowledged by status, never answered. Replying to
      // one is the usual way a hand-rolled server leaves a client waiting.
      if (body.id === undefined || body.id === null) return res.status(202).end();

      // Spend and concurrency are checked before the tool runs, not after — a refusal
      // that arrives once the workflow has already fired is a report, not a guard.
      if (body.method === 'tools/call' && BY_NAME.get(body.params?.name)?.costly) {
        const verdict = await tenantAllows(req, res);
        if (!verdict.ok) {
          logEvent('mcp.tool.throttled', { tool: body.params?.name, tenant: req.tenant?.id });
          return res.json(rpcOk(body.id, { ...asContent(verdict.message), isError: true }));
        }
      }

      return res.json(await handle(body, req));
    } catch (err) {
      logEvent('mcp.request.error', errFields(err));
      return res.status(500).json(rpcError(body?.id ?? null, INTERNAL_ERROR, err.message ?? String(err)));
    }
  });
}

export default mountMcpRoutes;
