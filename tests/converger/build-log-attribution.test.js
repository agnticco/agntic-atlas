/**
 * A BUILD-DIAGNOSTIC LOG THAT CANNOT NAME THE BUILD IS UNREADABLE IN PRODUCTION.
 *
 * QA Manager finding 9 (shakedown 2026-07-22). Every `converger.node` /
 * `blocker_to_chat` / `verify_rebuild` / `lane_examples` line was `{node, ms, step}`
 * and nothing else. Two tenants building at the same time produce one interleaved
 * stream that cannot be separated — and this log is the primary instrument for
 * diagnosing slow or looping builds, which is exactly when more than one person is
 * likely to be building. The QA Manager could only attribute a build's stages by
 * refusing to run a second one.
 *
 * `threadId` identifies the build; `tenant` makes it answerable per customer. Both
 * were already available — `threadId` in configurable, `tenantId` a parameter of
 * `createConverger` — and simply never reached the log line.
 *
 * These pin the WIRING (that the ids are forwarded and every build-log site stamps
 * them), because that is the whole defect. The values are only ever null in a call
 * that genuinely has no tenant, which is not a shape production produces.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRAPH = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');
const INDEX = readFileSync(path.join(ROOT, 'src/converger/index.js'), 'utf8');
const BUILD = readFileSync(path.join(ROOT, 'src/api/builder.js'), 'utf8');

describe('the id reaches the graph', () => {
  test('createConverger forwards tenantId into configurable', () => {
    assert.match(INDEX, /configurable:\s*\{\s*threadId,\s*\.\.\.\(tenantId\s*\?\s*\{\s*tenantId\s*\}/,
      'tenantId is a parameter of createConverger; if it is not put in configurable the log field is always null');
  });

  test('the bare-resume config carries it too', () => {
    // A resume that used a config without tenantId would blank the field for exactly
    // the long, looping builds this log exists to diagnose.
    const configs = INDEX.match(/configurable:\s*\{\s*threadId[^}]*\}/g) ?? [];
    assert.ok(configs.length >= 2, 'both the run/resume config and the bare-resume config must exist');
    for (const c of configs) {
      assert.match(c, /tenantId/, `a converger config omits tenantId: ${c}`);
    }
  });

  test('the server actually passes a real tenant id in', () => {
    const i = BUILD.indexOf('return createConverger({');
    const block = BUILD.slice(i, i + 400);
    assert.match(block, /tenantId:\s*req\.tenant\.id/,
      'a hardcoded or absent tenantId here would make the whole chain cosmetic');
  });
});

describe('every build-log site stamps who', () => {
  test('the `who` helper reads both ids from configurable', () => {
    assert.match(GRAPH, /const who = \(cfg\) => \(\{[\s\S]*?thread:[\s\S]*?tenant:[\s\S]*?\}\)/);
  });

  test('all four build-log events include ...who(cfg)', () => {
    for (const kind of ['converger.node', 'converger.blocker_to_chat',
                        'converger.verify_rebuild', 'converger.lane_examples']) {
      // find each logEvent for this kind and assert who(cfg) is in the same call
      const re = new RegExp(`logEvent\\('${kind.replace('.', '\\.')}',\\s*\\{[\\s\\S]{0,80}?who\\(cfg\\)`);
      assert.match(GRAPH, re, `${kind} does not stamp who(cfg) — it cannot be attributed to a build`);
    }
  });

  test('converger.node stamps who on BOTH the success and the pause/fail path', () => {
    // The pause path is the one that matters most: a build that keeps pausing is the
    // one being diagnosed, and it was the second, separate log line.
    const both = GRAPH.match(/logEvent\('converger\.node',\s*\{\s*\.\.\.who\(cfg\)/g) ?? [];
    assert.ok(both.length >= 2, 'the success and the pause/fail log lines must both carry who');
  });
});
