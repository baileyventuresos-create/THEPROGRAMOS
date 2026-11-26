/* THE PROGRAM OS — SaaS store (memory implementation + plan catalogue)
 * server/saas-store.js
 *
 * In-memory store for the SaaS layer (migrations 006-008 shape),
 * following the house pattern (assessment-store.js / reservation-
 * stores.js): plain JS, injected into the API layer, no network at
 * import time, synthetic data only in tests/dev. A Postgres-backed
 * implementation can slot in behind the same method surface later;
 * production reads/writes go through Supabase RLS (migrations
 * 006-008), never through this file.
 *
 * Also home to:
 *   - PLANS: the seeded plan catalogue (mirrors migration 008's
 *     INSERT; limits are data so tiers can be tuned without code).
 *   - Game validation: the existing 130-game library is referenced
 *     by TP2 ID. Valid IDs are TP2-001..TP2-130 minus the Safety
 *     Review / Retired games, which must never be assigned
 *     (docs/SAAS_ARCHITECTURE.md §1.6 / §2.2). No new drill library.
 */
'use strict';

const { randomUUID } = require('node:crypto');

/* Plan catalogue — mirrors migration 008 seed (market research §6).
 * Prices in cents; annual = 10x monthly. historyDays null = full
 * history display; maxCoachLinks null = unlimited; maxCoaches null
 * = unlimited. These are research recommendations seeded as data,
 * not approved public prices. */
const PLANS = {
  free_athlete: {
    code: 'free_athlete', audience: 'athlete', name: 'Athlete Free', active: true,
    limits: { maxAthletes: null, maxCoaches: null, historyDays: 90, maxCoachLinks: 1, canAssess: false, canAssign: false, trainingDaysPerWeek: 1, trialDays: 0, priceMonthlyCents: 0, priceAnnualCents: 0, overagePerAthleteCents: 0 },
  },
  athlete_remote: {
    code: 'athlete_remote', audience: 'athlete', name: 'Athlete Remote', active: true,
    limits: { maxAthletes: null, maxCoaches: null, historyDays: null, maxCoachLinks: null, canAssess: false, canAssign: false, trainingDaysPerWeek: null, trialDays: 0, priceMonthlyCents: 1499, priceAnnualCents: 14900, overagePerAthleteCents: 0 },
  },
  coach_starter: {
    code: 'coach_starter', audience: 'coach', name: 'Coach Starter', active: true,
    limits: { maxAthletes: 15, maxCoaches: 1, historyDays: null, maxCoachLinks: null, canAssess: true, canAssign: true, trialDays: 14, priceMonthlyCents: 2900, priceAnnualCents: 29000, overagePerAthleteCents: 200 },
  },
  coach_pro: {
    code: 'coach_pro', audience: 'coach', name: 'Coach Pro', active: true,
    limits: { maxAthletes: 50, maxCoaches: 3, historyDays: null, maxCoachLinks: null, canAssess: true, canAssign: true, trialDays: 14, priceMonthlyCents: 7900, priceAnnualCents: 79000, overagePerAthleteCents: 150 },
  },
  team_academy: {
    code: 'team_academy', audience: 'organization', name: 'Team / Academy', active: true,
    limits: { maxAthletes: 150, maxCoaches: null, historyDays: null, maxCoachLinks: null, canAssess: true, canAssign: true, trialDays: 14, priceMonthlyCents: 19900, priceAnnualCents: 199000, overagePerAthleteCents: 150 },
  },
  academy_scale: {
    code: 'academy_scale', audience: 'organization', name: 'Academy Scale', active: true,
    limits: { maxAthletes: 400, maxCoaches: null, historyDays: null, maxCoachLinks: null, canAssess: true, canAssign: true, trialDays: 14, priceMonthlyCents: 34900, priceAnnualCents: 349000, overagePerAthleteCents: 125 },
  },
};

/* The 130-game library (TP2-001..TP2-130) lives in THE PROGRAM
 * OS.html (window.TP_DATA). The server validates IDs against the
 * static range and the blocked set below — the 5 Safety Review
 * games and 1 Retired game must not be programmed (design §1.6). */
const GAME_ID_MIN = 1;
const GAME_ID_MAX = 130;
const BLOCKED_GAME_IDS = new Set([
  'TP2-084', 'TP2-090', 'TP2-092', 'TP2-093', 'TP2-098', // Safety Review
  'TP2-125', // Retired
]);

function isValidGameId(id) {
  if (typeof id !== 'string') return false;
  const m = /^TP2-(\d{3})$/.exec(id);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= GAME_ID_MIN && n <= GAME_ID_MAX;
}

