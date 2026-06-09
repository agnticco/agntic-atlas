/**
 * Workflows module — re-exports all public classes.
 * @module src/workflows/index.js
 */

export { SourceRegistry }      from './source-registry.js';
export { WorkflowStore }       from './workflow-store.js';
export { WorkflowScheduler }   from './workflow-scheduler.js';
export { detectRecurringIntent, parseSchedule, buildProposal } from './workflow-compiler.js';
export { FlowTester }          from './flow-tester.js';
export { ChannelRegistry } from './channel-registry.js';
export { registerBuiltInChannels, registerInAppChannel, registerWebhookChannel, registerMcpChannel } from './channel-handlers.js';
export { WorkflowValidator } from './workflow-validator.js';
export { NodeTypeRegistry } from './node-type-registry.js';
export { registerBuiltInNodeTypes } from './node-types/index.js';
export { translateError } from './error-translator.js';
export { validateRunOutput } from './output-validator.js';
export { FeedbackStore, FEEDBACK_TAGS } from './feedback-store.js';
export { enrichRun } from './run-enricher.js';
export { WorkflowService, WorkflowEventBus } from './workflow-service.js';
