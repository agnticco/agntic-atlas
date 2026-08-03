/**
 * EVERY CONNECTOR CLEARS THE SAME BAR — THE CHECK THAT MAKES P13 SAFE.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * On 2026-08-03 Slack went from "has never delivered a single event in the
 * product's history" to working. It took SIX defects, and not one was findable by
 * reading code or running the suite — every one needed a real message through a
 * real workspace, with the suite green throughout.
 *
 * P13's premise is connecting to services NOBODY hand-built, one button each. If
 * a connector is only known to work after someone drives it for four hours, that
 * premise fails: ten connectors means ten Slacks, each looking correct, each
 * silently broken in its own way, each found by a customer.
 *
 * So this asks of EVERY trigger the product has, from the LIVE registry, the
 * questions that were silently untrue for Slack. A connector added tomorrow is
 * asked them tomorrow, without anyone remembering to.
 *
 * ── What it proves, and what it CANNOT ──────────────────────────────────────
 *
 * PROVES (statically, no credentials, no network):
 *   · the shape the converger emits is the shape the dispatcher matches on
 *   · a test sample exists that looks like the real event
 *   · every dispatcher applies the same liveness rule
 *   · the trigger reads as English, with its own icon
 *
 * CANNOT PROVE, and nothing here should be read as proving it:
 *   · that the service is configured to send us anything (two mismatched Slack
 *     apps and a wrong signing secret — all config, all invisible from here)
 *   · that an event, once sent, arrives
 * Those need one real event per connector, per deployment. This check is the half
 * that can be automated; the other half is a human, once, and should stay on the
 * P13 checklist.
 *
 * ── MUTATION RESULTS, run by hand (2026-08-03) — READ THE FOURTH ────────────
 *
 *   the Airtable cascade comes back              → 1 red
 *   the Slack cascade comes back                 → 1 red
 *   a trigger loses its realistic sample         → 2 red
 *   the converger emits an unmatchable event id  → 0 red   ** NOT KILLED **
 *
 * THE FOURTH IS NOT PROVEN AND MUST NOT BE ASSUMED. Deleting the line that maps
 * the capability id `slack_message` to Slack's raw `message` — the exact defect
 * that made a live workflow never fire — left this file green. The first version
 * of that assertion GREPPED the dispatch layer for the id and passed for the
 * wrong reason; it was rewritten to EXECUTE each connector's real matcher
 * (`selectSlackFlows`, `isAirtableRecordChangedTrigger`), which is the right
 * shape — and the mutation still survives, so something in that path is not
 * reaching the matcher as intended and I could not finish diagnosing it.
 *
 * So: the round-trip assertion is UNPROVEN. Treat the three above as the coverage
 * this file actually has, fix the fourth before relying on it, and do not let its
 * presence here suggest the round trip is guarded. A check believed to work and
 * not working is worse than one known to be missing — which is the lesson the
 * whole of 2026-08-03 taught, repeatedly.
 *
 * FOUND ON ITS FIRST RUN: the Airtable dispatcher still filtered `status:'active'`
 * only — the cascade fixed for Slack hours earlier, where one failed run silently
 * disables a live workflow for ever. Nothing had failed; it was found by asking
 * both connectors the same question.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerSlackTriggers } from '../../src/connectors/slack/index.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { isRunnableTrigger } from '../../src/workflows/trigger-runnable.js';
import { normalizeConnectorTrigger } from '../../src/converger/elicitation-graph.js';
import { slackEventKind, selectSlackFlows } from '../../src/api/server.js';
import { isAirtableRecordChangedTrigger } from '../../src/connectors/airtable/webhook-sync.js';

/**
 * EACH CONNECTOR'S REAL MATCHER, EXECUTED — never grepped for.
 *
 * The first version searched the dispatch layer for the event id as a STRING. It
 * passed while the converger emitted an id nothing matched, because the id appears
 * in that file for other reasons. A grep proves a symbol exists, never that
 * anything enforces it — the trap this whole check exists to prevent, made inside
 * it. Now each connector's own matcher decides, by running.
 */
const MATCHES = {
  slack: async (t) => {
    const hits = [];
    for (const raw of ['message', 'app_mention']) {
      const flows = await selectSlackFlows({
        flows: [{ slug: 'probe', triggers: [t] }],
        ev: { type: raw, channel: 'C1', user: 'U1', text: 'hi' },
        wantEvent: slackEventKind({ type: raw }),
        resolveChannelId: async () => 'C1',
        onUnresolved: () => {},
      });
      if (flows.length) hits.push(raw);
    }
    return hits.length > 0;
  },
  airtable: async (t) => isAirtableRecordChangedTrigger(t),
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SERVER = readFileSync(path.join(ROOT, 'src/api/server.js'), 'utf8');

/**
 * THE WHOLE DISPATCH LAYER, not just server.js. Airtable's matcher is factored
 * into `webhook-sync.js`, so a search of server.js alone reported a disagreement
 * that does not exist — the check's own first false positive, fixed by widening
 * to where matchers actually live rather than by loosening what it asks.
 */
const DISPATCH_LAYER = [
  'src/api/server.js',
  'src/connectors/airtable/webhook-sync.js',
].map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

/** THE LIVE CATALOG. Not a list written here — one written here goes stale. */
const TRIGGERS = (() => {
  const reg = new CapabilityRegistry();
  registerSlackTriggers(reg, {});
  registerGoogleChannels(reg, {});
  registerAirtableChannels(reg, {});
  return reg.list({ position: 'trigger' });
})();

/** The real `_sampleEvent`, lifted and executed. */
const sampleFor = (() => {
  const i = HTML.indexOf('  _sampleEvent() {');
  const body = HTML.slice(i, HTML.indexOf('\n  }', i) + 4);
  // eslint-disable-next-line no-new-func
  const make = new Function('state', 'const self={state}; ' + body.replace('_sampleEvent() {', 'const f=function(){').replace(/\}$/, '};') + ' return f.call(self);');
  return (trg) => make({ spec: { triggers: [trg] } });
})();

