/* SaaS API tests (development only, synthetic data).
 * Run: node --test server/tests/saas-api.test.js
 *
 * Covers the backend-slice acceptance list: registration + free
 * entitlements, server-side paid-feature refusal, roster caps,
 * RELEASE-BLOCKING cross-tenant isolation on every path, org admin
 * over multiple coaches, subscription cancel/expire by derivation,
 * assignment -> completion -> persistent history, Safety Review
 * rejection, guardian consent gate, in-person member precedence.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MemorySaasStore } = require('../saas-store');
const { createSaasApi } = require('../saas-api');
const { FakeBillingAdapter } = require('../billing');
const { createAccessDirectory } = require('../assessment-access');

const NOW = Date.parse('2026-11-20T12:00:00Z');
const DIRECTOR = { authUserId: 'auth-director', role: 'director' };

function codeOf(fn) {
  try { fn(); } catch (e) { return e.code; }
  return null;
}
async function codeOfAsync(fn) {
  try { await fn(); } catch (e) { return e.code; }
  return null;
}

function freshWorld() {
  const store = new MemorySaasStore();
  const billing = new FakeBillingAdapter(store);
  const api = createSaasApi({ store, billing });
  // Two independent coaches (separate tenants) + one adult athlete each.
  const coachA = api.registerCoach({ authUserId: 'auth-coach-a', role: 'coach' },
    { email: 'a@dev.invalid', name: 'Coach A', now: NOW });
  const coachB = api.registerCoach({ authUserId: 'auth-coach-b', role: 'coach' },
    { email: 'b@dev.invalid', name: 'Coach B', now: NOW });
  const athA = api.registerAthlete({ authUserId: 'auth-ath-a', role: 'athlete' },
    { email: 'atha@dev.invalid', name: 'Athlete A', age: 25, now: NOW });
  const athB = api.registerAthlete({ authUserId: 'auth-ath-b', role: 'athlete' },
    { email: 'athb@dev.invalid', name: 'Athlete B', age: 28, now: NOW });
  const authA = { authUserId: 'auth-coach-a', role: 'coach' };
  const authB = { authUserId: 'auth-coach-b', role: 'coach' };
  api.linkAthlete(authA, { athleteId: athA.athlete.id, now: NOW });
  api.linkAthlete(authB, { athleteId: athB.athlete.id, now: NOW });
  return { store, billing, api, coachA, coachB, athA, athB, authA, authB };
}

test('registration creates the account with the correct role + free entitlements', () => {
  const store = new MemorySaasStore();
  const api = createSaasApi({ store });
  const reg = api.registerAthlete({ authUserId: 'auth-1', role: 'athlete' },
    { email: 'x@dev.invalid', name: 'New Athlete', age: 22, now: NOW });
  assert.equal(reg.appUser.role, 'athlete');
  assert.equal(reg.athlete.appUserId, reg.appUser.id);
  assert.equal(reg.entitlements.tier, 'free');
  assert.equal(reg.entitlements.historyDays, 90);
  // Idempotent re-registration returns the same account.
  const again = api.registerAthlete({ authUserId: 'auth-1', role: 'athlete' },
    { email: 'x@dev.invalid', name: 'New Athlete', age: 22, now: NOW });
  assert.equal(again.alreadyRegistered, true);
  assert.equal(again.athlete.id, reg.athlete.id);
  // Coach registration: coach role + solo tenant + org_admin membership + 14-day trial.
  const coach = api.registerCoach({ authUserId: 'auth-2', role: 'coach' },
    { email: 'c@dev.invalid', name: 'New Coach', now: NOW });
  assert.equal(coach.appUser.role, 'coach');
  assert.equal(coach.organization.kind, 'solo');
  assert.ok(store.isOrgAdmin(coach.appUser.id, coach.organization.id));
  assert.equal(coach.trial.status, 'trialing');
  assert.equal(coach.trial.planCode, 'coach_starter');
  assert.equal(coach.entitlements.active, true);
});

test('unauthenticated and wrong-role calls are refused server-side', () => {
  const { api, athA } = freshWorld();
  assert.equal(codeOf(() => api.myRoster(null, {})), 'UNAUTHENTICATED');
  assert.equal(codeOf(() => api.myRoster({ authUserId: '', role: 'coach' }, {})), 'UNAUTHENTICATED');
  assert.equal(codeOf(() => api.createAssignment({ authUserId: 'auth-ath-a', role: 'athlete' },
    { athleteId: athA.athlete.id, title: 'x' })), 'FORBIDDEN', 'athletes never assign training');
  assert.equal(codeOf(() => api.grantConsent({ authUserId: 'auth-coach-a', role: 'coach' },
    { athleteId: athA.athlete.id, consentVersion: 'v1' })), 'FORBIDDEN', 'coaches never grant consent');
});

test('paid features are refused without entitlement (server-side codes)', () => {
  const { api, store, coachA, authA } = freshWorld();
  // Lapse the coach: trial expired -> read-only.
  const trial = store.subscriptionsFor('coach', coachA.coach.id)[0];
  trial.status = 'expired';
  assert.equal(codeOf(() => api.linkAthlete(authA, { athleteId: 'missing', now: NOW })), 'ATHLETE_NOT_FOUND');
  const extra = api.registerAthlete({ authUserId: 'auth-ath-x', role: 'athlete' },
    { email: 'x@dev.invalid', name: 'Extra', age: 30, now: NOW });
  assert.equal(codeOf(() => api.linkAthlete(authA, { athleteId: extra.athlete.id, now: NOW })),
    'SUBSCRIPTION_INACTIVE', 'lapsed coach cannot add roster athletes');
  // Reads still work (read-only roster).
  const roster = api.myRoster(authA, { now: NOW });
  assert.equal(roster.count, 1);
  // Free athlete: second coach link refused by tier.
  const w = freshWorld();
  const athFree = w.api.registerAthlete({ authUserId: 'auth-free', role: 'athlete' },
    { email: 'f@dev.invalid', name: 'Free Athlete', age: 26, now: NOW });
  w.api.linkAthlete(w.authA, { athleteId: athFree.athlete.id, now: NOW });
  assert.equal(codeOf(() => w.api.linkAthlete(w.authB, { athleteId: athFree.athlete.id, now: NOW })),
    'ENTITLEMENT_LIMIT', 'free athlete tier allows 1 active coach link');
});

test('coach roster cap enforced (Starter 15); soft overage only with explicit confirmation', () => {
  const store = new MemorySaasStore();
  const api = createSaasApi({ store });
  const coach = api.registerCoach({ authUserId: 'auth-cap', role: 'coach' },
    { email: 'cap@dev.invalid', name: 'Cap Coach', now: NOW });
  const auth = { authUserId: 'auth-cap', role: 'coach' };
  for (let i = 0; i < 15; i++) {
    const a = api.registerAthlete({ authUserId: `auth-cap-${i}`, role: 'athlete' },
      { email: `cap${i}@dev.invalid`, name: `Cap Athlete ${i}`, age: 20 + i, now: NOW });
    api.linkAthlete(auth, { athleteId: a.athlete.id, now: NOW });
  }
  assert.equal(api.myRoster(auth, { now: NOW }).count, 15);
  const sixteenth = api.registerAthlete({ authUserId: 'auth-cap-16', role: 'athlete' },
    { email: 'cap16@dev.invalid', name: 'Cap Athlete 16', age: 24, now: NOW });
  assert.equal(codeOf(() => api.linkAthlete(auth, { athleteId: sixteenth.athlete.id, now: NOW })),
    'ENTITLEMENT_LIMIT', '16th athlete exceeds Coach Starter cap of 15');
  const over = api.linkAthlete(auth, { athleteId: sixteenth.athlete.id, now: NOW, confirmOverage: true });
  assert.equal(over.overage, true, 'soft overage recorded when explicitly confirmed');
  assert.equal(api.myRoster(auth, { now: NOW }).count, 16);
});

test('RELEASE-BLOCKING: cross-tenant isolation — Coach A cannot read/write Coach B athletes on ANY path', async () => {
  const { api, store, athA, athB, authA, authB } = freshWorld();
  const bId = athB.athlete.id;
  // Reads: existence does not leak.
  assert.equal(codeOf(() => api.listAssignments(authA, { athleteId: bId })), 'ATHLETE_NOT_FOUND');
  assert.equal(await codeOfAsync(() => api.athleteHistory(authA, { athleteId: bId, now: NOW })), 'ATHLETE_NOT_FOUND');
  assert.equal(codeOf(() => api.myEntitlements(authA, { athleteId: bId, now: NOW })), 'ATHLETE_NOT_FOUND');
  // Writes.
  assert.equal(codeOf(() => api.createAssignment(authA, { athleteId: bId, title: 'x', gameIds: ['TP2-001'], now: NOW })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.sponsorAthlete(authA, { athleteId: bId, now: NOW })), 'FORBIDDEN');
  // Roster enumeration: B's athlete never appears for A.
  const rosterA = api.myRoster(authA, { now: NOW });
  assert.deepEqual(rosterA.athletes.map(r => r.athlete.id), [athA.athlete.id]);
  // Unlink across tenants.
  assert.equal(codeOf(() => api.unlinkAthlete(authA, { athleteId: bId, now: NOW })), 'ATHLETE_NOT_FOUND');
  // Athlete B cannot complete Athlete A's assignment.
  const { assignment } = api.createAssignment(authA,
    { athleteId: athA.athlete.id, title: 'A work', gameIds: ['TP2-001'], now: NOW });
  assert.equal(codeOf(() => api.completeAssignment({ authUserId: 'auth-ath-b', role: 'athlete' },
    { assignmentId: assignment.id, now: NOW })), 'FORBIDDEN');
  // Assessment directory layer: link scope does not leak either.
  const directory = createAccessDirectory({
    athletes: [
      { id: athA.athlete.id, age: 25, coachIds: [], guardianUserIds: [], authUserId: 'auth-ath-a' },
      { id: bId, age: 28, coachIds: [], guardianUserIds: [], authUserId: 'auth-ath-b' },
    ],
    coachAuth: { 'auth-coach-a': store.coachByUserId(store.appUserByAuthId('auth-coach-a').id).id },
    links: store.links,
    orgMemberships: [],
  });
  const coachAAuth = { authUserId: 'auth-coach-a', role: 'coach', coachId: store.coachByUserId(store.appUserByAuthId('auth-coach-a').id).id };
  assert.equal(directory.canAssess(coachAAuth, athA.athlete.id), true, 'linked athlete is assessable');
  assert.equal(directory.canAssess(coachAAuth, bId), false, 'other tenant athlete is not assessable');
  assert.equal(directory.canView(coachAAuth, bId), false);
  assert.deepEqual(directory.listAthletes(coachAAuth).map(a => a.id), [athA.athlete.id]);
  // And Coach B's own paths still work.
  assert.equal(api.myRoster(authB, { now: NOW }).count, 1);
});

test('org admin manages multiple coaches; coaches see only their own athletes', () => {
  const store = new MemorySaasStore();
  const api = createSaasApi({ store });
  const founder = api.registerCoach({ authUserId: 'auth-founder', role: 'coach' },
    { email: 'f@dev.invalid', name: 'Founder', now: NOW });
  const founderAuth = { authUserId: 'auth-founder', role: 'org_admin' };
  const { organization } = api.createOrganization(founderAuth,
    { name: 'Test Academy', kind: 'academy', now: NOW });
  // Founder (now org_admin) invites a second coach.
  const { token } = api.inviteToOrg(founderAuth, { organizationId: organization.id, email: 'c2@dev.invalid', now: NOW });
  api.registerCoach({ authUserId: 'auth-coach2', role: 'coach' }, { email: 'c2@dev.invalid', name: 'Coach Two', now: NOW });
  const accepted = api.acceptInvitation({ authUserId: 'auth-coach2', role: 'coach' }, { token, now: NOW });
  assert.equal(accepted.organization.id, organization.id);
  // Token is single-use and stored hashed only.
  assert.equal(codeOf(() => api.acceptInvitation({ authUserId: 'auth-coach2', role: 'coach' }, { token, now: NOW })),
    'INVITATION_INVALID');
  assert.ok(store.invitations.every(i => !('token' in i) && i.tokenHash.length === 64), 'only SHA-256 hashes stored');
  // Each coach links their own athlete inside the org.
  const a1 = api.registerAthlete({ authUserId: 'auth-oa1', role: 'athlete' }, { email: 'oa1@dev.invalid', name: 'Org Athlete 1', age: 21, now: NOW });
  const a2 = api.registerAthlete({ authUserId: 'auth-oa2', role: 'athlete' }, { email: 'oa2@dev.invalid', name: 'Org Athlete 2', age: 23, now: NOW });
  const coach2Auth = { authUserId: 'auth-coach2', role: 'coach' };
  // Founder coaches a1 under the org (org trial covers the roster).
  const founderCoach = store.coachByUserId(founder.appUser.id);
  api.linkAthlete(DIRECTOR, { coachId: founderCoach.id, athleteId: a1.athlete.id, organizationId: organization.id, now: NOW });
  api.linkAthlete(coach2Auth, { athleteId: a2.athlete.id, organizationId: organization.id, now: NOW });
  // Org admin sees the whole org; coach2 sees only their own.
  const overview = api.orgOverview(founderAuth, { organizationId: organization.id, now: NOW });
  assert.equal(overview.athleteCount, 2);
  assert.equal(overview.coaches.length, 2);
  const roster2 = api.myRoster(coach2Auth, { now: NOW });
  assert.deepEqual(roster2.athletes.map(r => r.athlete.id), [a2.athlete.id]);
  assert.equal(codeOf(() => api.listAssignments(coach2Auth, { athleteId: a1.athlete.id })), 'ATHLETE_NOT_FOUND',
    'org membership alone grants a coach nothing over another coach\'s athlete');
});

test('subscription cancel/expire updates entitlements by derivation (no deletion)', () => {
  const { api, store, billing, athA } = freshWorld();
  const checkout = billing.createCheckoutSession({ ownerType: 'athlete', ownerId: athA.athlete.id, planCode: 'athlete_remote', interval: 'month', now: NOW });
  const { subscription } = billing.confirmCheckout(checkout.sessionId, { now: NOW });
  const athleteAuth = { authUserId: 'auth-ath-a', role: 'athlete' };
  assert.equal(api.myEntitlements(athleteAuth, { now: NOW }).entitlements.tier, 'paid');
  api.cancelSubscription(athleteAuth, { subscriptionId: subscription.id, atPeriodEnd: true, now: NOW });
  assert.equal(api.myEntitlements(athleteAuth, { now: NOW }).entitlements.tier, 'paid', 'access until period end');
  const later = NOW + 31 * 24 * 60 * 60 * 1000;
  assert.equal(api.myEntitlements(athleteAuth, { now: later }).entitlements.tier, 'free', 'derived to free after period end');
  assert.ok(store.subscriptions.has(subscription.id), 'subscription row retained, never deleted');
  api.expireSubscription(DIRECTOR, { subscriptionId: subscription.id, now: NOW });
  assert.equal(api.myEntitlements(athleteAuth, { now: NOW }).entitlements.tier, 'free');
});

test('assignment -> completion -> persistent history (join, nothing copied)', async () => {
  const store = new MemorySaasStore();
  const api = createSaasApi({
    store,
    assessmentHistory: async (athleteId) => [{ sessionId: 'sess-1', battery: 'generalAthleticAssessment', completedAt: new Date(NOW - 1000).toISOString(), results: [] }],
  });
  const coach = api.registerCoach({ authUserId: 'auth-hc', role: 'coach' }, { email: 'hc@dev.invalid', name: 'Hist Coach', now: NOW });
  const ath = api.registerAthlete({ authUserId: 'auth-ha', role: 'athlete' }, { email: 'ha@dev.invalid', name: 'Hist Athlete', age: 24, now: NOW });
  const coachAuth = { authUserId: 'auth-hc', role: 'coach' };
  const athAuth = { authUserId: 'auth-ha', role: 'athlete' };
  api.linkAthlete(coachAuth, { athleteId: ath.athlete.id, now: NOW });
  const { assignment } = api.createAssignment(coachAuth, {
    athleteId: ath.athlete.id, title: 'Speed day', gameIds: ['TP2-001', 'TP2-003'],
    build: 'COMPETE', dose: { rounds: 4, workSec: 30, restSec: 60 }, now: NOW,
  });
  assert.equal(assignment.status, 'assigned');
  assert.deepEqual(assignment.gameIds, ['TP2-001', 'TP2-003']);
  assert.equal(assignment.dose.rounds, 4);
  const { completion } = api.completeAssignment(athAuth,
    { assignmentId: assignment.id, durationMin: 25, effortRpe: 7, athleteNote: 'felt fast', now: NOW });
  assert.equal(completion.effortRpe, 7);
  assert.equal(codeOf(() => api.completeAssignment(athAuth, { assignmentId: assignment.id, now: NOW })), 'ALREADY_COMPLETED');
  const history = await api.athleteHistory(athAuth, { now: NOW });
  assert.equal(history.completions.length, 1);
  assert.equal(history.assignments.length, 1);
  assert.equal(history.assessments.length, 1, 'assessment history joins by athlete, not copied');
  assert.equal(history.assignments[0].status, 'completed');
  // Coach sees the same joined history for their linked athlete.
  const coachView = await api.athleteHistory(coachAuth, { athleteId: ath.athlete.id, now: NOW });
  assert.equal(coachView.completions.length, 1);
});

test('Safety Review / Retired games are rejected server-side; unknown IDs too', () => {
  const { api, athA, authA } = freshWorld();
  for (const gid of ['TP2-084', 'TP2-090', 'TP2-092', 'TP2-093', 'TP2-098', 'TP2-125']) {
    assert.equal(codeOf(() => api.createAssignment(authA,
      { athleteId: athA.athlete.id, title: 'x', gameIds: [gid], now: NOW })), 'GAME_NOT_ASSIGNABLE', gid);
  }
  assert.equal(codeOf(() => api.createAssignment(authA,
    { athleteId: athA.athlete.id, title: 'x', gameIds: ['TP2-999'], now: NOW })), 'INVALID_GAME_ID');
  assert.equal(codeOf(() => api.createAssignment(authA,
    { athleteId: athA.athlete.id, title: 'x', gameIds: ['not-a-game'], now: NOW })), 'INVALID_GAME_ID');
  assert.equal(codeOf(() => api.createAssignment(authA,
    { athleteId: athA.athlete.id, title: 'x', gameIds: ['TP2-001'], build: 'EXTREME', now: NOW })), 'INVALID_INPUT');
});

test('guardian consent gate blocks remote activation for minors without consent; adults bypass', async () => {
  const store = new MemorySaasStore();
  const api = createSaasApi({ store });
  api.registerCoach({ authUserId: 'auth-gc', role: 'coach' }, { email: 'gc@dev.invalid', name: 'Gate Coach', now: NOW });
  const coachAuth = { authUserId: 'auth-gc', role: 'coach' };
  const minor = api.registerAthlete({ authUserId: 'auth-minor', role: 'athlete' },
    { email: 'm@dev.invalid', name: 'Minor Athlete', age: 12, now: NOW });
  // No consent yet: link activation refused.
  assert.equal(codeOf(() => api.linkAthlete(coachAuth, { athleteId: minor.athlete.id, now: NOW })), 'CONSENT_REQUIRED');
  // Guardian registers and is linked (director attaches the guardian record).
  const parent = { id: store.newId(), authUserId: 'auth-parent', email: 'p@dev.invalid', role: 'parent' };
  store.appUsers.set(parent.id, parent);
  const guardian = { id: store.newId(), userId: parent.id };
  store.guardians.set(guardian.id, guardian);
  store.athleteGuardians.push({ athleteId: minor.athlete.id, guardianId: guardian.id });
  const parentAuth = { authUserId: 'auth-parent', role: 'parent' };
  api.grantConsent(parentAuth, { athleteId: minor.athlete.id, consentVersion: 'v1', now: NOW });
  assert.equal(store.consents.length, 1);
  // Now the link activates and assignments flow.
  api.linkAthlete(coachAuth, { athleteId: minor.athlete.id, now: NOW });
  const { assignment } = api.createAssignment(coachAuth,
    { athleteId: minor.athlete.id, title: 'Youth work', gameIds: ['TP2-002'], now: NOW });
  // Withdrawal re-gates immediately; history retained.
  api.withdrawConsent(parentAuth, { athleteId: minor.athlete.id, now: NOW });
  assert.equal(store.consents.length, 2, 'append-only: withdrawal is a new row');
  assert.equal(codeOf(() => api.completeAssignment({ authUserId: 'auth-minor', role: 'athlete' },
    { assignmentId: assignment.id, now: NOW })), 'CONSENT_REQUIRED');
  assert.equal(await codeOfAsync(() => api.athleteHistory({ authUserId: 'auth-minor', role: 'athlete' }, { now: NOW })), 'CONSENT_REQUIRED');
  assert.ok(store.assignments.has(assignment.id), 'data retained while gated');
  // Adults never hit the gate.
  const adult = api.registerAthlete({ authUserId: 'auth-adult', role: 'athlete' },
    { email: 'ad@dev.invalid', name: 'Adult Athlete', age: 48, now: NOW });
  api.linkAthlete(coachAuth, { athleteId: adult.athlete.id, now: NOW });
  const ok = api.createAssignment(coachAuth, { athleteId: adult.athlete.id, title: 'Adult work', gameIds: ['TP2-001'], now: NOW });
  assert.equal(ok.assignment.status, 'assigned');
});

test('in-person $149 member gets full remote access with no second charge', () => {
  const { api, store, billing, athA } = freshWorld();
  store.memberships.push({
    id: 'mem-a', athleteId: athA.athlete.id, status: 'active', priceCents: 14900,
    startDate: new Date(NOW - 1000).toISOString(), endDate: null,
  });
  const ent = api.myEntitlements({ authUserId: 'auth-ath-a', role: 'athlete' }, { now: NOW }).entitlements;
  assert.equal(ent.tier, 'member');
  assert.equal(ent.fullHistory, true);
  assert.equal(codeOf(() => billing.createCheckoutSession(
    { ownerType: 'athlete', ownerId: athA.athlete.id, planCode: 'athlete_remote', now: NOW })), 'ALREADY_COVERED');
});

test('free-tier history display window truncates display, never deletes rows', async () => {
  const store = new MemorySaasStore();
  const old = NOW - 200 * 24 * 60 * 60 * 1000;
  const api = createSaasApi({ store });
  api.registerCoach({ authUserId: 'auth-wc', role: 'coach' }, { email: 'wc@dev.invalid', name: 'Window Coach', now: old });
  const ath = api.registerAthlete({ authUserId: 'auth-wa', role: 'athlete' }, { email: 'wa@dev.invalid', name: 'Window Athlete', age: 30, now: old });
  const coachAuth = { authUserId: 'auth-wc', role: 'coach' };
  const athAuth = { authUserId: 'auth-wa', role: 'athlete' };
  api.linkAthlete(coachAuth, { athleteId: ath.athlete.id, now: old });
  const { assignment } = api.createAssignment(coachAuth, { athleteId: ath.athlete.id, title: 'Old work', gameIds: ['TP2-001'], now: old });
  api.completeAssignment(athAuth, { assignmentId: assignment.id, completedAt: new Date(old).toISOString(), now: old });
  const history = await api.athleteHistory(athAuth, { now: NOW });
  assert.equal(history.completions.length, 0, 'outside the 90-day free window');
  assert.equal(history.truncated, true);
  assert.equal(store.completions.size, 1, 'row retained');
});
