/**
 * Stripe lifecycle handler — the side-effecting half of the webhook. Given a
 * classified event (classifyWebhookEvent) it provisions / reactivates / suspends /
 * reconciles the tenant, records a billing event, and fires the internal (#sales) +
 * customer emails. Kept out of server.js so it's unit-testable with a mock spine.
 *
 * Critical DB mutations may throw (→ the route returns 500 → Stripe retries).
 * Notifications/emails are best-effort inside their own helpers and never throw.
 */

import { randomBytes } from 'node:crypto';
import { PLAN_META, PUBLIC_PLANS } from '../entitlements/index.js';
import { getSubscription } from './stripe.js';
import { notifyPurchase, notifyCancellation, sendPurchaseConfirmation, sendCancellationConfirmation } from './purchase-notify.js';
import { renderInviteEmail } from '../auth/invite-email.js';
import { sendMail } from '../utils/mailer.js';
import { logEvent, errFields } from '../utils/event-log.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const planLabel = (plan) => PLAN_META[plan]?.label ?? plan;
const mrrCents = (plan) => (PUBLIC_PLANS.includes(plan) ? PLAN_META[plan].price * 100 : 0);
const isoFromUnix = (s) => (s ? new Date(s * 1000).toISOString() : null);

/** The tenant's admin email (the account owner) — recipient for customer-facing mail. */
function adminEmailFor(spine, tenantId) {
  try {
    const users = spine.auth.userStore.list(tenantId) || [];
    const admin = users.find((u) => u.role === 'admin' && !u.disabled_at) || users.find((u) => !u.disabled_at) || users[0];
    return admin?.email ?? null;
  } catch { return null; }
}

/** Derive a unique slug from a workspace name (mirrors POST /admin/tenants). */
function deriveSlug(name, tenantStore) {
  let root = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
  if (root.length < 2) root += '-ws';
  let slug = root, n = 2;
  while (tenantStore.getBySlug(slug)) slug = `${root}-${n++}`;
  return slug;
}

/** Have we already emitted a cancellation for this subscription? (immediate vs scheduled dedup) */
function alreadyCanceled(spine, subscriptionId) {
  if (!subscriptionId) return false;
  try { return spine.billingEvents.list({ limit: 100 }).some((e) => e.type === 'cancellation' && e.subscription_id === subscriptionId); }
  catch { return false; }
}

/** Resolve tenant id from classifier metadata or the Stripe customer linkage. */
function resolveTenantId(spine, c) {
  return c.metaTenantId
    ?? (c.customerId ? spine.auth.tenantStore.getByStripeCustomer(c.customerId)?.id : null)
    ?? null;
}

/** Entry point — dispatch a classified event to its handler. `base` = public app URL. */
export async function handleStripeLifecycle(spine, c, { base } = {}) {
  switch (c.kind) {
    case 'signup':                 return provisionSignup(spine, c, base);
    case 'purchase':               return applyPurchase(spine, c, base);
    case 'cancellation':           return applyCancellation(spine, c, base);
    case 'cancellation_scheduled': return applyCancellationScheduled(spine, c, base);
    case 'plan_change':            return applyPlanChange(spine, c, base);
    default:                       logEvent('billing.webhook', { type: c.type, kind: c.kind }); return;
  }
}