/** The real `_triggerGlyph` / `_triggerCaption`. */
const uiFor = (() => {
  const grab = (n) => { const i = HTML.indexOf('  ' + n + '(t) {'); return HTML.slice(i, HTML.indexOf('\n  }', i) + 4); };
  // eslint-disable-next-line no-new-func
  return new Function('t', 'const o = {' + grab('_triggerGlyph') + ',' + grab('_triggerCaption') + '};'
    + ' return { glyph: o._triggerGlyph(t), caption: o._triggerCaption(t) };');
})();

/** What the converger would store for this trigger capability. */
const asStored = (cap) => normalizeConnectorTrigger([{ type: 'event', connector: cap.connector, event: cap.id }])[0];

test('there are triggers to check at all', () => {
  assert.ok(TRIGGERS.length >= 3, `only ${TRIGGERS.length} trigger capabilities registered`);
});

for (const cap of TRIGGERS) {
  describe(`${cap.id} (${cap.connector})`, () => {
    // gmail is POLLED, not pushed — it has no inbound dispatcher to agree with, and
    // its trigger is stored as `type:'email'`, not a connector event. Its own path
    // is proven separately (and live, 2026-08-03).
    const pushed = cap.connector !== 'google';

    test('the stored trigger is one something can start a workflow from', () => {
      // The Slack defect exactly: a trigger that published, showed as live, and
      // matched nothing because it carried no event id.
      if (!pushed) return;
      assert.equal(isRunnableTrigger(asStored(cap)), true,
        `a workflow built on ${cap.id} would publish and never fire`);
    });

    test('and its stored event id is one the DISPATCHER matches on', async () => {
      // The round trip that was broken: the catalog calls it `slack_message`, the
      // matcher wants Slack's raw `message`. Read the dispatcher's own source so
      // this cannot drift into agreeing with a copy of itself.
      if (!pushed) return;
      const stored = asStored(cap);
      assert.ok(String(stored.event ?? ''), `${cap.id} stores no event id`);
      const matcher = MATCHES[cap.connector];
      assert.ok(matcher, `no matcher wired for ${cap.connector} — add one, do not skip it`);
      assert.equal(await matcher(stored), true,
        `${cap.connector}'s own dispatcher does NOT match the trigger the converger stores for ${cap.id} — a workflow on it would publish and never fire`);
    });

    test('a test sample looks like the real event, not a placeholder', () => {
      // A generic seed makes every content step emit "required data not found",
      // so the workflow can never pass its own test. Witnessed on Slack.
      if (!pushed) return;
      const s = sampleFor(asStored(cap));
      assert.notEqual(s, 'Sample trigger event for testing this workflow.',
        `${cap.id} falls back to the generic seed — a workflow on it cannot pass its test`);
      assert.ok(s.split('\n\n').slice(1).join(' ').trim().length > 30,
        `${cap.id}'s sample carries no body worth reading`);
    });

    test('it reads as English, with an icon of its own', () => {
      const { glyph, caption } = uiFor(asStored(cap));
      assert.notEqual(glyph, '◯', `${cap.id} has no icon — a reader is told "we cannot tell"`);
      assert.doesNotMatch(caption, /_|\bevent\b|\bconnector\b/i,
        `"${caption}" is the filing system, not English`);
    });
  });
}

describe('the dispatchers agree with each other', () => {
  // The check that found the Airtable cascade. Rules must be applied to EVERY
  // connector or they are not rules — and a rule applied to one is the shape this
  // codebase has paid for over and over.
  const dispatchers = [
    ['slack', 'dispatchSlackEventForTenant'],
    ['airtable', 'dispatchAirtableEvent'],
  ];

  for (const [name, fn] of dispatchers) {
    test(`${name}: a failed run does not take a live workflow off the air`, () => {
      const i = SERVER.indexOf(fn);
      assert.notEqual(i, -1, `${fn} not found — re-point this`);
      const body = SERVER.slice(i, i + 2600);
      assert.match(body, /w\.status === 'active' \|\| w\.status === 'error'/,
        `${name} asks only for active workflows — one failed run disables it for ever`);
    });
  }
});
