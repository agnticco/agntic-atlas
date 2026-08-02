/**
 * A GOOGLE WRITE IS NOW CHECKED BEFORE A TEST CALLS IT REACHABLE.
 *
 * Charles, 2026-08-02, after two days of building Doc workflows: *"I checked my docs
 * account and see 0 docs created from our work over the past two days."*
 *
 * That was CORRECT — every test run is dry, so nothing is really written — and it is the
 * point. Measured the same day:
 *
 *     docs_create            probe: none
 *     sheets_append          probe: none
 *     gmail_send             probe: none
 *     calendar_create_event  probe: none
 *
 * Only Slack and Airtable had probes. So for every Google write a dry run proved the
 * content resolved, a target was present and the connector was connected — and NOTHING
 * about whether Google would accept the write. The write path had never been exercised
 * and no test we could run would exercise it, so "cleared to go live" meant materially
 * less for Google than for Slack, with nothing on screen saying so.
 *
 * THE CONTRACT, inherited from the Slack and Airtable probes and pinned here because it
 * is the half that keeps a probe from failing good workflows:
 *   · a read, NEVER a write;
 *   · a DEFINITIVE miss returns `{reachable:false, reason}` and blocks;
 *   · anything else RE-THROWS, so the dry path records reachability as inconclusive
 *     rather than failing a valid workflow.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';

function caps() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  return reg;
}

/** Drive the REAL probe with `fetch` stubbed, so the request it makes is the subject. */
async function probeWith(id, config, respond) {
  // `getProbe`, not `get`: the probe is deliberately kept off the public shape (it is a
  // dry-run-only internal), so reading it from `get(id)` finds nothing.
  const probe = caps().getProbe(id);
  assert.ok(probe, `${id} has no probe`);
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return respond(String(url));
  };
  try { return { result: await probe({ config }), seen }; }
  catch (e) { return { threw: e, seen }; }
  finally { globalThis.fetch = real; }
}

const ok   = (body = {}) => ({ ok: true,  status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const fail = (status, msg) => ({ ok: false, status, json: async () => ({ error: { message: msg, code: status } }),
                                 text: async () => JSON.stringify({ error: { message: msg, code: status } }) });

describe('every Google write capability now has a probe', () => {
  for (const id of ['sheets_append', 'docs_create', 'calendar_create_event']) {
    test(`${id} declares one`, () => {
      assert.ok(typeof caps().getProbe(id) === 'function',
        `${id} has no probe — a dry run cannot say its destination is reachable`);
    });
  }
});

describe('the probe READS — it never writes', () => {
  for (const [id, config] of [
    ['sheets_append',         { spreadsheetId: 'sheet1', googleToken: 't' }],
    ['docs_create',           { title: 'T', googleToken: 't' }],
    ['calendar_create_event', { title: 'T', googleToken: 't' }],
  ]) {
    test(`${id} issues only GETs`, async () => {
      const { seen } = await probeWith(id, config, () => ok({ spreadsheetId: 'sheet1', id: 'primary', user: {} }));
      assert.ok(seen.length > 0, 'the probe made no request at all');
      for (const s of seen) {
        assert.equal(s.method, 'GET',
          `${id}'s probe issued a ${s.method} — a probe that writes is the thing it exists to avoid`);
      }
    });
  }
});

describe('a definitive miss BLOCKS, with a reason a person can act on', () => {
  test('a spreadsheet that is not there', async () => {
    const { result } = await probeWith('sheets_append', { spreadsheetId: 'gone', googleToken: 't' },
      () => fail(404, 'Requested entity was not found.'));
    assert.equal(result.reachable, false);
    assert.match(result.reason, /Sheet/i);
    assert.doesNotMatch(result.reason, /\b404\b|entity/i,
      'the provider\'s own wording is not English a customer can act on');
  });

  test('no spreadsheet chosen at all', async () => {
    const { result } = await probeWith('sheets_append', { spreadsheetId: '', googleToken: 't' }, () => ok());
    assert.equal(result.reachable, false);
  });

  test('a Drive the account may not write to', async () => {
    const { result } = await probeWith('docs_create', { title: 'T', googleToken: 't' },
      () => fail(403, 'Insufficient Permission'));
    assert.equal(result.reachable, false);
    assert.match(result.reason, /reconnect/i, 'tell them what to DO about it');
  });
});

describe('anything else is INCONCLUSIVE — never a failed test', () => {
  // This is the half that stops a probe becoming a new way to fail good workflows. A
  // flaky read is not proof the destination is bad.
  for (const [id, config] of [
    ['sheets_append',         { spreadsheetId: 'sheet1', googleToken: 't' }],
    ['docs_create',           { title: 'T', googleToken: 't' }],
    ['calendar_create_event', { title: 'T', googleToken: 't' }],
  ]) {
    test(`${id} re-throws a transient failure`, async () => {
      const { result, threw } = await probeWith(id, config, () => fail(500, 'Backend Error'));
      assert.equal(result, undefined, 'a 500 must not be reported as "your destination is wrong"');
      assert.ok(threw, 'it must re-throw so the dry path records reachability as unknown');
    });
  }

  test('and a reachable destination simply passes', async () => {
    const { result } = await probeWith('sheets_append', { spreadsheetId: 'sheet1', googleToken: 't' },
      () => ok({ spreadsheetId: 'sheet1' }));
    assert.deepEqual(result, { reachable: true });
  });
});
