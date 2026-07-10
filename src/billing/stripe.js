/**
 * Stripe billing — self-serve upgrade for the pilot pricing ladder.
 *
 * The upgrade path (owner decision, 2026-07-09): hitting a plan wall opens the
 * in-app Upgrade modal → Stripe Checkout (subscription) → on payment, a webhook
 * flips the tenant's `plan`. This module owns the Stripe surface; plan limits
 * live in src/entitlements/index.js.
 *
 * Env-driven and fail-soft: if STRIPE_SECRET_KEY is unset (local/dev, or before
 * the owner finishes Stripe setup), the module loads fine and the server boots —
 * only an actual checkout call throws BillingNotConfiguredError (surfaced as a
 * clean 503 by the route). The SDK is imported lazily so a missing `stripe`
 * package never breaks startup either.
 *
 * Required env when live:
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *   STRIPE_PRICE_SOLO, STRIPE_PRICE_PROFESSIONAL, STRIPE_PRICE_TEAM, STRIPE_PRICE_BUSINESS
 */

import { PUBLIC_PLANS } from '../entitlements/index.js';

/** Floor a cancelled/expired subscription drops back to. */
const CANCEL_FLOOR_PLAN = 'solo';

export class BillingNotConfiguredError extends Error {
  constructor(msg = 'Billing is not configured (STRIPE_SECRET_KEY unset).') {
    super(msg);
    this.status = 503;
    this.code = 'BILLING_NOT_CONFIGURED';
  }
}

/** True once STRIPE_SECRET_KEY is present — the app can offer checkout. */
export function isBillingConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

/**
 * Stripe Tax toggle. Off by default so checkout works before Tax is set up in the
 * Stripe dashboard. Flip STRIPE_AUTOMATIC_TAX=true on the box ONLY after Stripe Tax
 * is enabled + an origin address and tax registrations exist — otherwise Stripe
 * rejects the session. Env-gated so it's a config flip, not a redeploy.
 */
export function isAutomaticTaxEnabled() {
  return /^(1|true|yes|on)$/i.test(process.env.STRIPE_AUTOMATIC_TAX || '');
}

/** Env var holding the Stripe price id for a plan, e.g. solo → STRIPE_PRICE_SOLO. */
function priceEnvKey(plan) {
  return `STRIPE_PRICE_${String(plan).toUpperCase()}`;
}

/** Stripe price id configured for a sellable plan (or null if unset/not sellable). */
export function planToPrice(plan) {
  if (!PUBLIC_PLANS.includes(plan)) return null;
  return process.env[priceEnvKey(plan)] || null;
}

/** Reverse map: a Stripe price id → the plan it sells (or null). */
export function priceToPlan(priceId) {
  if (!priceId) return null;
  for (const plan of PUBLIC_PLANS) {
    if (process.env[priceEnvKey(plan)] === priceId) return plan;
  }
  return null;
}

let _stripe = null;
async function getStripe() {
  if (!isBillingConfigured()) throw new BillingNotConfiguredError();
  if (_stripe) return _stripe;
  const { default: Stripe } = await import('stripe');
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

/**
 * Create a subscription Checkout session for a tenant upgrading to `plan`.
 * Returns the session (caller redirects the browser to `session.url`).
 *
 * `tenantId` is stamped on both `client_reference_id` and metadata so the webhook
 * can reconcile the payment back to the tenant; `plan` is carried in metadata so
 * we don't have to re-derive it from the price at fulfillment time.
 */
export async function createCheckoutSession({ tenantId, plan, email = null, baseUrl }) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!PUBLIC_PLANS.includes(plan)) throw new Error(`"${plan}" is not a purchasable plan`);
  const price = planToPrice(plan);
  if (!price) throw new BillingNotConfiguredError(`No Stripe price configured for the ${plan} plan (${priceEnvKey(plan)}).`);

  const stripe = await getStripe();
  const base = String(baseUrl || '').replace(/\/$/, '');
  const taxOn = isAutomaticTaxEnabled();
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: tenantId,
    ...(email ? { customer_email: email } : {}),
    metadata: { tenantId, plan },
    subscription_data: { metadata: { tenantId, plan } },
    success_url: `${base}/?upgraded=${encodeURIComponent(plan)}`,
    cancel_url: `${base}/?upgrade_cancelled=1`,
    allow_promotion_codes: true,
    // Stripe Tax (off unless STRIPE_AUTOMATIC_TAX=true). When on, Stripe computes
    // sales tax/VAT from the buyer's address (which Checkout then requires) against
    // the account's registrations, and B2B customers can enter a tax ID for
    // reverse-charge. Tax only applies where the account is registered.
    ...(taxOn ? {
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
    } : {}),
  });
}

/**
 * Create a Billing Portal session so a tenant can manage/cancel their subscription.
 * Requires a linked Stripe customer id. Returns the portal session (redirect to url).
 */
export async function createPortalSession({ customerId, baseUrl }) {
  if (!customerId) throw new Error('This workspace has no Stripe customer on file.');
  const stripe = await getStripe();
  const base = String(baseUrl || '').replace(/\/$/, '');
  return stripe.billing.portal.sessions.create({
    customer: customerId,
    return_url: `${base}/`,
  });
}

/** Verify + parse a raw webhook payload. Throws if the signature is invalid. */
export async function constructWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new BillingNotConfiguredError('STRIPE_WEBHOOK_SECRET unset — cannot verify webhooks.');
  const stripe = await getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Apply a verified Stripe event to the tenant store. Pure reconciliation — resolves
 * the tenant, then flips `plan` and links Stripe ids. Unknown event types are
 * ignored. Returns `{ handled, tenantId, plan }` for logging.
 */
export function handleWebhookEvent(event, { tenantStore }) {
  const obj = event?.data?.object ?? {};
  const resolveTenant = () =>
    obj.metadata?.tenantId
    ?? obj.client_reference_id
    ?? (obj.customer ? tenantStore.getByStripeCustomer(obj.customer)?.id : null)
    ?? null;

  switch (event.type) {
    case 'checkout.session.completed': {
      const tenantId = resolveTenant();
      const plan = obj.metadata?.plan;
      if (tenantId && PUBLIC_PLANS.includes(plan)) {
        tenantStore.setStripeIds(tenantId, {
          customerId: obj.customer ?? undefined,
          subscriptionId: obj.subscription ?? undefined,
        });
        tenantStore.setPlan(tenantId, plan);
        return { handled: true, tenantId, plan };
      }
      return { handled: false, tenantId, plan };
    }
    case 'customer.subscription.updated': {
      // Plan changes made in Stripe (or proration) — reconcile from the price.
      const tenantId = resolveTenant();
      const priceId = obj.items?.data?.[0]?.price?.id;
      const plan = priceToPlan(priceId) ?? obj.metadata?.plan;
      // A subscription set to cancel-at-period-end but still active keeps its plan.
      if (tenantId && PUBLIC_PLANS.includes(plan)) {
        tenantStore.setPlan(tenantId, plan);
        return { handled: true, tenantId, plan };
      }
      return { handled: false, tenantId, plan };
    }
    case 'customer.subscription.deleted': {
      const tenantId = resolveTenant();
      if (tenantId) {
        tenantStore.setPlan(tenantId, CANCEL_FLOOR_PLAN);
        tenantStore.setStripeIds(tenantId, { subscriptionId: null });
        return { handled: true, tenantId, plan: CANCEL_FLOOR_PLAN };
      }
      return { handled: false, tenantId };
    }
    default:
      return { handled: false, ignored: event.type };
  }
}

export { CANCEL_FLOOR_PLAN };
