/**
 * SSRF guard — refuse to fetch anything that is, or resolves to, a private address.
 *
 * Extracted from `connectors/web/index.js`, where it guarded `web_fetch` against a
 * workflow-controlled URL pointing at cloud metadata (169.254.169.254 → IAM creds),
 * loopback, or a private network service and reading the response back.
 *
 * It lives here now because a second caller needs exactly the same rule: OAuth client-id
 * metadata documents. Under CIMD the `client_id` IS a URL the authorization server
 * fetches, supplied by whoever is asking to connect — the same shape of hostile input
 * `web_fetch` takes, pointed at the same network. Copying the check would have produced
 * two guards that agree today and diverge the first time one is fixed, which is the
 * defect shape this codebase has paid for most.
 *
 * ── DNS REBINDING IS COVERED, AND THAT IS THE POINT OF `guardedLookup` ──────
 *
 * Validating a hostname then opening a socket leaves a window where the name can
 * re-resolve to a private address between the two. `guardedLookup` is called by undici
 * at connect time, so the IP checked is the exact IP connected to. A caller that
 * validates with `assertPublicUrl` and then fetches WITHOUT `ssrfDispatcher` has closed
 * the front door and left the window open.
 */

import dns from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

function ipToLong(ip) { return ip.split('.').reduce((a, o) => ((a << 8) + parseInt(o, 10)) >>> 0, 0); }

function v4Blocked(ip) {
  const n = ipToLong(ip);
  const inRange = (base, bits) => (n >>> (32 - bits)) === (ipToLong(base) >>> (32 - bits));
  return inRange('0.0.0.0', 8) || inRange('10.0.0.0', 8) || inRange('100.64.0.0', 10) ||
         inRange('127.0.0.0', 8) || inRange('169.254.0.0', 16) || inRange('172.16.0.0', 12) ||
         inRange('192.0.0.0', 24) || inRange('192.168.0.0', 16) || inRange('198.18.0.0', 15) ||
         n >= ipToLong('224.0.0.0'); // 224.0.0.0/3 — multicast + reserved
}

export function ipBlocked(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) {
    const lc = ip.toLowerCase();
    if (lc === '::1' || lc === '::') return true;                 // loopback / unspecified
    if (lc.startsWith('fe8') || lc.startsWith('fe9') || lc.startsWith('fea') || lc.startsWith('feb')) return true; // fe80::/10
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true;  // fc00::/7 unique-local
    const mapped = lc.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);  // IPv4-mapped
    if (mapped) return v4Blocked(mapped[1]);
    return false;
  }
  return true; // not a recognised IP → block
}

/**
 * Throw unless `url` is a public http(s) address.
 *
 * @param {string} url
 * @param {string} [what]  prefix for the error, so a caller's message names its own tool
 */
export async function assertPublicUrl(url, what = 'fetch') {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${what}: invalid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${what}: only http(s) URLs are allowed`);

  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (ipBlocked(host)) throw new Error(`${what}: refusing to fetch a private/reserved address`);
    return;
  }
  const lc = host.toLowerCase();
  if (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.local') || lc.endsWith('.internal')) {
    throw new Error(`${what}: refusing to fetch a local address`);
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error(`${what}: could not resolve ${host}`); }
  for (const a of addrs) if (ipBlocked(a.address)) throw new Error(`${what}: host resolves to a private/reserved address`);
}

/**
 * Connect-time DNS validation. undici calls this to resolve a hostname immediately
 * before opening the socket, so the IP validated is the exact IP connected to — closing
 * the rebinding window that `assertPublicUrl` alone cannot.
 */
export function guardedLookup(hostname, options, callback) {
  dnsLookup(hostname, { all: true, family: options?.family ?? 0, hints: options?.hints }, (err, addresses) => {
    if (err) return callback(err);
    for (const a of addresses) {
      if (ipBlocked(a.address)) return callback(new Error('host resolves to a private/reserved address'));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Pass as `dispatcher` to every fetch that follows an `assertPublicUrl` check. */
export const ssrfDispatcher = new Agent({ connect: { lookup: guardedLookup } });
