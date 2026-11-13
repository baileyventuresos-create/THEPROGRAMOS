/* THE PROGRAM OS — Thin authenticated API layer (backend completion)
 *
 * A thin layer over ReservationEngine + a store (PostgresStore in
 * production, MemoryStore/SqliteStore in tests). It exposes exactly:
 * reserve, cancel, availableSeats, recordAttendance,
 * reconcileAttendance, capacityFor, promoteWaitlist.
 *
 * Auth model (minimal, deliberate):
 *   - Every method takes an injected auth context { authUserId, role }
 *     as its FIRST argument. The caller (e.g. a Supabase Edge Function
 *     or a server route) derives it from a verified Supabase Auth JWT —
 *     this module never parses tokens and never trusts anything the
 *     client sends.
 *   - `actor` is ALWAYS the auth UID. A client-supplied `actor` in the
 *     params is ignored (never trusted): audit rows must name the
 *     authenticated user, not whoever the caller claims to be.
 *   - Role checks run here in JS AND in Postgres via the RLS policies in
 *     migration 003 (defence in depth: the JS check is the API contract,
 *     RLS is the backstop for any direct PostgREST caller).
 *   - Role table: reserve/cancel — director, coach, parent. (An athlete
 *     never books directly; a parent/guardian books for a minor.)
 *     availableSeats — any authenticated role (read-only display).
 *     recordAttendance / reconcileAttendance / capacityFor /
 *     promoteWaitlist — director, coach.
 *   - Missing authUserId -> UNAUTHENTICATED; role not allowed ->
 *     FORBIDDEN. Engine rejections (MEMBERSHIP, DUPLICATE, ...) pass
 *     through unchanged with their codes.
 *
 * Testable without live Supabase: inject any store (and optionally an
 * engine) — see server/tests/api.test.js. No network, no credentials.
 * This module owns no writes itself: scheduling a session (writing
 * training_sessions rows) is a separate, Director-only step that uses
 * server/schedule-session.js to build the row payload.
 */
'use strict';

const { ReservationEngine } = require('./reservation-engine');

const ALLOWED = {
  reserve: ['director', 'coach', 'parent'],
  cancel: ['director', 'coach', 'parent'],
  availableSeats: ['director', 'coach', 'parent', 'athlete'],
  recordAttendance: ['director', 'coach'],
  reconcileAttendance: ['director', 'coach'],
  capacityFor: ['director', 'coach'],
  promoteWaitlist: ['director', 'coach'],
};

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function requireAuth(auth, method) {
  if (!auth || typeof auth.authUserId !== 'string' || !auth.authUserId) {
    throw err('UNAUTHENTICATED', 'An authenticated user is required.');
  }
  if (!ALLOWED[method].includes(auth.role)) {
    throw err('FORBIDDEN', `Role '${auth.role}' may not call ${method}.`);
  }
  return auth.authUserId; // actor: always the auth UID, never client input
}

function createApi({ store, engine } = {}) {
  if (!store) throw new Error('createApi requires a store.');
  const eng = engine || new ReservationEngine(store);

  return {
    engine: eng,
    store,

    async reserve(auth, params) {
      const actor = requireAuth(auth, 'reserve');
      if (!params || !params.sessionId || !params.athleteId) {
        throw err('INVALID_INPUT', 'reserve requires sessionId and athleteId.');
      }
      // NOTE: params.actor, if present, is deliberately ignored.
      return eng.reserve({ sessionId: params.sessionId, athleteId: params.athleteId, actor });
    },

    async cancel(auth, params) {
      const actor = requireAuth(auth, 'cancel');
      if (!params || !params.reservationId) {
        throw err('INVALID_INPUT', 'cancel requires reservationId.');
      }
      return eng.cancel({ reservationId: params.reservationId, actor, reason: params.reason || null });
    },

    async availableSeats(auth, sessionId) {
      requireAuth(auth, 'availableSeats');
      if (!sessionId) throw err('INVALID_INPUT', 'availableSeats requires sessionId.');
      return eng.availableSeats(sessionId);
    },

    async recordAttendance(auth, params) {
      const actor = requireAuth(auth, 'recordAttendance');
      if (!params || !params.sessionId || !params.athleteId || !params.status) {
        throw err('INVALID_INPUT', 'recordAttendance requires sessionId, athleteId and status.');
      }
      return eng.recordAttendance({
        sessionId: params.sessionId, athleteId: params.athleteId,
        status: params.status, actor,
        walkIn: !!params.walkIn, note: params.note || null,
      });
    },

    async reconcileAttendance(auth, sessionId) {
      requireAuth(auth, 'reconcileAttendance');
      if (!sessionId) throw err('INVALID_INPUT', 'reconcileAttendance requires sessionId.');
      return eng.reconcileAttendance(sessionId);
    },

    async capacityFor(auth, sessionId) {
      requireAuth(auth, 'capacityFor');
      if (!sessionId) throw err('INVALID_INPUT', 'capacityFor requires sessionId.');
      const session = await store.getSession(sessionId);
      if (!session) {
        const e = new Error('Session not found.');
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }
      return eng.capacityFor(session);
    },

    async promoteWaitlist(auth, sessionId) {
      const actor = requireAuth(auth, 'promoteWaitlist');
      if (!sessionId) throw err('INVALID_INPUT', 'promoteWaitlist requires sessionId.');
      return eng.promoteWaitlist(sessionId, actor);
    },
  };
}

module.exports = { createApi, ALLOWED };
