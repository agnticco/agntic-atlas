/**
 * WorkflowService — single CRUD entry point for workflows.
 *
 * Every workflow mutation (create / update / delete / pause / resume / runNow)
 * MUST go through this module. Both the LLM tool layer and the REST API call
 * into it so there is exactly one validation + persistence + event-emission
 * path. The tool layer never duplicates logic that lives here.
 *
 * Per-call contract
 * ─────────────────
 *   Every method takes `{ userId }`. The service enforces that userId on
 *   reads, writes, and existence checks — callers never see another user's
 *   workflows, even if they guess an id. Pass a string userId; null/undefined
 *   is treated as "no owner" and returns nothing.
 *
 * Event bus
 * ─────────
 *   Pass `events: WorkflowEventBus` to a method to receive a corresponding
 *   `workflow_created` / `workflow_updated` / `workflow_deleted` /
 *   `workflow_status_changed` event. The chat/stream handler drains the bus
 *   at end-of-turn and serializes the events as SSE. REST handlers drain it
 *   for the response payload (or ignore it).
 *
 * Schedule normalization
 * ──────────────────────
 *   Input may carry a high-level `schedule` object (kind: daily | weekly |
 *   cron | manual). The service normalises that into a trigger node + an
 *   entry in `workflow.triggers`, which is what the scheduler reads. Tools
 *   take the high-level shape; REST may pass either the high-level shape or
 *   a pre-built `triggers/nodes/edges` for full control.
 *
 * @module src/workflows/workflow-service.js
 */

import { WorkflowStore } from './workflow-store.js';

const DOW_MAP = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