// ── New self-serve signup: provision tenant + admin on first payment ────────────
async function provisionSignup(spine, c, base) {
  const { tenantStore, userStore, authProvider, passwordResetStore } = spine.auth;
  if (!PUBLIC_PLANS.includes(c.plan) || !c.email) { logEvent('billing.signup.invalid', { plan: c.plan, hasEmail: !!c.email }); return; }

  // Idempotency: a retry of the same paid session, or an email that already has an account.
  if (c.customerId && tenantStore.getByStripeCustomer(c.customerId)) {
    logEvent('billing.signup.idempotent', { customer: c.customerId }); return;
  }
  const existingUser = userStore.findByEmail(c.email);
  if (existingUser) {
    // Same person subscribing again → treat as a purchase/reactivation of their tenant.
    return applyPurchase(spine, { ...c, metaTenantId: existingUser.tenant_id }, base);
  }

  const wsName = (c.workspaceName && c.workspaceName.trim()) || `${c.email.split('@')[0]}'s workspace`;
  const slug = deriveSlug(wsName, tenantStore);
  const tenant = tenantStore.create({ name: wsName, slug, plan: c.plan });
  tenantStore.setStripeIds(tenant.id, { customerId: c.customerId, subscriptionId: c.subscriptionId });
  const admin = await authProvider.register({
    tenantId: tenant.id, email: c.email, password: randomBytes(24).toString('base64url'), role: 'admin', display_name: '',
  });

  const sub = await getSubscription(c.subscriptionId);
  const nextChargeIso = isoFromUnix(sub?.current_period_end);

  // Onboarding email = set-password link + billing summary (their receipt + first step).
  try {
    const token = passwordResetStore.create({ userId: admin.id, tenantId: tenant.id, ttlMs: INVITE_TTL_MS });
    const inviteLink = `${String(base).replace(/\/+$/, '')}/?reset=${encodeURIComponent(token)}`;
    const mail = renderInviteEmail({ inviteLink, userEmail: c.email, workspaceName: wsName, base, plan: c.plan, nextChargeIso });
    await sendMail({ to: c.email, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (err) { logEvent('billing.signup.invite_error', errFields(err)); }

  spine.billingEvents.record({
    type: 'signup', tenantId: tenant.id, tenantName: wsName, plan: c.plan,
    amountCents: c.amountCents, mrrDeltaCents: mrrCents(c.plan), customerEmail: c.email, subscriptionId: c.subscriptionId,
  });
  notifyPurchase({
    tenantName: wsName, tenantId: tenant.id, plan: c.plan, planLabel: planLabel(c.plan),
    amountCents: c.amountCents ?? mrrCents(c.plan), currency: c.currency, email: c.email,
    subscriptionId: c.subscriptionId, adminBase: base,
  });
  logEvent('billing.signup.provisioned', { tenant: tenant.id, plan: c.plan });
}

// ── Existing tenant checkout: upgrade, or reactivate a suspended tenant ──────────
async function applyPurchase(spine, c, base) {
  const { tenantStore } = spine.auth;
  const tid = resolveTenantId(spine, c);
  if (!tid || !PUBLIC_PLANS.includes(c.plan)) { logEvent('billing.purchase.unresolved', { tid, plan: c.plan }); return; }

  const before = tenantStore.get(tid);
  const wasSuspended = before?.status === 'suspended';
  const prevPlan = before?.plan;

  tenantStore.setStripeIds(tid, { customerId: c.customerId, subscriptionId: c.subscriptionId });
  tenantStore.setPlan(tid, c.plan);
  if (wasSuspended) tenantStore.setStatus(tid, 'active'); // reactivation

  const tenant = tenantStore.get(tid);
  const email = c.email ?? adminEmailFor(spine, tid);
  const sub = await getSubscription(c.subscriptionId);
  const nextChargeIso = isoFromUnix(sub?.current_period_end);

  sendPurchaseConfirmation({
    to: email, name: null, plan: c.plan, planLabel: planLabel(c.plan),
    amountCents: c.amountCents ?? mrrCents(c.plan), currency: c.currency, nextChargeIso, appBase: base,
  });

  const kind = wasSuspended ? 'reactivation' : 'plan_change';
  const mrrDelta = wasSuspended ? mrrCents(c.plan) : (mrrCents(c.plan) - mrrCents(prevPlan));
  spine.billingEvents.record({
    type: kind, tenantId: tid, tenantName: tenant?.name, plan: c.plan, prevPlan,
    amountCents: c.amountCents, mrrDeltaCents: mrrDelta, customerEmail: email, subscriptionId: c.subscriptionId,
  });
  notifyPurchase({
    tenantName: tenant?.name, tenantId: tid, plan: c.plan, planLabel: planLabel(c.plan),
    amountCents: c.amountCents ?? mrrCents(c.plan), currency: c.currency, email, subscriptionId: c.subscriptionId, adminBase: base,
  });
  logEvent('billing.purchase', { tenant: tid, plan: c.plan, reactivated: wasSuspended });
}

// ── Subscription ended (deleted) → suspend the tenant (data preserved) ──────────
async function applyCancellation(spine, c, base) {
  const { tenantStore } = spine.auth;
  const tid = resolveTenantId(spine, c);
  if (!tid) { logEvent('billing.cancel.unresolved', { customer: c.customerId, sub: c.subscriptionId }); return; }

  const tenant = tenantStore.get(tid);
  const plan = tenant?.plan;
  tenantStore.setStatus(tid, 'suspended');                 // revoke access, keep the row + plan
  tenantStore.setStripeIds(tid, { subscriptionId: null }); // keep customerId for resubscribe reuse

  // If the customer already got a cancellation notice (scheduled-cancel path), just
  // suspend quietly; otherwise (immediate cancel) send it now.
  if (!alreadyCanceled(spine, c.subscriptionId)) {
    const email = adminEmailFor(spine, tid);
    sendCancellationConfirmation({ to: email, name: null, planLabel: planLabel(plan), accessUntilIso: c.accessUntil, appBase: base });
    spine.billingEvents.record({
      type: 'cancellation', tenantId: tid, tenantName: tenant?.name, plan,
      mrrDeltaCents: -mrrCents(plan), customerEmail: email, subscriptionId: c.subscriptionId,
    });
    notifyCancellation({
      tenantName: tenant?.name, tenantId: tid, plan, planLabel: planLabel(plan),
      mrrLostCents: mrrCents(plan), currency: c.currency, email, accessUntilIso: c.accessUntil,
      subscriptionId: c.subscriptionId, adminBase: base,
    });
  }
  logEvent('billing.cancellation.suspended', { tenant: tid, plan });
}

// ── Cancel scheduled at period end → notify now, suspend later on deletion ───────
async function applyCancellationScheduled(spine, c, base) {
  const { tenantStore } = spine.auth;
  const tid = resolveTenantId(spine, c);
  if (!tid) { logEvent('billing.cancel_scheduled.unresolved', { customer: c.customerId }); return; }
  if (alreadyCanceled(spine, c.subscriptionId)) return; // dedup

  const tenant = tenantStore.get(tid);
  const plan = tenant?.plan;
  const email = adminEmailFor(spine, tid);
  sendCancellationConfirmation({ to: email, name: null, planLabel: planLabel(plan), accessUntilIso: c.accessUntil, appBase: base });
  spine.billingEvents.record({
    type: 'cancellation', tenantId: tid, tenantName: tenant?.name, plan,
    mrrDeltaCents: -mrrCents(plan), customerEmail: email, subscriptionId: c.subscriptionId,
  });
  notifyCancellation({
    tenantName: tenant?.name, tenantId: tid, plan, planLabel: planLabel(plan),
    mrrLostCents: mrrCents(plan), currency: c.currency, email, accessUntilIso: c.accessUntil,
    subscriptionId: c.subscriptionId, adminBase: base,
  });
  logEvent('billing.cancellation.scheduled', { tenant: tid, plan, accessUntil: c.accessUntil });
}

// ── Plan change made in Stripe (e.g. via portal) → reconcile plan only ──────────
async function applyPlanChange(spine, c) {
  const { tenantStore } = spine.auth;
  const tid = resolveTenantId(spine, c);
  if (!tid || !PUBLIC_PLANS.includes(c.plan)) return;
  const before = tenantStore.get(tid);
  if (before?.plan === c.plan) return; // no-op update (common)
  const prevPlan = before?.plan;
  tenantStore.setPlan(tid, c.plan);
  spine.billingEvents.record({
    type: 'plan_change', tenantId: tid, tenantName: before?.name, plan: c.plan, prevPlan,
    mrrDeltaCents: mrrCents(c.plan) - mrrCents(prevPlan), subscriptionId: c.subscriptionId,
  });
  logEvent('billing.plan_change', { tenant: tid, from: prevPlan, to: c.plan });
}

export { planLabel, mrrCents, deriveSlug };
