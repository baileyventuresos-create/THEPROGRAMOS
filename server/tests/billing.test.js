/* Billing abstraction tests (test-mode only, fake adapter).
 * Run: node --test server/tests/billing.test.js
 * Pins: ALREADY_COVERED for sponsored/member athletes (never
 * double-charged), fake checkout -> active subscription, webhook
 * idempotency, live-key refusal by construction. No Stripe account
 * is touched; the connector is not connected in this environment.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MemorySaasStore } = require('../saas-store');
const { createSaasApi } = require('../saas-api');
const { FakeBillingAdapter, StripeTestAdapter } = require('../billing');
const { resolveAthleteEntitlements } = require('../entitlements');

const NOW = Date.parse('2026-11-20T12:00:00Z');

function codeOf(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

function freshWorld() {
  const store = new MemorySaasStore();
  const billing = new FakeBillingAdapter(store);
  const api = createSaasApi({ store, billing });
  api.registerCoach({ authUserId: 'auth-bc', role: 'coach' }, { email: 'bc@dev.invalid', name: 'Billing Coach', now: NOW });
  const ath = api.registerAthlete({ authUserId: 'auth-ba', role: 'athlete' }, { email: 'ba@dev.invalid', name: 'Billing Athlete', age: 27, now: NOW });
  const coachAuth = { authUserId: 'auth-bc', role: 'coach' };
  api.linkAthlete(coachAuth, { athleteId: ath.athlete.id, now: NOW });
  return { store, billing, api, ath, coachAuth };
}

test('fake checkout -> confirm -> subscription active -> paid entitlements', () => {
  const { store, billing, ath } = freshWorld();
  const session = billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: ath.athlete.id, planCode: 'athlete_remote', interval: 'year', now: NOW });
  assert.equal(session.priceCents, 14900, 'annual = 10x monthly ($149/yr)');
  const { subscription, alreadyComplete } = billing.confirmCheckout(session.sessionId, { now: NOW });
  assert.equal(alreadyComplete, false);
  assert.equal(subscription.status, 'active');
  assert.equal(subscription.billingInterval, 'year');
  assert.equal(resolveAthleteEntitlements(store, ath.athlete.id, NOW).tier, 'paid');
  const again = billing.confirmCheckout(session.sessionId, { now: NOW });
  assert.equal(again.alreadyComplete, true, 'double-confirm is a no-op');
});

test('sponsored athlete checkout is refused ALREADY_COVERED (never double-charged)', () => {
  const { store, billing, api, ath, coachAuth } = freshWorld();
  api.sponsorAthlete(coachAuth, { athleteId: ath.athlete.id, now: NOW });
  assert.equal(resolveAthleteEntitlements(store, ath.athlete.id, NOW).tier, 'sponsored');
  const e = codeOf(() => billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: ath.athlete.id, planCode: 'athlete_remote', now: NOW }));
  assert.equal(e.code, 'ALREADY_COVERED');
  assert.equal(e.coveringSource, 'sponsorship');
  // Ending the sponsorship re-opens checkout.
  api.endSponsorship(coachAuth, { athleteId: ath.athlete.id, now: NOW });
  const session = billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: ath.athlete.id, planCode: 'athlete_remote', now: NOW });
  assert.ok(session.sessionId);
});

test('in-person member checkout is refused ALREADY_COVERED with the source named', () => {
  const { store, billing, ath } = freshWorld();
  store.memberships.push({
    id: 'mem-1', athleteId: ath.athlete.id, status: 'active', priceCents: 14900,
    startDate: new Date(NOW - 1000).toISOString(), endDate: null,
  });
  const e = codeOf(() => billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: ath.athlete.id, planCode: 'athlete_remote', now: NOW }));
  assert.equal(e.code, 'ALREADY_COVERED');
  assert.equal(e.coveringSource, 'in_person_membership');
});

test('checkout validates plan audience and interval', () => {
  const { billing, ath } = freshWorld();
  assert.equal(codeOf(() => billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: ath.athlete.id, planCode: 'coach_starter', now: NOW })).code, 'INVALID_INPUT');
  assert.equal(codeOf(() => billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: ath.athlete.id, planCode: 'nope', now: NOW })).code, 'INVALID_INPUT');
  assert.equal(codeOf(() => billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: ath.athlete.id, planCode: 'athlete_remote', interval: 'week', now: NOW })).code, 'INVALID_INPUT');
});

test('provider events are idempotent and drive subscription state', () => {
  const { store, billing, ath } = freshWorld();
  const session = billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: ath.athlete.id, planCode: 'athlete_remote', now: NOW });
  const { subscription } = billing.confirmCheckout(session.sessionId, { now: NOW });
  const event = { providerEventId: 'evt_1', type: 'subscription.past_due', payload: { subscriptionId: subscription.id } };
  const first = billing.handleProviderEvent(event, { now: NOW });
  assert.equal(first.processed, true);
  assert.equal(store.subscriptions.get(subscription.id).status, 'past_due');
  const replay = billing.handleProviderEvent(event, { now: NOW });
  assert.equal(replay.processed, false);
  assert.equal(replay.duplicate, true, 'replayed webhook is a no-op');
  assert.equal(store.billingEvents.size, 1);
  billing.handleProviderEvent(
    { providerEventId: 'evt_2', type: 'subscription.renewed', payload: { subscriptionId: subscription.id } }, { now: NOW });
  assert.equal(store.subscriptions.get(subscription.id).status, 'active');
});

test('StripeTestAdapter refuses live keys by construction and needs no network', () => {
  assert.equal(codeOf(() => new StripeTestAdapter({ apiKey: 'sk_live_example' })).code, 'BILLING_LIVE_MODE_REFUSED');
  assert.equal(codeOf(() => new StripeTestAdapter({ apiKey: 'rk_live_example' })).code, 'BILLING_LIVE_MODE_REFUSED');
  assert.equal(codeOf(() => new StripeTestAdapter({})).code, 'BILLING_NOT_CONFIGURED');
  const adapter = new StripeTestAdapter({ apiKey: 'sk_test_example' });
  assert.equal(adapter.provider, 'stripe_test');
  assert.equal(codeOf(() => adapter.createCheckoutSession({})).code, 'BILLING_NOT_CONFIGURED',
    'test-mode connection is a separate approved step; no network calls happen here');
});
