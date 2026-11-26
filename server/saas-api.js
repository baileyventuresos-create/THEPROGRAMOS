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
const { isValidGameId, isAssignableGameId, BUILDS } = require('./saas-store');
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
};

const DAY_MS = 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * DAY_MS;

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
