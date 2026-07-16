/**
 * stop primitive — a terminal that ENDS a path with NO side effect.
 *
 * WHY IT EXISTS (architectural, not a workflow-specific fix). A `branch` must
 * route every case to a node, and every other node DOES something — so a case
 * that means "do nothing / silently ignore this input" had nowhere to go. Absent
 * a true no-op, the converger would invent a delivery for the ignore case (e.g.
 * post to the inbox), which SILENTLY did the OPPOSITE of what a user asked for
 * when they said "ignore" / "no noise": every ignored input produced a
 * notification. Nothing in the system caught it, because the outcome contract
 * only asserts what the ACTIVE lanes must do, never that the ignore lane stays
 * quiet.
 *
 * `stop` is the generic answer for ANY workflow: a branch case that means
 * "nothing happens here" routes to a `stop`, and the run simply ends on that
 * path. It is not tied to any connector, trigger, or intent.
 *
 * It is a CONTROL / TERMINAL node: it runs no compute, produces no content,
 * delivers nothing, and its (nil) output never becomes `lastOutput`. It takes no
 * config and needs no outgoing edge — it is, by definition, the end of a path.
 */

export const stopNodeType = {
  type: 'stop',
  label: 'Stop',
  description: 'Ends this path with no action — nothing is sent, written, or delivered.',
  icon: 'stop',
  family: 'control',
  configPolicy: 'closed',
  configSchema: [],
  previewTemplate: 'Ends here — nothing happens on this path.',
  // A no-op. No output, no side effect. Being in CONTROL_TYPES (flow-tester) and
  // NON_CONTENT_TYPES (_node-input) guarantees this nil never becomes lastOutput
  // nor an llm input — though nothing runs downstream of a terminal anyway.
  run: async () => null,
};
