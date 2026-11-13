/* Reservation engine tests — run against BOTH stores (MemoryStore and
 * SqliteStore) so the concurrency guarantee is proven in the store that
 * will stand in for PostgreSQL locally, not only in memory.
 * Run: node --test server/tests/reservation-engine.test.js
 * Fixtures: server/fixtures/seed-operational.json (fictional test athletes).
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { ReservationEngine } = require('../reservation-engine');
const { MemoryStore, SqliteStore } = require('../reservation-stores');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'seed-operational.json'), 'utf8'));

function session(overrides) {
  return Object.assign({
    id: 'sess-yaka-0615', cohortId: 'YAK-A',
    cohort: { id: 'YAK-A', age: [9, 11] },
    locationId: 'YAK', space: 'Main gym',
    date: '2027-06-15', startTime: '4:30 PM', durationMin: 60,
    coaches: ['kayla', 'marcus', 'jordan'],
    status: 'scheduled', capacityEffective: 2,
    emphasis: ['Acceleration'],
  }, overrides || {});
}
function otherSession(overrides) {
  return session(Object.assign({ id: 'sess-yakb-0615', cohortId: 'YAK-B',
    cohort: { id: 'YAK-B', age: [11, 13] }, locationId: 'ELL', space: 'Turf strip',
    startTime: '4:30 PM' }, overrides || {}));
}

function buildStore(kind, extraSeed) {
  const s = JSON.parse(JSON.stringify(seed));
  Object.assign(s, extraSeed || {});
  s.sessions = [session()];
  if (kind === 'sqlite') { const st = new SqliteStore(':memory:'); st.loadSeed(s); return st; }
  return new MemoryStore(s);
}

function addSession(store, kind, s) {
  const row = JSON.parse(JSON.stringify(s));
  if (kind === 'memory') store.sessions.set(row.id, row);
  else store.db.prepare('INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)').run(row.id, JSON.stringify(row));
}

async function expectReject(promise, code) {
  try { await promise; assert.fail(`expected rejection with code ${code}`); }
  catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); }
}

for (const kind of ['memory', 'sqlite']) {
  test(`[${kind}] booking the final available seat succeeds; the next books the waitlist`, async () => {
    const store = buildStore(kind);
    const eng = new ReservationEngine(store);
    const r1 = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' });
    assert.equal(r1.outcome, 'confirmed');
    const r2 = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02', actor: 'director' });
    assert.equal(r2.outcome, 'confirmed'); // 2/2 — final seat
    const seats = await eng.availableSeats('sess-yaka-0615');
    assert.equal(seats.available, 0);
    const r3 = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-07', actor: 'director' });
    assert.equal(r3.outcome, 'waitlisted');
    assert.equal(r3.waitlist.position, 1);
    assert.equal(await store.countConfirmed('sess-yaka-0615'), 2, 'never overbooks');
  });

  test(`[${kind}] two simultaneous attempts for one remaining seat: exactly one confirms`, async () => {
    const store = buildStore(kind);
    const eng = new ReservationEngine(store);
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' });
    const [a, b] = await Promise.allSettled([
      eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02', actor: 'director' }),
      eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-07', actor: 'director' }),
    ]);
    const outcomes = [a, b].map(r => (r.status === 'fulfilled' ? r.value.outcome : `rejected:${r.reason.code}`));
    assert.equal(outcomes.filter(o => o === 'confirmed').length, 1, `outcomes: ${outcomes}`);
    assert.equal(outcomes.filter(o => o === 'waitlisted').length, 1, `outcomes: ${outcomes}`);
    assert.equal(await store.countConfirmed('sess-yaka-0615'), 2);
  });

  test(`[${kind}] duplicate booking is rejected and is idempotent-safe`, async () => {
    const store = buildStore(kind);
    const eng = new ReservationEngine(store);
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' });
    await expectReject(eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' }), 'DUPLICATE');
    assert.equal(await store.countConfirmed('sess-yaka-0615'), 1);
  });

  test(`[${kind}] cancellation promotes the first eligible waitlisted athlete; conflicted candidate is skipped`, async () => {
    const store = buildStore(kind);
    const eng = new ReservationEngine(store);
    const r1 = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' });
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02', actor: 'director' });
    // Fill the session, then waitlist two athletes (07 first, 08 second).
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-07', actor: 'director' });
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-08', actor: 'director' });
    // 07 books the overlapping session, so at promotion time 07 conflicts.
    // (07 is age 10; YAK-B band is 11-13, so use a same-cohort overlapping session instead.)
    const overlap = session({ id: 'sess-yaka-overlap', startTime: '5:00 PM', locationId: 'ELL', space: 'Turf strip', coaches: ['jordan'] });
    addSession(store, kind, overlap);
    const ob = await eng.reserve({ sessionId: 'sess-yaka-overlap', athleteId: 'ath-test-07', actor: 'director' });
    assert.equal(ob.outcome, 'confirmed');
    const out = await eng.cancel({ reservationId: r1.reservation.id, actor: 'director', reason: 'athlete ill' });
    assert.equal(out.promoted.athleteId, 'ath-test-08', 'conflicted 07 skipped, 08 promoted');
    assert.deepEqual(out.skipped.map(w => w.athleteId), ['ath-test-07']);
    assert.equal(await store.countConfirmed('sess-yaka-0615'), 2);
    const audit = await store.listAudit({ action: 'WAITLIST_PROMOTED' });
    assert.equal(audit.length, 1);
  });

  test(`[${kind}] expired membership cannot reserve`, async () => {
    const eng = new ReservationEngine(buildStore(kind));
    await expectReject(eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-04', actor: 'director' }), 'MEMBERSHIP');
  });

  test(`[${kind}] ineligible athlete (age band, readiness restriction) cannot reserve`, async () => {
    const eng = new ReservationEngine(buildStore(kind));
    await expectReject(eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-05', actor: 'director' }), 'INELIGIBLE_AGE');
    const store = buildStore(kind);
    const eng2 = new ReservationEngine(store);
    // ath-test-06 is 15 (YAK-C band) — use a YAK-C session for the restriction check.
    const sC = session({ id: 'sess-yakc-0615', cohortId: 'YAK-C', cohort: { id: 'YAK-C', age: [14, 18] }, emphasis: ['Competitive Conditioning'], startTime: '6:15 PM' });
    addSession(store, kind, sC);
    await expectReject(eng2.reserve({ sessionId: 'sess-yakc-0615', athleteId: 'ath-test-06', actor: 'director' }), 'INELIGIBLE_READINESS');
  });

  test(`[${kind}] coach unavailability blocks booking (no silent substitution)`, async () => {
    const store = buildStore(kind, { coachUnavailability: [{ coachId: 'kayla', date: '2027-06-15', startMin: 16 * 60, endMin: 18 * 60 }] });
    const eng = new ReservationEngine(store);
    await expectReject(eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' }), 'COACH_UNAVAILABLE');
  });

  test(`[${kind}] facility scheduling conflict blocks booking`, async () => {
    const store = buildStore(kind);
    const clash = session({ id: 'sess-clash', startTime: '5:00 PM' }); // same gym, overlapping
    addSession(store, kind, clash);
    const eng = new ReservationEngine(store);
    await expectReject(eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' }), 'FACILITY_CONFLICT');
  });

  test(`[${kind}] athlete session conflict (overlapping booking) is rejected`, async () => {
    const store = buildStore(kind);
    const overlap = session({ id: 'sess-yaka-overlap2', startTime: '5:00 PM', locationId: 'ELL', space: 'Turf strip', coaches: ['jordan'] });
    addSession(store, kind, overlap);
    const eng = new ReservationEngine(store);
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' });
    await expectReject(eng.reserve({ sessionId: 'sess-yaka-overlap2', athleteId: 'ath-test-01', actor: 'director' }), 'CONFLICT');
  });

  test(`[${kind}] attendance recording + reconciliation`, async () => {
    const store = buildStore(kind);
    const eng = new ReservationEngine(store);
    const r1 = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'coach' });
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02', actor: 'coach' });
    await eng.recordAttendance({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', status: 'attended', actor: 'coach' });
    await eng.recordAttendance({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02', status: 'no_show', actor: 'coach' });
    await expectReject(eng.recordAttendance({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-07', status: 'attended', actor: 'coach' }), 'NOT_CONFIRMED');
    const walkIn = await eng.recordAttendance({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-07', status: 'attended', actor: 'coach', walkIn: true });
    assert.equal(walkIn.walkIn, true);
    const rec = await eng.reconcileAttendance('sess-yaka-0615');
    assert.equal(rec.confirmed, 2);
    assert.equal(rec.attended, 2); // 01 attended + 07 walk-in
    assert.equal(rec.noShow, 1);
    assert.equal(rec.walkIns, 1);
    assert.deepEqual(rec.unrecorded, []);
    assert.equal(rec.attendanceRate, 1);
    assert.equal(r1.reservation.status, 'confirmed');
  });

  test(`[${kind}] audit trail records reservations, cancellations and rejections`, async () => {
    const store = buildStore(kind);
    const eng = new ReservationEngine(store);
    const r = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' });
    await eng.cancel({ reservationId: r.reservation.id, actor: 'director', reason: 'test' });
    await expectReject(eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-04', actor: 'director' }), 'MEMBERSHIP');
    const actions = (await store.listAudit()).map(e => e.action);
    assert.ok(actions.includes('RESERVED'));
    assert.ok(actions.includes('CANCELLED'));
    assert.ok(actions.includes('RESERVE_REJECTED'));
  });

  test(`[${kind}] session without a computed capacity cannot be booked (never guessed)`, async () => {
    const store = buildStore(kind);
    const noCap = session({ id: 'sess-nocap', locationId: 'CLE', space: 'Gym', startTime: '4:00 PM', coaches: ['marcus'] });
    delete noCap.capacityEffective;
    addSession(store, kind, noCap);
    const eng = new ReservationEngine(store);
    await expectReject(eng.reserve({ sessionId: 'sess-nocap', athleteId: 'ath-test-01', actor: 'director' }), 'SESSION_NOT_BOOKABLE');
  });

  test(`[${kind}] infeasible session refuses to book: zero coaches (no waitlist entry created)`, async () => {
    const store = buildStore(kind);
    const zeroCoach = session({ id: 'sess-zero-coach', locationId: 'CLE', space: 'Gym', startTime: '4:00 PM',
      coaches: [], capacityInput: { template: { id: 'p60', dur: 60, phases: { build: 24 } }, coachesAvailable: 0 } });
    delete zeroCoach.capacityEffective;
    addSession(store, kind, zeroCoach);
    const eng = new ReservationEngine(store);
    await expectReject(eng.reserve({ sessionId: 'sess-zero-coach', athleteId: 'ath-test-01', actor: 'director' }), 'SESSION_NOT_BOOKABLE');
    assert.equal((await store.listWaitlist('sess-zero-coach')).length, 0, 'refused booking must not create a waitlist entry');
    assert.equal(await store.countConfirmed('sess-zero-coach'), 0);
    await expectReject(eng.availableSeats('sess-zero-coach'), 'SESSION_NOT_BOOKABLE');
  });

  test(`[${kind}] infeasible session refuses to book: equipment shortfall`, async () => {
    const store = buildStore(kind);
    const shortfall = session({ id: 'sess-shortfall', locationId: 'CLE', space: 'Gym', startTime: '4:00 PM',
      coaches: ['marcus'],
      capacityInput: { template: { id: 'p60', dur: 60, phases: { build: 24 } }, coachesAvailable: 1,
        equipment: [{ item: 'cones', have: 0, needPerAthlete: 4 }] } });
    delete shortfall.capacityEffective;
    addSession(store, kind, shortfall);
    const eng = new ReservationEngine(store);
    await expectReject(eng.reserve({ sessionId: 'sess-shortfall', athleteId: 'ath-test-01', actor: 'director' }), 'SESSION_NOT_BOOKABLE');
    assert.equal((await store.listWaitlist('sess-shortfall')).length, 0, 'no waitlist entry on an infeasible session');
  });

  test(`[${kind}] stored effective capacity of 0 refuses to book`, async () => {
    const store = buildStore(kind);
    const zeroCap = session({ id: 'sess-zero-cap', locationId: 'CLE', space: 'Gym', startTime: '4:00 PM', coaches: ['marcus'], capacityEffective: 0 });
    addSession(store, kind, zeroCap);
    const eng = new ReservationEngine(store);
    await expectReject(eng.reserve({ sessionId: 'sess-zero-cap', athleteId: 'ath-test-01', actor: 'director' }), 'SESSION_NOT_BOOKABLE');
    assert.equal((await store.listWaitlist('sess-zero-cap')).length, 0);
  });

  test(`[${kind}] cancel still succeeds when the session has become infeasible (no promotion attempted)`, async () => {
    const store = buildStore(kind);
    const eng = new ReservationEngine(store);
    const r = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' });
    // Coach roster drops to zero after booking: stored cap is now 0.
    const s = await store.getSession('sess-yaka-0615');
    s.capacityInput = { template: { id: 'p60', dur: 60, phases: { build: 24 } }, coachesAvailable: 0 };
    delete s.capacityEffective;
    if (kind === 'memory') store.sessions.set(s.id, s);
    else store.db.prepare('INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)').run(s.id, JSON.stringify(s));
    const out = await eng.cancel({ reservationId: r.reservation.id, actor: 'director', reason: 'session infeasible' });
    assert.equal(out.cancelled.status, 'cancelled');
    assert.equal(out.promoted, null);
  });

  test(`[${kind}] promoteWaitlist fills seats opened by a capacity increase`, async () => {
    const store = buildStore(kind);
    const eng = new ReservationEngine(store);
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' });
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02', actor: 'director' });
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-07', actor: 'director' }); // waitlisted
    await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-08', actor: 'director' }); // waitlisted
    // Capacity raised 2 -> 4 (e.g. a coach added): bulk-promote both.
    const s = await store.getSession('sess-yaka-0615');
    s.capacityEffective = 4;
    if (kind === 'memory') store.sessions.set(s.id, s);
    else store.db.prepare('INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)').run(s.id, JSON.stringify(s));
    const out = await eng.promoteWaitlist('sess-yaka-0615', 'director');
    assert.deepEqual(out.promoted.map(r => r.athleteId), ['ath-test-07', 'ath-test-08']);
    assert.equal(await store.countConfirmed('sess-yaka-0615'), 4);
  });

  test(`[${kind}] athlete with an empty eligibility array cannot book (empty = eligible for no cohort)`, async () => {
    const store = buildStore(kind);
    const emptyElig = { id: 'ath-test-09', name: 'Test Athlete 09', age: 10, eligibleCohortIds: [], restrictions: [] };
    if (kind === 'memory') store.athletes.set(emptyElig.id, JSON.parse(JSON.stringify(emptyElig)));
    else store.db.prepare('INSERT OR REPLACE INTO athletes (id, data) VALUES (?, ?)').run(emptyElig.id, JSON.stringify(emptyElig));
    // Membership is required before the cohort check is reached: reuse an
    // active membership row by pointing it at the new athlete.
    if (kind === 'memory') {
      const m = store.memberships.get('mem-test-02');
      store.memberships.set('mem-test-09', Object.assign({}, m, { id: 'mem-test-09', athleteId: 'ath-test-09' }));
    } else {
      const m = JSON.parse(store.db.prepare('SELECT data FROM memberships WHERE id = ?').get('mem-test-02').data);
      store.db.prepare('INSERT OR REPLACE INTO memberships (id, athlete_id, data) VALUES (?, ?, ?)')
        .run('mem-test-09', 'ath-test-09', JSON.stringify(Object.assign({}, m, { id: 'mem-test-09', athleteId: 'ath-test-09' })));
    }
    const eng = new ReservationEngine(store);
    await expectReject(eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-09', actor: 'director' }), 'INELIGIBLE_COHORT');
  });

  test(`[${kind}] athlete with undefined eligibility (legacy fixture) still books — check skipped only then`, async () => {
    const store = buildStore(kind);
    const legacy = { id: 'ath-test-10', name: 'Test Athlete 10', age: 10, restrictions: [] }; // no eligibleCohortIds field
    if (kind === 'memory') store.athletes.set(legacy.id, JSON.parse(JSON.stringify(legacy)));
    else store.db.prepare('INSERT OR REPLACE INTO athletes (id, data) VALUES (?, ?)').run(legacy.id, JSON.stringify(legacy));
    if (kind === 'memory') {
      const m = store.memberships.get('mem-test-02');
      store.memberships.set('mem-test-10', Object.assign({}, m, { id: 'mem-test-10', athleteId: 'ath-test-10' }));
    } else {
      const m = JSON.parse(store.db.prepare('SELECT data FROM memberships WHERE id = ?').get('mem-test-02').data);
      store.db.prepare('INSERT OR REPLACE INTO memberships (id, athlete_id, data) VALUES (?, ?, ?)')
        .run('mem-test-10', 'ath-test-10', JSON.stringify(Object.assign({}, m, { id: 'mem-test-10', athleteId: 'ath-test-10' })));
    }
    const eng = new ReservationEngine(store);
    const r = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-10', actor: 'director' });
    assert.equal(r.outcome, 'confirmed');
  });
}

test('migration 001 enforces the concurrency guarantee in SQL, not only in JS', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_operational_foundation.sql'), 'utf8');
  assert.match(sql, /FOR UPDATE/, 'reserve_seat() must lock the session row');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_confirmed/, 'duplicate confirmed reservations must be impossible in Postgres');
  assert.match(sql, /capacity_effective/, 'session cap is a stored, computed column — separate from enrollment_cap');
  assert.match(sql, /enrollment_cap/, 'cohort enrollment cap exists as its own field');
  assert.match(sql, /price_cents INT NOT NULL DEFAULT 14900/, 'membership price is the owner-fixed $149');
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/, 'RLS is enabled on athlete tables');
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS citext/, 'citext extension must be created — app_users.email / guardians.email are CITEXT');
  assert.match(sql, /v_cap <= 0/, 'reserve_seat() must refuse a zero cap instead of waitlisting (infeasible-session guard)');
  assert.match(sql, /session_not_bookable: session/, 'reserve_seat() must raise a clean session_not_bookable exception on a zero cap');
  assert.match(sql, /duplicate: athlete/, 'reserve_seat() must raise a clean duplicate exception for an athlete who already holds a confirmed seat (never waitlist a duplicate)');
  assert.match(sql, /Source of truth for cohort eligibility is the cohort_enrollments join/,
    'eligible_cohort_ids is documented as a snapshot of cohort_enrollments, not the source of truth');
  assert.match(sql, /Supabase is the SOLE backend/, '001 header must record the 2026-11-12 Supabase-only decision');
  assert.match(sql, /rkgdwqgmldznczikrjip/, '001 header must record the inspected TheProgramOS project ref');
  // Verified 2026-11-12 by reading both migrations: only gen_random_uuid,
  // JSONB, partial indexes and plpgsql FOR UPDATE — all PG15-compatible.
  assert.match(sql, /gen_random_uuid\(\)/, 'uuid defaults use gen_random_uuid (PG13+, fine on the PG15 project)');
});

/* Cross-process race at the atomic gate (PostgresStore / reserve_seat()):
 * the engine's in-process mutex cannot serialize two processes. When the
 * gate returns 'waitlisted', the store throws RACE_WAITLISTED with the
 * entry reserve_seat() already created; the engine must return the
 * waitlist outcome — not an error, and not a second waitlist entry.
 * (Fixed 2026-11-12 by the coordinator's verification pass.) */
