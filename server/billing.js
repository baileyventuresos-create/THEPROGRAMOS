/* THE PROGRAM OS — Billing abstraction (test-mode only)
 * server/billing.js
 *
 * Design: docs/SAAS_ARCHITECTURE.md §2.6. The Stripe connector in
 * this environment is NOT connected; no Stripe account (test or
 * live) is available to this work and none is touched.
 *
 *   - FakeBillingAdapter: in-memory, deterministic. Backs all tests
 *     and the dev server. Checkout -> confirm -> subscription
 *     active; provider events processed idempotently.
 *   - StripeTestAdapter: written against Stripe test mode but
 *     refuses live keys BY CONSTRUCTION (BILLING_LIVE_MODE_REFUSED)
 *     and performs no network calls until a separately approved
 *     test-mode connection exists.
 *
 * Sponsored-athlete protection lives here, not in Stripe:
 * createCheckoutSession for an athlete first resolves entitlements;
 * an athlete already covered by a complimentary grant, an in-person
 * membership, or an active sponsorship is refused with
 * ALREADY_COVERED (covering source named) — double-charging is
 * impossible through this API.
 *
 * No secrets in code or logs. Provider ids are test-mode ids only.
 */
'use strict';

const { resolveAthleteEntitlements } = require('./entitlements');

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function periodEndFor(interval, fromMs) {
  return new Date(fromMs + (interval === 'year' ? 365 : 30) * DAY_MS).toISOString();
}

/* Shared checkout guard: returns the covering entitlement when the
 * athlete must NOT be sold a subscription, else null. */
function athleteCoverageBlock(store, athleteId, now) {
  const ent = resolveAthleteEntitlements(store, athleteId, now);
  if (ent.tier === 'complimentary') return { code: 'ALREADY_COVERED', source: 'complimentary_grant', entitlements: ent };
  if (ent.tier === 'member') return { code: 'ALREADY_COVERED', source: 'in_person_membership', entitlements: ent };
  if (ent.tier === 'sponsored') return { code: 'ALREADY_COVERED', source: 'sponsorship', entitlements: ent };
  return null;
}

class FakeBillingAdapter {
  constructor(store) {
    if (!store) throw new Error('FakeBillingAdapter requires a store.');
    this.store = store;
    this.provider = 'none';
    this.sessions = new Map(); // sessionId -> {ownerType, ownerId, planCode, interval, status}
    this.counter = 0;
  }

  createCheckoutSession({ ownerType, ownerId, planCode, interval = 'month', now = Date.now() } = {}) {
    if (!['athlete', 'coach', 'organization'].includes(ownerType) || !ownerId || !planCode) {
      throw err('INVALID_INPUT', 'createCheckoutSession requires ownerType, ownerId, planCode.');
    }
    const plan = this.store.plans[planCode];
    if (!plan || !plan.active) throw err('INVALID_INPUT', `Unknown or inactive plan: ${planCode}.`);
    if (plan.audience !== ownerType) {
      throw err('INVALID_INPUT', `Plan ${planCode} is for ${plan.audience}, not ${ownerType}.`);
    }
    if (!['month', 'year'].includes(interval)) throw err('INVALID_INPUT', 'interval must be month or year.');
    if (ownerType === 'athlete') {
      const block = athleteCoverageBlock(this.store, ownerId, now);
      if (block) {
        const e = err('ALREADY_COVERED', `Athlete already has paid access via ${block.source}; checkout refused (no double charge).`);
        e.coveringSource = block.source;
        throw e;
      }
    }
    this.counter += 1;
    const sessionId = `fake_cs_${this.counter}`;
    this.sessions.set(sessionId, { ownerType, ownerId, planCode, interval, status: 'open' });
    const priceCents = interval === 'year' ? plan.limits.priceAnnualCents : plan.limits.priceMonthlyCents;
    return { sessionId, url: `fake-checkout://${sessionId}`, priceCents, interval, planCode };
  }

