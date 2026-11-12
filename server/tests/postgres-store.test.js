/* PostgresStore tests — injected fake Pool, no live database, no network.
 * Run: node --test server/tests/postgres-store.test.js
 * These tests pin the store contract: hydration (cohort age band,
 * capacity fields, eligibleCohortIds from cohort_enrollments), the
 * reserve_seat() atomic gate and its clean error mapping, single-client
 * transactions, and the migration-003 SQL invariants.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { PostgresStore } = require('../postgres-store');

function makePool(routes) {
  const calls = [];
  const clientCalls = [];
  async function handle(text, params, sink) {
    sink.push({ text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [] };
    for (const [re, fn] of routes) {
      if (re.test(text)) return fn(params);
    }
    throw new Error(`unexpected query: ${text.slice(0, 120)}`);
  }
  const client = {
    query: (text, params) => handle(text, params, clientCalls),
    release() { client.released = true; },
    released: false,
  };
  const pool = {
    calls, clientCalls, client,
    query: (text, params) => handle(text, params, calls),
    connect: async () => client,
    end: async () => {},
  };
  return pool;
}

const SESSION_ROW = {
  id: 'sess-yaka-0615', cohort_id: '11111111-1111-1111-1111-111111111111',
  age_min: 9, age_max: 11, location_id: '22222222-2222-2222-2222-222222222222',
  space_id: '33333333-3333-3333-3333-333333333333', space_name: 'Main gym',
  template_id: 'p60', date: '2027-06-15', start_time: '4:30 PM', duration_min: 60,
  status: 'scheduled', coach_ids: ['c-coach-1', 'c-coach-2'],
  capacity_effective: 18, capacity_preferred: 18,
  capacity_inputs: { template: { id: 'p60' }, coachesAvailable: 3 },
  emphasis: ['Acceleration'], plan_id: 'plan-1', plan_approved_by: 'Marcus',
};

const ATHLETE_ROW = {
  id: 'ath-1', first_name: 'Test', last_name: 'Athlete', age_years: 10,
  restrictions: [], cohort_ids: ['11111111-1111-1111-1111-111111111111'],
};

const RES_ROW = {
  id: 'res-1', session_id: 'sess-yaka-0615', athlete_id: 'ath-1', status: 'confirmed',
  promoted_from_waitlist_id: null, created_at: '2027-06-15T16:30:00.000Z',
  cancelled_at: null, cancel_reason: null, created_by: 'auth-director-1',
};

test('getSession hydrates cohort age band, capacity fields, coaches and space', async () => {
  const pool = makePool([
    [/FROM training_sessions ts/, () => ({ rows: [SESSION_ROW] })],
  ]);
  const store = new PostgresStore(pool);
  const s = await store.getSession('sess-yaka-0615');
  assert.deepEqual(s.cohort, { id: '11111111-1111-1111-1111-111111111111', age: [9, 11] });
  assert.equal(s.capacityEffective, 18);
  assert.deepEqual(s.capacityInput, { template: { id: 'p60' }, coachesAvailable: 3 });
  assert.deepEqual(s.coaches, ['c-coach-1', 'c-coach-2']);
  assert.equal(s.space, 'Main gym');
  assert.equal(s.date, '2027-06-15');
  assert.equal(s.planApprovedBy, 'Marcus');
  assert.match(pool.calls[0].text, /LEFT JOIN cohorts/, 'cohort comes from a cohorts join');
});

test('getAthlete hydrates eligibleCohortIds from cohort_enrollments (not the snapshot column)', async () => {
  const pool = makePool([
    [/FROM athletes a/, () => ({ rows: [ATHLETE_ROW] })],
  ]);
  const store = new PostgresStore(pool);
  const a = await store.getAthlete('ath-1');
  assert.deepEqual(a.eligibleCohortIds, ['11111111-1111-1111-1111-111111111111']);
  assert.equal(a.age, 10);
  assert.match(pool.calls[0].text, /cohort_enrollments/, 'eligibility is read from the join table');
  assert.match(pool.calls[0].text, /status = 'enrolled'/, 'only enrolled enrollments count');
  assert.doesNotMatch(pool.calls[0].text, /eligible_cohort_ids/, 'the snapshot column is not read');
});

test('getMembership returns the latest membership; coachAvailable reads availability blocks', async () => {
  const pool = makePool([
    [/FROM memberships/, () => ({ rows: [{ id: 'm1', athlete_id: 'ath-1', status: 'active', price_cents: 14900, start_date: '2027-01-01', end_date: null }] })],
    [/FROM coach_availability/, (params) => ({ rows: [{ blocked: params[0] === 'coach-busy' }] })],
  ]);
  const store = new PostgresStore(pool);
  const m = await store.getMembership('ath-1');
  assert.equal(m.status, 'active');
  assert.equal(m.priceCents, 14900);
  assert.equal(m.startDate, '2027-01-01');
  assert.equal(await store.coachAvailable('coach-free', '2027-06-15', 990, 1050), true);
  assert.equal(await store.coachAvailable('coach-busy', '2027-06-15', 990, 1050), false);
});

test('insertReservation calls reserve_seat() as the atomic gate and returns the confirmed row', async () => {
  const pool = makePool([
    [/reserve_seat/, () => ({ rows: [{ outcome: 'confirmed', reservation_id: 'res-1', waitlist_id: null, waitlist_position: null }] })],
    [/FROM reservations WHERE id/, () => ({ rows: [RES_ROW] })],
  ]);
  const store = new PostgresStore(pool);
  const r = await store.insertReservation({ sessionId: 'sess-yaka-0615', athleteId: 'ath-1', status: 'confirmed', actor: 'auth-director-1' });
  assert.equal(r.id, 'res-1');
  assert.equal(r.status, 'confirmed');
  assert.match(pool.calls[0].text, /reserve_seat\(\$1, \$2, \$3\)/, 'the atomic gate is called first');
  assert.deepEqual(pool.calls[0].params, ['sess-yaka-0615', 'ath-1', 'auth-director-1']);
});

test('insertReservation: waitlisted gate outcome throws RACE_WAITLISTED with the created entry attached (engine returns waitlisted, no second entry)', async () => {
  const pool = makePool([
    [/reserve_seat/, () => ({ rows: [{ outcome: 'waitlisted', reservation_id: null, waitlist_id: 'wl-1', waitlist_position: 1 }] })],
    [/FROM waitlist_entries WHERE id/, () => ({ rows: [{ id: 'wl-1', session_id: 'sess-yaka-0615', athlete_id: 'ath-1', position: 1, status: 'waiting', promoted_reservation_id: null, created_at: '2027-06-15T16:30:00.000Z' }] })],
  ]);
  const store = new PostgresStore(pool);
  await assert.rejects(
    store.insertReservation({ sessionId: 'sess-yaka-0615', athleteId: 'ath-1', status: 'confirmed', actor: 'auth-director-1' }),
    (e) => { assert.equal(e.code, 'RACE_WAITLISTED'); assert.equal(e.waitlist.id, 'wl-1'); assert.equal(e.waitlist.position, 1); return true; });
});

test('insertReservation: already_waitlisted gate outcome throws ALREADY_WAITLISTED with the existing entry attached', async () => {
  const pool = makePool([
    [/reserve_seat/, () => ({ rows: [{ outcome: 'already_waitlisted', reservation_id: null, waitlist_id: null, waitlist_position: 2 }] })],
    [/FROM waitlist_entries WHERE session_id/, () => ({ rows: [{ id: 'wl-0', session_id: 'sess-yaka-0615', athlete_id: 'ath-1', position: 2, status: 'waiting', promoted_reservation_id: null, created_at: '2027-06-15T16:30:00.000Z' }] })],
  ]);
  const store = new PostgresStore(pool);
  await assert.rejects(
    store.insertReservation({ sessionId: 'sess-yaka-0615', athleteId: 'ath-1', status: 'confirmed', actor: 'auth-director-1' }),
    (e) => { assert.equal(e.code, 'ALREADY_WAITLISTED'); assert.equal(e.waitlist.position, 2); return true; });
});

test('insertReservation: duplicate unique violation (23505) becomes a clean DUPLICATE code', async () => {
  const pool = makePool([
    [/reserve_seat/, () => { const e = new Error('duplicate key value violates unique constraint "uq_reservation_confirmed"'); e.code = '23505'; throw e; }],
  ]);
  const store = new PostgresStore(pool);
  await assert.rejects(
    store.insertReservation({ sessionId: 'sess-yaka-0615', athleteId: 'ath-1', status: 'confirmed', actor: 'auth-director-1' }),
    (e) => { assert.equal(e.code, 'DUPLICATE'); return true; });
});

test('insertReservation: reserve_seat duplicate exception becomes a clean DUPLICATE code', async () => {
  const pool = makePool([
    [/reserve_seat/, () => { throw new Error('duplicate: athlete ath-1 already holds a confirmed reservation for session sess-yaka-0615.'); }],
  ]);
  const store = new PostgresStore(pool);
  await assert.rejects(
    store.insertReservation({ sessionId: 'sess-yaka-0615', athleteId: 'ath-1', status: 'confirmed', actor: 'auth-director-1' }),
    (e) => { assert.equal(e.code, 'DUPLICATE'); return true; });
});

test('insertReservation: reserve_seat session_not_bookable exception becomes SESSION_NOT_BOOKABLE', async () => {
  const pool = makePool([
    [/reserve_seat/, () => { throw new Error('session_not_bookable: session sess-yaka-0615 has no bookable capacity (effective cap 0).'); }],
  ]);
  const store = new PostgresStore(pool);
  await assert.rejects(
    store.insertReservation({ sessionId: 'sess-yaka-0615', athleteId: 'ath-1', status: 'confirmed', actor: 'auth-director-1' }),
    (e) => { assert.equal(e.code, 'SESSION_NOT_BOOKABLE'); return true; });
});

test('transaction runs on one client with BEGIN/COMMIT and rolls back on error', async () => {
  const pool = makePool([
    [/FROM training_sessions ts/, () => ({ rows: [SESSION_ROW] })],
  ]);
  const store = new PostgresStore(pool);
  const s = await store.transaction(() => store.getSession('sess-yaka-0615'));
  assert.equal(s.id, 'sess-yaka-0615');
  const texts = pool.clientCalls.map(c => c.text);
  assert.equal(texts[0], 'BEGIN');
  assert.ok(texts.some(t => /FROM training_sessions/.test(t)), 'store calls inside transaction use the tx client');
  assert.equal(texts[texts.length - 1], 'COMMIT');
  assert.equal(pool.client.released, true);

  const failing = makePool([[/FROM training_sessions ts/, () => { throw new Error('boom'); }]]);
  const store2 = new PostgresStore(failing);
  await assert.rejects(store2.transaction(() => store2.getSession('x')), /boom/);
  assert.ok(failing.clientCalls.map(c => c.text).includes('ROLLBACK'), 'failed transaction rolls back');
  assert.equal(failing.client.released, true);
});

test('countConfirmed returns a number; listWaitlist orders by position', async () => {
  const pool = makePool([
    [/COUNT\(\*\)::int/, () => ({ rows: [{ c: 2 }] })],
    [/FROM waitlist_entries/, () => ({ rows: [
      { id: 'wl-1', session_id: 's', athlete_id: 'a1', position: 1, status: 'waiting', promoted_reservation_id: null, created_at: '2027-06-15T16:00:00.000Z' },
    ] })],
  ]);
  const store = new PostgresStore(pool);
  assert.strictEqual(await store.countConfirmed('s'), 2);
  const wl = await store.listWaitlist('s');
  assert.equal(wl[0].position, 1);
  assert.equal(wl[0].status, 'waiting');
});

test('migration 003 links auth and adds the minimum role-scoped RLS policies', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '003_auth_rls.sql'), 'utf8');
  assert.match(sql, /NOT applied to production/, '003 must state it is not applied');
  assert.match(sql, /requires Marcus's explicit approval/, '003 must state it needs Marcus approval');
  assert.match(sql, /auth_user_id UUID UNIQUE REFERENCES auth\.users\(id\)/, 'app_users links to auth.users');
  assert.match(sql, /app_users\.app_user_id|athletes[\s\S]*app_user_id UUID REFERENCES app_users/, 'athletes link to app_users for self-read');
  assert.match(sql, /auth\.uid\(\)/, 'policies use auth.uid()');
  assert.match(sql, /CREATE POLICY \w+ ON athletes/, 'athlete policies exist');
  assert.match(sql, /CREATE POLICY \w+ ON reservations/, 'reservation policies exist');
  assert.match(sql, /CREATE POLICY \w+ ON attendance_records/, 'attendance policies exist');
  assert.match(sql, /app_role\(\) = 'director'/, 'director role policy exists');
  assert.match(sql, /app_role\(\) = 'coach'/, 'coach role policy exists');
  assert.match(sql, /app_role\(\) = 'parent'/, 'parent/guardian role policy exists');
  assert.match(sql, /app_role\(\) = 'athlete'/, 'athlete role policy exists');
  assert.match(sql, /STUB auth\.users table/, 'header notes the local-stub requirement instead of creating one');
  assert.doesNotMatch(sql, /CREATE TABLE auth\.users/, '003 must not create a stub auth schema');
});
