/* Adult validation case: 48-year-old recreational soccer wingback.
 * Run: node --test server/tests/adult-validation.test.js
 *
 * End-to-end over a SYNTHETIC test athlete only (see
 * server/fixtures/synthetic-wingback-48.js). Nothing here is a real
 * person's result, and nothing is written anywhere except the
 * in-memory test store. The case proves the engine works for an adult
 * athlete without assuming athletes are children.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Fixture = require('../fixtures/synthetic-wingback-48');
const { recordAssessmentSession, MemoryAssessmentStore } = require('../assessment-store');
const { baselineStatus, scheduleFor, dueStatus } = require('../reassessment');
const { assessPlanReadiness, finalizePlan } = require('../baseline-gating');
const { progressForAthlete } = require('../progress');
const { prioritiesFromResults } = require('../smart-draft-adapter');
const { accommodationsFor } = require('../assessment-battery');

function storeData(store) {
  return {
    sessions: store.sessions.map(s => ({ id: s.id, athleteId: s.athleteId, battery: s.battery, recordedAt: s.recordedAt })),
    results: store.results.map(r => ({ sessionId: r.sessionId, athleteId: r.athleteId, assessmentId: r.assessmentId, result: r.result, modified: r.modified, recordedAt: r.recordedAt })),
    deferrals: [],
  };
}

test('the fixture is synthetic and the store is memory-only', () => {
  assert.equal(Fixture.athlete.synthetic, true);
  assert.equal(Fixture.athlete.age, 48);
  assert.deepEqual(Fixture.athlete.goals, ['acceleration', 'agility', 'cardiovascular_conditioning', 'power', 'strength']);
  assert.ok(Fixture.athlete.equipment.includes('kettlebell up to 35 lb'));
  const store = new MemoryAssessmentStore();
  assert.equal(store.constructor.name, 'MemoryAssessmentStore', 'no live database is involved');
});

test('adult wingback: baseline, 28-day due date, reassessment, progress, plan', async () => {
  const store = new MemoryAssessmentStore();
  const { athlete, baseline, reassessment } = Fixture;

  // No baseline yet: the plan cannot be finalized.
  const before = assessPlanReadiness({ athleteId: athlete.id, sessions: [], results: [], deferrals: [] });
  assert.equal(before.ready, false);
  assert.throws(() => finalizePlan({ plan: { id: 'plan-w', athleteId: athlete.id, status: 'draft' },
    readiness: before, coachId: 'coach-marcus' }), e => e.code === 'PLAN_NOT_READY');

  // Baseline: all 9 measured tests + the movement observation.
  const first = await recordAssessmentSession(store, { athleteId: athlete.id, coachId: 'coach-marcus',
    entries: baseline.entries,
    meta: { battery: baseline.battery, recordedAt: baseline.recordedAt, idempotencyKey: 'synth-wingback-baseline',
      context: { equipment: 'bodyweight + stopwatch', surface: 'outdoor hill + turf', protocolVersion: 'gaa-v1' } } });
  assert.equal(first.results.length, 9, 'nine measured results');
  assert.equal(first.observations.length, 1, 'the movement assessment is an observation');
  assert.equal(first.results.find(r => r.assessmentId === '10yd-sprint').result, 2.01);
  assert.equal(first.results.find(r => r.assessmentId === 'broad-jump').result, 80);

  const data = storeData(store);
  const base = baselineStatus(athlete.id, data);
  assert.equal(base.complete, true, 'baseline complete after the full GAA session');
  const sched = scheduleFor(athlete.id, data, baseline.recordedAt);
  assert.equal(sched.hasBaseline, true);
  assert.equal(sched.nextDueAt, '2027-02-07T12:00:00.000Z', 'due exactly 28 days after baseline');
  assert.equal(dueStatus({ lastCompletedAt: baseline.recordedAt, now: reassessment.recordedAt }), 'due');

  // The plan can now be finalized.
  const ready = assessPlanReadiness({ athleteId: athlete.id, ...data });
  const plan = finalizePlan({ plan: { id: 'plan-w', athleteId: athlete.id, status: 'draft' },
    readiness: ready, coachId: 'coach-marcus' });
  assert.equal(plan.status, 'finalized');
  assert.equal(plan.baselineSessionId, first.session.id);

  // Reassessment 28 days later, with improvement on every test.
  const second = await recordAssessmentSession(store, { athleteId: athlete.id, coachId: 'coach-marcus',
    entries: reassessment.entries,
    meta: { battery: reassessment.battery, recordedAt: reassessment.recordedAt, idempotencyKey: 'synth-wingback-reassessment-01',
      context: { equipment: 'bodyweight + stopwatch', surface: 'outdoor hill + turf', protocolVersion: 'gaa-v1' } } });
  assert.equal(second.results.length, 9);
  const data2 = storeData(store);
  const sched2 = scheduleFor(athlete.id, data2, reassessment.recordedAt);
  assert.equal(sched2.status, 'not-due');
  assert.equal(sched2.nextDueAt, '2027-03-07T12:00:00.000Z', 'the next reassessment is auto-scheduled');

  // Progress: improved everywhere, personal bests are the new results.
  const byAssessment = {};
  for (const r of data2.results) (byAssessment[r.assessmentId] = byAssessment[r.assessmentId] || []).push(r);
  const progress = progressForAthlete(athlete.id, byAssessment, { age: athlete.age });
  assert.equal(progress.summary.improved, 9);
  assert.equal(progress.summary.regressed, 0);
  assert.equal(progress.tests['10yd-sprint'].personalBest, 1.95);
  assert.equal(progress.tests['broad-jump'].personalBest, 84);
  assert.equal(progress.tests['6min-walk-run'].current, 690);
  assert.equal(progress.tests['6min-walk-run'].vsBaseline.status, 'improved');
  assert.equal(progress.tests['10yd-sprint'].caveats.length, 0, 'no youth-growth caveat for a 48-year-old');

  // Smart Draft: everything improved, so no declining priorities.
  const advisory = prioritiesFromResults(athlete.id, data2.results, { age: athlete.age, goals: athlete.goals });
  assert.equal(advisory.priorities.length, 0);
  assert.equal(advisory.advisoryOnly, true);
  assert.equal(advisory.insufficientEvidence, false);
});

test('retrying the baseline recording cannot duplicate the session', async () => {
  const store = new MemoryAssessmentStore();
  const { athlete, baseline } = Fixture;
  const input = { athleteId: athlete.id, coachId: 'coach-marcus', entries: baseline.entries,
    meta: { battery: baseline.battery, recordedAt: baseline.recordedAt, idempotencyKey: 'synth-wingback-baseline' } };
  await recordAssessmentSession(store, input);
  const replay = await recordAssessmentSession(store, input);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(store.sessions.length, 1, 'one session after a retried recording');
  assert.equal(store.results.length, 9, 'no duplicate results');
});

test('youth and adult athletes get different accommodations for the same test', async () => {
  const adult = accommodationsFor('push-ups', { age: 48 });
  const youth = accommodationsFor('push-ups', { age: 12 });
  assert.equal(adult.ageBand, 'adult');
  assert.equal(youth.ageBand, 'youth');
  assert.notEqual(adult.alternative, youth.alternative);

  // A youth athlete using the incline alternative has the result
  // flagged modified — never silently compared to a standard baseline.
  const store = new MemoryAssessmentStore();
  const out = await recordAssessmentSession(store, { athleteId: Fixture.youth.id, coachId: 'coach-marcus',
    entries: [{ assessmentId: 'push-ups', attempts: [12], modified: true, notes: 'Incline push-ups, hands on bench.' }],
    meta: { battery: 'generalAthleticAssessment', recordedAt: '2027-01-10T12:00:00Z' } });
  assert.equal(out.results[0].modified, true);
  assert.equal(out.results[0].result, 12);
});
