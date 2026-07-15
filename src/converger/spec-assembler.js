/**
 * spec-assembler — builds and mutates the draft spec from confirmed proposals.
 */

/**
 * Apply a confirmed proposal to the draft, returning a new draft.
 * Handles accept (as-is) and modify (with user override merged in).
 *
 * @param {{ name, triggers, nodes, edges, errorHandling }} draft
 * @param {{ component: string, spec: any }}               proposal
 * @param {{ type: string, modification?: string }}        confirmation
 * @returns {object} new draft
 */
export function applyProposal(draft, proposal, confirmation = { type: 'accept' }) {
  const d = {
    name:         draft.name,
    description:  draft.description ?? null,
    outcome:      draft.outcome ? { ...draft.outcome } : null,
    triggers:     [...(draft.triggers ?? [])],
    nodes:        [...(draft.nodes ?? [])],
    edges:        [...(draft.edges ?? [])],
    errorHandling: draft.errorHandling ?? {},
  };

  const spec = confirmation.type === 'modify' && confirmation.mergedSpec
    ? confirmation.mergedSpec
    : proposal.spec;

  switch (proposal.component) {
    // ── The outcome contract (P12 Increment C) ────────────────────────────
    // The anchor. Everything else in the draft is measured against it, and a
    // spec that does not deliver on it does not publish.
    case 'outcome':
      d.outcome = {
        statement:  spec?.statement ?? '',
        assertions: Array.isArray(spec?.assertions) ? spec.assertions : [],
        examples:   Array.isArray(spec?.examples) ? spec.examples : (draft.outcome?.examples ?? []),
      };
      break;

    case 'assertion': {
      const cur = d.outcome ?? { statement: '', assertions: [], examples: [] };
      const list = [...(cur.assertions ?? [])];
      const idx  = list.findIndex(a => a.id === spec?.id);
      if (idx >= 0) list[idx] = spec; else list.push(spec);
      d.outcome = { ...cur, assertions: list };
      break;
    }

    case 'example': {
      const cur = d.outcome ?? { statement: '', assertions: [], examples: [] };
      const list = [...(cur.examples ?? [])];
      const incoming = Array.isArray(spec) ? spec : [spec];
      for (const ex of incoming) {
        if (!ex) continue;
        const idx = list.findIndex(e => e.id === ex.id);
        if (idx >= 0) list[idx] = ex; else list.push(ex);
      }
      d.outcome = { ...cur, examples: list };
      break;
    }

    // Node-level attributes (P12 Increment B built the engine for these).
    case 'on_error': {
      const nid = spec?.nodeId ?? spec?.id;
      d.nodes = d.nodes.map(n => (n.id === nid ? { ...n, on_error: spec.on_error ?? spec.spec } : n));
      break;
    }
    case 'idempotency': {
      const nid = spec?.nodeId ?? spec?.id;
      d.nodes = d.nodes.map(n => (n.id === nid ? { ...n, idempotency: spec.idempotency ?? spec.spec } : n));
      break;
    }

    case 'trigger':
      d.triggers.push(spec);
      break;
    case 'node': {
      // Replace if same ID already exists (handles LLM re-proposing same node)
      const idx = d.nodes.findIndex(n => n.id === spec.id);
      if (idx >= 0) d.nodes[idx] = spec;
      else d.nodes.push(spec);
      break;
    }
    case 'edge': {
      const dup = d.edges.some(e => e.from === spec.from && e.to === spec.to);
      if (!dup) d.edges.push(spec);
      break;
    }
    case 'name':
      d.name = typeof spec === 'string' ? spec : spec.name;
      break;
    case 'description':
      d.description = typeof spec === 'string' ? spec : spec.description;
      break;
    case 'remove_node': {
      // S7-10: actually excise a node when the user asks to remove/replace a step.
      // Rewire around it so the chain isn't severed:
      //   search → [fetch] → summarize   becomes   search → summarize.
      const rid = (spec && spec.id) || spec;
      const ups   = d.edges.filter(e => e.to === rid).map(e => e.from);
      const downs = d.edges.filter(e => e.from === rid).map(e => e.to);
      d.nodes = d.nodes.filter(n => n.id !== rid);
      d.edges = d.edges.filter(e => e.from !== rid && e.to !== rid);
      for (const u of ups) for (const dn of downs) {
        if (u !== dn && !d.edges.some(e => e.from === u && e.to === dn)) d.edges.push({ from: u, to: dn });
      }
      break;
    }
    case 'remove_edge': {
      const from = spec && spec.from, to = spec && spec.to;
      d.edges = d.edges.filter(e => !(e.from === from && e.to === to));
      break;
    }
    default:
      break;
  }

  return d;
}

