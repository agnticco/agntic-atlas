/**
 * keep-alive — stop a slow request being cut by the proxy.
 *
 * Cloudflare kills any request that stays SILENT for ~100s (524). It is NOT a
 * limit on how LONG a request takes — it is a limit on how long NOTHING is sent.
 * The proof was already in this codebase: the reasoning stream
 * (`GET /api/builder/sessions/:id/reasoning`) heartbeats every 15s and has been
 * observed alive at **227s**, through the same tunnel, returning 200.
 *
 * Building an approval-gate workflow genuinely takes more than 100s of model
 * work. It died at the proxy three times running, and each death discarded the
 * entire build and told the user to start over from "+ New workflow". So the long
 * POSTs DRIP WHITESPACE while they work: leading whitespace before a JSON body is
 * insignificant — `JSON.parse` and `Response.json()` both skip it — so the client
 * parses the result exactly as before.
 *
 * ── Why the first heartbeat is DELAYED ──────────────────────────────────────
 *
 * Writing anything flushes the headers, and once flushed the status is locked at
 * 200 — a later `res.status(500)` is silently ignored. Almost every response is
 * fast, and those must keep their real status codes, so nothing is written until
 * the request has already run for `after` ms (default 15s, 10x a normal reply).
 * Only a request that was heading for a 524 anyway is ever affected.
 *
 * ── The failure case, which is the one that matters ─────────────────────────
 *
 * Once committed, a failure cannot be a 5xx. It travels in the BODY as
 * `{ error }` with a 200. A client that trusted the status would read that as a
 * successful build and hand `{error}` to a handler expecting an interrupt — which
 * ignores it, leaving the build apparently hung forever. So both call sites in
 * `public/index.html` treat a body-level `error` as an error regardless of status.
 * **Never a silent success.** (Same reasoning as `/workflows/run`, which has
 * returned application errors as 2xx since 2026-06-18 for this exact Cloudflare
 * behaviour — see ENGINEERING-LOG.md, Known gotchas.)
 *
 * This lives in its own module so the route and its tests share ONE definition.
 * A copy in the test file would be a test of a program nobody runs.
 *
 * @module src/api/keep-alive.js
 */

/**
 * @param {import('express').Response} res
 * @param {{ after?: number }} [opts] — ms of silence before the first drip.
 * @returns {{ stop: () => void, committed: () => boolean, send: (payload: any, status?: number) => any }}
 */
export function keepAlive(res, { after = 15000 } = {}) {
  let flushed = false;

  const timer = setInterval(() => {
    if (res.writableEnded) return;
    if (!flushed) {
      flushed = true;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');   // don't let a proxy buffer the drip away
      res.flushHeaders?.();
    }
    try { res.write(' '); } catch { /* client vanished; the close handler clears the timer */ }
  }, after);

  const stop = () => clearInterval(timer);
  res.on?.('close', stop);

  return {
    stop,

    /** True once headers are on the wire — after this the status can no longer change. */
    committed: () => flushed,

    /**
     * Finish the response correctly for whichever state we are in. `status` is
     * honoured only while still uncommitted; once committed the payload carries
     * the error and the status is unavoidably 200.
     */
    send: (payload, status = 200) => {
      stop();
      if (!flushed) return res.status(status).json(payload);
      try { res.write(JSON.stringify(payload)); } catch { /* ignore */ }
      try { res.end(); } catch { /* ignore */ }
    },
  };
}
