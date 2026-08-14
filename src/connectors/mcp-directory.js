/**
 * THE SERVICES A CUSTOMER CAN PICK FROM BY NAME.
 *
 * ── Why a list at all, when discovery is generic ───────────────────────────
 *
 * The connect machinery needs nothing but an address, so the temptation is to
 * show a box and let people paste one. That box IS the developer errand this
 * phase exists to remove — a person who knows their MCP server's URL is a person
 * who has already been in a settings screen. So Atlas offers NAMES, and holds the
 * addresses itself.
 *
 * This is a convenience list, not a capability list. Nothing here says what a
 * service can DO — that is read from the service itself after connecting, which
 * is the whole point. Adding an entry here is a one-line edit and grants nothing;
 * removing one takes nothing away from a tenant already connected.
 *
 * ── `route` is a MEASUREMENT, not a promise ────────────────────────────────
 *
 * It records how each service identified us when last checked, and is used only
 * to explain things — never trusted in place of asking. `beginConnect` rediscovers
 * live every time, because a service can change its mind and a stale value here
 * would send someone to a screen that cannot work.
 *
 * ── WHAT THE PREVIOUS RECORD GOT WRONG, and how ────────────────────────────
 *
 * ENGINEERING-LOG.md recorded all six as CIMD-supporting, checked 2026-07-24. Re-measured
 * against the live services on 2026-08-03, THREE OF THE SIX DO NOT ADVERTISE IT —
 * Asana, Stripe and Figma identify us by letting Atlas register itself instead.
 * Both routes cost the customer nothing, so the correction changes no promise to
 * anyone; it is recorded because a doc that disagrees with what the services
 * actually say is confidently wrong, and the next person builds on it.
 *
 * Two of those three ALSO needed a real fix before they could be seen at all:
 * Stripe's issuer carries a path (`https://access.stripe.com/mcp`) and its
 * metadata is only at the RFC 8414 location, and Figma's address here was the
 * DESKTOP APP's localhost port, which a server can never reach.
 */

/**
 * Verified against each service's own live metadata on 2026-08-03 — every field
 * below was read from the service that day, not carried forward.
 *
 * `route` is how it identifies us: `cimd` (it accepts our published document) or
 * `register-self` (Atlas registers itself over HTTP). Both are invisible to the
 * customer, who presses one button either way.
 */
export const MCP_DIRECTORY = [
  { id: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', route: 'cimd', checked: '2026-08-03' },
  { id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', route: 'cimd', checked: '2026-08-03' },
  { id: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', route: 'cimd', checked: '2026-08-03' },
  { id: 'asana', name: 'Asana', url: 'https://mcp.asana.com/sse', route: 'register-self', checked: '2026-08-03' },
  { id: 'stripe', name: 'Stripe', url: 'https://mcp.stripe.com', route: 'register-self', checked: '2026-08-03' },
  { id: 'figma', name: 'Figma', url: 'https://mcp.figma.com/mcp', route: 'register-self', checked: '2026-08-03' },
];

/** One entry, or null. Never throws — an unknown id is a 404, not a crash. */
export function mcpService(id) {
  return MCP_DIRECTORY.find((s) => s.id === String(id ?? '').toLowerCase()) ?? null;
}