test('race loser at the atomic gate returns waitlisted (no duplicate entry, no error)', async () => {
  const base = buildStore('memory');
  const store = Object.create(base);
  const raceWaitlist = { id: 'wl-race-1', sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02', position: 1, status: 'waiting' };
  store.insertReservation = async () => {
    const e = new Error('Session filled during booking (reserve_seat outcome: waitlisted, position 1).');
    e.code = 'RACE_WAITLISTED'; e.waitlist = raceWaitlist; throw e;
  };
  const eng = new ReservationEngine(store);
  const r = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02', actor: 'director' });
  assert.equal(r.outcome, 'waitlisted');
  assert.equal(r.waitlist.position, 1);
  assert.equal(await store.countConfirmed('sess-yaka-0615'), 0);
  assert.deepEqual(await store.listWaitlist('sess-yaka-0615'), [], 'engine must not insert a second waitlist entry');
});

test('already-waitlisted at the atomic gate rejects with ALREADY_WAITLISTED', async () => {
  const base = buildStore('memory');
  const store = Object.create(base);
  store.insertReservation = async () => {
    const e = new Error('Already waitlisted at position 1.');
    e.code = 'ALREADY_WAITLISTED'; e.waitlist = { id: 'wl-1', position: 1, status: 'waiting' }; throw e;
  };
  const eng = new ReservationEngine(store);
  await expectReject(
    eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02', actor: 'director' }),
    'ALREADY_WAITLISTED');
});
