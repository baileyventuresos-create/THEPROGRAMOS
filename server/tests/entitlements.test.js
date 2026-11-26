/* Entitlement derivation matrix (computed, never stored).
 * Run: node --test server/tests/entitlements.test.js
 * Pins the precedence fixed by docs/SAAS_ARCHITECTURE.md §2.2/§2.3:
 * in-person membership > sponsorship > own subscription > free;
 * expiry/cancel fall back by derivation; lapsed coach = read-only.
 * Synthetic rows only, in-memory store.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MemorySaasStore } = require('../saas-store');
const {
  subscriptionGrantsAccess, resolveAthleteEntitlements,
  resolveCoachEntitlements, resolveOrgEntitlements,
} = require('../entitlements');

const NOW = Date.parse('2026-11-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function sub(store, fields) {
  const s = {
    id: store.newId(), planCode: 'athlete_remote', ownerType: 'athlete', ownerId: 'ath-1',
    status: 'active', billingInterval: 'month',
    currentPeriodStart: iso(NOW - DAY), currentPeriodEnd: iso(NOW + 29 * DAY),
    cancelAtPeriodEnd: false, provider: 'none',
    providerCustomerId: null, providerSubscriptionId: null,
    createdAt: iso(NOW), updatedAt: iso(NOW), ...fields,
  };
  store.subscriptions.set(s.id, s);
  return s;
}

function freshStore() {
  const store = new MemorySaasStore();
  store.athletes.set('ath-1', { id: 'ath-1', appUserId: 'u-ath', name: 'Synthetic Athlete', age: 30, dob: null, sports: [] });
  store.appUsers.set('u-coach', { id: 'u-coach', authUserId: 'auth-coach', email: 'c@dev.invalid', role: 'coach' });
  store.coaches.set('coach-1', { id: 'coach-1', userId: 'u-coach', name: 'Synthetic Coach', organizationId: 'org-1' });
  store.organizations.set('org-1', { id: 'org-1', kind: 'solo', name: 'Solo', slug: 'solo', status: 'active', createdBy: 'u-coach' });
  store.orgMemberships.push({ organizationId: 'org-1', appUserId: 'u-coach', orgRole: 'org_admin', status: 'active' });
  return store;
}

test('free tier is the default: 90-day history window, 1 coach link, 1 training day/week', () => {
  const store = freshStore();
  const ent = resolveAthleteEntitlements(store, 'ath-1', NOW);
  assert.equal(ent.tier, 'free');
  assert.equal(ent.planCode, 'free_athlete');
  assert.equal(ent.historyDays, 90);
  assert.equal(ent.fullHistory, false);
  assert.equal(ent.maxCoachLinks, 1);
  assert.equal(ent.trainingDaysPerWeek, 1);
});

test('own subscription grants paid access with full history', () => {
  const store = freshStore();
  sub(store, {});
  const ent = resolveAthleteEntitlements(store, 'ath-1', NOW);
  assert.equal(ent.tier, 'paid');
  assert.equal(ent.source, 'own_subscription');
  assert.equal(ent.fullHistory, true);
  assert.equal(ent.historyDays, null);
  assert.equal(ent.maxCoachLinks, null);
});

test('in-person $149 member gets full remote access with no second charge', () => {
  const store = freshStore();
  store.memberships.push({ id: 'mem-1', athleteId: 'ath-1', status: 'active', priceCents: 14900, startDate: iso(NOW - 30 * DAY), endDate: null });
  const ent = resolveAthleteEntitlements(store, 'ath-1', NOW);
  assert.equal(ent.tier, 'member');
  assert.equal(ent.source, 'in_person_membership');
  assert.equal(ent.fullHistory, true);
  assert.equal(ent.membershipId, 'mem-1');
});

test('membership beats sponsorship beats own subscription (precedence order)', () => {
  const store = freshStore();
  sub(store, {}); // own
  const coachSub = sub(store, { planCode: 'coach_pro', ownerType: 'coach', ownerId: 'coach-1' });
  store.sponsorships.push({
    id: 'sp-1', athleteId: 'ath-1', sponsorType: 'coach', sponsorId: 'coach-1',
    subscriptionId: coachSub.id, status: 'active', startedAt: iso(NOW), endedAt: null,
  });
  let ent = resolveAthleteEntitlements(store, 'ath-1', NOW);
  assert.equal(ent.tier, 'sponsored', 'sponsorship wins over own subscription');
  store.memberships.push({ id: 'mem-1', athleteId: 'ath-1', status: 'active', priceCents: 14900, startDate: iso(NOW - DAY), endDate: null });
  ent = resolveAthleteEntitlements(store, 'ath-1', NOW);
  assert.equal(ent.tier, 'member', 'in-person membership wins over sponsorship');
});

test('sponsorship lapses with the sponsor subscription; athlete falls back to own, then free', () => {
  const store = freshStore();
  const coachSub = sub(store, { planCode: 'coach_starter', ownerType: 'coach', ownerId: 'coach-1' });
  store.sponsorships.push({
    id: 'sp-1', athleteId: 'ath-1', sponsorType: 'coach', sponsorId: 'coach-1',
    subscriptionId: coachSub.id, status: 'active', startedAt: iso(NOW), endedAt: null,
  });
  assert.equal(resolveAthleteEntitlements(store, 'ath-1', NOW).tier, 'sponsored');
  coachSub.status = 'expired';
  assert.equal(resolveAthleteEntitlements(store, 'ath-1', NOW).tier, 'free', 'no own sub -> free');
  sub(store, {});
  assert.equal(resolveAthleteEntitlements(store, 'ath-1', NOW).tier, 'paid', 'own sub takes over');
});

test('cancel at period end keeps access until the period ends, then derives to free', () => {
  const store = freshStore();
  const s = sub(store, { status: 'cancelled', cancelAtPeriodEnd: true });
  assert.equal(subscriptionGrantsAccess(s, NOW), true);
  assert.equal(resolveAthleteEntitlements(store, 'ath-1', NOW).tier, 'paid');
  const afterEnd = NOW + 30 * DAY;
  assert.equal(subscriptionGrantsAccess(s, afterEnd), false);
  assert.equal(resolveAthleteEntitlements(store, 'ath-1', afterEnd).tier, 'free');
});

test('immediate cancel and expiry grant nothing; past_due graces until period end', () => {
  const store = freshStore();
  const s = sub(store, { status: 'cancelled', cancelAtPeriodEnd: false });
  assert.equal(subscriptionGrantsAccess(s, NOW), false);
  s.status = 'expired';
  assert.equal(subscriptionGrantsAccess(s, NOW), false);
  s.status = 'past_due';
  assert.equal(subscriptionGrantsAccess(s, NOW), true, 'grace until current_period_end');
  assert.equal(subscriptionGrantsAccess(s, NOW + 30 * DAY), false);
  s.status = 'trialing';
  assert.equal(subscriptionGrantsAccess(s, NOW), true);
});

test('coach entitlements: org subscription wins; no subscription = read-only', () => {
  const store = freshStore();
  let ent = resolveCoachEntitlements(store, 'coach-1', NOW);
  assert.equal(ent.active, false);
  assert.equal(ent.readOnly, true, 'lapsed coach is read-only');
  sub(store, { planCode: 'coach_starter', ownerType: 'coach', ownerId: 'coach-1' });
  ent = resolveCoachEntitlements(store, 'coach-1', NOW);
  assert.equal(ent.active, true);
  assert.equal(ent.planCode, 'coach_starter');
  assert.equal(ent.limits.maxAthletes, 15);
  sub(store, { planCode: 'team_academy', ownerType: 'organization', ownerId: 'org-1' });
  ent = resolveCoachEntitlements(store, 'coach-1', NOW);
  assert.equal(ent.planCode, 'team_academy', 'org subscription wins over coach own');
  assert.equal(ent.source, 'organization_subscription');
  assert.equal(resolveOrgEntitlements(store, 'org-1', NOW).active, true);
});

test('expired membership returns the athlete to the free remote tier (no deletion, derivation only)', () => {
  const store = freshStore();
  store.memberships.push({ id: 'mem-1', athleteId: 'ath-1', status: 'expired', priceCents: 14900, startDate: iso(NOW - 60 * DAY), endDate: iso(NOW - DAY) });
  assert.equal(resolveAthleteEntitlements(store, 'ath-1', NOW).tier, 'free');
  store.memberships[0].status = 'active';
  store.memberships[0].endDate = iso(NOW - DAY);
  assert.equal(resolveAthleteEntitlements(store, 'ath-1', NOW).tier, 'free', 'past endDate does not cover');
});
