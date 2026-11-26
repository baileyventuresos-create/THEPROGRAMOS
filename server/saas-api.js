/* THE PROGRAM OS — SaaS API (accounts, tenancy, assignments, billing shape)
 * server/saas-api.js
 *
 * Transport-agnostic service layer for the SaaS expansion, following
 * the house auth model (server/assessment-api.js): every method
 * takes an injected auth context { authUserId, role, coachId?,
 * athleteId? } as its FIRST argument, derived by the caller from a
 * verified Supabase Auth JWT (production Edge Function) or dev
 * headers (dev server). This module never parses tokens; `actor`
 * is always the auth UID; client-supplied actors/tenant ids are
 * never trusted — organization ids in params are checked against
 * the caller's memberships.
 *
 * Enforcement (all server-side, stable codes — docs/SAAS_API.md):
 *   - Tenancy: a coach touches only athletes with an ACTIVE
 *     coach_athlete_links row to them; org_admins only their org's
 *     links; athletes only themselves; parents only their athletes.
 *     Cross-tenant reads return ATHLETE_NOT_FOUND (no enumeration);
 *     cross-tenant writes return FORBIDDEN.
 *   - Entitlements: computed by server/entitlements.js. Coach
 *     roster caps (soft overage via confirmOverage), free-athlete
 *     coach-link cap, lapsed coach = read-only
 *     (SUBSCRIPTION_INACTIVE on writes).
 *   - Guardian consent gate (design §2.8): minors (<18) need a
 *     granted guardian_consents row before remote activation —
 *     link activation, assignment creation/completion, and result
 *     reads return CONSENT_REQUIRED. Adults bypass entirely.
 *   - Games: TP2 IDs validated against the existing 130-game
 *     library; Safety Review / Retired rejected server-side.
 *     Assignments are coach-authored, always — no assessment score
 *     ever creates one.
 *
 * Store: server/saas-store.js (memory in tests/dev). Billing:
 * server/billing.js (fake adapter; Stripe test-mode only, not
 * connected in this environment).
 */
'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { isValidGameId, isAssignableGameId, BUILDS, PROGRAM_INTERNAL_ORG_ID } = require('./saas-store');
const {
  resolveAthleteEntitlements, resolveCoachEntitlements, resolveOrgEntitlements,
  subscriptionGrantsAccess,
} = require('./entitlements');

