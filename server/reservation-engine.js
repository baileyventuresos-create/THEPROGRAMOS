/* THE PROGRAM OS — Reservation engine (operational foundation V1)
 *
 * A reusable, backend-side reservation engine. It enforces every rule
 * server-side; browser-side checks (if any UI is added later) are only a
 * convenience preview and must never be the enforcement point.
 *
 * Concurrency: reserve() is serialised per session by an in-process
 * mutex AND, where the store supports it, by a store transaction
 * (SQLite: BEGIN IMMEDIATE; PostgreSQL: the reserve_seat() function in
 * migrations/001, which takes a row lock on the session and re-checks
 * capacity inside the transaction, plus a partial unique index that
 * makes a duplicate confirmed reservation impossible even if two
 * writers race). Either layer alone prevents overbooking; both are
 * present so a deployment that swaps the store keeps the guarantee.
 *
 * Critical distinction, preserved throughout: a cohort's ENROLLMENT cap
 * (how many athletes may belong to the cohort) is not a session's
 * RESERVATION cap (how many may book one session). The session cap
 * comes from session-capacity.js: coaches, template, facility and
 * equipment for that session. The engine reads the session's stored
 * effectiveCap (computed at scheduling time) and never invents one.
 *
 * Membership: $149/athlete/month (fixed by the owner; this engine reads
 * membership status, it never sets price or activates billing).
 *
 * Human approval is preserved: this engine books seats; it never
 * generates, approves, or changes a training session. Session content
 * still requires a human-approved draft (prototype: draftSession +
 * Director approval).
 *
 * Store interface (see reservation-stores.js for the two implementations
 * shipped here — in-memory and SQLite; PostgreSQL via migrations/001):
 *   getSession(id) getAthlete(id) getMembership(athleteId, dateISO)
 *   coachAvailable(coachId, dateISO, startMin, endMin)
 *   listSessionsAt(locationId, spaceName, dateISO, startMin, endMin, excludeId)
 *   countConfirmed(sessionId) listConfirmed(sessionId)
 *   findReservation(sessionId, athleteId) listAthleteReservations(athleteId, dateISO)
 *   insertReservation(r) updateReservation(id, patch)
 *   listWaitlist(sessionId) insertWaitlist(w) updateWaitlist(id, patch)
 *   insertAttendance(a) listAttendance(sessionId)
 *   insertAudit(e) listAudit(filter)
 *   transaction(fn)? — if present, mutations run inside it.
 */
'use strict';

const { computeSessionCapacity } = require('./session-capacity');

const MEMBERSHIP_ACTIVE = ['active', 'trialing'];
const REJECTION = {
  SESSION_NOT_FOUND: 'Session not found.',
  SESSION_NOT_BOOKABLE: 'Session is not open for booking.',
  MEMBERSHIP: 'Athlete does not hold an active membership covering the session date.',
  INELIGIBLE_AGE: 'Athlete age is outside this cohort’s age band.',
  INELIGIBLE_COHORT: 'Athlete is not eligible for this cohort.',
  INELIGIBLE_READINESS: 'Athlete readiness/restriction blocks this session.',
  DUPLICATE: 'Athlete already holds a confirmed reservation for this session.',
  CONFLICT: 'Athlete already holds a confirmed reservation for an overlapping session.',
  COACH_UNAVAILABLE: 'A scheduled coach is unavailable and no substitute has been assigned.',
  FACILITY_CONFLICT: 'Facility/space is already booked for an overlapping session.',
  ALREADY_WAITLISTED: 'Athlete is already on the waitlist for this session.',
  RESERVATION_NOT_FOUND: 'Reservation not found.',
  NOT_CONFIRMED: 'Only a confirmed reservation can be recorded as attended.',
};

function err(code, detail) {
  const e = new Error(REJECTION[code] || code);
  e.code = code; if (detail) e.detail = detail; return e;
}
function minutes(t) {
  const m = String(t || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let h = +m[1]; if (/pm/i.test(m[3]) && h < 12) h += 12; if (/am/i.test(m[3]) && h === 12) h = 0;
  return h * 60 + (+m[2]);
}
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }
function membershipCovers(m, dateISO) {
  if (!m || !MEMBERSHIP_ACTIVE.includes(m.status)) return false;
  if (m.startDate && dateISO < m.startDate) return false;
  if (m.endDate && dateISO > m.endDate) return false;
  return true;
}

