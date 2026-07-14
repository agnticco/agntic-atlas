/**
 * The REAL capability catalog, built the way production builds it.
 *
 * WHY THIS EXISTS. Several suites constructed `new WorkflowValidator({ nodeTypes })`
 * with **no channel registry** — and then asserted things about config keys. That
 * is architectural flaw #2 (CLAUDE.md): *a check that exercises a configuration
 * production never uses cannot see the bug production has*, and it cuts both ways.
 *
 * With no registry, a capability's params are UNKNOWABLE, so the validator does not
 * judge them (an unknowable key set is not a wrong one). Which meant:
 *
 *   · `deliver.message` — the pin for defect #3, where a delivery's content is
 *     silently dropped — passed only because the catalog was absent. Wire the
 *     catalog and it still fails, for the RIGHT reason: `message` is not one of
 *     Slack's declared params. Without the catalog it was passing on an accident.
 *   · a `connector-action` carrying `baseId`/`tableId` was "fine" because nobody
 *     could check it — the very hole Increment F closes.
 *
 * `buildEngine()` in `src/api/server.js` instantiates a CapabilityRegistry, registers
 * the connectors into it, and wraps it in a ChannelRegistry. This does the same, so a
 * test's validator sees the same catalog publish sees.
 */

import { CapabilityRegistry }      from '../../src/connectors/capability-registry.js';
import { ChannelRegistry }         from '../../src/workflows/channel-registry.js';
import { registerSlackChannel }    from '../../src/connectors/slack/index.js';
import { registerGoogleChannels }  from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';

/**
 * @returns {ChannelRegistry} the real catalog, with every capability forced
 *          `available` — a test is asserting SHAPE, not whether this machine
 *          happens to hold a live OAuth token.
 */
export function realCatalog() {
  // The EXACT wiring order of buildEngine() (server.js): the CapabilityRegistry is
  // the catalog, ChannelRegistry is the adapter over it — and Slack registers
  // through the ADAPTER (registerSlackChannel takes the ChannelRegistry) while
  // Google and Airtable register straight into the capability registry. Getting
  // that backwards throws "positions[] is required", which is the registry telling
  // you that you are not building it the way production does.
  const caps     = new CapabilityRegistry();
  const channels = new ChannelRegistry(caps);

  registerSlackChannel(channels);
  registerGoogleChannels(caps);
  registerAirtableChannels(caps);
  const get = channels.get.bind(channels);
  // isReady() is false without live tokens, which would make every spec fail on
  // CHANNEL_UNAVAILABLE and tell us nothing about the keys. Availability is a
  // deployment fact; the key set is a schema fact, and these suites test the latter.
  channels.get = (id) => {
    const ch = get(id);
    return ch ? { ...ch, available: true } : null;
  };
  return channels;
}
