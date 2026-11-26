/* API layer tests — injected MemoryStore, no live database, no network.
 * Run: node --test server/tests/api.test.js
 * Pins the auth contract: role checks, actor = auth UID (never a
 * client-supplied actor), and the six exposed methods + promoteWaitlist
 * behaving through the real engine.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createApi } = require('../api');
const { MemoryStore } = require('../reservation-stores');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'seed-operational.json'), 'utf8'));

const DIRECTOR = { authUserId: 'auth-director-1', role: 'director' };
const COACH = { authUserId: 'auth-coach-1', role: 'coach' };
const PARENT = { authUserId: 'auth-parent-1', role: 'parent' };
const ATHLETE = { authUserId: 'auth-athlete-1', role: 'athlete' };

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

function buildApi() {
  const s = JSON.parse(JSON.stringify(seed));
  s.sessions = [session()];
  const store = new MemoryStore(s);
  return { api: createApi({ store }), store };
}

async function expectReject(promise, code) {
  try { await promise; assert.fail(`expected rejection with code ${code}`); }
  catch (e) { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); }
}

test('createApi requires a store', () => {
  assert.throws(() => createApi({}), /requires a store/);
});

test('reserve: director books; actor is the auth UID, never client-supplied actor', async () => {
  const { api, store } = buildApi();
  const r = await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'spoofed-actor' });
  assert.equal(r.outcome, 'confirmed');
  assert.equal(r.reservation.actor, 'auth-director-1', 'engine actor comes from auth, not the client');
  const audit = await store.listAudit({ action: 'RESERVED' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, 'auth-director-1', 'audit names the authenticated user');
  assert.ok(!audit.some(e => e.actor === 'spoofed-actor'), 'spoofed actor never reaches the audit trail');
});

test('reserve: parent and coach may book; athlete role may not', async () => {
  const { api } = buildApi();
  const r1 = await api.reserve(PARENT, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01' });
  assert.equal(r1.outcome, 'confirmed');
  const r2 = await api.reserve(COACH, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02' });
  assert.equal(r2.outcome, 'confirmed');
  await expectReject(api.reserve(ATHLETE, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-07' }), 'FORBIDDEN');
});

test('reserve: missing auth is UNAUTHENTICATED; missing ids are INVALID_INPUT', async () => {
  const { api } = buildApi();
  await expectReject(api.reserve(null, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01' }), 'UNAUTHENTICATED');
  await expectReject(api.reserve({ role: 'director' }, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01' }), 'UNAUTHENTICATED');
  await expectReject(api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615' }), 'INVALID_INPUT');
});

test('reserve: engine rejections pass through with their codes', async () => {
  const { api } = buildApi();
  await expectReject(api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-04' }), 'MEMBERSHIP');
  await expectReject(api.reserve(DIRECTOR, { sessionId: 'sess-missing', athleteId: 'ath-test-01' }), 'SESSION_NOT_FOUND');
});

test('cancel via the API promotes the waitlisted athlete; actor is the auth UID', async () => {
  const { api, store } = buildApi();
  const r1 = await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01' });
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02' });
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-07' }); // waitlisted
  const out = await api.cancel(COACH, { reservationId: r1.reservation.id, reason: 'ill' });
  assert.equal(out.promoted.athleteId, 'ath-test-07');
  assert.equal(await store.countConfirmed('sess-yaka-0615'), 2);
  const audit = await store.listAudit({ action: 'CANCELLED' });
  assert.equal(audit[0].actor, 'auth-coach-1');
  await expectReject(api.cancel(ATHLETE, { reservationId: r1.reservation.id }), 'FORBIDDEN');
});

test('availableSeats math is exposed to any authenticated role', async () => {
  const { api } = buildApi();
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01' });
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02' });
  const seats = await api.availableSeats(ATHLETE, 'sess-yaka-0615');
  assert.deepEqual(seats, { sessionId: 'sess-yaka-0615', capacity: 2, confirmed: 2, available: 0, waitlisted: 0 });
  await expectReject(api.availableSeats(null, 'sess-yaka-0615'), 'UNAUTHENTICATED');
});

test('recordAttendance: coach and director may record; parent may not', async () => {
  const { api } = buildApi();
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01' });
  const row = await api.recordAttendance(COACH, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', status: 'attended' });
  assert.equal(row.status, 'attended');
  assert.equal(row.actor, 'auth-coach-1');
  await expectReject(
    api.recordAttendance(PARENT, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', status: 'attended' }),
    'FORBIDDEN');
});

test('reconcileAttendance and capacityFor: director/coach only', async () => {
  const { api } = buildApi();
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01' });
  await api.recordAttendance(COACH, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', status: 'attended' });
  const rec = await api.reconcileAttendance(DIRECTOR, 'sess-yaka-0615');
  assert.equal(rec.confirmed, 1);
  assert.equal(rec.attended, 1);
  const cap = await api.capacityFor(COACH, 'sess-yaka-0615');
  assert.equal(cap.effectiveCap, 2);
  await expectReject(api.reconcileAttendance(PARENT, 'sess-yaka-0615'), 'FORBIDDEN');
  await expectReject(api.capacityFor(ATHLETE, 'sess-yaka-0615'), 'FORBIDDEN');
  await expectReject(api.capacityFor(DIRECTOR, 'sess-missing'), 'SESSION_NOT_FOUND');
});

test('promoteWaitlist via the API fills seats opened by a capacity increase', async () => {
  const { api, store } = buildApi();
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01' });
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-02' });
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-07' });
  await api.reserve(DIRECTOR, { sessionId: 'sess-yaka-0615', athleteId: 'ath-test-08' });
  const s = await store.getSession('sess-yaka-0615');
  s.capacityEffective = 4;
  store.sessions.set(s.id, s);
  const out = await api.promoteWaitlist(DIRECTOR, 'sess-yaka-0615');
  assert.deepEqual(out.promoted.map(r => r.athleteId), ['ath-test-07', 'ath-test-08']);
  assert.equal(await store.countConfirmed('sess-yaka-0615'), 4);
  await expectReject(api.promoteWaitlist(PARENT, 'sess-yaka-0615'), 'FORBIDDEN');
});