class ReservationEngine {
  constructor(store, opts) {
    this.store = store;
    this.opts = Object.assign({ waitlistEnabled: true }, opts || {});
    this._locks = new Map(); // sessionId -> promise chain (per-session mutex)
  }

  _withLock(sessionId, fn) {
    const prev = this._locks.get(sessionId) || Promise.resolve();
    const run = prev.then(fn, fn);
    this._locks.set(sessionId, run.then(() => undefined, () => undefined));
    return run;
  }

  _tx(fn) {
    return typeof this.store.transaction === 'function'
      ? this.store.transaction(fn) : fn();
  }

  /* Effective capacity for a session: the stored computed cap when the
   * session was scheduled; recomputed live when capacity inputs are
   * present so a changed coach roster/equipment is honoured.
   *
   * INFEASIBLE-SESSION GUARD (fixed 2026-11-12): a session whose computed
   * capacity is not feasible, or whose effective cap is 0 (zero coaches,
   * equipment shortfall), REFUSES to book — it never silently waitlists.
   * A waitlist entry on such a session would promise a seat that can
   * never exist. reserve_seat() in migrations/001 enforces the same
   * guard atomically in Postgres for direct callers. */
  async capacityFor(session) {
    if (session.capacityInput) {
      const d = computeSessionCapacity(session.capacityInput);
      if (!d.feasible || d.effectiveCap <= 0) {
        throw err('SESSION_NOT_BOOKABLE',
          `Session is not bookable: ${d.infeasibleReasons.join(' ') || 'computed capacity is 0.'}`);
      }
      return { effectiveCap: d.effectiveCap, decision: d };
    }
    if (Number.isFinite(+session.capacityEffective)) {
      if (+session.capacityEffective <= 0) {
        throw err('SESSION_NOT_BOOKABLE', 'Session has an effective capacity of 0 (no coach or equipment shortfall); it cannot be booked.');
      }
      return { effectiveCap: +session.capacityEffective, decision: null };
    }
    throw err('SESSION_NOT_BOOKABLE', 'Session has no computed capacity. Schedule it through the capacity adapter first — capacity is never guessed.');
  }

  /* Cohort eligibility — SOURCE OF TRUTH (decided 2026-11-12):
   * the cohort_enrollments join table is the single source of truth.
   * athletes.eligible_cohort_ids is only a hydrated snapshot of it: the
   * Postgres store (server/postgres-store.js) builds the array from
   * cohort_enrollments (status='enrolled') at read time. The engine
   * therefore treats the array as authoritative when present: an array —
   * INCLUDING an empty array — requires the session's cohort to be listed
   * (empty array = eligible for no cohort). The check is skipped ONLY
   * when the field is undefined/null, i.e. legacy in-memory fixtures
   * that predate the enrollment model. Never grant eligibility by editing
   * the array; insert a cohort_enrollments row. */
  async eligibility(session, athlete, dateISO) {
    const checks = [];
    const membership = await this.store.getMembership(athlete.id, dateISO);
    if (!membershipCovers(membership, dateISO)) {
      checks.push({ code: 'MEMBERSHIP', detail: membership ? `Membership status: ${membership.status}.` : 'No membership record.' });
    }
    const cohort = session.cohort || null;
    if (cohort) {
      if (athlete.age < cohort.age[0] || athlete.age > cohort.age[1]) {
        checks.push({ code: 'INELIGIBLE_AGE', detail: `Athlete age ${athlete.age}; cohort band ${cohort.age[0]}–${cohort.age[1]}.` });
      }
      if (Array.isArray(athlete.eligibleCohortIds) && !athlete.eligibleCohortIds.includes(cohort.id)) {
        checks.push({ code: 'INELIGIBLE_COHORT', detail: `Athlete is not listed as eligible for cohort ${cohort.id}.` });
      }
    }
    const restrictions = athlete.restrictions || [];
    const blocked = restrictions.filter(r => (session.emphasis || []).includes(r) || (session.blockedBy || []).includes(r));
    if (blocked.length) checks.push({ code: 'INELIGIBLE_READINESS', detail: `Restriction(s): ${blocked.join(', ')}.` });
    return { ok: checks.length === 0, checks, membership };
  }

