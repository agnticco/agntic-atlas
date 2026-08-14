/**
 * Who a user of THIS deployment should contact for help.
 *
 * Atlas's invite emails, reset emails, billing receipts and in-app "talk to us"
 * link all used to name `hello@agntic.co` as a literal. That is correct for the
 * deployment Agntic runs and WRONG for every other one: someone self-hosting Atlas
 * for their own team would have their colleagues emailing a company they have never
 * heard of, about an account that company cannot see, for a server it does not run.
 *
 * So the address is configuration, and it DEFAULTS TO NOTHING. An unset address
 * means the "questions?" line is omitted entirely rather than filled with a guess —
 * no contact detail is strictly better than a wrong one, and there is no sensible
 * default for "who supports this particular installation".
 *
 * `SUPPORT_EMAIL` is deliberately the SAME variable the ticket system already uses
 * to route in-app bug reports. One deployment has one answer to "where does support
 * go"; giving it two variables is how two halves of one idea drift apart.
 */

/** The configured support address, or null when this deployment has not named one. */
export function supportEmail() {
  const raw = process.env.SUPPORT_EMAIL?.trim();
  return raw || null;
}

/**
 * A plain-text "questions?" line, or '' when no address is configured.
 * Callers spread this into a line array, so an empty string must be filtered out
 * by the caller (`.filter(Boolean)`) to avoid leaving a blank line behind.
 */
export function supportLineText(lead = 'Questions:') {
  const to = supportEmail();
  return to ? `${lead} ${to}` : '';
}

/**
 * The same line as HTML, or '' when unset. Returns a complete sentence including
 * the leading space, so the caller can append it directly after existing copy
 * without producing a stray space when there is no address.
 */
export function supportLineHtml(lead = 'Questions?') {
  const to = supportEmail();
  if (!to) return '';
  const safe = to.replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  return ` ${lead} Reach us at <a class="textlink" href="mailto:${safe}" style="color:#767676; border-bottom:1px solid rgba(0,0,0,0.25);">${safe}</a>.`;
}
