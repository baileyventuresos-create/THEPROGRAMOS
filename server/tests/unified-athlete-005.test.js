/* Unified athlete system — migration 005.
 * Run: node --test server/tests/unified-athlete-005.test.js
 *
 * Marcus correction 2026-11-13: The Program OS serves athletes of
 * all ages under ONE unified athlete system. Age is an athlete
 * attribute, not a division. Migration 005 (reviewed-only, NOT
 * applied) does exactly two things: it removes the arbitrary
 * 19-year-old maximum from athletes.age_years (floor of 5 kept as a
 * data-sanity guard), and it adds the missing modified/capped
 * BOOLEAN columns to assessment_results. No new divisions, no new
 * membership categories, no pricing change.
 *
 * These tests pin the migration's shape and prove the existing
 * workflows already accept adult athletes through the SAME paths
 * youth use — the only thing standing in the way was the database
 * CHECK (and the missing columns). Synthetic data only, local
 * in-memory stores only.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Fixture48 = require('../fixtures/synthetic-wingback-48');
const Youth12 = require('../fixtures/synthetic-youth-12');
const { recordAssessmentSession, MemoryAssessmentStore } = require('../assessment-store');
const { baselineStatus, scheduleFor } = require('../reassessment');
const { assessPlanReadiness, finalizePlan } = require('../baseline-gating');
const { progressForAthlete } = require('../progress');
const { ageBandFor, accommodationsFor } = require('../assessment-battery');
const { ReservationEngine } = require('../reservation-engine');
const { MemoryStore } = require('../reservation-stores');

const sql005 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '005_unified_athlete_age_and_result_flags.sql'), 'utf8');
// The rollback block at the end is documentation, not executable
// intent: strip it before checking for destructive statements —
// same approach as the migration-004 tests.
const body005 = sql005.slice(0, sql005.indexOf('-- Rollback'));
// The executable body is the transaction; the header above it is
// comments. Strip comments for the no-division / no-pricing checks.
const exec005 = body005.slice(body005.indexOf('BEGIN;'));

test('migration 005 is a reviewed-only, transactional, additive migration', () => {
  assert.match(sql005, /STATUS: NOT APPLIED/);
  assert.match(body005, /^BEGIN;/m);
  assert.match(body005, /^COMMIT;/m);
  assert.ok(!/DROP TABLE/i.test(body005), 'no table is dropped');
  assert.ok(!/DROP COLUMN/i.test(body005), 'no column is dropped');
  assert.ok(!/DELETE FROM/i.test(body005), 'no rows are deleted');
  assert.ok(!/TRUNCATE/i.test(body005), 'nothing is truncated');
  assert.ok(!/CREATE TABLE/i.test(body005), '005 creates no tables');
  assert.ok(!/CREATE POLICY/i.test(body005), '005 changes no policies');
});

test('migration 005 removes the 19 maximum and keeps only the floor of 5', () => {
  // The new CHECK admits any age from 5 up, with no upper bound.
  assert.match(body005, /ADD CONSTRAINT athletes_age_years_check CHECK \(age_years >= 5\)/,
    'the re-issued CHECK keeps only the floor of 5');
  // The old range is dropped by definition (Postgres normalizes
  // BETWEEN to >= / <= when it stores the CHECK, so both spellings
  // are matched) — and no new upper bound is introduced anywhere.
  assert.match(body005, /BETWEEN 5 AND 19|<= 19/, 'the old range CHECK is the one being dropped');
  assert.ok(!/age_years <=/.test(exec005), 'no new upper bound on age_years');
  assert.ok(!/age_years < /.test(exec005), 'no new upper bound on age_years');
});

test('migration 005 adds exactly the two missing result-flag columns', () => {
  assert.match(body005, /ADD COLUMN IF NOT EXISTS modified BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(body005, /ADD COLUMN IF NOT EXISTS capped BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.ok(/ALTER TABLE IF EXISTS assessment_results/.test(body005), 'flags land on assessment_results');
  // And nothing else is touched: no other table is altered.
  const alters = [...exec005.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:public\.)?(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(alters)].sort(), ['assessment_results', 'athletes'],
    `005 alters only athletes and assessment_results, got: ${alters.join(', ')}`);
});

test('migration 005 introduces no divisions, categories, or pricing', () => {
  assert.ok(!/division/i.test(exec005), 'no division language in 005');
  assert.ok(!/categor/i.test(exec005), 'no category language in 005');
  assert.ok(!/14900|price/i.test(exec005), 'no pricing in 005');
});

function storeData(store) {
  return {
    sessions: store.sessions.map(s => ({ id: s.id, athleteId: s.athleteId, battery: s.battery, recordedAt: s.recordedAt })),
    results: store.results.map(r => ({ sessionId: r.sessionId, athleteId: r.athleteId, assessmentId: r.assessmentId, result: r.result, modified: r.modified, capped: r.capped, recordedAt: r.recordedAt })),
    deferrals: [],
  };
}

async function recordBaseline(store, athleteId, entries, when) {
  return recordAssessmentSession(store, {
    athleteId, coachId: 'coach-marcus', entries,
    meta: { battery: 'generalAthleticAssessment', recordedAt: when, idempotencyKey: `unified-${athleteId}-${when}`,
      context: { equipment: 'bodyweight + stopwatch', surface: 'turf', protocolVersion: 'gaa-v1' } },
  });
}

for (const age of [19, 20, 48, 65]) {
  test(`adult athlete aged ${age} runs the full workflow on the same paths as youth`, async () => {
    const store = new MemoryAssessmentStore();
    const athleteId = `ath-synth-adult-${age}`;
    const first = await recordBaseline(store, athleteId, Fixture48.baseline.entries, '2026-11-13T10:00:00.000Z');
    assert.equal(first.results.length, 9, 'nine measured results');
    const data = storeData(store);
    const base = baselineStatus(athleteId, data);
    assert.equal(base.complete, true, 'baseline is complete');
    const readiness = assessPlanReadiness({ athleteId, sessions: data.sessions, results: data.results, deferrals: [] });
    assert.equal(readiness.ready, true, 'plan can be finalized after baseline');
    const plan = finalizePlan({ plan: { id: `plan-${age}`, athleteId, status: 'draft' }, readiness, coachId: 'coach-marcus' });
    assert.equal(plan.status, 'finalized');
    const sched = scheduleFor(athleteId, data, new Date('2026-11-13T10:00:00.000Z'));
    assert.equal(sched.status, 'not-due');
    assert.equal(sched.nextDueAt, '2026-12-11T10:00:00.000Z', 'reassessment due 28 days after baseline');
    const byAssessment = {};
    for (const r of data.results) (byAssessment[r.assessmentId] = byAssessment[r.assessmentId] || []).push(r);
    const progress = progressForAthlete(athleteId, byAssessment, { age });
    assert.equal(progress.tests['10yd-sprint'].caveats.length, 0, `no youth-growth caveat at age ${age}`);
    assert.equal(ageBandFor(age), 'adult');
  });
}

test('youth athlete aged 12 still works identically, with the under-18 caveat kept', async () => {
  const store = new MemoryAssessmentStore();
  const athleteId = Youth12.athlete.id;
  const first = await recordBaseline(store, athleteId, Youth12.baseline.entries, '2026-11-13T10:00:00.000Z');
  assert.equal(first.results.length, 9);
  const data = storeData(store);
  assert.equal(baselineStatus(athleteId, data).complete, true);
  const byAssessment = {};
  for (const r of data.results) (byAssessment[r.assessmentId] = byAssessment[r.assessmentId] || []).push(r);
  const progress = progressForAthlete(athleteId, byAssessment, { age: 12 });
  assert.ok(progress.tests['10yd-sprint'].caveats.length > 0, 'under-18 growth caveat still applies to youth');
  assert.match(progress.tests['10yd-sprint'].caveats[0], /under 18/);
  assert.equal(ageBandFor(12), 'youth');
  assert.equal(ageBandFor(17), 'youth');
  assert.equal(ageBandFor(18), 'adult', '18 is the adult band boundary — the band is for protocols, not a division');
});

test('modified and capped flags round-trip through the store on the same record path', async () => {
  const store = new MemoryAssessmentStore();
  const entries = Fixture48.baseline.entries.map(e => {
    if (e.assessmentId === 'push-ups') return { ...e, modified: true };
    // 120 seconds is the documented side-plank cap; the attempt hits
    // it, so the result is recorded at the cap with the capped flag.
    if (e.assessmentId === 'side-plank-r') return { ...e, attempts: [120], capped: true };
    return e;
  });
  const first = await recordBaseline(store, 'ath-synth-adult-48', entries, '2026-11-13T10:00:00.000Z');
  const pushups = first.results.find(r => r.assessmentId === 'push-ups');
  assert.equal(pushups.modified, true, 'incline alternative is flagged modified');
  assert.equal(pushups.capped, false);
  const plank = first.results.find(r => r.assessmentId === 'side-plank-r');
  assert.equal(plank.capped, true, 'cap hit is flagged capped');
  assert.equal(plank.result, 120, 'capped result is recorded at the cap value');
  assert.equal(plank.modified, false);
  const sprint = first.results.find(r => r.assessmentId === '10yd-sprint');
  assert.equal(sprint.modified, false);
  assert.equal(sprint.capped, false);
  // Flags survive a re-read from the store (they are row fields, not
  // request-scoped): the same columns migration 005 adds to Postgres.
  const stored = store.results.find(r => r.assessmentId === 'push-ups');
  assert.equal(stored.modified, true);
  assert.equal(store.results.find(r => r.assessmentId === 'side-plank-r').capped, true);
});

test('cohort age bands are preserved: an adult is still ineligible for a youth cohort', async () => {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'seed-operational.json'), 'utf8'));
  // The adult athlete must exist in the store with an active
  // membership and YAK-A listed as an eligible cohort, so the ONLY
  // failing check is the cohort's age band (a missing athlete is
  // rejected as INELIGIBLE_COHORT "not found" before age is ever
  // considered).
  seed.athletes.push({ id: 'ath-synth-adult-48', name: 'Synthetic Adult 48', age: 48,
    eligibleCohortIds: ['YAK-A'], restrictions: [] });
  seed.memberships.push({ athleteId: 'ath-synth-adult-48', id: 'mem-adult-48',
    priceCents: 14900, startDate: '2027-01-01', endDate: null, status: 'active' });
  seed.sessions = [{
    id: 'sess-yaka-0615', cohortId: 'YAK-A', cohort: { id: 'YAK-A', age: [9, 11] },
    locationId: 'YAK', space: 'Main gym', date: '2027-06-15', startTime: '4:30 PM',
    durationMin: 60, coaches: ['kayla', 'marcus', 'jordan'], status: 'scheduled', capacityEffective: 2,
    emphasis: ['Acceleration'],
  }];
  const store = new MemoryStore(seed);
  const eng = new ReservationEngine(store);
  // A 48-year-old cannot book a 9–11 cohort session: the band is
  // per-cohort eligibility, and removing the athlete maximum does
  // not remove it.
  await assert.rejects(
    eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-synth-adult-48', actor: 'director' }),
    e => e.code === 'INELIGIBLE_AGE');
  // And the band still admits the youth it is for.
  const ok = await eng.reserve({ sessionId: 'sess-yaka-0615', athleteId: 'ath-test-01', actor: 'director' });
  assert.equal(ok.outcome, 'confirmed');
});

test('age-appropriate protocols are still served per age band (no division, just guidance)', () => {
  assert.equal(accommodationsFor('push-ups', { age: 48 }).ageBand, 'adult');
  assert.equal(accommodationsFor('push-ups', { age: 12 }).ageBand, 'youth');
  assert.notEqual(
    accommodationsFor('push-ups', { age: 48 }).alternative,
    accommodationsFor('push-ups', { age: 12 }).alternative);
});