export class WorkflowService {
  /**
   * @param {object} deps
   * @param {import('./workflow-store.js').WorkflowStore} deps.workflowStore
   * @param {import('./node-type-registry.js').NodeTypeRegistry} deps.nodeTypeRegistry
   * @param {import('./channel-registry.js').ChannelRegistry} deps.channelRegistry
   * @param {import('./source-registry.js').SourceRegistry} [deps.sourceRegistry]
   * @param {import('./workflow-validator.js').WorkflowValidator} deps.workflowValidator
   * @param {import('./workflow-scheduler.js').WorkflowScheduler} deps.workflowScheduler
   */
  constructor({ workflowStore, nodeTypeRegistry, channelRegistry, sourceRegistry, workflowValidator, workflowScheduler }) {
    this.workflowStore     = workflowStore;
    this.nodeTypeRegistry  = nodeTypeRegistry;
    this.channelRegistry   = channelRegistry;
    this.sourceRegistry    = sourceRegistry;
    this.workflowValidator = workflowValidator;
    this.workflowScheduler = workflowScheduler;
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  list({ userId, status = null, kind = null } = {}) {
    if (!userId) return [];
    return this.workflowStore.list({ userId, status, kind });
  }

  get(idOrSlug, { userId } = {}) {
    if (!userId || !idOrSlug) return null;
    return this.workflowStore.get(idOrSlug, { userId })
        ?? this.workflowStore.getBySlug(idOrSlug, { userId })
        ?? null;
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  /**
   * Create a new workflow from a high-level recipe OR a pre-assembled
   * definition. Recipe shape (preferred from LLM):
   *   { name, description?, schedule: {kind, time, daysOfWeek, cron},
   *     steps: [{type, config, label?}], delivery: {channel, ...}, autoStart? }
   * Definition shape (REST clients with full control):
   *   { name, description?, triggers: [...], nodes: [...], edges: [...],
   *     errorHandling?: {...}, status? }
   */
  async create(input, { userId, tenantId = null, events = null } = {}) {
    if (!userId) return _err('Missing authenticated userId on service call.');

    const built = this._assembleDefinition(input);
    if (built.error) return { ok: false, error: built.error };
    const { def, status } = built;

    const result = this.workflowValidator.validate(def);
    if (!result.ok) {
      return {
        ok: false,
        error: 'Workflow failed validation.',
        issues: result.errors.map(_publicIssue),
        warnings: result.warnings,
      };
    }

    const slug = await this._uniqueSlug(def.name, userId, input.slug);
    const workflow = this.workflowStore.create({
      slug,
      userId,
      tenantId,
      sessionId:    input.sessionId,
      kind:         'flow',
      name:         def.name,
      description:  def.description,
      userIntent:   input.userIntent ?? def.name,
      triggers:     def.triggers,
      nodes:        def.nodes,
      edges:        def.edges,
      errorHandling: def.errorHandling,
      outcome:      def.outcome ?? null,
      specVersion:  def.outcome ? 2 : 1,
      status,
    });
    events?.push({ type: 'workflow_created', workflow });
    return { ok: true, workflow, warnings: result.warnings };
  }

  /**
   * Partial update. Accepts a recipe-style patch (schedule/steps/delivery)
   * which is re-assembled, or definition-level fields (triggers/nodes/edges/
   * name/description/errorHandling) which are merged directly.
   * Status patches go through pause/resume — this method ignores `status`.
   */
  async update(idOrSlug, patch = {}, { userId, events = null } = {}) {
    if (!userId) return _err('Missing authenticated userId on service call.');
    const current = this.get(idOrSlug, { userId });
    if (!current) return { ok: false, error: `No workflow matches "${idOrSlug}".`, code: 'NOT_FOUND' };

    // Two patch styles: recipe (schedule/steps/delivery) or definition fields.
    let merged;
    if (patch.schedule || patch.steps || patch.delivery) {
      // Re-assemble from recipe. Fall back to current's definition where the
      // patch doesn't override.
      const recipe = {
        name:        patch.name        ?? current.name        ?? current.user_intent,
        description: patch.description ?? current.description,
        schedule:    patch.schedule    ?? _deriveScheduleFromCurrent(current),
        steps:       patch.steps       ?? _deriveStepsFromCurrent(current),
        delivery:    patch.delivery    ?? _deriveDeliveryFromCurrent(current),
        autoStart:   patch.autoStart,
      };
      const built = this._assembleDefinition(recipe);
      if (built.error) return { ok: false, error: built.error };
      merged = built.def;
    } else {
      merged = {
        name:          patch.name          ?? current.name,
        description:   patch.description   ?? current.description,
        triggers:      patch.triggers      ?? current.triggers,
        nodes:         this._applyConfigDefaults(patch.nodes ?? current.nodes ?? []),
        edges:         patch.edges         ?? current.edges,
        errorHandling: patch.errorHandling ?? current.error_handling,
      };
    }

    // THE CONTRACT SURVIVES THE EDIT. A workflow published with an outcome is
    // still held to it when it is changed — otherwise defect #1 simply walks back
    // in through the edit path: publish "post to Slack AND email the rep" (checked,
    // passes), then delete the email step in a later edit and nobody objects.
    // The promise was made to the user, not to the publish button.
    //
    // `patch.outcome === null` is how you deliberately RETRACT a contract; an
    // absent key inherits the stored one.
    const inheritedOutcome = patch.outcome !== undefined ? patch.outcome : (current.outcome ?? null);
    if (inheritedOutcome) {
      merged.outcome = inheritedOutcome;
      merged.version = 2;
    }

    const result = this.workflowValidator.validate(merged);
    if (!result.ok) {
      return {
        ok: false,
        error: 'Workflow update failed validation.',
        issues: result.errors.map(_publicIssue),
        warnings: result.warnings,
      };
    }

    const updated = this.workflowStore.update(current.id, {
      name:          merged.name,
      description:   merged.description,
      triggers:      merged.triggers,
      nodes:         merged.nodes,
      edges:         merged.edges,
      errorHandling: merged.errorHandling,
      // Retracting the outcome must also drop the spec version back to 1 —
      // otherwise the row claims version 2 with no contract in it, and the next
      // reader has to guess which of the two is lying.
      ...(patch.outcome !== undefined
        ? { outcome: patch.outcome, specVersion: patch.outcome ? 2 : 1 }
        : {}),
    }, { userId, message: patch.message ?? null });
    if (!updated) return { ok: false, error: 'Update did not persist.', code: 'UPDATE_FAILED' };

    events?.push({ type: 'workflow_updated', workflow: updated });
    return { ok: true, workflow: updated, warnings: result.warnings };
  }

  /**
   * Delete a workflow. If `idOrSlug` could match more than one workflow
   * the caller owns (rare — only via slug substring guess), the caller
   * should pre-resolve via `findCandidates`. Here we delete the single
   * exact match or 404.
   */
  async delete(idOrSlug, { userId, events = null } = {}) {
    if (!userId) return _err('Missing authenticated userId on service call.');
    const current = this.get(idOrSlug, { userId });
    if (!current) return { ok: false, error: `No workflow matches "${idOrSlug}".`, code: 'NOT_FOUND' };

    const removed = this.workflowStore.delete(current.id, { userId });
    if (!removed) return { ok: false, error: 'Delete did not persist.', code: 'DELETE_FAILED' };

    events?.push({ type: 'workflow_deleted', workflow: { id: current.id, slug: current.slug, name: current.name } });
    return { ok: true, deleted: { id: current.id, slug: current.slug, name: current.name } };
  }

  /** Pause a workflow (set status='paused'). No-op if already paused. */
  async pause(idOrSlug, { userId, events = null } = {}) {
    return this._setStatus(idOrSlug, 'paused', { userId, events });
  }

  /** Resume a workflow (set status='active'). No-op if already active. */
  async resume(idOrSlug, { userId, events = null } = {}) {
    return this._setStatus(idOrSlug, 'active', { userId, events });
  }

  async _setStatus(idOrSlug, newStatus, { userId, events }) {
    if (!userId) return _err('Missing authenticated userId on service call.');
    const current = this.get(idOrSlug, { userId });
    if (!current) return { ok: false, error: `No workflow matches "${idOrSlug}".`, code: 'NOT_FOUND' };
    if (current.status === newStatus) {
      return { ok: true, workflow: current, unchanged: true };
    }
    const previous = current.status;
    const updated  = this.workflowStore.update(current.id, { status: newStatus }, { userId });
    events?.push({
      type: 'workflow_status_changed',
      workflow: updated,
      previousStatus: previous,
      newStatus,
    });
    return { ok: true, workflow: updated, previousStatus: previous };
  }

  /**
   * Trigger a saved workflow to run immediately, bypassing schedule. Returns
   * the run record (status, output, error) once the run completes.
   *
   * iter-8: forwards `trigger` / `sessionId` to the scheduler so the unified
   * outputs log records what kicked off the run.
   *   - run_workflow_now chat tool   → trigger='chat',   sessionId = toolContext.sessionId
   *   - REST /workflows/:id/run-now  → trigger='manual', sessionId = null
   */
  async runNow(idOrSlug, { userId, trigger = 'chat', sessionId = null } = {}) {
    if (!userId) return _err('Missing authenticated userId on service call.');
    const current = this.get(idOrSlug, { userId });
    if (!current) return { ok: false, error: `No workflow matches "${idOrSlug}".`, code: 'NOT_FOUND' };
    try {
      const run = await this.workflowScheduler.runNow(current.id, { trigger, sessionId });
      return { ok: true, workflow: { id: current.id, slug: current.slug, name: current.name }, run };
    } catch (err) {
      return { ok: false, error: `Run failed: ${err.message ?? String(err)}` };
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Translate either a recipe or a definition-style input into a normalised
   * { def, status } pair ready for validation. Returns { error } on bad input.
   */
  _assembleDefinition(input) {
    const isRecipe = input.schedule !== undefined || input.steps !== undefined || input.delivery !== undefined;
    if (!isRecipe) {
      // Treat as already-built definition (converger / tool output). Pre-built
      // specs may omit required node config that has a sensible schema default
      // (e.g. summarize length/style) — fill those so the stored spec is
      // self-describing and validation passes, exactly matching what the
      // executor applies at runtime.
      return {
        def: {
          name:          String(input.name ?? '').trim(),
          description:   String(input.description ?? '').trim(),
          // The outcome contract (P12 Increment C, spec v2). It MUST reach the
          // definition the validator sees: `UNSATISFIED_ASSERTION` is what makes
          // the "Slack AND email" silent drop unpublishable, and a def that has
          // dropped its own outcome on the way in cannot be checked against it.
          // Stripping it here would leave the whole contract decorative — the
          // unit tests green, and the real publish path unguarded.
          ...(input.outcome ? { outcome: input.outcome } : {}),
          ...(input.version ? { version: input.version } : {}),
          triggers:      input.triggers ?? [],
          nodes:         this._applyConfigDefaults(input.nodes ?? []),
          edges:         input.edges ?? [],
          errorHandling: input.errorHandling ?? {},
        },
        status: input.status ?? 'draft',
      };
    }

    const { name, description = '', schedule, steps, delivery, autoStart = true } = input;
    if (!name || !String(name).trim()) return { error: 'Workflow needs a `name`.' };
    if (!Array.isArray(steps) || steps.length === 0) {
      return { error: 'Provide at least one entry in `steps` (between trigger and delivery).' };
    }
    if (!delivery || !delivery.channel) {
      return { error: 'Provide a `delivery` object with at least a `channel`.' };
    }

    const triggerResult = _buildTrigger(schedule);
    if (triggerResult.error) return { error: triggerResult.error };
    const triggerNode = triggerResult.node;

    const nodes = [triggerNode];
    const edges = [];
    let prevId = triggerNode.id;
    steps.forEach((step, i) => {
      if (!step?.type) return;
      const id = `s${i + 1}`;
      nodes.push({
        id,
        type:   step.type,
        label:  step.label ?? step.type,
        config: step.config ?? {},
      });
      edges.push({ from: prevId, to: id });
      prevId = id;
    });
    nodes.push({
      id:     'deliver',
      type:   'deliver',
      label:  'Deliver',
      config: _buildDeliveryConfig(delivery),
    });
    edges.push({ from: prevId, to: 'deliver' });

    const isManualOnly = schedule?.kind === 'manual';
    const status = (autoStart && !isManualOnly) ? 'active' : 'paused';
    const triggers = isManualOnly
      ? []
      : [{ type: 'schedule', config: triggerNode.config }];

    return {
      def: {
        name: String(name).trim(),
        description: String(description).trim(),
        triggers,
        nodes,
        edges,
        errorHandling: {},
      },
      status,
    };
  }

  /**
   * Fill missing required node config from each node-type's schema `default`.
   * Pre-built specs (converger output, the frozen canonical spec, tool calls)
   * may omit fields like summarize's length/style. Those have explicit defaults
   * the executor already applies at runtime, so persisting them keeps the spec
   * self-describing and lets validation pass. Returns new node objects — the
   * caller's input is not mutated.
   */
  _applyConfigDefaults(nodes) {
    return (Array.isArray(nodes) ? nodes : []).map((node) => {
      const schema = this.nodeTypeRegistry?.get?.(node?.type)?.configSchema;
      if (!Array.isArray(schema) || !node) return node;
      const cfg = { ...(node.config ?? {}) };
      let changed = false;
      for (const field of schema) {
        if (field.optional || field.default === undefined) continue;
        const v = cfg[field.key];
        if (v == null || (typeof v === 'string' && !v.trim())) {
          cfg[field.key] = field.default;
          changed = true;
        }
      }
      return changed ? { ...node, config: cfg } : node;
    });
  }

  /**
   * Pick an unused slug for a given user. Starts from the suggested base
   * (or derives from name); appends -2, -3, … on conflict.
   */
  async _uniqueSlug(name, userId, suggested = null) {
    const base = (suggested ?? WorkflowStore.slugify(name || 'workflow')) || 'workflow';
    let candidate = base;
    let n = 2;
    while (this.workflowStore.getBySlug(candidate, { userId })) {
      candidate = `${base}-${n++}`;
      if (n > 999) break;
    }
    return candidate;
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────

function _err(message) { return { ok: false, error: message }; }

function _publicIssue(e) {
  return { code: e.code, message: e.message, nodeId: e.nodeId, field: e.field, hint: e.hint };
}

function _buildTrigger(schedule) {
  if (!schedule || typeof schedule !== 'object') {
    return { error: 'Provide a `schedule` object with at least a `kind`.' };
  }
  const node = { id: 'trigger', type: 'trigger', label: 'Trigger', config: {} };
  const kind = schedule.kind;

  if (kind === 'daily') {
    if (!_isHHMM(schedule.time)) return { error: 'For schedule.kind="daily", provide `time` as "HH:MM" (24-hour).' };
    node.config.time = schedule.time;
    return { node };
  }
  if (kind === 'weekly') {
    if (!_isHHMM(schedule.time)) return { error: 'For schedule.kind="weekly", provide `time` as "HH:MM" (24-hour).' };
    if (!Array.isArray(schedule.daysOfWeek) || schedule.daysOfWeek.length === 0) {
      return { error: 'For schedule.kind="weekly", provide `daysOfWeek` (e.g. ["MON","WED"]).' };
    }
    const dows = [];
    for (const d of schedule.daysOfWeek) {
      const n = DOW_MAP[String(d).toUpperCase()];
      if (n === undefined) return { error: `Unknown day "${d}" in daysOfWeek. Use MON, TUE, WED, THU, FRI, SAT, SUN.` };
      dows.push(n);
    }
    const [h, m] = schedule.time.split(':').map(n => parseInt(n, 10));
    node.config.cron = `${m} ${h} * * ${dows.sort((a, b) => a - b).join(',')}`;
    return { node };
  }
  if (kind === 'cron') {
    if (!schedule.cron || typeof schedule.cron !== 'string') {
      return { error: 'For schedule.kind="cron", provide a 5-field `cron` string (M H DOM MO DOW).' };
    }
    const parts = schedule.cron.trim().split(/\s+/);
    if (parts.length !== 5) return { error: 'Cron must have exactly 5 fields. Got: ' + schedule.cron };
    if (parts[2] !== '*' || parts[3] !== '*') {
      return { error: 'Scheduler only honors daily / weekly cron — DOM and MO must both be "*". Got: ' + schedule.cron };
    }
    node.config.cron = schedule.cron;
    return { node };
  }
  if (kind === 'manual') return { node };
  return { error: `Unsupported schedule.kind "${kind}". Use one of: daily, weekly, cron, manual.` };
}

function _buildDeliveryConfig(delivery) {
  const cfg = { channel: delivery.channel };
  if (delivery.title)   cfg.title   = delivery.title;
  if (delivery.body)    cfg.body    = delivery.body;
  if (delivery.url)     cfg.url     = delivery.url;
  if (delivery.headers) cfg.headers = delivery.headers;
  return cfg;
}

function _isHHMM(v) {
  if (typeof v !== 'string' || !/^\d{1,2}:\d{2}$/.test(v)) return false;
  const [h, m] = v.split(':').map(n => parseInt(n, 10));
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/**
 * Best-effort: pull the current workflow's schedule back into recipe shape,
 * so an update that only changes `schedule` can pass the rest through
 * unchanged.
 */
function _deriveScheduleFromCurrent(current) {
  const t = current.triggers?.[0];
  if (!t || t.type !== 'schedule') return { kind: 'manual' };
  const cfg = t.config ?? {};
  if (cfg.time) return { kind: 'daily', time: cfg.time };
  if (cfg.cron) {
    const parts = cfg.cron.trim().split(/\s+/);
    if (parts.length === 5 && parts[2] === '*' && parts[3] === '*') {
      const h = parseInt(parts[1], 10), m = parseInt(parts[0], 10);
      const time = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      if (parts[4] === '*') return { kind: 'daily', time };
      const dowsCodes = Object.entries(DOW_MAP);
      const nums = new Set();
      for (const piece of parts[4].split(',')) {
        const mm = piece.match(/^(\d+)(?:-(\d+))?$/);
        if (!mm) return { kind: 'cron', cron: cfg.cron };
        const a = parseInt(mm[1], 10), b = mm[2] ? parseInt(mm[2], 10) : a;
        for (let i = a; i <= b; i++) nums.add(i === 7 ? 0 : i);
      }
      const daysOfWeek = dowsCodes.filter(([_, n]) => nums.has(n)).map(([code]) => code);
      return { kind: 'weekly', time, daysOfWeek };
    }
    return { kind: 'cron', cron: cfg.cron };
  }
  return { kind: 'manual' };
}

/**
 * Best-effort: pull the current workflow's non-trigger, non-deliver nodes
 * back into the recipe `steps` shape.
 */
function _deriveStepsFromCurrent(current) {
  const nodes = current.nodes ?? [];
  return nodes
    .filter(n => n.type !== 'trigger' && n.type !== 'deliver')
    .map(n => ({ type: n.type, config: n.config ?? {}, label: n.label }));
}

function _deriveDeliveryFromCurrent(current) {
  const deliver = (current.nodes ?? []).find(n => n.type === 'deliver');
  if (!deliver) return { channel: 'in_app' };
  return { ...deliver.config };
}

/**
 * Tiny event-bus for the chat/stream handler. Tools push events here during
 * an agent turn; the handler drains them and emits typed SSE at end of turn.
 */
export class WorkflowEventBus {
  constructor() { this._events = []; }
  push(evt) { this._events.push(evt); }
  drain()   { const out = this._events; this._events = []; return out; }
  get size() { return this._events.length; }
}

export default WorkflowService;