const ALLOWED = {
  registerAthlete: ['athlete', 'director'],
  registerCoach: ['coach', 'director'],
  createOrganization: ['coach', 'org_admin', 'director'],
  inviteToOrg: ['org_admin', 'director'],
  inviteAthlete: ['coach', 'org_admin', 'director'],
  acceptInvitation: ['coach', 'athlete', 'parent', 'org_admin', 'director'],
  linkAthlete: ['coach', 'org_admin', 'director'],
  unlinkAthlete: ['coach', 'org_admin', 'director', 'athlete'],
  myRoster: ['coach', 'org_admin', 'director'],
  createAssignment: ['coach', 'director'],
  listAssignments: ['coach', 'org_admin', 'director', 'parent', 'athlete'],
  completeAssignment: ['athlete', 'director'],
  athleteHistory: ['coach', 'org_admin', 'director', 'parent', 'athlete'],
  myEntitlements: ['coach', 'org_admin', 'director', 'parent', 'athlete'],
  sponsorAthlete: ['coach', 'org_admin', 'director'],
  endSponsorship: ['coach', 'org_admin', 'director'],
  grantConsent: ['parent', 'director'],
  withdrawConsent: ['parent', 'director'],
  orgOverview: ['org_admin', 'director'],
  cancelSubscription: ['coach', 'org_admin', 'director', 'athlete'],
  expireSubscription: ['director'],
  mySubscription: ['coach', 'org_admin', 'director', 'athlete'],
  listPlans: ['coach', 'org_admin', 'director', 'parent', 'athlete'],
  // Athlete Pathways V1 (G1/G2): director-only owner management.
  ownerCreateAthlete: ['director'],
  ownerListAthletes: ['director'],
  grantComplimentary: ['director'],
  revokeComplimentary: ['director'],
  suspendAthlete: ['director'],
  reactivateAthlete: ['director'],
  updateAthleteRole: ['director'],
  ownerInviteAthlete: ['director'],
  listAudit: ['director'],
  // Pathways V1 (G3): prospect profiles + sharing.
  createProspectProfile: ['coach', 'org_admin', 'director', 'athlete'],
  updateProspectProfile: ['coach', 'org_admin', 'director', 'athlete'],
  approveProspectProfile: ['coach', 'org_admin', 'director', 'athlete'],
  getProspectProfile: ['coach', 'org_admin', 'director', 'parent', 'athlete'],
  listProfileShares: ['coach', 'org_admin', 'director'],
  createProfileShare: ['coach', 'org_admin', 'director'],
  revokeProfileShare: ['coach', 'org_admin', 'director'],
  // getPublicProfile is unauthenticated (token-only) — NOT in ALLOWED.
  // Pathways V1 (G4): recruitment CRM.
  createRecruitmentContact: ['coach', 'org_admin', 'director'],
  updateRecruitmentContact: ['coach', 'org_admin', 'director'],
  listRecruitmentContacts: ['coach', 'org_admin', 'director'],
  createOpportunity: ['coach', 'org_admin', 'director'],
  listOpportunities: ['coach', 'org_admin', 'director', 'athlete'],
  addRecruitmentNote: ['coach', 'org_admin', 'director'],
  listRecruitmentNotes: ['coach', 'org_admin', 'director'],
  referAthlete: ['coach', 'org_admin', 'director'],
  updateReferralStatus: ['coach', 'org_admin', 'director'],
  listReferrals: ['coach', 'org_admin', 'director', 'athlete'],
  // Pathways V1 (G5): media links (URL-only).
  addMediaLink: ['coach', 'org_admin', 'director'],
  removeMediaLink: ['coach', 'org_admin', 'director'],
  listMediaLinks: ['coach', 'org_admin', 'director', 'parent', 'athlete'],
  // Pathways V1 (G6): sport assignment, goals, scouting evaluations.
  assignSport: ['coach', 'director'],
  setDevelopmentGoals: ['coach', 'director'],
  updateDevelopmentGoal: ['coach', 'director'],
  listDevelopmentGoals: ['coach', 'org_admin', 'director', 'parent', 'athlete'],
  recordScoutingEvaluation: ['coach', 'director'],
  listScoutingEvaluations: ['coach', 'org_admin', 'director', 'parent', 'athlete'],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * DAY_MS;
/* Profile share links: same 7-day default TTL as invitations. */
const PROFILE_SHARE_TTL_MS = 7 * DAY_MS;
const OPPORTUNITY_LEVELS = ['collegiate', 'developmental', 'pre-professional', 'semi-professional', 'professional', 'national team'];
const OPPORTUNITY_TYPES = ['tryout', 'combine', 'other'];
const CONTACT_STATUSES = ['new', 'contacted', 'evaluating', 'offered', 'committed', 'declined'];
const REFERRAL_STATUSES = ['referred', 'contacted', 'evaluating', 'offered', 'committed', 'declined'];
const MEDIA_KINDS = ['highlight', 'full_game', 'other'];
const PROFILE_STATUSES = ['draft', 'pending_approval', 'approved'];
const SPORTS = ['baseball', 'soccer', 'basketball', 'football', 'flag_football'];

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function slugify(name) {
  return String(name || 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'org';
}

function athleteAge(athlete, now) {
  if (!athlete) return null;
  if (typeof athlete.age === 'number') return athlete.age;
  if (athlete.dob) {
    const dob = Date.parse(athlete.dob);
    if (Number.isFinite(dob)) return Math.floor((now - dob) / (365.25 * DAY_MS));
  }
  return null;
}

function createSaasApi({ store, billing = null, assessmentHistory = null } = {}) {
  if (!store) throw new Error('createSaasApi requires a store (MemorySaasStore).');

  function requireAuth(auth, method) {
    if (!auth || typeof auth.authUserId !== 'string' || !auth.authUserId) {
      throw err('UNAUTHENTICATED', 'An authenticated user is required.');
    }
    if (method && !ALLOWED[method].includes(auth.role)) {
      throw err('FORBIDDEN', `Role '${auth.role}' may not call ${method}.`);
    }
    return auth;
  }

  function appUserFor(auth) {
    return store.appUserByAuthId(auth.authUserId);
  }

  function coachFor(auth) {
    if (auth.coachId) return store.coachById(auth.coachId);
    const u = appUserFor(auth);
    return u ? store.coachByUserId(u.id) : null;
  }

  function athleteSelfFor(auth) {
    if (auth.athleteId) return store.athleteById(auth.athleteId);
    const u = appUserFor(auth);
    return u ? store.athleteByAppUserId(u.id) : null;
  }

  function requireAthlete(athleteId) {
    const a = store.athleteById(athleteId);
    if (!a) throw err('ATHLETE_NOT_FOUND', 'Athlete not found.');
    return a;
  }

  function isMinor(athlete, now) {
    const age = athleteAge(athlete, now);
    return age != null && age < 18;
  }

  function requireConsent(athlete, now) {
    if (isMinor(athlete, now) && !store.hasConsent(athlete.id)) {
      throw err('CONSENT_REQUIRED', 'Guardian consent is required before remote features activate for a minor athlete.');
    }
  }

  /* --- Pathways V1 helpers (G1-G6) --- */

  function requireDirector(auth, method) {
    if (!auth || auth.role !== 'director') throw err('FORBIDDEN', `Only the director (owner) may call ${method}.`);
  }

  /* Public fields of a prospect profile — the ONLY fields a share
   * token ever exposes. Contact info, training notes, medical info,
   * and anything not listed here never leaves the server on a
   * public read.
   *
   * Athlete name (Marcus decision 2026-11-26): the name MAY appear
   * on an authorized prospect profile, subject to athlete + coach
   * approval (+ guardian consent if the athlete is a minor).
   * Profiles stay private by default: the name is included ONLY
   * when both approval timestamps are recorded and, for a minor,
   * a granted guardian-consent row is live at read time. Consent
   * withdrawn after approval hides the name again — the profile
   * itself stays shareable, the name does not. The gate is
   * re-checked on every public read, never cached at approval
   * time, and reuses the existing approval/consent records — no
   * new consent logic. */
  function nameDisplayAllowed(profile, now) {
    const athlete = store.athleteById(profile.athleteId);
    if (!athlete) return false;
    if (!profile.athleteApprovedAt || !profile.coachApprovedAt) return false;
    if (isMinor(athlete, now) && !store.hasConsent(athlete.id)) return false;
    return true;
  }

  function publicProfileView(profile, now = Date.now()) {
    const media = store.mediaLinksForProfile(profile.id).map(m => ({
      kind: m.kind, url: m.url, title: m.title || null,
    }));
    const evaluations = store.evaluationsForAthlete(profile.athleteId)
      .filter(e => e.coachApproved)
      .map(e => ({ body: e.body, approvedAt: e.approvedAt || null }));
    const athlete = store.athleteById(profile.athleteId);
    return {
      profileId: profile.id,
      athleteName: nameDisplayAllowed(profile, now) ? (athlete && athlete.name) || null : null,
      bio: profile.bio || null,
      primarySport: profile.primarySport || null,
      secondarySport: profile.secondarySport || null,
      positions: profile.positions || [],
      measurements: profile.measurements || {},
      accomplishments: profile.accomplishments || [],
      playingHistory: profile.playingHistory || [],
      verifiedMetrics: profile.verifiedMetrics || {},
      availability: profile.availability || null,
      mediaLinks: media,
      scoutingEvaluations: evaluations,
    };
  }

  function requireProfile(profileId) {
    const p = store.prospectProfileById(profileId);
    if (!p) throw err('INVALID_INPUT', 'Prospect profile not found.');
    return p;
  }

  function requireContact(contactId) {
    const c = store.recruitmentContactById(contactId);
    if (!c) throw err('INVALID_INPUT', 'Recruitment contact not found.');
    return c;
  }

  /* CRM tenancy: a coach touches only contacts they created (or in
   * an org they admin); org_admin only their org's contacts. */
  function inContactScope(auth, contact) {
    if (auth.role === 'director') return true;
    if (auth.role === 'coach') {
      const coach = coachFor(auth);
      return !!coach && contact.createdByCoachId === coach.id;
    }
    if (auth.role === 'org_admin') {
      const u = appUserFor(auth);
      return !!u && contact.organizationId && store.isOrgAdmin(u.id, contact.organizationId);
    }
    return false;
  }

  function requireContactScope(auth, contact) {
    if (!inContactScope(auth, contact)) throw err('FORBIDDEN', 'Recruitment contact is outside your scope.');
  }

  /* CRM list reads (Pathways V1, G1 fix): opportunities, notes, and
   * referrals are stored server-side and must be readable back.
   * Enrichment: list rows carry the contact's `organization`
   * (orgName) so the athlete portal can name the organization
   * without a contacts read athletes are not allowed to make. */
  function withContactOrg(row) {
    const contact = row && row.contactId ? store.recruitmentContactById(row.contactId) : null;
    return { ...row, organization: contact ? contact.orgName : null };
  }

  /* Contact ids an athlete was referred to — the athlete-visible
   * slice of the pipeline. */
  function referredContactIds(athleteId) {
    return new Set(store.referralsForAthlete(athleteId).map(r => r.contactId));
  }

  function isValidUrl(url) {
    try {
      const u = new URL(String(url));
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
  }

  /* Scope: can this caller act on this athlete at all?
   * director: all. coach: active link to them. org_admin: active
   * link inside an org they admin. parent: guardian. athlete: self. */
  function inScope(auth, athleteId) {
    if (auth.role === 'director') return true;
    if (auth.role === 'coach') {
      const coach = coachFor(auth);
      return !!coach && store.activeLinksForCoach(coach.id).some(l => l.athleteId === athleteId);
    }
    if (auth.role === 'org_admin') {
      const u = appUserFor(auth);
      if (!u) return false;
      return store.activeLinksForAthlete(athleteId).some(l => store.isOrgAdmin(u.id, l.organizationId));
    }
    if (auth.role === 'parent') {
      const u = appUserFor(auth);
      return !!u && store.isGuardianOf(u.id, athleteId);
    }
    if (auth.role === 'athlete') {
      const self = athleteSelfFor(auth);
      return !!self && self.id === athleteId;
    }
    return false;
  }

  function requireScopeRead(auth, athleteId) {
    requireAthlete(athleteId);
    if (!inScope(auth, athleteId)) throw err('ATHLETE_NOT_FOUND', 'Athlete not found.');
  }

  function requireScopeWrite(auth, athleteId) {
    requireAthlete(athleteId);
    if (!inScope(auth, athleteId)) throw err('FORBIDDEN', 'Athlete is outside your scope.');
  }

  function orgIdForCoach(auth, coach, requestedOrgId) {
    if (requestedOrgId) {
      const u = appUserFor(auth);
      const ok = auth.role === 'director'
        || (u && store.isOrgMember(u.id, requestedOrgId))
        || (coach && coach.organizationId === requestedOrgId);
      if (!ok) throw err('FORBIDDEN', 'Organization is outside your memberships.');
      return requestedOrgId;
    }
    if (coach && coach.organizationId) return coach.organizationId;
    const u = appUserFor(auth);
    const ms = u ? store.membershipsForUser(u.id) : [];
    if (ms.length) return ms[0].organizationId;
    throw err('INVALID_INPUT', 'Coach has no organization; registerCoach creates one.');
  }

  function startTrial({ ownerType, ownerId, planCode, now }) {
    const plan = store.plans[planCode];
    const trialDays = plan && plan.limits ? (plan.limits.trialDays || 0) : 0;
    if (!trialDays) return null;
    const existing = store.subscriptionsFor(ownerType, ownerId)
      .find(s => subscriptionGrantsAccess(s, now));
    if (existing) return existing;
    const sub = {
      id: store.newId(), planCode, ownerType, ownerId,
      status: 'trialing', billingInterval: 'month',
      currentPeriodStart: new Date(now).toISOString(),
      currentPeriodEnd: new Date(now + trialDays * DAY_MS).toISOString(),
      cancelAtPeriodEnd: false, provider: 'none',
      providerCustomerId: null, providerSubscriptionId: null,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    };
    store.subscriptions.set(sub.id, sub);
    return sub;
  }

  return {
    store,

    /* --- registration (provisioning on first authenticated call) --- */

    registerAthlete(auth, params = {}) {
      requireAuth(auth, 'registerAthlete');
      const now = params.now ?? Date.now();
      const existing = appUserFor(auth);
      if (existing) {
        if (existing.role !== 'athlete') throw err('ACCOUNT_EXISTS', `Account already exists with role '${existing.role}'.`);
        const athlete = store.athleteByAppUserId(existing.id);
        return { appUser: existing, athlete, entitlements: resolveAthleteEntitlements(store, athlete.id, now), alreadyRegistered: true };
      }
      if (!params.email || !params.name) throw err('INVALID_INPUT', 'registerAthlete requires email and name.');
      const appUser = { id: store.newId(), authUserId: auth.authUserId, email: params.email, role: 'athlete' };
      store.appUsers.set(appUser.id, appUser);
      const athlete = {
        id: store.newId(), appUserId: appUser.id, name: params.name,
        age: params.age ?? null, dob: params.dob ?? null,
        sports: Array.isArray(params.sports) ? params.sports : [],
      };
      store.athletes.set(athlete.id, athlete);
      store.audit(auth.authUserId, 'register_athlete', { athleteId: athlete.id }, new Date(now).toISOString());
      return { appUser, athlete, entitlements: resolveAthleteEntitlements(store, athlete.id, now), alreadyRegistered: false };
    },

    registerCoach(auth, params = {}) {
      requireAuth(auth, 'registerCoach');
      const now = params.now ?? Date.now();
      const existing = appUserFor(auth);
      if (existing) {
        if (!['coach', 'org_admin'].includes(existing.role)) {
          throw err('ACCOUNT_EXISTS', `Account already exists with role '${existing.role}'.`);
        }
        const coach = store.coachByUserId(existing.id);
        return { appUser: existing, coach, organization: coach ? store.orgById(coach.organizationId) : null, alreadyRegistered: true };
      }
      if (!params.email || !params.name) throw err('INVALID_INPUT', 'registerCoach requires email and name.');
      const appUser = { id: store.newId(), authUserId: auth.authUserId, email: params.email, role: 'coach' };
      store.appUsers.set(appUser.id, appUser);
      let slug = slugify(params.orgName || `${params.name} Coaching`);
      if (store.orgBySlug(slug)) slug = `${slug}-${store.newId().slice(0, 8)}`;
      const org = {
        id: store.newId(), kind: 'solo', name: params.orgName || `${params.name} Coaching`,
        slug, status: 'active', createdBy: appUser.id,
      };
      store.organizations.set(org.id, org);
      store.orgMemberships.push({ organizationId: org.id, appUserId: appUser.id, orgRole: 'org_admin', status: 'active' });
      const coach = { id: store.newId(), userId: appUser.id, name: params.name, organizationId: org.id };
      store.coaches.set(coach.id, coach);
      const trial = startTrial({ ownerType: 'coach', ownerId: coach.id, planCode: 'coach_starter', now });
      store.audit(auth.authUserId, 'register_coach', { coachId: coach.id, organizationId: org.id }, new Date(now).toISOString());
      return {
        appUser, coach, organization: org, trial,
        entitlements: resolveCoachEntitlements(store, coach.id, now), alreadyRegistered: false,
      };
    },

    createOrganization(auth, params = {}) {
      requireAuth(auth, 'createOrganization');
      const now = params.now ?? Date.now();
      const u = appUserFor(auth);
      if (!u && auth.role !== 'director') throw err('FORBIDDEN', 'Register first, then create an organization.');
      if (!params.name) throw err('INVALID_INPUT', 'createOrganization requires name.');
      const kind = params.kind || 'team';
      if (!['team', 'academy'].includes(kind)) throw err('INVALID_INPUT', "kind must be 'team' or 'academy'.");
      let slug = params.slug ? slugify(params.slug) : slugify(params.name);
      if (store.orgBySlug(slug)) slug = `${slug}-${store.newId().slice(0, 8)}`;
      const org = { id: store.newId(), kind, name: params.name, slug, status: 'active', createdBy: u ? u.id : null };
      store.organizations.set(org.id, org);
      if (u) {
        store.orgMemberships.push({ organizationId: org.id, appUserId: u.id, orgRole: 'org_admin', status: 'active' });
        if (u.role === 'coach') u.role = 'org_admin';
      }
      const trial = startTrial({ ownerType: 'organization', ownerId: org.id, planCode: 'team_academy', now });
      store.audit(auth.authUserId, 'create_organization', { organizationId: org.id, kind }, new Date(now).toISOString());
      return { organization: org, trial, entitlements: resolveOrgEntitlements(store, org.id, now) };
    },

    /* --- invitations --- */

    inviteToOrg(auth, params = {}) {
      requireAuth(auth, 'inviteToOrg');
      const now = params.now ?? Date.now();
      if (!params.organizationId || !params.email) throw err('INVALID_INPUT', 'inviteToOrg requires organizationId and email.');
      const org = store.orgById(params.organizationId);
      if (!org) throw err('INVALID_INPUT', 'Organization not found.');
      const u = appUserFor(auth);
      if (auth.role !== 'director' && !(u && store.isOrgAdmin(u.id, org.id))) {
        throw err('FORBIDDEN', 'Only an org admin may invite coaches to this organization.');
      }
      const ent = resolveOrgEntitlements(store, org.id, now);
      const maxCoaches = ent.limits ? ent.limits.maxCoaches : null;
      if (maxCoaches != null && store.membershipsForOrg(org.id).length >= maxCoaches) {
        throw err('ENTITLEMENT_LIMIT', `Organization coach limit reached (${maxCoaches}).`);
      }
      const token = randomBytes(24).toString('hex');
      const invite = {
        id: store.newId(), organizationId: org.id, invitedBy: u ? u.id : null,
        email: params.email, inviteRole: 'coach', coachId: null,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        status: 'pending', expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
        createdAt: new Date(now).toISOString(),
      };
      store.invitations.push(invite);
      store.audit(auth.authUserId, 'invite_to_org', { organizationId: org.id, email: params.email }, new Date(now).toISOString());
      return { invitation: { ...invite, tokenHash: undefined }, token };
    },

    inviteAthlete(auth, params = {}) {
      requireAuth(auth, 'inviteAthlete');
      const now = params.now ?? Date.now();
      if (!params.email) throw err('INVALID_INPUT', 'inviteAthlete requires email.');
      const coach = coachFor(auth);
      if (auth.role !== 'director' && !coach) throw err('FORBIDDEN', 'Only a coach may invite an athlete.');
      const orgId = orgIdForCoach(auth, coach, params.organizationId);
      const u = appUserFor(auth);
      const token = randomBytes(24).toString('hex');
      const invite = {
        id: store.newId(), organizationId: orgId, invitedBy: u ? u.id : null,
        email: params.email, inviteRole: params.inviteRole === 'parent' ? 'parent' : 'athlete',
        coachId: coach ? coach.id : null,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        status: 'pending', expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
        createdAt: new Date(now).toISOString(),
      };
      store.invitations.push(invite);
      store.audit(auth.authUserId, 'invite_athlete', { organizationId: orgId, email: params.email }, new Date(now).toISOString());
      return { invitation: { ...invite, tokenHash: undefined }, token };
    },

    acceptInvitation(auth, params = {}) {
      requireAuth(auth, 'acceptInvitation');
      const now = params.now ?? Date.now();
      if (!params.token) throw err('INVALID_INPUT', 'acceptInvitation requires token.');
      const hash = createHash('sha256').update(String(params.token)).digest('hex');
      const invite = store.invitations.find(i => i.tokenHash === hash);
      if (!invite || invite.status !== 'pending') throw err('INVITATION_INVALID', 'Invitation is invalid or already used.');
      if (Date.parse(invite.expiresAt) <= now) {
        invite.status = 'expired';
        throw err('INVITATION_INVALID', 'Invitation has expired.');
      }
      const u = appUserFor(auth);
      if (!u) throw err('FORBIDDEN', 'Register an account first, then accept the invitation.');
      invite.status = 'accepted';
      if (invite.inviteRole === 'coach') {
        if (!store.isOrgMember(u.id, invite.organizationId)) {
          store.orgMemberships.push({ organizationId: invite.organizationId, appUserId: u.id, orgRole: 'coach', status: 'active' });
        }
        let coach = store.coachByUserId(u.id);
        if (!coach) {
          coach = { id: store.newId(), userId: u.id, name: params.name || u.email, organizationId: invite.organizationId };
          store.coaches.set(coach.id, coach);
        }
        store.audit(auth.authUserId, 'accept_invitation_coach', { organizationId: invite.organizationId }, new Date(now).toISOString());
        return { organization: store.orgById(invite.organizationId), coach };
      }
      // athlete / parent invitation: link the athlete to the inviting coach
      const athlete = params.athleteId ? requireAthlete(params.athleteId) : athleteSelfFor(auth);
      if (!athlete) throw err('INVALID_INPUT', 'acceptInvitation for an athlete requires a registered athlete account.');
      if (!invite.coachId) throw err('INVITATION_INVALID', 'Invitation has no inviting coach.');
      const link = this.linkAthlete(
        { authUserId: auth.authUserId, role: 'director' },
        { coachId: invite.coachId, athleteId: athlete.id, organizationId: invite.organizationId, source: 'coach_invite', now },
      );
      store.audit(auth.authUserId, 'accept_invitation_athlete', { athleteId: athlete.id }, new Date(now).toISOString());
      return { link };
    },

    /* --- roster links --- */

    linkAthlete(auth, params = {}) {
      requireAuth(auth, 'linkAthlete');
      const now = params.now ?? Date.now();
      if (!params.athleteId) throw err('INVALID_INPUT', 'linkAthlete requires athleteId.');
      const athlete = requireAthlete(params.athleteId);
      let coach = params.coachId ? store.coachById(params.coachId) : coachFor(auth);
      if (auth.role === 'coach') {
        const self = coachFor(auth);
        if (!self || (coach && coach.id !== self.id)) throw err('FORBIDDEN', 'A coach may only link athletes to themselves.');
        coach = self;
      }
      if (!coach) throw err('INVALID_INPUT', 'linkAthlete requires a coach (coachId or coach auth).');
      const orgId = orgIdForCoach(auth, coach, params.organizationId);
      if (auth.role === 'org_admin') {
        const u = appUserFor(auth);
        if (!u || !store.isOrgAdmin(u.id, orgId)) throw err('FORBIDDEN', 'Organization is outside your memberships.');
      }
      // Consent gate: a minor's link never activates without consent.
      requireConsent(athlete, now);
      // Coach entitlement: lapsed coach is read-only.
      const coachEnt = resolveCoachEntitlements(store, coach.id, now);
      if (!coachEnt.active) throw err('SUBSCRIPTION_INACTIVE', 'Coach subscription is inactive; roster is read-only.');
      const existing = store.findActiveLink(coach.id, athlete.id, orgId);
      if (existing) return { link: existing, alreadyLinked: true };
      // Coach roster cap (soft overage only with explicit confirmation).
      const maxAthletes = coachEnt.limits ? coachEnt.limits.maxAthletes : null;
      const rosterCount = store.activeLinksForCoach(coach.id).length;
      let overage = false;
      if (maxAthletes != null && rosterCount >= maxAthletes) {
        if (!params.confirmOverage) {
          throw err('ENTITLEMENT_LIMIT', `Coach roster limit reached (${maxAthletes} athletes on ${coachEnt.planCode}).`);
        }
        overage = true;
      }
      // Athlete free-tier coach-link cap.
      const athEnt = resolveAthleteEntitlements(store, athlete.id, now);
      if (athEnt.maxCoachLinks != null && store.activeLinksForAthlete(athlete.id).length >= athEnt.maxCoachLinks) {
        throw err('ENTITLEMENT_LIMIT', `Athlete tier allows ${athEnt.maxCoachLinks} active coach link(s).`);
      }
      const link = {
        id: store.newId(), coachId: coach.id, athleteId: athlete.id, organizationId: orgId,
        status: 'active', source: params.source || (auth.role === 'director' ? 'program_internal' : 'coach_invite'),
        startedAt: new Date(now).toISOString(), endedAt: null, createdBy: auth.authUserId,
        overage,
      };
      store.links.push(link);
      store.audit(auth.authUserId, 'link_athlete', { coachId: coach.id, athleteId: athlete.id, organizationId: orgId, overage }, new Date(now).toISOString());
      return { link, alreadyLinked: false, overage };
    },

    unlinkAthlete(auth, params = {}) {
      requireAuth(auth, 'unlinkAthlete');
      const now = params.now ?? Date.now();
      if (!params.athleteId) throw err('INVALID_INPUT', 'unlinkAthlete requires athleteId.');
      requireAthlete(params.athleteId);
      const coach = params.coachId ? store.coachById(params.coachId) : coachFor(auth);
      const orgId = params.organizationId || (coach ? coach.organizationId : null);
      const link = store.links.find(l => l.athleteId === params.athleteId && l.status === 'active'
        && (!coach || l.coachId === coach.id) && (!orgId || l.organizationId === orgId));
      if (!link) throw err('ATHLETE_NOT_FOUND', 'No active link found for this athlete.');
      if (auth.role === 'coach') {
        const self = coachFor(auth);
        if (!self || link.coachId !== self.id) throw err('FORBIDDEN', 'A coach may only end their own links.');
      }
      if (auth.role === 'athlete') {
        const self = athleteSelfFor(auth);
        if (!self || self.id !== params.athleteId) throw err('FORBIDDEN', 'An athlete may only end their own links.');
      }
      if (auth.role === 'org_admin') {
        const u = appUserFor(auth);
        if (!u || !store.isOrgAdmin(u.id, link.organizationId)) throw err('FORBIDDEN', 'Link is outside your organization.');
      }
      link.status = 'ended';
      link.endedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'unlink_athlete', { linkId: link.id }, new Date(now).toISOString());
      return { link };
    },

    myRoster(auth, params = {}) {
      requireAuth(auth, 'myRoster');
      const now = params.now ?? Date.now();
      let links = [];
      if (auth.role === 'director') {
        links = store.links.filter(l => l.status === 'active');
      } else if (auth.role === 'coach') {
        const coach = coachFor(auth);
        links = coach ? store.activeLinksForCoach(coach.id) : [];
      } else if (auth.role === 'org_admin') {
        const u = appUserFor(auth);
        const orgIds = u ? store.membershipsForUser(u.id).filter(m => m.orgRole === 'org_admin').map(m => m.organizationId) : [];
        links = store.links.filter(l => l.status === 'active' && orgIds.includes(l.organizationId));
      }
      const byAthlete = new Map();
      for (const l of links) {
        const a = store.athleteById(l.athleteId);
        if (!a) continue;
        if (!byAthlete.has(a.id)) byAthlete.set(a.id, { athlete: a, links: [] });
        byAthlete.get(a.id).links.push(l);
      }
      return { athletes: [...byAthlete.values()], count: byAthlete.size };
    },

    /* --- assignments & completions --- */

    createAssignment(auth, params = {}) {
      requireAuth(auth, 'createAssignment');
      const now = params.now ?? Date.now();
      if (!params.athleteId || !params.title) throw err('INVALID_INPUT', 'createAssignment requires athleteId and title.');
      const athlete = requireAthlete(params.athleteId);
      const coach = coachFor(auth);
      if (auth.role === 'coach') {
        requireScopeWrite(auth, athlete.id);
        if (!coach) throw err('FORBIDDEN', 'Coach record not found.');
        const ent = resolveCoachEntitlements(store, coach.id, now);
        if (!ent.active) throw err('SUBSCRIPTION_INACTIVE', 'Coach subscription is inactive; roster is read-only.');
        if (ent.limits && ent.limits.canAssign === false) throw err('ENTITLEMENT_LIMIT', 'Plan does not include training assignment.');
      }
      requireConsent(athlete, now);
      const gameIds = params.gameIds || [];
      if (!Array.isArray(gameIds)) throw err('INVALID_INPUT', 'gameIds must be an array of TP2 IDs.');
      for (const gid of gameIds) {
        if (!isValidGameId(gid)) throw err('INVALID_GAME_ID', `Unknown game ID: ${gid}. Valid IDs are TP2-001..TP2-130.`);
        if (!isAssignableGameId(gid)) throw err('GAME_NOT_ASSIGNABLE', `Game ${gid} is Safety Review / Retired and must not be assigned.`);
      }
      if (params.build != null && !BUILDS.includes(params.build)) {
        throw err('INVALID_INPUT', `build must be one of ${BUILDS.join(', ')}.`);
      }
      const orgId = params.organizationId
        || (coach ? coach.organizationId : null)
        || (store.activeLinksForAthlete(athlete.id)[0] || {}).organizationId
        || null;
      if (!orgId) throw err('INVALID_INPUT', 'createAssignment requires an organization (link the athlete first).');
      const assignment = {
        id: store.newId(), athleteId: athlete.id,
        coachId: coach ? coach.id : (params.coachId || null),
        organizationId: orgId,
        developmentPlanId: params.developmentPlanId || null,
        title: params.title, instructions: params.instructions || null,
        gameIds: [...gameIds], build: params.build || null,
        dose: params.dose || null, dueAt: params.dueAt || null,
        status: 'assigned', assignedAt: new Date(now).toISOString(), createdBy: auth.authUserId,
      };
      store.assignments.set(assignment.id, assignment);
      store.audit(auth.authUserId, 'create_assignment', { assignmentId: assignment.id, athleteId: athlete.id }, new Date(now).toISOString());
      return { assignment };
    },

    listAssignments(auth, params = {}) {
      requireAuth(auth, 'listAssignments');
      const athleteId = params.athleteId || (athleteSelfFor(auth) || {}).id;
      if (!athleteId) throw err('INVALID_INPUT', 'listAssignments requires athleteId.');
      requireScopeRead(auth, athleteId);
      const rows = [...store.assignments.values()]
        .filter(a => a.athleteId === athleteId)
        .filter(a => !params.status || a.status === params.status)
        .sort((x, y) => Date.parse(y.assignedAt) - Date.parse(x.assignedAt));
      return { assignments: rows };
    },

    completeAssignment(auth, params = {}) {
      requireAuth(auth, 'completeAssignment');
      const now = params.now ?? Date.now();
      if (!params.assignmentId) throw err('INVALID_INPUT', 'completeAssignment requires assignmentId.');
      const assignment = store.assignments.get(String(params.assignmentId));
      if (!assignment) throw err('INVALID_INPUT', 'Assignment not found.');
      if (auth.role === 'athlete') {
        const self = athleteSelfFor(auth);
        if (!self || self.id !== assignment.athleteId) throw err('FORBIDDEN', 'An athlete may only complete their own assignments.');
      }
      const athlete = requireAthlete(assignment.athleteId);
      requireConsent(athlete, now);
      if (assignment.status === 'completed') throw err('ALREADY_COMPLETED', 'Assignment is already completed.');
      if (assignment.status === 'cancelled') throw err('INVALID_INPUT', 'Assignment was cancelled.');
      if (params.effortRpe != null && (!Number.isInteger(params.effortRpe) || params.effortRpe < 1 || params.effortRpe > 10)) {
        throw err('INVALID_INPUT', 'effortRpe must be an integer 1-10.');
      }
      const completion = {
        id: store.newId(), assignmentId: assignment.id, athleteId: athlete.id,
        completedAt: params.completedAt || new Date(now).toISOString(),
        durationMin: params.durationMin ?? null, effortRpe: params.effortRpe ?? null,
        athleteNote: params.athleteNote || null, coachNote: null,
      };
      store.completions.set(completion.id, completion);
      assignment.status = 'completed';
      store.audit(auth.authUserId, 'complete_assignment', { assignmentId: assignment.id }, new Date(now).toISOString());
      return { completion, assignment };
    },

    /* Persistent history = join, nothing copied: completions +
     * assignments from this store, assessments from the injected
     * assessmentHistory provider (the assessment workflow in dev /
     * production shape). Free tier: display window only — rows are
     * retained, never deleted. */
    async athleteHistory(auth, params = {}) {
      requireAuth(auth, 'athleteHistory');
      const now = params.now ?? Date.now();
      const athleteId = params.athleteId || (athleteSelfFor(auth) || {}).id;
      if (!athleteId) throw err('INVALID_INPUT', 'athleteHistory requires athleteId.');
      requireScopeRead(auth, athleteId);
      const athlete = requireAthlete(athleteId);
      requireConsent(athlete, now);
      const ent = resolveAthleteEntitlements(store, athleteId, now);
      const cutoff = ent.historyDays != null ? now - ent.historyDays * DAY_MS : null;
      const inWindow = (iso) => cutoff == null || Date.parse(iso) >= cutoff;
      const allCompletions = [...store.completions.values()].filter(c => c.athleteId === athleteId);
      const completions = allCompletions.filter(c => inWindow(c.completedAt));
      const assignments = [...store.assignments.values()].filter(a => a.athleteId === athleteId);
      let assessments = [];
      if (assessmentHistory) {
        const provided = await assessmentHistory(athleteId);
        assessments = Array.isArray(provided) ? provided : [];
      }
      const visibleAssessments = assessments.filter(s => !s.completedAt || inWindow(s.completedAt));
      return {
        athleteId,
        entitlements: ent,
        completions,
        assignments,
        assessments: visibleAssessments,
        truncated: completions.length < allCompletions.length || visibleAssessments.length < assessments.length,
        historyWindowDays: ent.historyDays,
      };
    },

    /* --- entitlements / subscriptions --- */

    myEntitlements(auth, params = {}) {
      requireAuth(auth, 'myEntitlements');
      const now = params.now ?? Date.now();
      if (auth.role === 'athlete' || params.athleteId) {
        const athleteId = params.athleteId || (athleteSelfFor(auth) || {}).id;
        if (!athleteId) throw err('INVALID_INPUT', 'myEntitlements requires an athlete.');
        if (auth.role !== 'director') requireScopeRead(auth, athleteId);
        return { kind: 'athlete', athleteId, entitlements: resolveAthleteEntitlements(store, athleteId, now) };
      }
      if (auth.role === 'coach') {
        const coach = coachFor(auth);
        if (!coach) throw err('FORBIDDEN', 'Coach record not found.');
        return { kind: 'coach', coachId: coach.id, entitlements: resolveCoachEntitlements(store, coach.id, now) };
      }
      if (auth.role === 'org_admin') {
        const u = appUserFor(auth);
        const orgIds = u ? store.membershipsForUser(u.id).map(m => m.organizationId) : [];
        return { kind: 'organization', organizations: orgIds.map(id => ({ organizationId: id, entitlements: resolveOrgEntitlements(store, id, now) })) };
      }
      return { kind: 'director', entitlements: { tier: 'director', fullHistory: true } };
    },

    mySubscription(auth, params = {}) {
      requireAuth(auth, 'mySubscription');
      const now = params.now ?? Date.now();
      let ownerType; let ownerId;
      if (params.ownerType && params.ownerId) {
        ownerType = params.ownerType; ownerId = params.ownerId;
        if (auth.role !== 'director') {
          const u = appUserFor(auth);
          const coach = coachFor(auth);
          const self = athleteSelfFor(auth);
          const ok = (ownerType === 'coach' && coach && coach.id === ownerId)
            || (ownerType === 'athlete' && self && self.id === ownerId)
            || (ownerType === 'organization' && u && store.isOrgMember(u.id, ownerId));
          if (!ok) throw err('FORBIDDEN', 'Subscription is outside your scope.');
        }
      } else if (auth.role === 'coach') {
        const coach = coachFor(auth);
        if (!coach) throw err('FORBIDDEN', 'Coach record not found.');
        ownerType = 'coach'; ownerId = coach.id;
      } else if (auth.role === 'athlete') {
        const self = athleteSelfFor(auth);
        if (!self) throw err('FORBIDDEN', 'Athlete record not found.');
        ownerType = 'athlete'; ownerId = self.id;
      } else if (auth.role === 'org_admin') {
        const u = appUserFor(auth);
        const ms = u ? store.membershipsForUser(u.id) : [];
        if (!ms.length) throw err('FORBIDDEN', 'No organization membership.');
        ownerType = 'organization'; ownerId = ms[0].organizationId;
      } else {
        throw err('INVALID_INPUT', 'mySubscription requires ownerType and ownerId for this role.');
      }
      const subs = store.subscriptionsFor(ownerType, ownerId);
      return { ownerType, ownerId, subscriptions: subs, granting: subs.filter(s => subscriptionGrantsAccess(s, now)) };
    },

    cancelSubscription(auth, params = {}) {
      requireAuth(auth, 'cancelSubscription');
      const now = params.now ?? Date.now();
      if (!params.subscriptionId) throw err('INVALID_INPUT', 'cancelSubscription requires subscriptionId.');
      const sub = store.subscriptions.get(String(params.subscriptionId));
      if (!sub) throw err('INVALID_INPUT', 'Subscription not found.');
      if (auth.role !== 'director') {
        const u = appUserFor(auth);
        const coach = coachFor(auth);
        const self = athleteSelfFor(auth);
        const ok = (sub.ownerType === 'coach' && coach && coach.id === sub.ownerId)
          || (sub.ownerType === 'athlete' && self && self.id === sub.ownerId)
          || (sub.ownerType === 'organization' && u && store.isOrgAdmin(u.id, sub.ownerId));
        if (!ok) throw err('FORBIDDEN', 'Subscription is outside your scope.');
      }
      sub.status = 'cancelled';
      sub.cancelAtPeriodEnd = params.atPeriodEnd !== false;
      sub.updatedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'cancel_subscription', { subscriptionId: sub.id, atPeriodEnd: sub.cancelAtPeriodEnd }, new Date(now).toISOString());
      return { subscription: sub };
    },

    expireSubscription(auth, params = {}) {
      requireAuth(auth, 'expireSubscription');
      const now = params.now ?? Date.now();
      if (!params.subscriptionId) throw err('INVALID_INPUT', 'expireSubscription requires subscriptionId.');
      const sub = store.subscriptions.get(String(params.subscriptionId));
      if (!sub) throw err('INVALID_INPUT', 'Subscription not found.');
      sub.status = 'expired';
      sub.updatedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'expire_subscription', { subscriptionId: sub.id }, new Date(now).toISOString());
      return { subscription: sub };
    },

    listPlans(auth) {
      requireAuth(auth, 'listPlans');
      return { plans: Object.values(store.plans).filter(p => p.active) };
    },

    /* --- sponsorships --- */

    sponsorAthlete(auth, params = {}) {
      requireAuth(auth, 'sponsorAthlete');
      const now = params.now ?? Date.now();
      if (!params.athleteId) throw err('INVALID_INPUT', 'sponsorAthlete requires athleteId.');
      const athlete = requireAthlete(params.athleteId);
      let sponsorType; let sponsorId;
      if (auth.role === 'coach') {
        const coach = coachFor(auth);
        if (!coach) throw err('FORBIDDEN', 'Coach record not found.');
        requireScopeWrite(auth, athlete.id);
        sponsorType = 'coach'; sponsorId = coach.id;
      } else if (auth.role === 'org_admin') {
        requireScopeWrite(auth, athlete.id);
        const link = store.activeLinksForAthlete(athlete.id)[0];
        sponsorType = 'organization'; sponsorId = params.organizationId || (link && link.organizationId);
        if (!sponsorId) throw err('INVALID_INPUT', 'sponsorAthlete requires organizationId.');
      } else {
        sponsorType = params.sponsorType; sponsorId = params.sponsorId;
        if (!sponsorType || !sponsorId) throw err('INVALID_INPUT', 'Director sponsorship requires sponsorType and sponsorId.');
      }
      const covering = store.subscriptionsFor(sponsorType, sponsorId)
        .find(s => subscriptionGrantsAccess(s, now));
      if (!covering) throw err('SUBSCRIPTION_INACTIVE', 'Sponsor has no active subscription to cover this athlete.');
      const existing = store.sponsorships.find(s => s.athleteId === athlete.id
        && s.sponsorType === sponsorType && s.sponsorId === sponsorId && s.status === 'active');
      if (existing) return { sponsorship: existing, alreadySponsored: true };
      const sponsorship = {
        id: store.newId(), athleteId: athlete.id, sponsorType, sponsorId,
        subscriptionId: covering.id, status: 'active',
        startedAt: new Date(now).toISOString(), endedAt: null,
      };
      store.sponsorships.push(sponsorship);
      store.audit(auth.authUserId, 'sponsor_athlete', { sponsorshipId: sponsorship.id, athleteId: athlete.id }, new Date(now).toISOString());
      return { sponsorship, alreadySponsored: false };
    },

    endSponsorship(auth, params = {}) {
      requireAuth(auth, 'endSponsorship');
      const now = params.now ?? Date.now();
      if (!params.sponsorshipId && !params.athleteId) throw err('INVALID_INPUT', 'endSponsorship requires sponsorshipId or athleteId.');
      const sp = params.sponsorshipId
        ? store.sponsorships.find(s => s.id === params.sponsorshipId && s.status === 'active')
        : store.sponsorships.find(s => s.athleteId === params.athleteId && s.status === 'active');
      if (!sp) throw err('INVALID_INPUT', 'Active sponsorship not found.');
      if (auth.role === 'coach') {
        const coach = coachFor(auth);
        if (!coach || sp.sponsorType !== 'coach' || sp.sponsorId !== coach.id) {
          throw err('FORBIDDEN', 'A coach may only end their own sponsorships.');
        }
      }
      if (auth.role === 'org_admin') {
        const u = appUserFor(auth);
        if (!u || sp.sponsorType !== 'organization' || !store.isOrgAdmin(u.id, sp.sponsorId)) {
          throw err('FORBIDDEN', 'Sponsorship is outside your organization.');
        }
      }
      sp.status = 'ended';
      sp.endedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'end_sponsorship', { sponsorshipId: sp.id }, new Date(now).toISOString());
      return { sponsorship: sp };
    },

    /* --- guardian consents (append-only) --- */

    grantConsent(auth, params = {}) {
      requireAuth(auth, 'grantConsent');
      const now = params.now ?? Date.now();
      if (!params.athleteId || !params.consentVersion) {
        throw err('INVALID_INPUT', 'grantConsent requires athleteId and consentVersion.');
      }
      const athlete = requireAthlete(params.athleteId);
      const u = appUserFor(auth);
      let guardianId = params.guardianId || (u ? store.guardianIdFor(u.id, athlete.id) : null);
      if (auth.role === 'parent' && !guardianId) {
        throw err('FORBIDDEN', 'Only a linked guardian may grant consent for this athlete.');
      }
      if (!guardianId) {
        // Director recording an off-platform consent (e.g. paper on
        // file): create/attach a guardian record for audit.
        guardianId = store.newId();
        store.guardians.set(guardianId, { id: guardianId, userId: u ? u.id : null });
        store.athleteGuardians.push({ athleteId: athlete.id, guardianId });
      }
      const consent = {
        id: store.newId(), athleteId: athlete.id, guardianId,
        consentVersion: params.consentVersion, status: 'granted',
        method: params.method || 'in_app',
        grantedAt: new Date(now).toISOString(), withdrawnAt: null,
        createdAt: new Date(now).toISOString(),
      };
      store.consents.push(consent);
      store.audit(auth.authUserId, 'grant_consent', { athleteId: athlete.id, consentVersion: params.consentVersion }, new Date(now).toISOString());
      return { consent };
    },

    withdrawConsent(auth, params = {}) {
      requireAuth(auth, 'withdrawConsent');
      const now = params.now ?? Date.now();
      if (!params.athleteId) throw err('INVALID_INPUT', 'withdrawConsent requires athleteId.');
      const athlete = requireAthlete(params.athleteId);
      const u = appUserFor(auth);
      const guardianId = params.guardianId || (u ? store.guardianIdFor(u.id, athlete.id) : null);
      if (auth.role === 'parent' && !guardianId) {
        throw err('FORBIDDEN', 'Only a linked guardian may withdraw consent for this athlete.');
      }
      const latest = store.latestConsent(athlete.id);
      const consent = {
        id: store.newId(), athleteId: athlete.id,
        guardianId: guardianId || (latest && latest.guardianId) || null,
        consentVersion: params.consentVersion || (latest && latest.consentVersion) || 'unknown',
        status: 'withdrawn', method: params.method || 'in_app',
        grantedAt: null, withdrawnAt: new Date(now).toISOString(),
        createdAt: new Date(now).toISOString(),
      };
      store.consents.push(consent);
      store.audit(auth.authUserId, 'withdraw_consent', { athleteId: athlete.id }, new Date(now).toISOString());
      return { consent };
    },

    /* --- Athlete Pathways V1 (G1/G2): owner account management --- */

    ownerCreateAthlete(auth, params = {}) {
      requireAuth(auth, 'ownerCreateAthlete');
      requireDirector(auth, 'ownerCreateAthlete');
      const now = params.now ?? Date.now();
      if (!params.name) throw err('INVALID_INPUT', 'ownerCreateAthlete requires name.');
      // Manual creation by the owner: no card, no subscription, no
      // payment of any kind. Fictional test data only in tests.
      const athlete = {
        id: store.newId(), appUserId: params.appUserId || null, name: params.name,
        age: params.age ?? null, dob: params.dob ?? null,
        sports: Array.isArray(params.sports) ? params.sports : [],
        status: 'active', createdBy: auth.authUserId,
        createdAt: new Date(now).toISOString(),
      };
      store.athletes.set(athlete.id, athlete);
      store.audit(auth.authUserId, 'owner_create_athlete', { athleteId: athlete.id }, new Date(now).toISOString());
      return { athlete };
    },

    ownerListAthletes(auth, params = {}) {
      requireAuth(auth, 'ownerListAthletes');
      requireDirector(auth, 'ownerListAthletes');
      const now = params.now ?? Date.now();
      const athletes = [...store.athletes.values()].map(a => {
        const grant = store.activeComplimentaryGrantsFor(a.id, now)[0] || null;
        return {
          athlete: a,
          status: a.status || 'active',
          complimentaryGrant: grant ? { id: grant.id, grantedAt: grant.grantedAt, expiresAt: grant.expiresAt, reason: grant.reason || null } : null,
          entitlements: resolveAthleteEntitlements(store, a.id, now),
        };
      });
      return { athletes, count: athletes.length };
    },

    grantComplimentary(auth, params = {}) {
      requireAuth(auth, 'grantComplimentary');
      requireDirector(auth, 'grantComplimentary');
      const now = params.now ?? Date.now();
      if (!params.athleteId) throw err('INVALID_INPUT', 'grantComplimentary requires athleteId.');
      const athlete = requireAthlete(params.athleteId);
      const existing = store.activeComplimentaryGrantsFor(athlete.id, now)[0];
      if (existing) return { grant: existing, alreadyGranted: true };
      if (params.expiresAt != null && Date.parse(params.expiresAt) <= now) {
        throw err('INVALID_INPUT', 'expiresAt must be in the future.');
      }
      const grant = {
        id: store.newId(), athleteId: athlete.id, grantedBy: auth.authUserId,
        grantedAt: new Date(now).toISOString(),
        expiresAt: params.expiresAt || null, // null = indefinite
        status: 'active', reason: params.reason || null, revokedAt: null,
      };
      store.complimentaryGrants.push(grant);
      store.audit(auth.authUserId, 'grant_complimentary', { athleteId: athlete.id, grantId: grant.id, expiresAt: grant.expiresAt }, new Date(now).toISOString());
      return { grant, alreadyGranted: false, entitlements: resolveAthleteEntitlements(store, athlete.id, now) };
    },

    revokeComplimentary(auth, params = {}) {
      requireAuth(auth, 'revokeComplimentary');
      requireDirector(auth, 'revokeComplimentary');
      const now = params.now ?? Date.now();
      const grant = params.grantId
        ? store.complimentaryGrantById(params.grantId)
        : store.activeComplimentaryGrantsFor(params.athleteId || '', now)[0];
      if (!grant || grant.status !== 'active') throw err('INVALID_INPUT', 'Active complimentary grant not found.');
      grant.status = 'revoked';
      grant.revokedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'revoke_complimentary', { athleteId: grant.athleteId, grantId: grant.id }, new Date(now).toISOString());
      return { grant, entitlements: resolveAthleteEntitlements(store, grant.athleteId, now) };
    },

    suspendAthlete(auth, params = {}) {
      requireAuth(auth, 'suspendAthlete');
      requireDirector(auth, 'suspendAthlete');
      const now = params.now ?? Date.now();
      const athlete = requireAthlete(params.athleteId);
      athlete.status = 'suspended';
      store.audit(auth.authUserId, 'suspend_athlete', { athleteId: athlete.id, reason: params.reason || null }, new Date(now).toISOString());
      return { athlete };
    },

    reactivateAthlete(auth, params = {}) {
      requireAuth(auth, 'reactivateAthlete');
      requireDirector(auth, 'reactivateAthlete');
      const now = params.now ?? Date.now();
      const athlete = requireAthlete(params.athleteId);
      athlete.status = 'active';
      store.audit(auth.authUserId, 'reactivate_athlete', { athleteId: athlete.id }, new Date(now).toISOString());
      return { athlete };
    },

    updateAthleteRole(auth, params = {}) {
      requireAuth(auth, 'updateAthleteRole');
      requireDirector(auth, 'updateAthleteRole');
      const now = params.now ?? Date.now();
      if (!params.athleteId || !params.role) throw err('INVALID_INPUT', 'updateAthleteRole requires athleteId and role.');
      if (!['athlete', 'parent', 'coach'].includes(params.role)) {
        throw err('INVALID_INPUT', "role must be 'athlete', 'parent', or 'coach'.");
      }
      const athlete = requireAthlete(params.athleteId);
      const appUser = athlete.appUserId ? store.appUserById(athlete.appUserId) : null;
      if (appUser) appUser.role = params.role;
      athlete.role = params.role; // recorded on the athlete row too
      store.audit(auth.authUserId, 'update_athlete_role', { athleteId: athlete.id, role: params.role }, new Date(now).toISOString());
      return { athlete, appUser };
    },

    ownerInviteAthlete(auth, params = {}) {
      requireAuth(auth, 'ownerInviteAthlete');
      requireDirector(auth, 'ownerInviteAthlete');
      const now = params.now ?? Date.now();
      if (!params.email) throw err('INVALID_INPUT', 'ownerInviteAthlete requires email.');
      const u = appUserFor(auth);
      const orgId = params.organizationId || PROGRAM_INTERNAL_ORG_ID;
      const token = randomBytes(24).toString('hex');
      const invite = {
        id: store.newId(), organizationId: orgId, invitedBy: u ? u.id : null,
        email: params.email, inviteRole: 'athlete', coachId: params.coachId || null,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        status: 'pending', expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
        createdAt: new Date(now).toISOString(),
      };
      store.invitations.push(invite);
      store.audit(auth.authUserId, 'owner_invite_athlete', { organizationId: orgId, email: params.email }, new Date(now).toISOString());
      // No email is sent anywhere: the token is returned once to the owner.
      return { invitation: { ...invite, tokenHash: undefined }, token };
    },

    listAudit(auth, params = {}) {
      requireAuth(auth, 'listAudit');
      requireDirector(auth, 'listAudit');
      const events = store.auditEvents.filter(e => !params.action || e.action === params.action);
      return { events, count: events.length };
    },

    /* --- Athlete Pathways V1 (G3): prospect profiles + sharing --- */

    createProspectProfile(auth, params = {}) {
      requireAuth(auth, 'createProspectProfile');
      const now = params.now ?? Date.now();
      if (!params.athleteId) throw err('INVALID_INPUT', 'createProspectProfile requires athleteId.');
      requireScopeWrite(auth, params.athleteId);
      if (store.prospectProfileByAthlete(params.athleteId)) {
        throw err('INVALID_INPUT', 'Athlete already has a prospect profile; update it instead.');
      }
      if (!params.primarySport || !SPORTS.includes(params.primarySport)) {
        throw err('INVALID_INPUT', `primarySport must be one of ${SPORTS.join(', ')}.`);
      }
      const profile = {
        id: store.newId(), athleteId: params.athleteId,
        bio: params.bio || null,
        primarySport: params.primarySport,
        secondarySport: params.secondarySport || null,
        positions: Array.isArray(params.positions) ? params.positions : [],
        measurements: params.measurements || {},
        accomplishments: Array.isArray(params.accomplishments) ? params.accomplishments : [],
        playingHistory: Array.isArray(params.playingHistory) ? params.playingHistory : [],
        verifiedMetrics: params.verifiedMetrics || {},
        availability: params.availability || null,
        contactInfo: params.contactInfo || {},
        status: 'draft',
        coachApprovedBy: null, coachApprovedAt: null,
        athleteApprovedAt: null,
        guardianConsentId: null,
        createdBy: auth.authUserId, createdAt: new Date(now).toISOString(),
      };
      store.prospectProfiles.set(profile.id, profile);
      store.audit(auth.authUserId, 'create_prospect_profile', { profileId: profile.id, athleteId: profile.athleteId }, new Date(now).toISOString());
      return { profile };
    },

    updateProspectProfile(auth, params = {}) {
      requireAuth(auth, 'updateProspectProfile');
      const now = params.now ?? Date.now();
      const profile = requireProfile(params.profileId);
      requireScopeWrite(auth, profile.athleteId);
      const editable = ['bio', 'primarySport', 'secondarySport', 'positions', 'measurements',
        'accomplishments', 'playingHistory', 'verifiedMetrics', 'availability', 'contactInfo'];
      for (const key of editable) {
        if (params[key] !== undefined) {
          if (key === 'primarySport' && !SPORTS.includes(params[key])) {
            throw err('INVALID_INPUT', `primarySport must be one of ${SPORTS.join(', ')}.`);
          }
          profile[key] = params[key];
        }
      }
      // Editing an approved profile re-opens it: re-approval is required.
      if (profile.status === 'approved') {
        profile.status = 'draft';
        profile.coachApprovedBy = null; profile.coachApprovedAt = null;
        profile.athleteApprovedAt = null;
      }
      profile.updatedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'update_prospect_profile', { profileId: profile.id }, new Date(now).toISOString());
      return { profile };
    },

    /* Approval requires BOTH athlete and coach approval; a minor
     * additionally requires a guardian-consent row. Call once per
     * side: approval:'athlete' (self) or 'coach' (linked coach). */
    approveProspectProfile(auth, params = {}) {
      requireAuth(auth, 'approveProspectProfile');
      const now = params.now ?? Date.now();
      const profile = requireProfile(params.profileId);
      const athlete = requireAthlete(profile.athleteId);
      if (params.approval === 'athlete') {
        const self = athleteSelfFor(auth);
        if (auth.role !== 'director' && (!self || self.id !== athlete.id)) {
          throw err('FORBIDDEN', 'Only the athlete may give athlete approval.');
        }
        profile.athleteApprovedAt = new Date(now).toISOString();
      } else if (params.approval === 'coach') {
        requireScopeWrite(auth, athlete.id);
        const coach = coachFor(auth);
        profile.coachApprovedBy = coach ? coach.id : auth.authUserId;
        profile.coachApprovedAt = new Date(now).toISOString();
      } else {
        throw err('INVALID_INPUT', "approval must be 'athlete' or 'coach'.");
      }
      const bothApproved = !!profile.athleteApprovedAt && !!profile.coachApprovedAt;
      if (bothApproved) {
        if (isMinor(athlete, now)) {
          requireConsent(athlete, now);
          const consent = store.latestConsent(athlete.id);
          profile.guardianConsentId = consent ? consent.id : null;
        }
        profile.status = 'approved';
      } else {
        profile.status = 'pending_approval';
      }
      store.audit(auth.authUserId, 'approve_prospect_profile', { profileId: profile.id, approval: params.approval, status: profile.status }, new Date(now).toISOString());
      return { profile };
    },

    getProspectProfile(auth, params = {}) {
      requireAuth(auth, 'getProspectProfile');
      const profile = params.profileId ? requireProfile(params.profileId)
        : store.prospectProfileByAthlete(params.athleteId);
      if (!profile) throw err('INVALID_INPUT', 'Prospect profile not found.');
      requireScopeRead(auth, profile.athleteId);
      const evaluations = store.evaluationsForAthlete(profile.athleteId);
      return {
        profile,
        mediaLinks: store.mediaLinksForProfile(profile.id),
        // Scouting evaluations are visible to the athlete; only
        // coach-approved ones are included in the public profile.
        scoutingEvaluations: evaluations,
        developmentGoals: store.goalsForAthlete(profile.athleteId),
      };
    },

    createProfileShare(auth, params = {}) {
      requireAuth(auth, 'createProfileShare');
      const now = params.now ?? Date.now();
      const profile = requireProfile(params.profileId);
      requireScopeWrite(auth, profile.athleteId);
      if (profile.status !== 'approved') {
        throw err('PROFILE_NOT_APPROVED', 'Only an approved prospect profile may be shared.');
      }
      if (params.expiresAt != null && Date.parse(params.expiresAt) <= now) {
        throw err('INVALID_INPUT', 'expiresAt must be in the future.');
      }
      const token = randomBytes(24).toString('hex');
      const share = {
        id: store.newId(), profileId: profile.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: params.expiresAt || new Date(now + PROFILE_SHARE_TTL_MS).toISOString(),
        revokedAt: null, status: 'active', createdBy: auth.authUserId,
        createdAt: new Date(now).toISOString(),
      };
      store.profileShares.push(share);
      store.audit(auth.authUserId, 'create_profile_share', { profileId: profile.id, shareId: share.id }, new Date(now).toISOString());
      return { share: { ...share, tokenHash: undefined }, token };
    },

    revokeProfileShare(auth, params = {}) {
      requireAuth(auth, 'revokeProfileShare');
      const now = params.now ?? Date.now();
      const share = store.profileShares.find(s => s.id === String(params.shareId));
      if (!share) throw err('INVALID_INPUT', 'Profile share not found.');
      const profile = requireProfile(share.profileId);
      requireScopeWrite(auth, profile.athleteId);
      share.status = 'revoked';
      share.revokedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'revoke_profile_share', { profileId: profile.id, shareId: share.id }, new Date(now).toISOString());
      return { share };
    },

    listProfileShares(auth, params = {}) {
      requireAuth(auth, 'listProfileShares');
      const profile = requireProfile(params.profileId);
      requireScopeRead(auth, profile.athleteId);
      return { shares: store.profileSharesFor(profile.id).map(s => ({ ...s, tokenHash: undefined })) };
    },

    /* Unauthenticated, token-only public read. `auth` may be null or
     * the params object itself. Returns ONLY approved public fields. */
    getPublicProfile(auth, params = {}) {
      if (auth && !params.token && typeof auth.token === 'string') params = auth;
      const now = params.now ?? Date.now();
      if (!params.token) throw err('INVALID_INPUT', 'getPublicProfile requires token.');
      const hash = createHash('sha256').update(String(params.token)).digest('hex');
      const share = store.profileShareByTokenHash(hash);
      if (!share || share.status !== 'active' || share.revokedAt) {
        throw err('PROFILE_SHARE_INVALID', 'Profile share is revoked or invalid.');
      }
      if (Date.parse(share.expiresAt) <= now) {
        share.status = 'expired';
        throw err('PROFILE_SHARE_INVALID', 'Profile share has expired.');
      }
      const profile = requireProfile(share.profileId);
      if (profile.status !== 'approved') throw err('PROFILE_NOT_APPROVED', 'Profile is not approved for sharing.');
      return { profile: publicProfileView(profile, now) };
    },

    /* --- Athlete Pathways V1 (G4): recruitment CRM --- */

    createRecruitmentContact(auth, params = {}) {
      requireAuth(auth, 'createRecruitmentContact');
      const now = params.now ?? Date.now();
      if (!params.orgName) throw err('INVALID_INPUT', 'createRecruitmentContact requires orgName.');
      if (params.level != null && !OPPORTUNITY_LEVELS.includes(params.level)) {
        throw err('INVALID_INPUT', `level must be one of ${OPPORTUNITY_LEVELS.join(', ')}.`);
      }
      if (params.status != null && !CONTACT_STATUSES.includes(params.status)) {
        throw err('INVALID_INPUT', `status must be one of ${CONTACT_STATUSES.join(', ')}.`);
      }
      const coach = coachFor(auth);
      const u = appUserFor(auth);
      const orgId = params.organizationId
        || (coach ? coach.organizationId : null)
        || (u ? (store.membershipsForUser(u.id)[0] || {}).organizationId : null)
        || null;
      const contact = {
        id: store.newId(), orgName: params.orgName,
        sport: params.sport || null, league: params.league || null,
        level: params.level || null, region: params.region || null,
        contactName: params.contactName || null, title: params.title || null,
        email: params.email || null, phone: params.phone || null,
        requirements: params.requirements || null,
        status: params.status || 'new',
        organizationId: orgId, createdByCoachId: coach ? coach.id : null,
        createdBy: auth.authUserId, createdAt: new Date(now).toISOString(),
      };
      store.recruitmentContacts.set(contact.id, contact);
      store.audit(auth.authUserId, 'create_recruitment_contact', { contactId: contact.id }, new Date(now).toISOString());
      return { contact };
    },

    updateRecruitmentContact(auth, params = {}) {
      requireAuth(auth, 'updateRecruitmentContact');
      const now = params.now ?? Date.now();
      const contact = requireContact(params.contactId);
      requireContactScope(auth, contact);
      const editable = ['orgName', 'sport', 'league', 'level', 'region', 'contactName',
        'title', 'email', 'phone', 'requirements', 'status'];
      for (const key of editable) {
        if (params[key] !== undefined) {
          if (key === 'level' && params[key] != null && !OPPORTUNITY_LEVELS.includes(params[key])) {
            throw err('INVALID_INPUT', `level must be one of ${OPPORTUNITY_LEVELS.join(', ')}.`);
          }
          if (key === 'status' && !CONTACT_STATUSES.includes(params[key])) {
            throw err('INVALID_INPUT', `status must be one of ${CONTACT_STATUSES.join(', ')}.`);
          }
          contact[key] = params[key];
        }
      }
      contact.updatedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'update_recruitment_contact', { contactId: contact.id }, new Date(now).toISOString());
      return { contact };
    },

    listRecruitmentContacts(auth, params = {}) {
      requireAuth(auth, 'listRecruitmentContacts');
      let contacts = [...store.recruitmentContacts.values()];
      if (auth.role !== 'director') {
        contacts = contacts.filter(c => inContactScope(auth, c));
      }
      if (params.status) contacts = contacts.filter(c => c.status === params.status);
      if (params.level) contacts = contacts.filter(c => c.level === params.level);
      if (params.region) contacts = contacts.filter(c => c.region === params.region);
      if (params.sport) contacts = contacts.filter(c => c.sport === params.sport);
      return { contacts, count: contacts.length };
    },

    createOpportunity(auth, params = {}) {
      requireAuth(auth, 'createOpportunity');
      const now = params.now ?? Date.now();
      const contact = requireContact(params.contactId);
      requireContactScope(auth, contact);
      if (!params.type || !OPPORTUNITY_TYPES.includes(params.type)) {
        throw err('INVALID_INPUT', `type must be one of ${OPPORTUNITY_TYPES.join(', ')}.`);
      }
      const opportunity = {
        id: store.newId(), contactId: contact.id, type: params.type,
        date: params.date || null, notes: params.notes || null,
        createdBy: auth.authUserId, createdAt: new Date(now).toISOString(),
      };
      store.recruitmentOpportunities.push(opportunity);
      store.audit(auth.authUserId, 'create_opportunity', { contactId: contact.id, opportunityId: opportunity.id }, new Date(now).toISOString());
      return { opportunity };
    },

    listOpportunities(auth, params = {}) {
      requireAuth(auth, 'listOpportunities');
      let opps = [...store.recruitmentOpportunities];
      if (params.contactId) {
        const contact = requireContact(params.contactId);
        if (auth.role === 'athlete') {
          /* Athletes read only contacts they were referred to; a
           * contact with no referral for them reads back empty,
           * never an error that would leak its existence. */
          const self = athleteSelfFor(auth);
          if (!self || !referredContactIds(self.id).has(contact.id)) {
            return { opportunities: [], count: 0 };
          }
        } else {
          requireContactScope(auth, contact);
        }
        opps = opps.filter(o => o.contactId === contact.id);
      }
      if (params.athleteId) {
        /* Athlete: self only. Coach/org_admin: an athlete in scope.
         * Director: all. Cross-tenant reads are ATHLETE_NOT_FOUND,
         * same as every other athlete-scoped list. */
        requireScopeRead(auth, params.athleteId);
        const allowed = referredContactIds(params.athleteId);
        opps = opps.filter(o => allowed.has(o.contactId));
      } else if (!params.contactId && auth.role !== 'director') {
        if (auth.role === 'athlete') {
          const self = athleteSelfFor(auth);
          const allowed = self ? referredContactIds(self.id) : new Set();
          opps = opps.filter(o => allowed.has(o.contactId));
        } else {
          opps = opps.filter(o => {
            const c = store.recruitmentContactById(o.contactId);
            return c && inContactScope(auth, c);
          });
        }
      }
      const rows = opps.map(withContactOrg);
      return { opportunities: rows, count: rows.length };
    },

    addRecruitmentNote(auth, params = {}) {
      requireAuth(auth, 'addRecruitmentNote');
      const now = params.now ?? Date.now();
      const contact = requireContact(params.contactId);
      requireContactScope(auth, contact);
      if (!params.body) throw err('INVALID_INPUT', 'addRecruitmentNote requires body.');
      const note = {
        id: store.newId(), contactId: contact.id,
        author: auth.authUserId, body: params.body,
        followUpDate: params.followUpDate || null,
        createdAt: new Date(now).toISOString(),
      };
      store.recruitmentNotes.push(note);
      store.audit(auth.authUserId, 'add_recruitment_note', { contactId: contact.id, noteId: note.id }, new Date(now).toISOString());
      return { note };
    },

    listRecruitmentNotes(auth, params = {}) {
      requireAuth(auth, 'listRecruitmentNotes');
      let notes = [...store.recruitmentNotes];
      if (params.contactId) {
        const contact = requireContact(params.contactId);
        requireContactScope(auth, contact);
        notes = notes.filter(n => n.contactId === contact.id);
      } else if (auth.role !== 'director') {
        notes = notes.filter(n => {
          const c = store.recruitmentContactById(n.contactId);
          return c && inContactScope(auth, c);
        });
      }
      return { notes, count: notes.length };
    },

    referAthlete(auth, params = {}) {
      requireAuth(auth, 'referAthlete');
      const now = params.now ?? Date.now();
      const contact = requireContact(params.contactId);
      requireContactScope(auth, contact);
      requireScopeWrite(auth, params.athleteId);
      const existing = store.referrals.find(r => r.contactId === contact.id
        && r.athleteId === params.athleteId && r.status !== 'declined');
      if (existing) return { referral: existing, alreadyReferred: true };
      const referral = {
        id: store.newId(), contactId: contact.id, athleteId: params.athleteId,
        status: 'referred', outcome: null,
        referredAt: new Date(now).toISOString(), referredBy: auth.authUserId,
      };
      store.referrals.push(referral);
      store.audit(auth.authUserId, 'refer_athlete', { contactId: contact.id, athleteId: params.athleteId, referralId: referral.id }, new Date(now).toISOString());
      return { referral, alreadyReferred: false };
    },

    updateReferralStatus(auth, params = {}) {
      requireAuth(auth, 'updateReferralStatus');
      const now = params.now ?? Date.now();
      const referral = store.referralById(params.referralId);
      if (!referral) throw err('INVALID_INPUT', 'Referral not found.');
      const contact = requireContact(referral.contactId);
      requireContactScope(auth, contact);
      if (!params.status || !REFERRAL_STATUSES.includes(params.status)) {
        throw err('INVALID_INPUT', `status must be one of ${REFERRAL_STATUSES.join(', ')}.`);
      }
      referral.status = params.status;
      if (params.outcome !== undefined) referral.outcome = params.outcome;
      referral.updatedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'update_referral_status', { referralId: referral.id, status: referral.status }, new Date(now).toISOString());
      return { referral };
    },

    listReferrals(auth, params = {}) {
      requireAuth(auth, 'listReferrals');
      let refs = [...store.referrals];
      if (params.contactId) {
        const contact = requireContact(params.contactId);
        if (auth.role === 'athlete') {
          /* Athletes read only their own referrals on a contact. */
          const self = athleteSelfFor(auth);
          refs = refs.filter(r => r.contactId === contact.id
            && self && r.athleteId === self.id);
        } else {
          requireContactScope(auth, contact);
          refs = refs.filter(r => r.contactId === contact.id);
        }
      }
      if (params.athleteId) {
        requireScopeRead(auth, params.athleteId);
        refs = refs.filter(r => r.athleteId === params.athleteId);
      } else if (!params.contactId && auth.role !== 'director') {
        if (auth.role === 'athlete') {
          const self = athleteSelfFor(auth);
          refs = self ? refs.filter(r => r.athleteId === self.id) : [];
        } else {
          refs = refs.filter(r => {
            const c = store.recruitmentContactById(r.contactId);
            return c && inContactScope(auth, c);
          });
        }
      }
      const rows = refs.map(withContactOrg);
      return { referrals: rows, count: rows.length };
    },

    /* --- Athlete Pathways V1 (G5): media links (URL-only) --- */

    addMediaLink(auth, params = {}) {
      requireAuth(auth, 'addMediaLink');
      const now = params.now ?? Date.now();
      const profile = requireProfile(params.profileId);
      requireScopeWrite(auth, profile.athleteId);
      if (!params.kind || !MEDIA_KINDS.includes(params.kind)) {
        throw err('INVALID_INPUT', `kind must be one of ${MEDIA_KINDS.join(', ')}.`);
      }
      // URL/embed links ONLY — no uploads, no Storage, no paid hosting.
      if (!params.url || !isValidUrl(params.url)) {
        throw err('INVALID_INPUT', 'addMediaLink requires a valid http(s) URL. Uploads are not supported.');
      }
      const link = {
        id: store.newId(), profileId: profile.id, kind: params.kind,
        url: String(params.url), title: params.title || null,
        approvedBy: auth.authUserId, approvedAt: new Date(now).toISOString(),
        createdAt: new Date(now).toISOString(),
      };
      store.prospectMediaLinks.push(link);
      store.audit(auth.authUserId, 'add_media_link', { profileId: profile.id, mediaLinkId: link.id }, new Date(now).toISOString());
      return { mediaLink: link };
    },

    removeMediaLink(auth, params = {}) {
      requireAuth(auth, 'removeMediaLink');
      const now = params.now ?? Date.now();
      const link = store.prospectMediaLinks.find(m => m.id === String(params.mediaLinkId));
      if (!link) throw err('INVALID_INPUT', 'Media link not found.');
      const profile = requireProfile(link.profileId);
      requireScopeWrite(auth, profile.athleteId);
      store.prospectMediaLinks = store.prospectMediaLinks.filter(m => m.id !== link.id);
      store.audit(auth.authUserId, 'remove_media_link', { profileId: profile.id, mediaLinkId: link.id }, new Date(now).toISOString());
      return { removed: true, mediaLinkId: link.id };
    },

    listMediaLinks(auth, params = {}) {
      requireAuth(auth, 'listMediaLinks');
      const profile = requireProfile(params.profileId);
      requireScopeRead(auth, profile.athleteId);
      return { mediaLinks: store.mediaLinksForProfile(profile.id) };
    },

    /* --- Athlete Pathways V1 (G6): sport, goals, scouting --- */

    assignSport(auth, params = {}) {
      requireAuth(auth, 'assignSport');
      const now = params.now ?? Date.now();
      if (!params.athleteId || !params.sport) throw err('INVALID_INPUT', 'assignSport requires athleteId and sport.');
      if (!SPORTS.includes(params.sport)) {
        throw err('INVALID_INPUT', `sport must be one of ${SPORTS.join(', ')}.`);
      }
      requireScopeWrite(auth, params.athleteId);
      const coach = params.coachId ? store.coachById(params.coachId) : coachFor(auth);
      if (!coach) throw err('INVALID_INPUT', 'assignSport requires a coach.');
      const link = store.links.find(l => l.coachId === coach.id
        && l.athleteId === params.athleteId && l.status === 'active');
      if (!link) throw err('ATHLETE_NOT_FOUND', 'No active coach-athlete link for this athlete.');
      link.sport = params.sport;
      link.positions = Array.isArray(params.positions) ? params.positions : (link.positions || []);
      const athlete = requireAthlete(params.athleteId);
      if (!athlete.sports.includes(params.sport)) athlete.sports = [...athlete.sports, params.sport];
      store.audit(auth.authUserId, 'assign_sport', { athleteId: athlete.id, sport: params.sport }, new Date(now).toISOString());
      return { link, athlete };
    },

    setDevelopmentGoals(auth, params = {}) {
      requireAuth(auth, 'setDevelopmentGoals');
      const now = params.now ?? Date.now();
      if (!params.athleteId || !params.goal) throw err('INVALID_INPUT', 'setDevelopmentGoals requires athleteId and goal.');
      requireScopeWrite(auth, params.athleteId);
      const coach = coachFor(auth);
      const goal = {
        id: store.newId(), athleteId: params.athleteId,
        coachId: coach ? coach.id : (params.coachId || null),
        goal: params.goal, targetDate: params.targetDate || null,
        status: 'active', createdAt: new Date(now).toISOString(),
      };
      store.developmentGoals.push(goal);
      store.audit(auth.authUserId, 'set_development_goal', { athleteId: goal.athleteId, goalId: goal.id }, new Date(now).toISOString());
      return { goal };
    },

    updateDevelopmentGoal(auth, params = {}) {
      requireAuth(auth, 'updateDevelopmentGoal');
      const now = params.now ?? Date.now();
      const goal = store.developmentGoals.find(g => g.id === String(params.goalId));
      if (!goal) throw err('INVALID_INPUT', 'Development goal not found.');
      requireScopeWrite(auth, goal.athleteId);
      if (params.status != null) {
        if (!['active', 'completed', 'cancelled'].includes(params.status)) {
          throw err('INVALID_INPUT', "status must be 'active', 'completed', or 'cancelled'.");
        }
        goal.status = params.status;
      }
      if (params.goal != null) goal.goal = params.goal;
      if (params.targetDate !== undefined) goal.targetDate = params.targetDate;
      goal.updatedAt = new Date(now).toISOString();
      store.audit(auth.authUserId, 'update_development_goal', { goalId: goal.id, status: goal.status }, new Date(now).toISOString());
      return { goal };
    },

    listDevelopmentGoals(auth, params = {}) {
      requireAuth(auth, 'listDevelopmentGoals');
      requireScopeRead(auth, params.athleteId);
      return { goals: store.goalsForAthlete(params.athleteId) };
    },

    recordScoutingEvaluation(auth, params = {}) {
      requireAuth(auth, 'recordScoutingEvaluation');
      const now = params.now ?? Date.now();
      if (!params.athleteId || !params.body) throw err('INVALID_INPUT', 'recordScoutingEvaluation requires athleteId and body.');
      requireScopeWrite(auth, params.athleteId);
      const coach = coachFor(auth);
      const evaluation = {
        id: store.newId(), athleteId: params.athleteId,
        coachId: coach ? coach.id : (params.coachId || null),
        body: params.body,
        // Coach-authored evaluations are coach-approved on record;
        // only coach-approved evaluations enter the public profile.
        coachApproved: params.coachApproved !== false,
        approvedBy: coach ? coach.id : auth.authUserId,
        approvedAt: new Date(now).toISOString(),
        createdAt: new Date(now).toISOString(),
      };
      store.scoutingEvaluations.push(evaluation);
      store.audit(auth.authUserId, 'record_scouting_evaluation', { athleteId: evaluation.athleteId, evaluationId: evaluation.id }, new Date(now).toISOString());
      return { evaluation };
    },

    listScoutingEvaluations(auth, params = {}) {
      requireAuth(auth, 'listScoutingEvaluations');
      requireScopeRead(auth, params.athleteId);
      return { evaluations: store.evaluationsForAthlete(params.athleteId) };
    },

    /* --- org admin --- */

    orgOverview(auth, params = {}) {
      requireAuth(auth, 'orgOverview');
      const now = params.now ?? Date.now();
      if (!params.organizationId) throw err('INVALID_INPUT', 'orgOverview requires organizationId.');
      const org = store.orgById(params.organizationId);
      if (!org) throw err('INVALID_INPUT', 'Organization not found.');
      const u = appUserFor(auth);
      if (auth.role !== 'director' && !(u && store.isOrgAdmin(u.id, org.id))) {
        throw err('FORBIDDEN', 'Only an org admin may view this organization.');
      }
      const members = store.membershipsForOrg(org.id);
      const coaches = members
        .map(m => store.coachByUserId(m.appUserId))
        .filter(Boolean)
        .map(c => ({ coach: c, athleteCount: store.activeLinksForCoach(c.id).length }));
      const links = store.activeLinksForOrg(org.id);
      const athleteIds = [...new Set(links.map(l => l.athleteId))];
      return {
        organization: org,
        entitlements: resolveOrgEntitlements(store, org.id, now),
        coaches,
        athleteCount: athleteIds.length,
        athletes: athleteIds.map(id => store.athleteById(id)).filter(Boolean),
        pendingInvitations: store.invitations.filter(i => i.organizationId === org.id && i.status === 'pending').length,
      };
    },
  };
}

module.exports = { createSaasApi, ALLOWED };
