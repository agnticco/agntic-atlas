/**
 * human node — a durable pause for a person's decision. (P12 Increment B.)
 *
 * BPMN's User Task. The run stops, persists, and holds **no compute** while it
 * waits — a pending approval is free. When the decision arrives, the run is
 * rehydrated from the run's CHECKPOINT (not the persisted steps — those are
 * display-shrunk) and continues from the next node.
 *
 * SCOPE — Increment B builds the ENGINE MECHANIC only (converger-v2 §7.4):
 * pause, persist, resume. It does NOT build the ask-delivery or the
 * authentication of the answer — the Slack Block Kit buttons, the signed
 * single-use magic links, the ApprovalStore and the Approvals inbox are
 * **Increment D** (§7.2, §7.3, §7.5). Until D lands, a decision can only be
 * injected by a trusted caller (the resume API), which is exactly what the
 * engine test does.
 *
 * That split is deliberate, and the order matters: an approval anyone can forge
 * is not an approval, so the authentication is its own increment with its own
 * adversarial check — it is not a detail to bolt onto this one.
 *
 * **Never authenticate an approval by parsing an email reply body** (§11.8).
 * `From:` is trivially spoofable, SPF/DKIM authenticate a sending *domain* and
 * not a human *intent*, and a forwarded thread is full of the word "yes".
 *
 * config (§7.1):
 *   prompt:    what the person is being asked
 *   preview:   what they actually see (usually "{{draft.output}}")
 *   decisions: ["approve", "reject"] — the closed set of answers
 *   channels:  where to ask (Increment D)
 *   timeout:   { after: "48h", then: "escalate" | "<decision>" } (Increment D sweeper)
 *
 * Output: { decision, by, at, channel } — so a downstream `branch` can route on
 * `{{approve_send.decision}}` and the run log carries who approved what, when,
 * over which channel. That is the audit trail.
 */

export const DEFAULT_DECISIONS = ['approve', 'reject'];

export const humanNodeType = {
  type: 'human',
  label: 'Ask a person',
  description: 'Pauses the workflow until a person approves, rejects, or answers. The run costs nothing while it waits.',
  icon: 'how_to_reg',
  family: 'control',
  configPolicy: 'closed',
  configSchema: [
    { key: 'prompt', label: 'What to ask', type: 'textarea', rows: 3,
      placeholder: 'e.g. Send this reply to the customer?',
      hint: 'The question the person is asked.' },
    { key: 'preview', label: 'What they see', type: 'textarea', optional: true, rows: 4,
      placeholder: 'e.g. {{draft_reply.output}}',
      hint: 'The content being approved. Reference an earlier step with {{stepId.output}}.' },
    { key: 'decisions', label: 'Possible answers', type: 'object', optional: true, default: DEFAULT_DECISIONS,
      hint: 'The closed set of answers, e.g. ["approve","reject"]. A downstream branch routes on the answer.' },
    { key: 'channels', label: 'Where to ask', type: 'object', optional: true,
      hint: 'Slack, the in-app inbox, or a signed email link. Asked over all of them; the first valid answer wins.' },
    { key: 'assignee', label: 'Who to ask', type: 'text', optional: true,
      hint: 'A user, or "inbox" for whoever owns the workflow.' },
    { key: 'timeout', label: 'Timeout', type: 'object', optional: true,
      hint: 'e.g. { "after": "48h", "then": "escalate" }. What happens if nobody answers.' },
  ],
  previewTemplate: 'Pauses and asks a person: "{prompt}".',

  validate: (node) => {
    const issues = [];
    const decisions = normalizeDecisions(node?.config?.decisions);
    if (decisions.length < 2) {
      issues.push({
        severity: 'error', code: 'MISSING_CONFIG',
        message: `"${node.label || node.id}" asks a person to decide but offers fewer than two answers.`,
        nodeId: node.id, field: 'config.decisions',
        hint: 'Give at least two, e.g. ["approve","reject"]. A single-answer question is not a decision.',
      });
    }
    return issues;
  },

  /**
   * By the time run() is called, FlowTester has ALREADY established that a
   * decision exists for this node — a node with no decision pauses the run and
   * never reaches here (see flow-tester.js, _pendingHuman). So this only shapes
   * the decision into the node's output.
   *
   * The guard below is not dead code: it is what stops a `human` node from
   * silently evaluating to "approved" if a future caller ever runs the registry
   * dispatch directly, without the pause. An approval must never be the default.
   */
  run: async (cfg, ctx, _services) => {
    const provided = ctx?.humanDecision;
    if (!provided || !provided.decision) {
      throw new Error(
        'human step reached the executor with no decision. A pause must be resolved by a real answer — ' +
        'it can never default to approved.',
      );
    }
    const allowed = normalizeDecisions(cfg.decisions);
    if (allowed.length && !allowed.includes(String(provided.decision))) {
      throw new Error(
        `human step got the answer "${provided.decision}", which is not one of ${allowed.join(', ')}.`,
      );
    }
    return {
      decision: String(provided.decision),
      by:       provided.by ?? null,
      at:       provided.at ?? new Date().toISOString(),
      channel:  provided.channel ?? null,
    };
  },
};

/** The ask payload handed to whatever is going to deliver it (Increment D). */
export function buildAsk(node, cfg) {
  return {
    nodeId:    node.id,
    prompt:    cfg.prompt ?? 'Approve this step?',
    preview:   cfg.preview ?? null,
    decisions: normalizeDecisions(cfg.decisions),
    channels:  normalizeChannels(cfg.channels),
    assignee:  cfg.assignee ?? 'inbox',
    timeout:   cfg.timeout ?? null,
  };
}

export function normalizeDecisions(raw) {
  let d = raw;
  if (d == null) return [...DEFAULT_DECISIONS];
  if (typeof d === 'string') {
    try { d = JSON.parse(d); }
    catch { d = String(raw).split(/[\n,]/); }
  }
  if (!Array.isArray(d)) return [...DEFAULT_DECISIONS];
  const out = d.map(x => String(x).trim()).filter(Boolean);
  return out.length ? out : [...DEFAULT_DECISIONS];
}

export function normalizeChannels(raw) {
  let c = raw;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch { return []; }
  }
  return Array.isArray(c) ? c.filter(x => x && typeof x === 'object') : [];
}
