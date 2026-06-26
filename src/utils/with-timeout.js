/**
 * withTimeout — race a promise against a deadline so a hung external call can't
 * stall a workflow forever.
 *
 * Note: on timeout the underlying operation is NOT cancelled (no AbortController
 * here) — it resolves/rejects later and is ignored. This is a backstop against
 * indefinite hangs (e.g. a connector HTTP call with no socket timeout), not a
 * hard cancellation. LLM HTTP calls have their own SDK-level request timeout.
 *
 * @param {Promise<T>} promise
 * @param {number} ms        deadline in milliseconds
 * @param {string} [label]   included in the timeout error message
 * @returns {Promise<T>}
 * @template T
 */
export function withTimeout(promise, ms, label = 'operation') {
  if (!ms || ms <= 0) return promise;
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}
