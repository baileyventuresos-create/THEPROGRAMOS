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
}

test('migration 001 enforces the concurrency guarantee in SQL, not only in JS', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_operational_foundation.sql'), 'utf8');
  assert.match(sql, /FOR UPDATE/, 'reserve_seat() must lock the session row');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_confirmed/, 'duplicate confirmed reservations must be impossible in Postgres');
  assert.match(sql, /capacity_effective/, 'session cap is a stored, computed column — separate from enrollment_cap');
  assert.match(sql, /enrollment_cap/, 'cohort enrollment cap exists as its own field');
  assert.match(sql, /price_cents INT NOT NULL DEFAULT 14900/, 'membership price is the owner-fixed $149');
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/, 'RLS is enabled on athlete tables');
});
