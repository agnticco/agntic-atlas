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
    triggers:     [...(draft.triggers ?? [])],
    nodes:        [...(draft.nodes ?? [])],
    edges:        [...(draft.edges ?? [])],
    errorHandling: draft.errorHandling ?? {},
  };

  const spec = confirmation.type === 'modify' && confirmation.mergedSpec
    ? confirmation.mergedSpec
    : proposal.spec;

  switch (proposal.component) {
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
    default:
      break;
  }

  return d;
}

/**
 * Emit the final canonical spec JSON from a completed draft.
 *
 * @param {{ name, description, triggers, nodes, edges, errorHandling }} draft
 * @returns {object} spec ready for the execution engine
 */
export function assembleSpec(draft) {
  return {
    name:         draft.name ?? 'Untitled workflow',
    description:  draft.description ?? '',
    kind:         'flow',
    triggers:     draft.triggers ?? [],
    nodes:        draft.nodes ?? [],
    edges:        draft.edges ?? [],
    errorHandling: draft.errorHandling ?? {},
  };
}
