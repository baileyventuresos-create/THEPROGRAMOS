/* Athlete Pathways V1 — complimentary access + owner management (G1/G2).
 * Run: node --test server/tests/pathways-complimentary.test.js
 * Synthetic data only, in-memory store. Pins: complimentary is
 * entitlement step (0) above membership/sponsorship/paid/free;
 * checkout refuses complimentary athletes (ALREADY_COVERED);
 * grant/suspend/reactivate/revoke lifecycle + audit rows;
 * director-only enforcement; owner invitation token-hash flow.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { MemorySaasStore } = require('../saas-store');
const { createSaasApi } = require('../saas-api');
const { FakeBillingAdapter } = require('../billing');
const { resolveAthleteEntitlements } = require('../entitlements');

const NOW = Date.parse('2026-11-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const DIRECTOR = { authUserId: 'auth-director', role: 'director' };

function codeOf(fn) {
  try { fn(); } catch (e) { return e.code; }
  return null;
}

function freshWorld() {
  const store = new MemorySaasStore();
  const billing = new FakeBillingAdapter(store);
  const api = createSaasApi({ store, billing });
  const coachA = api.registerCoach({ authUserId: 'auth-coach-a', role: 'coach' },
    { email: 'a@dev.invalid', name: 'Coach A', now: NOW });
  const athA = api.registerAthlete({ authUserId: 'auth-ath-a', role: 'athlete' },
    { email: 'atha@dev.invalid', name: 'Athlete A', age: 25, now: NOW });
  const authA = { authUserId: 'auth-coach-a', role: 'coach' };
  api.linkAthlete(authA, { athleteId: athA.athlete.id, now: NOW });
  return { store, billing, api, coachA, athA, authA };
}

function giveOwnSub(store, athleteId) {
  const s = {
    id: store.newId(), planCode: 'athlete_remote', ownerType: 'athlete', ownerId: athleteId,
    status: 'active', billingInterval: 'month',
    currentPeriodStart: iso(NOW - DAY), currentPeriodEnd: iso(NOW + 29 * DAY),
    cancelAtPeriodEnd: false, provider: 'none',
    providerCustomerId: null, providerSubscriptionId: null,
    createdAt: iso(NOW), updatedAt: iso(NOW),
  };
  store.subscriptions.set(s.id, s);
  return s;
}

test('complimentary beats membership, sponsorship, own subscription, and free', () => {
  const { store, api, coachA, athA } = freshWorld();
  const id = athA.athlete.id;
  giveOwnSub(store, id);
  store.memberships.push({ id: 'mem-1', athleteId: id, status: 'active', startDate: iso(NOW - DAY), endDate: null });
  const coachSub = giveOwnSub(store, coachA.coach.id);
  coachSub.ownerType = 'coach'; coachSub.planCode = 'coach_pro';
  store.sponsorships.push({
    id: 'sp-1', athleteId: id, sponsorType: 'coach', sponsorId: coachA.coach.id,
    subscriptionId: coachSub.id, status: 'active', startedAt: iso(NOW), endedAt: null,
  });
  // Without a grant the membership wins (existing precedence).
  assert.equal(resolveAthleteEntitlements(store, id, NOW).tier, 'member');
  const { grant } = api.grantComplimentary(DIRECTOR, { athleteId: id, reason: 'Founding athlete', now: NOW });
  const ent = resolveAthleteEntitlements(store, id, NOW);
  assert.equal(ent.tier, 'complimentary');
  assert.equal(ent.source, 'complimentary_grant');
  assert.equal(ent.planCode, 'athlete_remote');
  assert.equal(ent.fullHistory, true);
  assert.equal(ent.historyDays, null);
  assert.equal(ent.maxCoachLinks, null);
  assert.equal(ent.grantId, grant.id);
});

test('revoking a grant falls back to the next covering source; an expired grant grants nothing', () => {
  const { store, api, athA } = freshWorld();
  const id = athA.athlete.id;
  store.memberships.push({ id: 'mem-1', athleteId: id, status: 'active', startDate: iso(NOW - DAY), endDate: null });
  const { grant } = api.grantComplimentary(DIRECTOR, { athleteId: id, now: NOW });
  assert.equal(resolveAthleteEntitlements(store, id, NOW).tier, 'complimentary');
  api.revokeComplimentary(DIRECTOR, { grantId: grant.id, now: NOW });
  assert.equal(resolveAthleteEntitlements(store, id, NOW).tier, 'member', 'revoked grant falls back to membership');
  // Expiry: a grant whose expiresAt has passed grants nothing.
  const g2 = api.grantComplimentary(DIRECTOR, { athleteId: id, expiresAt: iso(NOW + 7 * DAY), now: NOW }).grant;
  assert.equal(resolveAthleteEntitlements(store, id, NOW).tier, 'complimentary');
  assert.equal(resolveAthleteEntitlements(store, id, NOW + 8 * DAY).tier, 'member', 'expired grant falls back');
  assert.equal(g2.expiresAt, iso(NOW + 7 * DAY));
});

test('complimentary athletes are refused checkout with ALREADY_COVERED', () => {
  const { billing, api, athA } = freshWorld();
  const id = athA.athlete.id;
  api.grantComplimentary(DIRECTOR, { athleteId: id, now: NOW });
  assert.equal(codeOf(() => billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: id, planCode: 'athlete_remote', now: NOW })),
    'ALREADY_COVERED', 'no double charge for a complimentary athlete');
  // After revocation the same checkout is allowed again.
  const grant = api.ownerListAthletes(DIRECTOR, { now: NOW })
    .athletes.find(a => a.athlete.id === id).complimentaryGrant;
  api.revokeComplimentary(DIRECTOR, { grantId: grant.id, now: NOW });
  const session = billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: id, planCode: 'athlete_remote', now: NOW });
  assert.equal(session.planCode, 'athlete_remote');
});

test('grant / suspend / reactivate / revoke lifecycle writes audit rows', () => {
  const { store, api, athA } = freshWorld();
  const id = athA.athlete.id;
  api.grantComplimentary(DIRECTOR, { athleteId: id, reason: 'Test grant', now: NOW });
  api.suspendAthlete(DIRECTOR, { athleteId: id, reason: 'Test suspension', now: NOW });
  assert.equal(store.athleteById(id).status, 'suspended');
  api.reactivateAthlete(DIRECTOR, { athleteId: id, now: NOW });
  assert.equal(store.athleteById(id).status, 'active');
  const grant = store.activeComplimentaryGrantsFor(id, NOW)[0];
  api.revokeComplimentary(DIRECTOR, { grantId: grant.id, now: NOW });
  assert.equal(store.complimentaryGrantById(grant.id).status, 'revoked');
  const actions = store.auditEvents.map(e => e.action);
  for (const a of ['grant_complimentary', 'suspend_athlete', 'reactivate_athlete', 'revoke_complimentary']) {
    assert.ok(actions.includes(a), `audit row for ${a}`);
  }
  // listAudit is director-only and surfaces the trail.
  const trail = api.listAudit(DIRECTOR, {});
  assert.ok(trail.count >= 4);
  assert.equal(codeOf(() => api.listAudit({ authUserId: 'auth-coach-a', role: 'coach' }, {})), 'FORBIDDEN');
});

test('owner-only enforcement: coach and athlete cannot grant, revoke, suspend, or list', () => {
  const { api, athA, authA } = freshWorld();
  const id = athA.athlete.id;
  const athAuth = { authUserId: 'auth-ath-a', role: 'athlete' };
  assert.equal(codeOf(() => api.grantComplimentary(authA, { athleteId: id, now: NOW })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.grantComplimentary(athAuth, { athleteId: id, now: NOW })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.suspendAthlete(authA, { athleteId: id, now: NOW })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.ownerListAthletes(authA, { now: NOW })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.ownerCreateAthlete(authA, { name: 'Nope', now: NOW })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.revokeComplimentary(authA, { athleteId: id, now: NOW })), 'FORBIDDEN');
});

test('ownerCreateAthlete creates an athlete with no card or subscription; ownerListAthletes shows grant status', () => {
  const { store, api, athA } = freshWorld();
  const created = api.ownerCreateAthlete(DIRECTOR, { name: 'Fictional Owner Athlete', age: 17, now: NOW });
  assert.equal(created.athlete.status, 'active');
  assert.equal(store.subscriptionsFor('athlete', created.athlete.id).length, 0, 'no subscription created');
  api.grantComplimentary(DIRECTOR, { athleteId: athA.athlete.id, now: NOW });
  const list = api.ownerListAthletes(DIRECTOR, { now: NOW });
  assert.equal(list.count, 2);
  const withGrant = list.athletes.find(a => a.athlete.id === athA.athlete.id);
  const withoutGrant = list.athletes.find(a => a.athlete.id === created.athlete.id);
  assert.ok(withGrant.complimentaryGrant, 'grant shown');
  assert.equal(withoutGrant.complimentaryGrant, null, 'no grant shown as null');
  assert.equal(withGrant.entitlements.tier, 'complimentary');
  assert.equal(withoutGrant.entitlements.tier, 'free');
});

test('updateAthleteRole changes the linked account role and audits it', () => {
  const { store, api, athA } = freshWorld();
  const id = athA.athlete.id;
  const out = api.updateAthleteRole(DIRECTOR, { athleteId: id, role: 'parent', now: NOW });
  assert.equal(out.athlete.role, 'parent');
  assert.equal(store.appUserById(athA.appUser.id).role, 'parent');
  assert.ok(store.auditEvents.some(e => e.action === 'update_athlete_role'));
  assert.equal(codeOf(() => api.updateAthleteRole(DIRECTOR, { athleteId: id, role: 'superuser', now: NOW })), 'INVALID_INPUT');
});

test('owner invitation uses the hashed-token pattern, 7-day TTL, no email sent', () => {
  const { store, api } = freshWorld();
  const { invitation, token } = api.ownerInviteAthlete(DIRECTOR,
    { email: 'invite@dev.invalid', now: NOW });
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32, '24-byte token hex');
  assert.equal(invitation.tokenHash, undefined, 'raw hash never returned');
  const stored = store.invitations.find(i => i.id === invitation.id);
  assert.equal(stored.tokenHash, createHash('sha256').update(token).digest('hex'), 'only the hash is stored');
  assert.notEqual(stored.tokenHash, token, 'token itself is never stored');
  assert.equal(stored.status, 'pending');
  assert.equal(stored.expiresAt, iso(NOW + 7 * DAY), '7-day TTL');
  assert.ok(store.auditEvents.some(e => e.action === 'owner_invite_athlete'));
  // A coach may not send owner invitations.
  assert.equal(codeOf(() => api.ownerInviteAthlete(
    { authUserId: 'auth-coach-a', role: 'coach' }, { email: 'x@dev.invalid', now: NOW })), 'FORBIDDEN');
});

test('indefinite grant has null expiresAt; a past expiresAt is refused', () => {
  const { api, athA } = freshWorld();
  const { grant } = api.grantComplimentary(DIRECTOR, { athleteId: athA.athlete.id, now: NOW });
  assert.equal(grant.expiresAt, null, 'null = indefinite');
  const other = api.registerAthlete({ authUserId: 'auth-ath-z', role: 'athlete' },
    { email: 'z@dev.invalid', name: 'Athlete Z', age: 30, now: NOW });
  assert.equal(codeOf(() => api.grantComplimentary(DIRECTOR,
    { athleteId: other.athlete.id, expiresAt: iso(NOW - DAY), now: NOW })), 'INVALID_INPUT');
});
