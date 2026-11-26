/* THE PROGRAM OS — Entitlement resolution (computed, never stored)
 * server/entitlements.js
 *
 * Resolves effective access from live rows, in the priority order
 * fixed by docs/SAAS_ARCHITECTURE.md §2.2/§2.3:
 *
 *   Athlete: (1) active in-person memberships row ($149) -> full
 *            paid remote access, never a second charge;
 *            (2) active sponsorship whose sponsor subscription is
 *            active/trialing -> paid access at the sponsor's tier;
 *            (3) the athlete's own active/trialing subscription;
 *            (4) otherwise the free tier.
 *   Coach:   org subscription (when the coach belongs to an org
 *            with one) > the coach's own subscription > none
 *            (read-only: roster/history visible, no new
 *            assessments/assignments/links).
 *
 * Pure functions over store rows + an injectable `now`, so expiry
 * and cancellation need no downgrade job: a lapsed subscription
 * simply stops resolving. No data is ever deleted on lapse.
 * Past-due grace: a past_due subscription still resolves until
 * current_period_end (design §2.3 default).
 */
'use strict';

function toTime(v) {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/* Is this subscription currently granting access at `now`?
 * trialing/active: yes (period end, if set, must be in the future).
 * past_due: yes until current_period_end (grace). cancelled: yes
 * until current_period_end when cancel_at_period_end, else no.
 * expired/incomplete: no. */
function subscriptionGrantsAccess(sub, now) {
  if (!sub) return false;
  const end = toTime(sub.currentPeriodEnd);
  const withinPeriod = end == null || end > now;
  switch (sub.status) {
    case 'trialing':
    case 'active':
      return withinPeriod;
    case 'past_due':
      return withinPeriod;
    case 'cancelled':
      return !!sub.cancelAtPeriodEnd && withinPeriod;
    default:
      return false;
  }
}

function bestSubscription(subs, now) {
  const granting = subs.filter(s => subscriptionGrantsAccess(s, now));
  if (!granting.length) return null;
  // Prefer the one with the latest period end (null end = open-ended wins).
  granting.sort((a, b) => {
    const ea = toTime(a.currentPeriodEnd); const eb = toTime(b.currentPeriodEnd);
    if (ea == null && eb == null) return 0;
    if (ea == null) return -1;
    if (eb == null) return 1;
    return eb - ea;
  });
  return granting[0];
}

/* In-person $149 membership covering `now` (same rule the
 * reservation engine applies: active/trialing covering the date). */
function membershipCovers(membership, now) {
  if (!membership) return false;
  if (!['active', 'trialing'].includes(membership.status)) return false;
  const start = toTime(membership.startDate);
  const end = toTime(membership.endDate);
  if (start != null && start > now) return false;
  if (end != null && end <= now) return false;
  return true;
}

function planLimits(store, planCode) {
  const plan = store.plans[planCode];
  return plan ? plan.limits : null;
}

/* Athlete entitlements. Returns:
 * { tier: 'member'|'sponsored'|'paid'|'free', planCode, source,
 *   fullHistory: bool, historyDays: number|null,
 *   maxCoachLinks: number|null, trainingDaysPerWeek: number|null,
 *   subscriptionId?, sponsorshipId?, membershipId? } */
function resolveAthleteEntitlements(store, athleteId, now = Date.now()) {
  // (1) In-person membership -> full remote access, no second charge.
  const membership = store.membershipsFor(athleteId).find(m => membershipCovers(m, now));
  if (membership) {
    const limits = planLimits(store, 'athlete_remote');
    return {
      tier: 'member', planCode: 'athlete_remote', source: 'in_person_membership',
      fullHistory: true, historyDays: null, maxCoachLinks: null,
      trainingDaysPerWeek: null, membershipId: membership.id || null,
      limits,
    };
  }
  // (2) Sponsorship whose sponsor subscription grants access.
  for (const sp of store.activeSponsorshipsFor(athleteId)) {
    let sponsorSub = null;
    if (sp.subscriptionId) {
      const s = store.subscriptions.get(String(sp.subscriptionId));
      if (s && subscriptionGrantsAccess(s, now)) sponsorSub = s;
    }
    if (!sponsorSub) {
      sponsorSub = bestSubscription(store.subscriptionsFor(sp.sponsorType, sp.sponsorId), now);
    }
    if (sponsorSub) {
      return {
        tier: 'sponsored', planCode: sponsorSub.planCode, source: 'sponsorship',
        fullHistory: true, historyDays: null, maxCoachLinks: null,
        trainingDaysPerWeek: null, sponsorshipId: sp.id, subscriptionId: sponsorSub.id,
        limits: planLimits(store, sponsorSub.planCode),
      };
    }
  }
  // (3) Athlete's own subscription.
  const own = bestSubscription(store.subscriptionsFor('athlete', athleteId), now);
  if (own) {
    const limits = planLimits(store, own.planCode) || {};
    return {
      tier: 'paid', planCode: own.planCode, source: 'own_subscription',
      fullHistory: limits.historyDays == null, historyDays: limits.historyDays ?? null,
      maxCoachLinks: limits.maxCoachLinks ?? null,
      trainingDaysPerWeek: limits.trainingDaysPerWeek ?? null,
      subscriptionId: own.id, limits,
    };
  }
  // (4) Free tier.
  const limits = planLimits(store, 'free_athlete') || {};
  return {
    tier: 'free', planCode: 'free_athlete', source: 'free',
    fullHistory: false, historyDays: limits.historyDays ?? 90,
    maxCoachLinks: limits.maxCoachLinks ?? 1,
    trainingDaysPerWeek: limits.trainingDaysPerWeek ?? 1,
    limits,
  };
}

/* Coach entitlements. Org subscription wins over the coach's own.
 * Returns { active: bool, planCode, source, limits, subscriptionId,
 * organizationId, readOnly: bool }. No granting subscription ->
 * readOnly true (roster/history visible; writes refused). */
function resolveCoachEntitlements(store, coachId, now = Date.now()) {
  const coach = store.coachById(coachId);
  if (!coach) return { active: false, readOnly: true, planCode: null, source: 'none', limits: null };
  // Org subscription first (coach's org, or any org they belong to).
  const orgIds = new Set();
  if (coach.organizationId) orgIds.add(coach.organizationId);
  for (const m of store.membershipsForUser(coach.userId)) orgIds.add(m.organizationId);
  for (const orgId of orgIds) {
    const sub = bestSubscription(store.subscriptionsFor('organization', orgId), now);
    if (sub) {
      return {
        active: true, readOnly: false, planCode: sub.planCode, source: 'organization_subscription',
        limits: planLimits(store, sub.planCode), subscriptionId: sub.id, organizationId: orgId,
      };
    }
  }
  const own = bestSubscription(store.subscriptionsFor('coach', coachId), now);
  if (own) {
    return {
      active: true, readOnly: false, planCode: own.planCode, source: 'own_subscription',
      limits: planLimits(store, own.planCode), subscriptionId: own.id,
      organizationId: coach.organizationId || null,
    };
  }
  return {
    active: false, readOnly: true, planCode: null, source: 'none', limits: null,
    organizationId: coach.organizationId || null,
  };
}

/* Org entitlements (for org-admin surfaces + coach-count caps). */
function resolveOrgEntitlements(store, organizationId, now = Date.now()) {
  const sub = bestSubscription(store.subscriptionsFor('organization', organizationId), now);
  if (!sub) return { active: false, readOnly: true, planCode: null, limits: null };
  return {
    active: true, readOnly: false, planCode: sub.planCode,
    limits: planLimits(store, sub.planCode), subscriptionId: sub.id,
  };
}

module.exports = {
  subscriptionGrantsAccess, bestSubscription, membershipCovers,
  resolveAthleteEntitlements, resolveCoachEntitlements, resolveOrgEntitlements,
};
