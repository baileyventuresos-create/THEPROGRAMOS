/* Athlete Pathways V1 — prospect profiles, sharing, CRM, media (G3/G4/G5).
 * Run: node --test server/tests/pathways-profiles-crm.test.js
 * Synthetic data only, in-memory store. Pins: profile approval
 * needs athlete + coach (+ guardian consent for minors); public
 * reads expose only approved public fields; revoked/expired shares
 * refuse; CRM CRUD + referral transitions; media is URL-only;
 * Coach A cannot touch Coach B's athletes/profiles/contacts.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MemorySaasStore } = require('../saas-store');
const { createSaasApi } = require('../saas-api');

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
  const api = createSaasApi({ store });
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
  const athAuthA = { authUserId: 'auth-ath-a', role: 'athlete' };
  api.linkAthlete(authA, { athleteId: athA.athlete.id, now: NOW });
  api.linkAthlete(authB, { athleteId: athB.athlete.id, now: NOW });
  return { store, api, coachA, coachB, athA, athB, authA, authB, athAuthA };
}

function makeProfile(api, authA, athleteId, extra = {}) {
  return api.createProspectProfile(authA, {
    athleteId, primarySport: 'soccer', bio: 'Fictional prospect.',
    positions: ['midfielder'], measurements: { heightCm: 175 },
    accomplishments: ['League finalist (fictional)'],
    contactInfo: { email: 'private@dev.invalid', phone: '555-0000' },
    now: NOW, ...extra,
  }).profile;
}

function approveBoth(api, authA, athAuth, profileId) {
  api.approveProspectProfile(authA, { profileId, approval: 'coach', now: NOW });
  return api.approveProspectProfile(athAuth, { profileId, approval: 'athlete', now: NOW });
}

test('profile approval requires BOTH athlete and coach approval', () => {
  const { api, athA, authA, athAuthA } = freshWorld();
  const profile = makeProfile(api, authA, athA.athlete.id);
  assert.equal(profile.status, 'draft');
  const afterCoach = api.approveProspectProfile(authA, { profileId: profile.id, approval: 'coach', now: NOW });
  assert.equal(afterCoach.profile.status, 'pending_approval', 'coach alone is not enough');
  const afterAthlete = api.approveProspectProfile(athAuthA, { profileId: profile.id, approval: 'athlete', now: NOW });
  assert.equal(afterAthlete.profile.status, 'approved', 'both approvals approve');
  // Athlete approval alone (second athlete's profile) is also not enough.
  const w2 = freshWorld();
  const p2 = w2.api.createProspectProfile(w2.authB, {
    athleteId: w2.athB.athlete.id, primarySport: 'basketball', now: NOW,
  }).profile;
  const athBAuth = { authUserId: 'auth-ath-b', role: 'athlete' };
  const onlyAthlete = w2.api.approveProspectProfile(athBAuth,
    { profileId: p2.id, approval: 'athlete', now: NOW });
  assert.equal(onlyAthlete.profile.status, 'pending_approval', 'athlete alone is not enough');
});

test('a minor profile additionally requires a guardian-consent row', () => {
  const { store, api, authA } = freshWorld();
  const minor = api.registerAthlete({ authUserId: 'auth-minor', role: 'athlete' },
    { email: 'minor@dev.invalid', name: 'Minor Athlete', age: 15, now: NOW });
  // Director grants consent on the minor's behalf path is via
  // grantConsent; link first (consent gate needs it for linking).
  api.grantConsent(DIRECTOR, { athleteId: minor.athlete.id, consentVersion: 'v1', now: NOW });
  api.linkAthlete(authA, { athleteId: minor.athlete.id, now: NOW });
  const profile = makeProfile(api, authA, minor.athlete.id);
  // Withdraw consent: latest row is withdrawn, so approval must refuse.
  api.withdrawConsent(DIRECTOR, { athleteId: minor.athlete.id, now: NOW });
  assert.equal(store.hasConsent(minor.athlete.id), false);
  const minorAuth = { authUserId: 'auth-minor', role: 'athlete' };
  api.approveProspectProfile(authA, { profileId: profile.id, approval: 'coach', now: NOW });
  assert.equal(codeOf(() => api.approveProspectProfile(minorAuth,
    { profileId: profile.id, approval: 'athlete', now: NOW })), 'CONSENT_REQUIRED');
  // Re-grant consent: the same two approvals now complete.
  api.grantConsent(DIRECTOR, { athleteId: minor.athlete.id, consentVersion: 'v1', now: NOW });
  const done = api.approveProspectProfile(minorAuth, { profileId: profile.id, approval: 'athlete', now: NOW });
  assert.equal(done.profile.status, 'approved');
  assert.ok(done.profile.guardianConsentId, 'consent row recorded on the profile');
});

test('public profile exposes only approved public fields', () => {
  const { api, athA, authA, athAuthA } = freshWorld();
  const profile = makeProfile(api, authA, athA.athlete.id);
  approveBoth(api, authA, athAuthA, profile.id);
  api.addMediaLink(authA, { profileId: profile.id, kind: 'highlight', url: 'https://example.invalid/clip', title: 'Clip', now: NOW });
  const { token } = api.createProfileShare(authA, { profileId: profile.id, now: NOW });
  const pub = api.getPublicProfile({ token, now: NOW });
  const p = pub.profile;
  assert.equal(p.bio, 'Fictional prospect.');
  assert.equal(p.athleteName, 'Athlete A', 'adult with both approvals: name visible');
  assert.equal(p.primarySport, 'soccer');
  assert.deepEqual(p.positions, ['midfielder']);
  assert.equal(p.mediaLinks.length, 1);
  assert.equal(p.mediaLinks[0].url, 'https://example.invalid/clip');
  const flat = JSON.stringify(pub);
  assert.ok(!flat.includes('private@dev.invalid'), 'contact email never exposed');
  assert.ok(!flat.includes('555-0000'), 'contact phone never exposed');
  assert.ok(!('contactInfo' in p), 'no contactInfo key on the public view');
});

test('name display: minor with consent shows name; withdrawn consent hides it again', () => {
  const { store, api, authA } = freshWorld();
  const minor = api.registerAthlete({ authUserId: 'auth-minor', role: 'athlete' },
    { email: 'minor@dev.invalid', name: 'Minor Athlete', age: 15, now: NOW });
  api.grantConsent(DIRECTOR, { athleteId: minor.athlete.id, consentVersion: 'v1', now: NOW });
  api.linkAthlete(authA, { athleteId: minor.athlete.id, now: NOW });
  const profile = makeProfile(api, authA, minor.athlete.id);
  const minorAuth = { authUserId: 'auth-minor', role: 'athlete' };
  approveBoth(api, authA, minorAuth, profile.id);
  const { token } = api.createProfileShare(authA, { profileId: profile.id, now: NOW });
  assert.equal(api.getPublicProfile({ token, now: NOW }).profile.athleteName, 'Minor Athlete',
    'minor with live guardian consent: name visible');
  // Consent withdrawn after approval: the share still works, the
  // name does not — the gate is re-checked on every public read.
  api.withdrawConsent(DIRECTOR, { athleteId: minor.athlete.id, now: NOW });
  assert.equal(store.hasConsent(minor.athlete.id), false);
  const pub = api.getPublicProfile({ token, now: NOW });
  assert.equal(pub.profile.athleteName, null, 'withdrawn consent hides the name');
  assert.equal(pub.profile.bio, 'Fictional prospect.', 'other public fields still served');
  assert.ok(!JSON.stringify(pub).includes('Minor Athlete'), 'name string nowhere in the payload');
});

test('name display: approval absent or revoked never leaks a name', () => {
  const { api, athA, authA, athAuthA } = freshWorld();
  const profile = makeProfile(api, authA, athA.athlete.id);
  approveBoth(api, authA, athAuthA, profile.id);
  const { token } = api.createProfileShare(authA, { profileId: profile.id, now: NOW });
  assert.equal(api.getPublicProfile({ token, now: NOW }).profile.athleteName, 'Athlete A');
  // Editing an approved profile re-opens it (approvals cleared):
  // the public read refuses outright, so no name can leak.
  api.updateProspectProfile(authA, { profileId: profile.id, bio: 'Edited bio.', now: NOW });
  assert.equal(codeOf(() => api.getPublicProfile({ token, now: NOW })), 'PROFILE_NOT_APPROVED');
});

test('revoked and expired shares refuse; unapproved profiles cannot be shared', () => {
  const { api, athA, authA, athAuthA } = freshWorld();
  const profile = makeProfile(api, authA, athA.athlete.id);
  assert.equal(codeOf(() => api.createProfileShare(authA, { profileId: profile.id, now: NOW })),
    'PROFILE_NOT_APPROVED', 'draft profiles cannot be shared');
  approveBoth(api, authA, athAuthA, profile.id);
  const { token } = api.createProfileShare(authA, { profileId: profile.id, now: NOW });
  const shares = api.listProfileShares(authA, { profileId: profile.id });
  api.revokeProfileShare(authA, { shareId: shares.shares[0].id, now: NOW });
  assert.equal(codeOf(() => api.getPublicProfile({ token, now: NOW })), 'PROFILE_SHARE_INVALID');
  // Expired share: a second share whose expiry is moved into the past.
  const second = api.createProfileShare(authA,
    { profileId: profile.id, expiresAt: iso(NOW + 7 * DAY), now: NOW });
  assert.equal(codeOf(() => api.getPublicProfile({ token: second.token, now: NOW + 8 * DAY })),
    'PROFILE_SHARE_INVALID', 'expired share refuses');
  assert.equal(codeOf(() => api.getPublicProfile({ token: 'deadbeef', now: NOW })),
    'PROFILE_SHARE_INVALID', 'unknown token refuses');
});

test('tenant isolation: Coach B cannot touch Coach A athlete profiles or shares', () => {
  const { api, athA, authA, authB, athAuthA } = freshWorld();
  const profile = makeProfile(api, authA, athA.athlete.id);
  assert.equal(codeOf(() => api.createProspectProfile(authB,
    { athleteId: athA.athlete.id, primarySport: 'soccer', now: NOW })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.getProspectProfile(authB, { profileId: profile.id })), 'ATHLETE_NOT_FOUND');
  assert.equal(codeOf(() => api.updateProspectProfile(authB,
    { profileId: profile.id, bio: 'Hijack', now: NOW })), 'FORBIDDEN');
  approveBoth(api, authA, athAuthA, profile.id);
  assert.equal(codeOf(() => api.createProfileShare(authB, { profileId: profile.id, now: NOW })), 'FORBIDDEN');
});

test('CRM: contact CRUD, opportunity, note, referral status transitions', () => {
  const { api, athA, authA, authB } = freshWorld();
  const { contact } = api.createRecruitmentContact(authA, {
    orgName: 'Fictional State University', sport: 'soccer', league: 'NCAA',
    level: 'collegiate', region: 'WA', contactName: 'Coach Fictional',
    email: 'recruit@dev.invalid', now: NOW,
  });
  assert.equal(contact.status, 'new');
  assert.equal(codeOf(() => api.createRecruitmentContact(authA,
    { orgName: 'Bad Level', level: 'pro', now: NOW })), 'INVALID_INPUT');
  const updated = api.updateRecruitmentContact(authA,
    { contactId: contact.id, status: 'contacted', now: NOW });
  assert.equal(updated.contact.status, 'contacted');
  const opp = api.createOpportunity(authA,
    { contactId: contact.id, type: 'tryout', date: '2026-12-05', notes: 'Fictional tryout.', now: NOW });
  assert.equal(opp.opportunity.type, 'tryout');
  assert.equal(codeOf(() => api.createOpportunity(authA,
    { contactId: contact.id, type: 'signing', now: NOW })), 'INVALID_INPUT');
  const note = api.addRecruitmentNote(authA,
    { contactId: contact.id, body: 'Called; left message.', followUpDate: '2026-12-01', now: NOW });
  assert.equal(note.note.followUpDate, '2026-12-01');
  const { referral } = api.referAthlete(authA,
    { contactId: contact.id, athleteId: athA.athlete.id, now: NOW });
  assert.equal(referral.status, 'referred');
  for (const status of ['contacted', 'evaluating', 'offered']) {
    const r = api.updateReferralStatus(authA, { referralId: referral.id, status, now: NOW });
    assert.equal(r.referral.status, status);
  }
  assert.equal(codeOf(() => api.updateReferralStatus(authA,
    { referralId: referral.id, status: 'signed', now: NOW })), 'INVALID_INPUT');
  // Coach B sees none of Coach A's contacts and cannot act on them.
  assert.equal(api.listRecruitmentContacts(authB, {}).count, 0);
  assert.equal(codeOf(() => api.updateRecruitmentContact(authB,
    { contactId: contact.id, status: 'declined', now: NOW })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.referAthlete(authB,
    { contactId: contact.id, athleteId: athA.athlete.id, now: NOW })), 'FORBIDDEN');
  const mine = api.listRecruitmentContacts(authA, { level: 'collegiate', region: 'WA' });
  assert.equal(mine.count, 1);
});

test('G1: list methods return what was created; empty lists return empty, not errors', () => {
  const { api, athA, authA } = freshWorld();
  const { contact } = api.createRecruitmentContact(authA, {
    orgName: 'Fictional State University', sport: 'soccer', league: 'NCAA',
    level: 'collegiate', region: 'WA', contactName: 'Coach Fictional',
    email: 'recruit@dev.invalid', now: NOW,
  });
  const opp = api.createOpportunity(authA,
    { contactId: contact.id, type: 'tryout', date: '2026-12-05', notes: 'Fictional tryout.', now: NOW });
  const note = api.addRecruitmentNote(authA,
    { contactId: contact.id, body: 'Called; left message.', followUpDate: '2026-12-01', now: NOW });
  const { referral } = api.referAthlete(authA,
    { contactId: contact.id, athleteId: athA.athlete.id, now: NOW });

  const opps = api.listOpportunities(authA, { contactId: contact.id });
  assert.equal(opps.count, 1);
  assert.equal(opps.opportunities[0].id, opp.opportunity.id);
  assert.equal(opps.opportunities[0].type, 'tryout');
  assert.equal(opps.opportunities[0].organization, 'Fictional State University');

  const notes = api.listRecruitmentNotes(authA, { contactId: contact.id });
  assert.equal(notes.count, 1);
  assert.equal(notes.notes[0].id, note.note.id);
  assert.equal(notes.notes[0].body, 'Called; left message.');

  const refs = api.listReferrals(authA, { contactId: contact.id });
  assert.equal(refs.count, 1);
  assert.equal(refs.referrals[0].id, referral.id);
  assert.equal(refs.referrals[0].status, 'referred');
  assert.equal(refs.referrals[0].organization, 'Fictional State University');

  // No-filter coach reads return the same rows (own contacts only).
  assert.equal(api.listOpportunities(authA, {}).count, 1);
  assert.equal(api.listRecruitmentNotes(authA, {}).count, 1);
  assert.equal(api.listReferrals(authA, {}).count, 1);

  // A contact with nothing attached reads back empty, not an error.
  const empty = api.createRecruitmentContact(authA, { orgName: 'Empty College', now: NOW }).contact;
  assert.deepEqual(api.listOpportunities(authA, { contactId: empty.id }), { opportunities: [], count: 0 });
  assert.deepEqual(api.listRecruitmentNotes(authA, { contactId: empty.id }), { notes: [], count: 0 });
  assert.deepEqual(api.listReferrals(authA, { contactId: empty.id }), { referrals: [], count: 0 });

  // Unknown contact is an input error, not an empty list.
  assert.equal(codeOf(() => api.listOpportunities(authA, { contactId: 'no-such-contact' })), 'INVALID_INPUT');
  assert.equal(codeOf(() => api.listRecruitmentNotes(authA, { contactId: 'no-such-contact' })), 'INVALID_INPUT');
  assert.equal(codeOf(() => api.listReferrals(authA, { contactId: 'no-such-contact' })), 'INVALID_INPUT');
});

test('G1: cross-coach isolation on list reads; director sees all; notes stay coach-side', () => {
  const { api, athA, authA, authB } = freshWorld();
  const { contact } = api.createRecruitmentContact(authA, {
    orgName: 'Fictional State University', sport: 'soccer', now: NOW,
  });
  api.createOpportunity(authA, { contactId: contact.id, type: 'tryout', now: NOW });
  api.addRecruitmentNote(authA, { contactId: contact.id, body: 'Private note.', now: NOW });
  api.referAthlete(authA, { contactId: contact.id, athleteId: athA.athlete.id, now: NOW });

  // Coach B cannot read Coach A's contact items, by id or by listing.
  assert.equal(codeOf(() => api.listOpportunities(authB, { contactId: contact.id })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.listRecruitmentNotes(authB, { contactId: contact.id })), 'FORBIDDEN');
  assert.equal(codeOf(() => api.listReferrals(authB, { contactId: contact.id })), 'FORBIDDEN');
  assert.equal(api.listOpportunities(authB, {}).count, 0);
  assert.equal(api.listRecruitmentNotes(authB, {}).count, 0);
  assert.equal(api.listReferrals(authB, {}).count, 0);

  // Director sees everything.
  assert.equal(api.listOpportunities(DIRECTOR, {}).count, 1);
  assert.equal(api.listRecruitmentNotes(DIRECTOR, {}).count, 1);
  assert.equal(api.listReferrals(DIRECTOR, {}).count, 1);
  assert.equal(api.listOpportunities(DIRECTOR, { contactId: contact.id }).count, 1);

  // Recruitment notes are coach/director-only: athletes may not list them.
  const athAuthA = { authUserId: 'auth-ath-a', role: 'athlete' };
  assert.equal(codeOf(() => api.listRecruitmentNotes(athAuthA, { contactId: contact.id })), 'FORBIDDEN');
});

test('G1: athlete reads only their own referrals and opportunities', () => {
  const { api, athA, athB, authA } = freshWorld();
  const athAuthA = { authUserId: 'auth-ath-a', role: 'athlete' };
  const athAuthB = { authUserId: 'auth-ath-b', role: 'athlete' };
  const { contact } = api.createRecruitmentContact(authA, {
    orgName: 'Fictional State University', sport: 'soccer', now: NOW,
  });
  api.createOpportunity(authA, { contactId: contact.id, type: 'tryout', date: '2026-12-05', now: NOW });
  api.referAthlete(authA, { contactId: contact.id, athleteId: athA.athlete.id, now: NOW });
  // A second contact with an opportunity but NO referral for Athlete A.
  const other = api.createRecruitmentContact(authA, { orgName: 'Unreferred College', now: NOW }).contact;
  api.createOpportunity(authA, { contactId: other.id, type: 'combine', now: NOW });

  // Own referrals, by athlete and by contact.
  const mine = api.listReferrals(athAuthA, { athleteId: athA.athlete.id });
  assert.equal(mine.count, 1);
  assert.equal(mine.referrals[0].athleteId, athA.athlete.id);
  assert.equal(api.listReferrals(athAuthA, { contactId: contact.id }).count, 1);
  assert.equal(api.listReferrals(athAuthA, {}).count, 1);
  // Another athlete's id is a cross-tenant read, never a leak.
  assert.equal(codeOf(() => api.listReferrals(athAuthA, { athleteId: athB.athlete.id })), 'ATHLETE_NOT_FOUND');
  assert.equal(codeOf(() => api.listOpportunities(athAuthA, { athleteId: athB.athlete.id })), 'ATHLETE_NOT_FOUND');

  // Opportunities: only on contacts the athlete was referred to.
  const opps = api.listOpportunities(athAuthA, { athleteId: athA.athlete.id });
  assert.equal(opps.count, 1);
  assert.equal(opps.opportunities[0].type, 'tryout');
  assert.equal(opps.opportunities[0].organization, 'Fictional State University');
  assert.equal(api.listOpportunities(athAuthA, { contactId: contact.id }).count, 1);
  assert.equal(api.listOpportunities(athAuthA, {}).count, 1);

  // Athlete B was referred to nothing: empty everywhere, never A's rows.
  assert.equal(api.listReferrals(athAuthB, {}).count, 0);
  assert.equal(api.listOpportunities(athAuthB, {}).count, 0);
  assert.equal(api.listReferrals(athAuthB, { contactId: contact.id }).count, 0);
  assert.equal(api.listOpportunities(athAuthB, { contactId: contact.id }).count, 0);
});

test('media links are URL-only: non-URLs refused, no upload path exists', () => {
  const { api, athA, authA, athAuthA } = freshWorld();
  const profile = makeProfile(api, authA, athA.athlete.id);
  approveBoth(api, authA, athAuthA, profile.id);
  assert.equal(codeOf(() => api.addMediaLink(authA,
    { profileId: profile.id, kind: 'highlight', url: 'not-a-url', now: NOW })), 'INVALID_INPUT');
  assert.equal(codeOf(() => api.addMediaLink(authA,
    { profileId: profile.id, kind: 'highlight', url: 'ftp://example.invalid/x', now: NOW })), 'INVALID_INPUT');
  assert.equal(codeOf(() => api.addMediaLink(authA,
    { profileId: profile.id, kind: 'video', url: 'https://example.invalid/x', now: NOW })), 'INVALID_INPUT');
  const { mediaLink } = api.addMediaLink(authA,
    { profileId: profile.id, kind: 'full_game', url: 'https://example.invalid/game', title: 'Game', now: NOW });
  assert.equal(mediaLink.approvedBy, 'auth-coach-a', 'coach add = coach-approved');
  assert.equal(api.listMediaLinks(authA, { profileId: profile.id }).mediaLinks.length, 1);
  const removed = api.removeMediaLink(authA, { mediaLinkId: mediaLink.id, now: NOW });
  assert.equal(removed.removed, true);
  assert.equal(api.listMediaLinks(authA, { profileId: profile.id }).mediaLinks.length, 0);
  // Media visibility follows the profile: a removed link never
  // appears on a public read of the approved profile.
  const { token } = api.createProfileShare(authA, { profileId: profile.id, now: NOW });
  const pub = api.getPublicProfile({ token, now: NOW });
  assert.equal(pub.profile.mediaLinks.length, 0, 'removed link is gone from the public view');
});