function isAssignableGameId(id) {
  return isValidGameId(id) && !BLOCKED_GAME_IDS.has(id);
}

const BUILDS = ['LEARN', 'COMPETE', 'PRESSURE', 'CHAOS'];

const PROGRAM_INTERNAL_ORG_ID = '11111111-1111-4111-8111-111111111111';

class MemorySaasStore {
  constructor() {
    this.appUsers = new Map();        // id -> {id, authUserId, email, role}
    this.athletes = new Map();        // id -> {id, appUserId, name, age, dob, sports}
    this.coaches = new Map();         // id -> {id, userId, name, organizationId}
    this.organizations = new Map();   // id -> {id, kind, name, slug, status, createdBy}
    this.orgMemberships = [];         // {organizationId, appUserId, orgRole, status}
    this.links = [];                  // coach_athlete_links rows
    this.invitations = [];            // invitations rows (tokenHash only)
    this.consents = [];               // guardian_consents rows (append-only)
    this.guardians = new Map();       // id -> {id, userId}
    this.athleteGuardians = [];       // {athleteId, guardianId}
    this.assignments = new Map();     // id -> training_assignments row
    this.completions = new Map();     // id -> training_completions row
    this.subscriptions = new Map();   // id -> subscriptions row
    this.sponsorships = [];           // sponsorships rows
    this.billingEvents = new Map();   // providerEventId -> row
    this.memberships = [];            // in-person $149 memberships (existing table shape)
    this.auditEvents = [];            // {actor, action, detail, at}
    // Athlete Pathways V1 (migration 009 shape, memory mirror).
    this.complimentaryGrants = [];    // {id, athleteId, grantedBy, grantedAt, expiresAt, status, reason, revokedAt}
    this.prospectProfiles = new Map(); // id -> prospect profile row
    this.profileShares = [];          // {id, profileId, tokenHash, expiresAt, revokedAt, status, createdBy}
    this.recruitmentContacts = new Map(); // id -> recruitment contact row
    this.recruitmentOpportunities = [];   // {id, contactId, type, date, notes, createdBy}
    this.recruitmentNotes = [];       // {id, contactId, author, body, followUpDate, createdAt}
    this.referrals = [];              // {id, contactId, athleteId, status, outcome, referredAt, referredBy}
    this.prospectMediaLinks = [];     // {id, profileId, kind, url, title, approvedBy, approvedAt}
    this.developmentGoals = [];       // {id, athleteId, coachId, goal, targetDate, status}
    this.scoutingEvaluations = [];    // {id, athleteId, coachId, body, coachApproved, approvedBy, approvedAt, createdAt}
    this.plans = JSON.parse(JSON.stringify(PLANS));

    this.organizations.set(PROGRAM_INTERNAL_ORG_ID, {
      id: PROGRAM_INTERNAL_ORG_ID, kind: 'program_internal',
      name: 'The Program', slug: 'the-program-internal', status: 'active', createdBy: null,
    });
  }

  newId() { return randomUUID(); }

  audit(actor, action, detail, at) {
    this.auditEvents.push({ actor: actor || null, action, detail: detail || {}, at: at || new Date().toISOString() });
  }

  /* --- app users / profiles --- */
  appUserByAuthId(authUserId) {
    for (const u of this.appUsers.values()) if (u.authUserId === authUserId) return u;
    return null;
  }
  appUserById(id) { return this.appUsers.get(String(id)) || null; }
  athleteByAppUserId(appUserId) {
    for (const a of this.athletes.values()) if (a.appUserId === appUserId) return a;
    return null;
  }
  coachByUserId(userId) {
    for (const c of this.coaches.values()) if (c.userId === userId) return c;
    return null;
  }
  coachById(id) { return this.coaches.get(String(id)) || null; }
  athleteById(id) { return this.athletes.get(String(id)) || null; }
  orgById(id) { return this.organizations.get(String(id)) || null; }
  orgBySlug(slug) {
    for (const o of this.organizations.values()) if (o.slug === slug) return o;
    return null;
  }

  /* --- org memberships --- */
  membershipsForUser(appUserId) {
    return this.orgMemberships.filter(m => m.appUserId === appUserId && m.status === 'active');
  }
  membershipsForOrg(organizationId) {
    return this.orgMemberships.filter(m => m.organizationId === organizationId && m.status === 'active');
  }
  isOrgAdmin(appUserId, organizationId) {
    return this.orgMemberships.some(m => m.appUserId === appUserId
      && m.organizationId === organizationId && m.status === 'active' && m.orgRole === 'org_admin');
  }
  isOrgMember(appUserId, organizationId) {
    return this.orgMemberships.some(m => m.appUserId === appUserId
      && m.organizationId === organizationId && m.status === 'active');
  }

