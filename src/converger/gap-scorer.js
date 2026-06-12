/**
 * gap-scorer — measures how far a draft spec is from complete.
 *
 * A spec is complete when it has:
 *   1. A trigger  (what starts the workflow)
 *   2. At least one processing node  (what to do with the data)
 *   3. At least one delivery node  (where to send the result)
 *   4. Edges connecting all nodes in sequence
 *   5. A name
 */

const PROCESSING_TYPES = new Set(['summarize', 'llm', 'extract', 'rewrite', 'daily-digest', 'fetch']);
// tool/mcp-tool nodes can be either processing OR delivery depending on their action.
// We treat them as delivery if they are the last node (no outgoing edges to another node).
// For gap-scoring purposes, any tool/mcp-tool node counts as delivery since we can't
// inspect the action at this layer.
const DELIVERY_TYPES   = new Set(['deliver', 'tool', 'mcp-tool']);

/**
 * @param {{ name, triggers, nodes, edges }} draft
 * @returns {{ needsTrigger, needsProcessing, needsDelivery, needsEdges, needsName, complete }}
 */
export function scoreGap(draft = {}) {
  const hasTrigger    = (draft.triggers ?? []).length > 0;
  const hasProcessing = (draft.nodes ?? []).some(n => PROCESSING_TYPES.has(n.type));
  const hasDelivery   = (draft.nodes ?? []).some(n => DELIVERY_TYPES.has(n.type));
  // Edges: a linear chain of N nodes needs N-1 edges minimum
  const nodeIds       = new Set((draft.nodes ?? []).map(n => n.id).filter(Boolean));
  const nodeCount     = nodeIds.size;
  const validEdges    = (draft.edges ?? []).filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));
  const hasEdges      = nodeCount < 2 || validEdges.length >= nodeCount - 1;
  const hasName       = Boolean(draft.name?.trim());

  const needsTrigger    = !hasTrigger;
  const needsProcessing = hasTrigger && !hasProcessing;
  const needsDelivery   = hasTrigger && hasProcessing && !hasDelivery;
  const needsEdges      = hasTrigger && hasProcessing && hasDelivery && !hasEdges;
  const needsName       = hasTrigger && hasProcessing && hasDelivery && hasEdges && !hasName;
  const complete        = !needsTrigger && !needsProcessing && !needsDelivery && !needsEdges && !needsName;

  return { needsTrigger, needsProcessing, needsDelivery, needsEdges, needsName, complete };
}

/** Human-readable label for the current gap — used in prompts. */
export function gapLabel(gap) {
  if (gap.needsTrigger)    return 'a trigger (what event starts this workflow)';
  if (gap.needsProcessing) return 'a processing step (what to do with the incoming data)';
  if (gap.needsDelivery)   return 'a delivery step (where to send the result)';
  if (gap.needsEdges)      return 'edges connecting the steps in order';
  if (gap.needsName)       return 'a name for the workflow';
  return 'nothing — spec is complete';
}