  /* Reserve a seat. Returns { outcome:'confirmed', reservation } or
   * { outcome:'waitlisted', waitlist } — never silently overbooks. */
  async reserve({ sessionId, athleteId, actor }) {
    return this._withLock(sessionId, async () => {
      try {
        return await this._tx(() => this._reserveInsideTx({ sessionId, athleteId, actor }));
      } catch (e) {
        // Eligibility rejections are audited OUTSIDE the transaction: the
        // store rolls the transaction back on error, which would otherwise
        // erase the audit record of the rejected attempt (found by test:
        // SQLite rolled back the in-transaction RESERVE_REJECTED row).
        if (e && e.code && ['MEMBERSHIP', 'INELIGIBLE_AGE', 'INELIGIBLE_COHORT', 'INELIGIBLE_READINESS'].includes(e.code)) {
          try {
            await this.store.insertAudit({ entityType: 'reservation', entityId: `${sessionId}:${athleteId}`,
              action: 'RESERVE_REJECTED', actor: actor || 'system',
              detail: `${e.code}: ${e.detail || ''}` });
          } catch (_) { /* audit must never mask the rejection itself */ }
        }
        throw e;
      }
    });
  }

  async _reserveInsideTx({ sessionId, athleteId, actor }) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw err('SESSION_NOT_FOUND');
      if (session.status !== 'scheduled') throw err('SESSION_NOT_BOOKABLE', `Session status: ${session.status}.`);
      const athlete = await this.store.getAthlete(athleteId);
      if (!athlete) throw err('INELIGIBLE_COHORT', 'Athlete not found.');
      const dateISO = session.date;
      const elig = await this.eligibility(session, athlete, dateISO);
      if (!elig.ok) {
        throw err(elig.checks[0].code, elig.checks[0].detail);
      }
      const dup = await this.store.findReservation(sessionId, athleteId);
      if (dup && dup.status === 'confirmed') throw err('DUPLICATE');
      // Session conflict: overlapping confirmed reservation same day.
      const mine = await this.store.listAthleteReservations(athleteId, dateISO);
      const s0 = minutes(session.startTime), s1 = s0 + (+session.durationMin || 60);
      for (const r of mine) {
        if (r.status !== 'confirmed' || r.sessionId === sessionId) continue;
        const other = await this.store.getSession(r.sessionId);
        if (!other) continue;
        const o0 = minutes(other.startTime), o1 = o0 + (+other.durationMin || 60);
        if (o0 != null && overlaps(s0, s1, o0, o1)) throw err('CONFLICT', `Overlaps session ${other.id} (${other.startTime}).`);
      }
      // Coach availability (no silent substitution).
      for (const coachId of session.coaches || []) {
        const ok = await this.store.coachAvailable(coachId, dateISO, s0, s1);
        if (!ok) throw err('COACH_UNAVAILABLE', `Coach ${coachId} is unavailable for this slot.`);
      }
      // Facility conflict: same location+space, overlapping time.
      if (session.locationId) {
        const clash = await this.store.listSessionsAt(session.locationId, session.space || null, dateISO, s0, s1, sessionId);
        const live = clash.filter(s => s.status === 'scheduled');
        if (live.length) throw err('FACILITY_CONFLICT', `Space already booked by session ${live[0].id}.`);
      }
      const { effectiveCap } = await this.capacityFor(session);
      const confirmed = await this.store.countConfirmed(sessionId);
      if (confirmed >= effectiveCap) {
        if (!this.opts.waitlistEnabled) throw err('SESSION_NOT_BOOKABLE', `Session is full (${confirmed}/${effectiveCap}).`);
        const existing = (await this.store.listWaitlist(sessionId))
          .find(w => w.athleteId === athleteId && w.status === 'waiting');
        if (existing) throw err('ALREADY_WAITLISTED', `Already waitlisted at position ${existing.position}.`);
        const wait = await this.store.insertWaitlist({ sessionId, athleteId,
          status: 'waiting', actor: actor || 'system' });
        await this.store.insertAudit({ entityType: 'waitlist', entityId: wait.id,
          action: 'WAITLISTED', actor: actor || 'system',
          detail: `Session full (${confirmed}/${effectiveCap}); position ${wait.position}.` });
        return { outcome: 'waitlisted', waitlist: wait, capacity: effectiveCap, confirmed };
      }
      const reservation = await this.store.insertReservation({
        sessionId, athleteId, status: 'confirmed', actor: actor || 'system' });
      await this.store.insertAudit({ entityType: 'reservation', entityId: reservation.id,
        action: 'RESERVED', actor: actor || 'system',
        detail: `Seat ${confirmed + 1}/${effectiveCap} for session ${sessionId}.` });
      return { outcome: 'confirmed', reservation, capacity: effectiveCap, confirmed: confirmed + 1 };
  }

  /* Cancel + automatic waitlist promotion (re-checking eligibility at
   * promotion time; ineligible candidates are skipped, never promoted). */
  async cancel({ reservationId, actor, reason }) {
    const reservation = await this.store.getReservation(reservationId);
    if (!reservation) throw err('RESERVATION_NOT_FOUND');
    if (reservation.status === 'cancelled') return { cancelled: reservation, promoted: null, skipped: [] };
    return this._withLock(reservation.sessionId, () => this._tx(async () => {
      const cancelled = await this.store.updateReservation(reservationId,
        { status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: reason || null });
      await this.store.insertAudit({ entityType: 'reservation', entityId: reservationId,
        action: 'CANCELLED', actor: actor || 'system', detail: reason || '' });
      const promoted = await this._promoteNext(reservation.sessionId, actor);
      return { cancelled, promoted: promoted.reservation, skipped: promoted.skipped };
    }));
  }

  async _promoteNext(sessionId, actor) {
    const session = await this.store.getSession(sessionId);
    let effectiveCap;
    try {
      ({ effectiveCap } = await this.capacityFor(session));
    } catch (e) {
      // Session became infeasible (cap 0 / no computed capacity): nothing
      // can be promoted, but cancel() must still succeed — a cancellation
      // is not blocked by the session no longer being bookable.
      if (e && e.code === 'SESSION_NOT_BOOKABLE') return { reservation: null, skipped: [] };
      throw e;
    }
    const confirmed = await this.store.countConfirmed(sessionId);
    if (confirmed >= effectiveCap) return { reservation: null, skipped: [] };
    const skipped = [];
    const waiting = (await this.store.listWaitlist(sessionId)).filter(w => w.status === 'waiting');
    for (const w of waiting) {
      const athlete = await this.store.getAthlete(w.athleteId);
      if (!athlete) { await this.store.updateWaitlist(w.id, { status: 'skipped' }); skipped.push(w); continue; }
      const elig = await this.eligibility(session, athlete, session.date);
      const conflict = await this._hasConflict(w.athleteId, session);
      if (!elig.ok || conflict) {
        await this.store.updateWaitlist(w.id, { status: 'skipped' });
        await this.store.insertAudit({ entityType: 'waitlist', entityId: w.id,
          action: 'PROMOTION_SKIPPED', actor: actor || 'system',
          detail: conflict ? 'Session conflict at promotion time.' : elig.checks.map(c => c.code).join(', ') });
        skipped.push(w); continue;
      }
      const reservation = await this.store.insertReservation({
        sessionId, athleteId: w.athleteId, status: 'confirmed',
        actor: actor || 'system', promotedFromWaitlistId: w.id });
      await this.store.updateWaitlist(w.id, { status: 'promoted', promotedReservationId: reservation.id });
      await this.store.insertAudit({ entityType: 'reservation', entityId: reservation.id,
        action: 'WAITLIST_PROMOTED', actor: actor || 'system',
        detail: `Promoted from waitlist position ${w.position} after a cancellation.` });
      return { reservation, skipped };
    }
    return { reservation: null, skipped };
  }

  /* Bulk promotion after a capacity increase (e.g. after
   * recalculateCapacity() raises a session's cap): promote waiting
   * athletes, in order, until the session is full or the waitlist is
   * exhausted. cancel() promotes only one; this is the explicit path for
   * filling newly available seats. Each promotion re-checks eligibility
   * and conflicts via _promoteNext. Returns { promoted: [...], skipped: [...] }. */
  async promoteWaitlist(sessionId, actor) {
    const promoted = [];
    const skipped = [];
    for (;;) {
      const session = await this.store.getSession(sessionId);
      if (!session) throw err('SESSION_NOT_FOUND');
      let effectiveCap;
      try {
        ({ effectiveCap } = await this.capacityFor(session));
      } catch (e) {
        if (e && e.code === 'SESSION_NOT_BOOKABLE') break; // infeasible: nothing to promote
        throw e;
      }
      const confirmed = await this.store.countConfirmed(sessionId);
      if (confirmed >= effectiveCap) break;
      const next = await this._withLock(sessionId, () => this._tx(() => this._promoteNext(sessionId, actor)));
      skipped.push(...next.skipped);
      if (!next.reservation) break;
      promoted.push(next.reservation);
    }
    return { promoted, skipped };
  }

  async _hasConflict(athleteId, session) {
    const mine = await this.store.listAthleteReservations(athleteId, session.date);
    const s0 = minutes(session.startTime), s1 = s0 + (+session.durationMin || 60);
    for (const r of mine) {
      if (r.status !== 'confirmed' || r.sessionId === session.id) continue;
      const other = await this.store.getSession(r.sessionId);
      if (!other) continue;
      const o0 = minutes(other.startTime), o1 = o0 + (+other.durationMin || 60);
      if (o0 != null && overlaps(s0, s1, o0, o1)) return true;
    }
    return false;
  }

  async availableSeats(sessionId) {
    const session = await this.store.getSession(sessionId);
    if (!session) throw err('SESSION_NOT_FOUND');
    const { effectiveCap } = await this.capacityFor(session);
    const confirmed = await this.store.countConfirmed(sessionId);
    return { sessionId, capacity: effectiveCap, confirmed,
      available: Math.max(0, effectiveCap - confirmed),
      waitlisted: (await this.store.listWaitlist(sessionId)).filter(w => w.status === 'waiting').length };
  }

  /* Attendance: only a confirmed reservation can be marked attended /
   * no-show. A walk-in (no reservation) is recorded explicitly as such
   * and audited — it never silently becomes a reservation. */
  async recordAttendance({ sessionId, athleteId, status, actor, walkIn, note }) {
    const allowed = ['attended', 'no_show', 'late', 'excused'];
    if (!allowed.includes(status)) throw new Error(`Unknown attendance status: ${status}`);
    const session = await this.store.getSession(sessionId);
    if (!session) throw err('SESSION_NOT_FOUND');
    const reservation = await this.store.findReservation(sessionId, athleteId);
    if (!walkIn && (!reservation || reservation.status !== 'confirmed')) throw err('NOT_CONFIRMED');
    const row = await this.store.insertAttendance({ sessionId, athleteId, status,
      reservationId: reservation ? reservation.id : null, walkIn: !!walkIn,
      actor: actor || 'system', note: note || null });
    await this.store.insertAudit({ entityType: 'attendance', entityId: row.id,
      action: walkIn ? 'WALK_IN_RECORDED' : 'ATTENDANCE_RECORDED',
      actor: actor || 'system', detail: `${athleteId} → ${status} (session ${sessionId}).` });
    return row;
  }

  /* Reconciliation after a session: confirmed vs actually recorded. */
  async reconcileAttendance(sessionId) {
    const session = await this.store.getSession(sessionId);
    if (!session) throw err('SESSION_NOT_FOUND');
    const confirmed = await this.store.listConfirmed(sessionId);
    const records = await this.store.listAttendance(sessionId);
    const byAthlete = new Map(records.map(r => [r.athleteId, r]));
    const attended = records.filter(r => r.status === 'attended' || r.status === 'late');
    const noShow = records.filter(r => r.status === 'no_show');
    const unrecorded = confirmed.filter(r => !byAthlete.has(r.athleteId));
    const walkIns = records.filter(r => r.walkIn);
    return { sessionId, confirmed: confirmed.length, recorded: records.length,
      attended: attended.length, noShow: noShow.length, walkIns: walkIns.length,
      unrecorded: unrecorded.map(r => r.athleteId),
      attendanceRate: confirmed.length ? +(attended.length / confirmed.length).toFixed(3) : null };
  }
}

module.exports = { ReservationEngine, membershipCovers, REJECTION };