  /* Test/dev stand-in for a completed checkout + webhook: creates
   * (or reactivates) the subscription row as active. */
  confirmCheckout(sessionId, { now = Date.now() } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s) throw err('INVALID_INPUT', `Unknown checkout session: ${sessionId}.`);
    if (s.status === 'complete') {
      const existing = this.store.subscriptionsFor(s.ownerType, s.ownerId)
        .find(x => x.planCode === s.planCode && x.status === 'active');
      return { subscription: existing || null, alreadyComplete: true };
    }
    s.status = 'complete';
    const sub = {
      id: this.store.newId(), planCode: s.planCode, ownerType: s.ownerType, ownerId: s.ownerId,
      status: 'active', billingInterval: s.interval,
      currentPeriodStart: new Date(now).toISOString(),
      currentPeriodEnd: periodEndFor(s.interval, now),
      cancelAtPeriodEnd: false, provider: 'none',
      providerCustomerId: null, providerSubscriptionId: null,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    };
    this.store.subscriptions.set(sub.id, sub);
    return { subscription: sub, alreadyComplete: false };
  }

  createPortalSession({ ownerType, ownerId } = {}) {
    if (!ownerType || !ownerId) throw err('INVALID_INPUT', 'createPortalSession requires ownerType and ownerId.');
    return { url: `fake-portal://${ownerType}/${ownerId}` };
  }

  /* Idempotent provider-event processing (billing_events log).
   * Replaying the same provider_event_id is a no-op. */
  handleProviderEvent(event, { now = Date.now() } = {}) {
    if (!event || !event.providerEventId || !event.type) {
      throw err('INVALID_INPUT', 'handleProviderEvent requires providerEventId and type.');
    }
    if (this.store.billingEvents.has(event.providerEventId)) {
      return { processed: false, duplicate: true };
    }
    const row = {
      id: this.store.newId(), provider: event.provider || 'none',
      providerEventId: event.providerEventId, eventType: event.type,
      payload: event.payload || {}, processedAt: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
    this.store.billingEvents.set(event.providerEventId, row);
    const subId = event.payload && event.payload.subscriptionId;
    const sub = subId ? this.store.subscriptions.get(String(subId)) : null;
    if (sub) {
      if (event.type === 'subscription.cancelled') {
        sub.status = 'cancelled'; sub.cancelAtPeriodEnd = false;
      } else if (event.type === 'subscription.past_due') {
        sub.status = 'past_due';
      } else if (event.type === 'subscription.renewed') {
        sub.status = 'active';
        sub.currentPeriodStart = new Date(now).toISOString();
        sub.currentPeriodEnd = periodEndFor(sub.billingInterval || 'month', now);
      }
      sub.updatedAt = new Date(now).toISOString();
    }
    return { processed: true, duplicate: false, subscription: sub || null };
  }

  syncSubscription(subscriptionId) {
    return this.store.subscriptions.get(String(subscriptionId)) || null;
  }
}

/* Stripe test-mode adapter. Refuses live keys by construction and
 * makes no network calls: exercising it requires the separately
 * approved Stripe test-mode connection (design §2.6 steps 1-4). */
class StripeTestAdapter {
  constructor({ apiKey } = {}) {
    if (typeof apiKey !== 'string' || !apiKey) {
      throw err('BILLING_NOT_CONFIGURED', 'StripeTestAdapter requires a test-mode API key (none is configured in this environment).');
    }
    if (apiKey.startsWith('sk_live_') || !apiKey.startsWith('sk_test_')) {
      throw err('BILLING_LIVE_MODE_REFUSED', 'Live-mode Stripe keys are refused by construction. Test-mode keys (sk_test_) only.');
    }
    this.provider = 'stripe_test';
    this.configured = true;
  }

  createCheckoutSession() {
    throw err('BILLING_NOT_CONFIGURED', 'Stripe test mode is not connected in this environment; checkout is unavailable (design §2.6).');
  }
  createPortalSession() {
    throw err('BILLING_NOT_CONFIGURED', 'Stripe test mode is not connected in this environment.');
  }
  handleProviderEvent() {
    throw err('BILLING_NOT_CONFIGURED', 'Stripe test mode is not connected in this environment.');
  }
  syncSubscription() {
    throw err('BILLING_NOT_CONFIGURED', 'Stripe test mode is not connected in this environment.');
  }
}

module.exports = { FakeBillingAdapter, StripeTestAdapter, athleteCoverageBlock, periodEndFor };