  /* --- links --- */
  activeLinksForCoach(coachId) {
    return this.links.filter(l => l.coachId === coachId && l.status === 'active');
  }
  activeLinksForAthlete(athleteId) {
    return this.links.filter(l => l.athleteId === athleteId && l.status === 'active');
  }
  activeLinksForOrg(organizationId) {
    return this.links.filter(l => l.organizationId === organizationId && l.status === 'active');
  }
  findActiveLink(coachId, athleteId, organizationId) {
    return this.links.find(l => l.coachId === coachId && l.athleteId === athleteId
      && l.organizationId === organizationId && l.status === 'active') || null;
  }

  /* --- consents --- */
  latestConsent(athleteId) {
    const rows = this.consents.filter(c => c.athleteId === athleteId);
    return rows.length ? rows[rows.length - 1] : null;
  }
  hasConsent(athleteId) {
    const latest = this.latestConsent(athleteId);
    return !!latest && latest.status === 'granted';
  }
  isGuardianOf(appUserId, athleteId) {
    return this.athleteGuardians.some(ag => {
      if (ag.athleteId !== athleteId) return false;
      const g = this.guardians.get(String(ag.guardianId));
      return !!g && g.userId === appUserId;
    });
  }
  guardianIdFor(appUserId, athleteId) {
    for (const ag of this.athleteGuardians) {
      if (ag.athleteId !== athleteId) continue;
      const g = this.guardians.get(String(ag.guardianId));
      if (g && g.userId === appUserId) return g.id;
    }
    return null;
  }

  /* --- subscriptions / sponsorships / memberships --- */
  subscriptionsFor(ownerType, ownerId) {
    return [...this.subscriptions.values()].filter(s => s.ownerType === ownerType && s.ownerId === ownerId);
  }
  activeSponsorshipsFor(athleteId) {
    return this.sponsorships.filter(s => s.athleteId === athleteId && s.status === 'active');
  }
  membershipsFor(athleteId) {
    return this.memberships.filter(m => m.athleteId === athleteId);
  }

  /* --- complimentary grants (Pathways G1) --- */
  activeComplimentaryGrantsFor(athleteId, now = Date.now()) {
    return this.complimentaryGrants.filter(g => g.athleteId === athleteId
      && g.status === 'active'
      && (g.expiresAt == null || Date.parse(g.expiresAt) > now));
  }
  complimentaryGrantById(id) {
    return this.complimentaryGrants.find(g => g.id === String(id)) || null;
  }

  /* --- prospect profiles / shares (Pathways G3) --- */
  prospectProfileById(id) { return this.prospectProfiles.get(String(id)) || null; }
  prospectProfileByAthlete(athleteId) {
    for (const p of this.prospectProfiles.values()) if (p.athleteId === athleteId) return p;
    return null;
  }
  profileShareByTokenHash(tokenHash) {
    return this.profileShares.find(s => s.tokenHash === tokenHash) || null;
  }
  profileSharesFor(profileId) {
    return this.profileShares.filter(s => s.profileId === profileId);
  }
  mediaLinksForProfile(profileId) {
    return this.prospectMediaLinks.filter(m => m.profileId === profileId);
  }

  /* --- recruitment CRM (Pathways G4) --- */
  recruitmentContactById(id) { return this.recruitmentContacts.get(String(id)) || null; }
  referralById(id) { return this.referrals.find(r => r.id === String(id)) || null; }
  opportunitiesForContact(contactId) {
    return this.recruitmentOpportunities.filter(o => o.contactId === contactId);
  }
  notesForContact(contactId) {
    return this.recruitmentNotes.filter(n => n.contactId === contactId);
  }
  referralsForContact(contactId) {
    return this.referrals.filter(r => r.contactId === contactId);
  }

  /* --- development goals / scouting evaluations (Pathways G6) --- */
  goalsForAthlete(athleteId) {
    return this.developmentGoals.filter(g => g.athleteId === athleteId);
  }
  evaluationsForAthlete(athleteId) {
    return this.scoutingEvaluations.filter(e => e.athleteId === athleteId);
  }
}

module.exports = {
  MemorySaasStore, PLANS, PROGRAM_INTERNAL_ORG_ID,
  isValidGameId, isAssignableGameId, BLOCKED_GAME_IDS, BUILDS,
};
