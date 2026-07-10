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

// Stripe Tax params (off unless STRIPE_AUTOMATIC_TAX=true). When on, Stripe computes
// sales tax/VAT from the buyer's address (which Checkout then requires) against the
// account's registrations; B2B customers can enter a tax ID for reverse-charge.
function taxParams() {
  return isAutomaticTaxEnabled()
    ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, billing_address_collection: 'required' }
    : {};
}

/**
 * Create a subscription Checkout session for an EXISTING tenant — an upgrade, or a
 * resubscribe from a suspended tenant. `tenantId` is stamped on `client_reference_id`
 * + metadata so the webhook reconciles the payment back to it; `plan` in metadata so
 * we don't re-derive it from the price. On resubscribe pass `customerId` to reuse the
 * tenant's existing Stripe customer (so it stays one customer, not two).
 */
export async function createCheckoutSession({ tenantId, plan, email = null, customerId = null, baseUrl, context = 'upgrade' }) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!PUBLIC_PLANS.includes(plan)) throw new Error(`"${plan}" is not a purchasable plan`);
  const price = planToPrice(plan);
  if (!price) throw new BillingNotConfiguredError(`No Stripe price configured for the ${plan} plan (${priceEnvKey(plan)}).`);

  const stripe = await getStripe();
  const base = String(baseUrl || '').replace(/\/$/, '');
  const done = context === 'resubscribe' ? 'resubscribed' : 'upgraded';
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: tenantId,
    ...(customerId ? { customer: customerId } : (email ? { customer_email: email } : {})),
    metadata: { tenantId, plan },
    subscription_data: { metadata: { tenantId, plan } },
    success_url: `${base}/?${done}=${encodeURIComponent(plan)}`,
    cancel_url: `${base}/?upgrade_cancelled=1`,
    allow_promotion_codes: true,
    ...taxParams(),
  });
}

/**
 * Pre-tenant Checkout for a brand-new self-serve signup. No tenant exists yet — the
 * webhook provisions tenant + admin on `checkout.session.completed` when it sees
 * `metadata.intent==='signup'`. Carries the email/workspace/plan through metadata.
 */
export async function createSignupCheckoutSession({ email, workspaceName, plan, baseUrl }) {
  if (!email) throw new Error('email is required');
  if (!PUBLIC_PLANS.includes(plan)) throw new Error(`"${plan}" is not a purchasable plan`);
  const price = planToPrice(plan);
  if (!price) throw new BillingNotConfiguredError(`No Stripe price configured for the ${plan} plan (${priceEnvKey(plan)}).`);

  const stripe = await getStripe();
  const base = String(baseUrl || '').replace(/\/$/, '');
  const meta = { intent: 'signup', email, plan, workspaceName: String(workspaceName ?? '').slice(0, 120) };
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    customer_email: email,
    metadata: meta,
    subscription_data: { metadata: meta },
    success_url: `${base}/?signup=complete`,
    cancel_url: `${base}/?signup=cancelled`,
    allow_promotion_codes: true,
    ...taxParams(),
  });
}

/** Retrieve a subscription (for current_period_end → next-charge / access-until). Null on error. */
export async function getSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  try { const stripe = await getStripe(); return await stripe.subscriptions.retrieve(subscriptionId); }
  catch { return null; }
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
 * Pure classifier — turns a verified Stripe event into a normalized descriptor the
 * webhook route acts on (provision / reactivate / suspend / notify). No store access,
 * no side effects. The route resolves the tenant (metadata OR customer lookup) and
 * performs the mutations, since only it has the auth stores + mailer.
 *
 * `kind`:
 *   'signup'                 — checkout completed with metadata.intent==='signup' (no tenant yet)
 *   'purchase'               — checkout completed for an existing tenant (upgrade/resubscribe)
 *   'cancellation'           — subscription deleted (ended) → suspend
 *   'cancellation_scheduled' — subscription set to cancel at period end → notify now
 *   'plan_change'            — subscription updated (price change) → reconcile plan
 *   'ignored'                — anything else
 *
 * @returns {{ kind, metaTenantId, intent, customerId, subscriptionId, plan, priceId,
 *             email, workspaceName, amountCents, currency, accessUntil }}
 */
export function classifyWebhookEvent(event) {
  const obj = event?.data?.object ?? {};
  const prev = event?.data?.previous_attributes ?? {};
  const base = {
    type: event?.type ?? null,
    metaTenantId: obj.metadata?.tenantId ?? obj.client_reference_id ?? null,
    intent: obj.metadata?.intent ?? null,
    customerId: obj.customer ?? null,
    subscriptionId: obj.subscription ?? obj.id ?? null, // session.subscription | subscription.id
    email: obj.customer_details?.email ?? obj.customer_email ?? obj.metadata?.email ?? null,
    workspaceName: obj.metadata?.workspaceName ?? null,
    plan: obj.metadata?.plan ?? priceToPlan(obj.items?.data?.[0]?.price?.id) ?? null,
    priceId: obj.items?.data?.[0]?.price?.id ?? null,
    amountCents: obj.amount_total ?? null,
    currency: obj.currency ?? null,
    accessUntil: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
  };

  switch (event.type) {
    case 'checkout.session.completed':
      return { ...base, kind: base.intent === 'signup' ? 'signup' : 'purchase' };
    case 'customer.subscription.deleted':
      return { ...base, kind: 'cancellation', subscriptionId: obj.id ?? null };
    case 'customer.subscription.updated': {
      const scheduledCancel = obj.cancel_at_period_end === true && prev.cancel_at_period_end === false;
      return { ...base, kind: scheduledCancel ? 'cancellation_scheduled' : 'plan_change', subscriptionId: obj.id ?? null };
    }
    default:
      return { ...base, kind: 'ignored' };
  }
}