/**
 * Extract a node id from a reference: "id.output", "id.decision", "{{id.field}}", "id".
 * A branch's `on` and a decision's input `from` are REFERENCES to the node whose
 * output they read — the base id is everything before the first dot, minus any
 * `{{ }}` wrapper.
 */
export function refNodeId(ref) {
  if (typeof ref !== 'string') return null;
  const s = ref.trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').split('.')[0].trim();
  return s || null;
}

/**
 * Deterministically wire the structural edges a correct graph MUST have, derived
 * from each node's own config — so the model no longer has to remember to emit
 * every connecting edge one at a time (the root cause of orphaned classifiers and
 * branches with no feed; see docs/handoff/converger-rearchitecture.md).
 *
 * ADDITIVE: keeps the model's edges, adds only the missing structural ones.
 *   - a `branch` gets an INPUT edge from the node its `config.on` routes on, and an
 *     OUTPUT edge to each `config.cases[].to` (so it actually forks).
 *   - a `decision` gets an INPUT edge from each `config.inputs[].from` node.
 * The base of "make a branch actually branch": with this, classify→branch and
 * branch→{lead,other} are guaranteed even if the model dropped them.
 *
 * @param {{nodes, edges, triggers}} draft
 * @returns {object} draft with a complete structural edge set
 */
export function wireEdges(draft) {
  const nodes   = [...(draft.nodes ?? [])];
  const nodeIds = new Set(nodes.map(n => n && n.id).filter(Boolean));
  const edges   = [...(draft.edges ?? [])];
  const hasEdge = (from, to) => edges.some(e => e.from === from && e.to === to);
  const addEdge = (from, to) => {
    if (from && to && from !== to && nodeIds.has(from) && nodeIds.has(to) && !hasEdge(from, to)) {
      edges.push({ from, to });
    }
  };

  for (const n of nodes) {
    if (!n) continue;
    if (n.type === 'branch') {
      addEdge(refNodeId(n.config?.on), n.id);                       // input: routed-on node → branch
      for (const c of (n.config?.cases ?? [])) addEdge(n.id, c?.to); // outputs: branch → each case target
    } else if (n.type === 'decision') {
      for (const inp of (n.config?.inputs ?? [])) addEdge(refNodeId(inp?.from), n.id);
    }
  }

  return { ...draft, edges };
}

/**
 * Emit the final spec from a completed draft.
 *
 * Spec v2 (P12 Increment C) adds `outcome` — the contract the workflow is held
 * to. `version: 2` is emitted ONLY when there is an outcome to hold it to:
 * the executor branches on `spec.version` and an absent version means 1 (§8),
 * so a draft with no outcome must not claim to be v2 — `MISSING_OUTCOME` would
 * reject a spec that is otherwise perfectly runnable, purely for wearing the
 * wrong label. The headless P3 path is exactly that case.
 *
 * @returns {object} spec ready for the execution engine
 */
export function assembleSpec(draft) {
  const outcome = draft.outcome?.assertions?.length ? draft.outcome : null;

  return {
    ...(outcome ? { version: 2, outcome } : {}),
    name:         draft.name ?? 'Untitled workflow',
    description:  draft.description ?? '',
    kind:         'flow',
    triggers:     draft.triggers ?? [],
    nodes:        draft.nodes ?? [],
    edges:        draft.edges ?? [],
    errorHandling: draft.errorHandling ?? {},
  };
}
