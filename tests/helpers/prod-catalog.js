/**
 * The catalog PRODUCTION builds — all of it.
 *
 * `tests/helpers/catalog.js` says of itself: *"`buildEngine()` in `src/api/server.js`
 * instantiates a CapabilityRegistry, registers the connectors into it, and wraps it in
 * a ChannelRegistry. This does the same, so a test's validator sees the same catalog
 * publish sees."*
 *
 * It does not. `buildEngine()` registers SIX things (src/api/server.js:590-597 and
 * :1050-1054):
 *
 *     registerBuiltInChannels   ← in_app, webhook          ✗ missing from realCatalog()
 *     registerSlackChannel                                 ✓
 *     registerSlackTriggers                                ✗ (deliberate here too — see below)
 *     registerGoogleChannels                               ✓
 *     registerAirtableChannels                             ✓
 *     registerFilesystemCapabilities ← filesystem_read/_list ✗ missing
 *     registerWebCapabilities        ← web_search/web_fetch  ✗ missing
 *
 * That omission is architectural flaw #2 (CLAUDE.md) inside the very helper written to
 * fix it: `in_app` is the DEFAULT delivery channel (`deliver.js` — `cfg.channel ?? 'in_app'`),
 * and under `realCatalog()` it resolves to nothing, so every suite built on that helper is
 * blind to the most common delivery in the product. Same for a `connector-action` on
 * `web_search` or `filesystem_read`: unknown to the test catalog, ordinary in production.
 *
 * P12 Increment F made that gap load-bearing: `UNKNOWN_CONNECTOR_ACTION` and
 * `UNKNOWN_CONFIG_KEY` now both key off "can the registry resolve this capability?", so a
 * catalog that is missing capabilities is a validator that answers a different question
 * than publish answers.
 *
 * This builds the catalog in `buildEngine()`'s order, with every capability it registers.
 */

import { CapabilityRegistry }        from '../../src/connectors/capability-registry.js';
import { ChannelRegistry }           from '../../src/workflows/channel-registry.js';
import { registerBuiltInChannels }   from '../../src/workflows/channel-handlers.js';
import { registerSlackChannel }      from '../../src/connectors/slack/index.js';
import { registerGoogleChannels }    from '../../src/connectors/google/index.js';
import { registerAirtableChannels }  from '../../src/connectors/airtable/index.js';
import { registerFilesystemCapabilities } from '../../src/connectors/filesystem.js';
import { registerWebCapabilities }   from '../../src/connectors/web/index.js';

/**
 * @returns {ChannelRegistry} every capability `buildEngine()` registers, forced
 *          `available` — availability is a deployment fact (is there a live token on
 *          this machine?); these suites assert SHAPE.
 */
export function productionCatalog() {
  const caps     = new CapabilityRegistry();
  const channels = new ChannelRegistry(caps);

  registerBuiltInChannels(channels, {});                    // server.js:593
  registerSlackChannel(channels);                           // server.js:594
  registerGoogleChannels(caps);                             // server.js:596
  registerAirtableChannels(caps);                           // server.js:597
  registerFilesystemCapabilities(caps, { listFolders: () => [] });   // server.js:1050
  registerWebCapabilities(caps, { llm: null });                      // server.js:1054

  const get = channels.get.bind(channels);
  channels.get = (id) => {
    const ch = get(id);
    return ch ? { ...ch, available: true } : null;
  };
  return channels;
}

/** The converger's view of it — `capabilities.channels`, exactly as builder.js:1081 builds it. */
export function productionCapabilities(channels = productionCatalog()) {
  return { channels: channels.getAll().map(c => ({ ...c, available: true })) };
}
