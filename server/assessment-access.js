/* THE PROGRAM OS — Assessment access control (service layer)
 * server/assessment-access.js
 *
 * Who may assess whom, and who may view whose results. This is the
 * JavaScript enforcement for the assessment workflow; Postgres RLS
 * (migrations 003 + 004) is the backstop for direct PostgREST callers.
 *
 * Roles (same vocabulary as server/api.js):
 *   - director: everything.
 *   - coach: assess + view only athletes in their own cohorts.
 *   - parent: view only athletes they are guardian of. Parents never
 *     record assessments (recording is coach/director only).
 *   - athlete: view only their own records.
 *   - anyone else / missing auth: UNAUTHENTICATED; out-of-scope:
 *     FORBIDDEN. The actor is ALWAYS the auth UID — a client-supplied
 *     actor is never trusted (same rule as server/api.js).
 *
 * Directory records (in-memory for tests/dev; production mapping in
 * the header below):
 *   athlete: { id, age, coachIds: [coaches.id...],
 *              guardianUserIds: [app_users.auth_user_id...],
 *              authUserId: <the athlete's own Supabase Auth UID or null> }
 *   coachAuth: { [authUserId]: coachId } — maps a coach's Auth UID to
 *     their coaches.id record.
 *
 * Production mapping (Supabase): coachIds come from cohort_enrollments
 * joined through session_coaches/cohorts (the same membership the RLS
 * helper public.is_my_cohort_athlete() computes); guardianUserIds come
 * from athlete_guardians joined to guardians/app_users; an athlete's
 * authUserId is athletes.app_user_id (migration 003). The API transport
 * (Edge Function / server route) builds this directory from the
 * verified JWT and passes it in — this module never parses tokens.
 */
'use strict';

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function createAccessDirectory({ athletes = [], coachAuth = {} } = {}) {
  const byId = new Map();
  for (const a of athletes) byId.set(String(a.id), a);

  function coachIdFor(auth) {
    if (!auth) return null;
    if (typeof auth.coachId === 'string' && auth.coachId) return auth.coachId;
    if (auth.authUserId && coachAuth[auth.authUserId]) return coachAuth[auth.authUserId];
    return null;
  }

  function athleteFor(auth) {
    if (!auth) return null;
    if (typeof auth.athleteId === 'string' && auth.athleteId) return byId.get(auth.athleteId) || null;
    if (auth.authUserId) {
      for (const a of byId.values()) if (a.authUserId && a.authUserId === auth.authUserId) return a;
    }
    return null;
  }

  function requireAuth(auth) {
    if (!auth || typeof auth.authUserId !== 'string' || !auth.authUserId) {
      throw err('UNAUTHENTICATED', 'An authenticated user is required.');
    }
    if (!['director', 'coach', 'parent', 'athlete'].includes(auth.role)) {
      throw err('FORBIDDEN', `Role '${auth.role}' has no assessment access.`);
    }
    return auth;
  }

  /* Can this caller record assessments for this athlete? Coach +
   * director only, and a coach only for their own cohort athletes. */
  function canAssess(auth, athleteId) {
    requireAuth(auth);
    const a = byId.get(String(athleteId));
    if (!a) return false;
    if (auth.role === 'director') return true;
    if (auth.role !== 'coach') return false;
    const cid = coachIdFor(auth);
    return !!cid && Array.isArray(a.coachIds) && a.coachIds.includes(cid);
  }

  /* Can this caller view this athlete's assessment records?
   * Director: all. Coach: own cohort athletes. Parent: athletes they
   * guard. Athlete: themselves only. */
  function canView(auth, athleteId) {
    requireAuth(auth);
    const a = byId.get(String(athleteId));
    if (!a) return false;
    if (auth.role === 'director') return true;
    if (auth.role === 'coach') return canAssess(auth, athleteId);
    if (auth.role === 'parent') {
      return Array.isArray(a.guardianUserIds) && a.guardianUserIds.includes(auth.authUserId);
    }
    if (auth.role === 'athlete') {
      const self = athleteFor(auth);
      return !!self && String(self.id) === String(athleteId);
    }
    return false;
  }

  function requireAssess(auth, athleteId) {
    requireAuth(auth);
    if (!byId.has(String(athleteId))) throw err('ATHLETE_NOT_FOUND', 'Athlete not found.');
    if (!canAssess(auth, athleteId)) {
      throw err('FORBIDDEN', `Role '${auth.role}' may not record assessments for this athlete.`);
    }
  }

  function requireView(auth, athleteId) {
    requireAuth(auth);
    if (!byId.has(String(athleteId))) throw err('ATHLETE_NOT_FOUND', 'Athlete not found.');
    if (!canView(auth, athleteId)) {
      throw err('FORBIDDEN', `Role '${auth.role}' may not view this athlete's assessments.`);
    }
  }

  /* Athletes the caller may assess (coach/director) or view
   * (parent/athlete). Step 1 of the coach workflow: select an athlete. */
  function listAthletes(auth) {
    requireAuth(auth);
    const all = [...byId.values()];
    if (auth.role === 'director') return all.map(a => ({ ...a }));
    if (auth.role === 'coach') {
      const cid = coachIdFor(auth);
      return all.filter(a => cid && Array.isArray(a.coachIds) && a.coachIds.includes(cid)).map(a => ({ ...a }));
    }
    if (auth.role === 'parent') {
      return all.filter(a => Array.isArray(a.guardianUserIds) && a.guardianUserIds.includes(auth.authUserId)).map(a => ({ ...a }));
    }
    const self = athleteFor(auth);
    return self ? [{ ...self }] : [];
  }

  return { byId, coachIdFor, athleteFor, requireAuth, canAssess, canView, requireAssess, requireView, listAthletes };
}

module.exports = { createAccessDirectory };
