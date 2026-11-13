/* Assessment workflow end-to-end tests (development only).
 * Run: node --test server/tests/assessment-workflow.test.js
 *
 * Exercises the complete coach workflow (mission §2, steps 1–10)
 * and the athlete/parent read views, over SYNTHETIC athletes only
 * (48-year-old wingback + 12-year-old youth fixtures) in memory
 * stores. Nothing here is a real person's result and nothing is
 * written to any live database.
 *
 * Scenarios: initial assessment, incomplete save/resume, baseline
 * creation, plan finalization, coach override, 28-day reassessment,
 * overdue + deferred assessments, progress comparisons, personal
 * bests, and unauthorized access attempts (athlete seeing another
 * athlete, parent seeing another athlete, coach outside their
 * cohort, anonymous caller).
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Wingback = require('../fixtures/synthetic-wingback-48');
const Youth = require('../fixtures/synthetic-youth-12');
const { MemoryAssessmentStore } = require('../assessment-store');
const { MemoryReassessmentStore } = require('../reassessment');
const { createAccessDirectory } = require('../assessment-access');
const { createAssessmentWorkflow, MemoryPlanStore } = require('../assessment-workflow');

const COACH = { authUserId: 'auth-coach-marcus', role: 'coach', coachId: 'coach-marcus' };
const COACH_OTHER = { authUserId: 'auth-coach-other', role: 'coach', coachId: 'coach-other' };
const DIRECTOR = { authUserId: 'auth-director', role: 'director' };
const PARENT_YOUTH = { authUserId: 'parent-youth-uid', role: 'parent' };
const ATHLETE_WINGBACK = { authUserId: 'athlete-wingback-uid', role: 'athlete' };
const ATHLETE_YOUTH = { authUserId: 'athlete-youth-uid', role: 'athlete' };
const ANON = { authUserId: null, role: 'coach' };

function fresh() {
  const directory = createAccessDirectory({
    athletes: [
      { ...Wingback.athlete, coachIds: ['coach-marcus'], guardianUserIds: [], authUserId: 'athlete-wingback-uid' },
      { ...Youth.athlete, coachIds: ['coach-marcus'], guardianUserIds: ['parent-youth-uid'], authUserId: 'athlete-youth-uid' },
    ],
    coachAuth: { 'auth-coach-marcus': 'coach-marcus', 'auth-coach-other': 'coach-other' },
  });
  const store = new MemoryAssessmentStore();
  const rs = new MemoryReassessmentStore();
  const plans = new MemoryPlanStore();
  const wf = createAssessmentWorkflow({ store, reassessmentStore: rs, planStore: plans, directory });
  return { wf, store, rs, plans, directory };
}

const W = Wingback.athlete.id;
const Y = Youth.athlete.id;

async function completeBaseline(wf, athleteId, fixture, key) {
  await wf.startAssessment(COACH, { athleteId, now: fixture.baseline.recordedAt });
  return wf.completeAssessment(COACH, {
    athleteId, entries: fixture.baseline.entries, idempotencyKey: key,
    context: { equipment: 'bodyweight + stopwatch', surface: 'turf', protocolVersion: 'gaa-v1' },
    now: fixture.baseline.recordedAt,
  });
}

test('coach selects an athlete: scoped lists, parent and athlete see only their own', () => {
  const { wf } = fresh();
  assert.deepEqual(wf.listAthletes(COACH).map(a => a.id).sort(), [W, Y].sort());
  assert.deepEqual(wf.listAthletes(COACH_OTHER), []);
  assert.deepEqual(wf.listAthletes(DIRECTOR).map(a => a.id).sort(), [W, Y].sort());
  assert.deepEqual(wf.listAthletes(PARENT_YOUTH).map(a => a.id), [Y]);
  assert.deepEqual(wf.listAthletes(ATHLETE_WINGBACK).map(a => a.id), [W]);
  assert.throws(() => wf.listAthletes(ANON), e => e.code === 'UNAUTHENTICATED');
});

test('adult: start, partial save, resume, complete — baseline established, draft deleted', async () => {
  const { wf, store } = fresh();
  const started = await wf.startAssessment(COACH, { athleteId: W, now: Wingback.baseline.recordedAt });
  assert.equal(started.isReassessment, false);
  assert.equal(started.missing.length, 10, 'nine measured tests + movement assessment');
  assert.equal(started.complete, false);

  // Record only the first three tests: the draft saves, the rest stay missing.
  const partial = await wf.recordAttempts(COACH, {
    athleteId: W, entries: Wingback.baseline.entries.slice(0, 3), now: Wingback.baseline.recordedAt,
  });
  assert.deepEqual(partial.missing.slice().sort(),
    ['push-ups', 'side-plank-r', 'side-plank-l', 'single-leg-balance-r', 'single-leg-balance-l',
      '6min-walk-run', 'movement-assessment'].sort());

  // Resume later: the draft still holds the three recorded tests.
  const resumed = await wf.getDraft(COACH, { athleteId: W });
  assert.equal(resumed.entries.length, 3);
  assert.equal(resumed.complete, false);

  // Completing now must refuse: the assessment is incomplete.
  await assert.rejects(
    () => wf.completeAssessment(COACH, { athleteId: W, entries: [], now: Wingback.baseline.recordedAt }),
    e => e.code === 'INCOMPLETE_ASSESSMENT' && e.missing.includes('push-ups'));

  // Finish the remaining tests and complete.
  const done = await wf.completeAssessment(COACH, {
    athleteId: W, entries: Wingback.baseline.entries.slice(3), idempotencyKey: 'wf-wingback-baseline',
    now: Wingback.baseline.recordedAt,
  });
  assert.equal(done.idempotentReplay, false);
  assert.equal(done.results.length, 9, 'nine measured results');
  assert.equal(done.observations.length, 1, 'movement assessment is an observation');
  assert.equal(done.baseline.complete, true);
  assert.equal(done.baseline.sessionId, done.session.id);
  assert.equal(done.schedule.status, 'not-due');
  assert.equal(done.schedule.nextDueAt, '2027-02-07T12:00:00.000Z', 'baseline + 28 days');
  assert.equal(await wf.getDraft(COACH, { athleteId: W }), null, 'draft is deleted on completion');
  assert.equal(store.sessions.length, 1, 'exactly one session recorded');
});

test('adult: idempotent retry of completion returns the original session, inserts nothing', async () => {
  const { wf, store } = fresh();
  const first = await completeBaseline(wf, W, Wingback, 'wf-wingback-retry');
  const retry = await wf.completeAssessment(COACH, {
    athleteId: W, entries: Wingback.baseline.entries, idempotencyKey: 'wf-wingback-retry',
    now: Wingback.baseline.recordedAt,
  });
  assert.equal(retry.idempotentReplay, true);
  assert.equal(retry.session.id, first.session.id);
  assert.equal(store.sessions.length, 1, 'no duplicate session');
  assert.equal(store.results.length, 9, 'no duplicate results');
});

test('adult: invalid attempts are rejected at completion, not stored', async () => {
  const { wf, store } = fresh();
  await wf.startAssessment(COACH, { athleteId: W, now: Wingback.baseline.recordedAt });
  const bad = Wingback.baseline.entries.map(e =>
    (e.assessmentId === '5-10-5-shuttle' ? { ...e, attempts: [5.24, 5.20, 5.30] } : e));
  await assert.rejects(
    () => wf.completeAssessment(COACH, { athleteId: W, entries: bad, now: Wingback.baseline.recordedAt }),
    e => e.code === 'INVALID_ATTEMPTS' && e.assessmentId === '5-10-5-shuttle');
  assert.equal(store.sessions.length, 0, 'nothing stored');
  const draft = await wf.getDraft(COACH, { athleteId: W });
  assert.equal(draft.entries.length, 0, 'the failed completion left the empty draft untouched — the coach can fix the attempts and retry');
});

test('youth: modified push-ups baseline, youth caveat on progress, parent can view', async () => {
  const { wf } = fresh();
  const done = await completeBaseline(wf, Y, Youth, 'wf-youth-baseline');
  assert.equal(done.baseline.complete, true);
  const pushups = done.results.find(r => r.assessmentId === 'push-ups');
  assert.equal(pushups.modified, true, 'knee push-ups flagged modified');
  assert.equal(pushups.result, 12);

  const view = await wf.athleteAssessmentView(PARENT_YOUTH, { athleteId: Y, now: Youth.baseline.recordedAt });
  assert.equal(view.baseline.complete, true);
  assert.equal(view.schedule.status, 'not-due');
  // No second session yet: every test is baseline-only, and every
  // progress record carries the under-18 growth caveat.
  for (const p of Object.values(view.progress.tests)) {
    assert.equal(p.status, 'baseline-only');
    assert.ok(p.caveats.some(c => c.includes('under 18')), 'youth growth caveat present');
  }
  assert.equal(view.personalBests['broad-jump'].value, 64);
});

test('plan finalization: gated without baseline, finalized with baseline, override recorded', async () => {
  const { wf } = fresh();
  // Youth has no baseline yet: finalization refuses.
  const planY = await wf.createPlan(COACH, { athleteId: Y });
  assert.equal(planY.status, 'draft');
  await assert.rejects(
    () => wf.finalizePlan(COACH, { planId: planY.id }),
    e => e.code === 'PLAN_NOT_READY' && e.missing.includes('10yd-sprint'));

  // Explicit recorded override finalizes, and the override is on the plan.
  const over = await wf.finalizePlan(COACH, {
    planId: planY.id, override: { reason: 'Youth athlete starts play-based block while baseline is scheduled.', approvedBy: 'coach-marcus' },
  });
  assert.equal(over.status, 'finalized');
  assert.equal(over.overrideReason, 'Youth athlete starts play-based block while baseline is scheduled.');
  assert.equal(over.overrideApprovedBy, 'coach-marcus');
  assert.equal(over.baselineSessionId, null, 'no baseline session on an override finalization');

  // Adult with a complete baseline finalizes on the baseline session.
  await completeBaseline(wf, W, Wingback, 'wf-wingback-plan');
  const planW = await wf.createPlan(COACH, { athleteId: W });
  const fin = await wf.finalizePlan(COACH, { planId: planW.id });
  assert.equal(fin.status, 'finalized');
  assert.ok(fin.baselineSessionId, 'finalized on the baseline session');
  assert.equal(fin.overrideReason, null);
  // A finalized plan cannot be finalized again.
  await assert.rejects(() => wf.finalizePlan(COACH, { planId: planW.id }), /already finalized/);
});

test('adult: 28-day reassessment — due, completed, progress improved, PBs updated, next due set', async () => {
  const { wf } = fresh();
  await completeBaseline(wf, W, Wingback, 'wf-wingback-reassess');
  const dueAt = '2027-02-07T12:00:00Z';
  const before = await wf.athleteAssessmentView(COACH, { athleteId: W, now: dueAt });
  assert.equal(before.schedule.status, 'due');
  assert.equal(before.reminder.message, 'Your reassessment is due today.');

  const done = await wf.completeAssessment(COACH, {
    athleteId: W, entries: Wingback.reassessment.entries, idempotencyKey: 'wf-wingback-reassess-1',
    now: dueAt,
  });
  assert.equal(done.schedule.status, 'not-due');
  assert.equal(done.schedule.nextDueAt, '2027-03-07T12:00:00.000Z', 'reassessment + 28 days');

  const view = await wf.athleteAssessmentView(COACH, { athleteId: W, now: dueAt });
  assert.equal(view.history.length, 2, 'baseline + reassessment');
  assert.equal(view.progress.tests['10yd-sprint'].status, 'improved');
  assert.equal(view.progress.tests['10yd-sprint'].vsBaseline.absolute, -0.06);
  assert.equal(view.progress.tests['10yd-sprint'].vsPrevious.absolute, -0.06);
  assert.equal(view.progress.tests['10yd-sprint'].personalBest, 1.95);
  assert.equal(view.progress.tests['10yd-sprint'].isPersonalBest, true);
  assert.equal(view.progress.tests['broad-jump'].personalBest, 84);
  assert.equal(view.progress.summary.improved, 9, 'all nine measured tests improved');
  // Smart Draft evidence is advisory only: no plan was touched.
  assert.equal(view.advisory.advisoryOnly, true);
  assert.equal(view.advisory.autoRewrite, false);
  assert.equal(view.advisory.priorities.length, 0, 'no declining priorities after an all-improved reassessment');
});

test('overdue stays overdue until completed or deferred; deferral flips it to deferred', async () => {
  const { wf } = fresh();
  await completeBaseline(wf, W, Wingback, 'wf-wingback-overdue');
  const late = '2027-02-14T12:00:00Z'; // 35 days after baseline: 7 days overdue
  const view = await wf.athleteAssessmentView(COACH, { athleteId: W, now: late });
  assert.equal(view.schedule.status, 'overdue');
  assert.equal(view.schedule.overdueDays, 7);

  const dash = await wf.coachDashboard(COACH, { now: late });
  assert.deepEqual(dash.reminders.overdue.map(s => s.athleteId), [W]);
  assert.deepEqual(dash.reminders.neverAssessed.map(s => s.athleteId), [Y]);

  // A deferral without a reason or approver is refused.
  await assert.rejects(
    () => wf.recordDeferral(COACH, { athleteId: W, scope: 'battery', kind: 'deferral', deferredUntil: '2027-03-01T12:00:00Z' }),
    e => e.code === 'INVALID_DEFERRAL');
  const def = await wf.recordDeferral(COACH, {
    athleteId: W, scope: 'battery', kind: 'deferral', deferredUntil: '2027-03-01T12:00:00Z',
    reason: 'Travel — athlete away for two weeks.', approvedBy: 'coach-marcus', now: late,
  });
  assert.equal(def.kind, 'deferral');
  const after = await wf.athleteAssessmentView(COACH, { athleteId: W, now: late });
  assert.equal(after.schedule.status, 'deferred');
  assert.equal(after.reminder.message, 'Your reassessment has been deferred by your coach.');
});

test('exclusion lets a baseline complete without an unsafe test', async () => {
  const { wf } = fresh();
  await wf.recordDeferral(COACH, {
    athleteId: Y, scope: 'test', assessmentId: 'single-leg-balance-l', kind: 'exclusion',
    reason: 'Left ankle sprain — balance test unsafe this cycle.', approvedBy: 'coach-marcus',
  });
  const entries = Youth.baseline.entries.filter(e => e.assessmentId !== 'single-leg-balance-l');
  const done = await wf.completeAssessment(COACH, {
    athleteId: Y, entries, idempotencyKey: 'wf-youth-exclusion', now: Youth.baseline.recordedAt,
  });
  assert.equal(done.baseline.complete, true, 'excluded test does not block the baseline');
  assert.deepEqual(done.baseline.excluded, ['single-leg-balance-l']);
  assert.equal(done.results.find(r => r.assessmentId === 'single-leg-balance-l'), undefined);
});

test('Smart Draft: a single declining result is low-confidence advisory only; no plan is ever rewritten', async () => {
  const { wf } = fresh();
  await completeBaseline(wf, W, Wingback, 'wf-wingback-decline');
  // Reassessment where only the sprint regresses.
  const worse = Wingback.reassessment.entries.map(e =>
    (e.assessmentId === '10yd-sprint' ? { ...e, attempts: [2.20, 2.18, 2.19] } : e));
  await wf.completeAssessment(COACH, {
    athleteId: W, entries: worse, idempotencyKey: 'wf-wingback-decline-1', now: '2027-02-07T12:00:00Z',
  });
  const plan = await wf.createPlan(COACH, { athleteId: W });
  const before = JSON.parse(JSON.stringify(plan));
  const advisory = await wf.advisoryPriorities(COACH, { athleteId: W, goals: ['acceleration'] });
  assert.equal(advisory.advisoryOnly, true);
  assert.equal(advisory.requiresCoachApproval, true);
  assert.equal(advisory.autoRewrite, false);
  assert.equal(advisory.priorities.length, 1);
  assert.equal(advisory.priorities[0].priority, 'acceleration');
  assert.equal(advisory.priorities[0].confidence, 'low', 'single-result evidence is low confidence');
  assert.equal(advisory.priorities[0].goalAligned, true);
  assert.deepEqual(plan, before, 'the plan record is untouched by advisory output');
  assert.equal(typeof wf.applyAdvisory, 'undefined', 'no function exists that applies advisory output to a plan');
});

test('unauthorized access: athlete sees only self, parent only own, coach only own cohort, anon nothing', async () => {
  const { wf } = fresh();
  await completeBaseline(wf, W, Wingback, 'wf-wingback-authz');
  // Athlete A views athlete B.
  await assert.rejects(
    () => wf.athleteAssessmentView(ATHLETE_WINGBACK, { athleteId: Y }),
    e => e.code === 'FORBIDDEN');
  // Parent of the youth views the wingback.
  await assert.rejects(
    () => wf.athleteAssessmentView(PARENT_YOUTH, { athleteId: W }),
    e => e.code === 'FORBIDDEN');
  // Parent may not record anything.
  await assert.rejects(
    () => wf.startAssessment(PARENT_YOUTH, { athleteId: Y }),
    e => e.code === 'FORBIDDEN');
  // A coach from another cohort may not start, record, or view.
  await assert.rejects(
    () => wf.startAssessment(COACH_OTHER, { athleteId: W }),
    e => e.code === 'FORBIDDEN');
  await assert.rejects(
    () => wf.athleteAssessmentView(COACH_OTHER, { athleteId: W }),
    e => e.code === 'FORBIDDEN');
  // Anonymous caller gets nothing.
  await assert.rejects(
    () => wf.athleteAssessmentView(ANON, { athleteId: W }),
    e => e.code === 'UNAUTHENTICATED');
  await assert.rejects(
    () => wf.coachDashboard(ANON, {}),
    e => e.code === 'UNAUTHENTICATED');
  // The athlete's own view works.
  const self = await wf.athleteAssessmentView(ATHLETE_WINGBACK, { athleteId: W, now: Wingback.baseline.recordedAt });
  assert.equal(self.baseline.complete, true);
  // The athlete cannot see drafts (coach working state).
  await assert.rejects(
    () => wf.getDraft(ATHLETE_WINGBACK, { athleteId: W }),
    e => e.code === 'FORBIDDEN');
});

test('drafts never count as history: a discarded draft leaves no session, no baseline, no due date', async () => {
  const { wf } = fresh();
  await wf.startAssessment(COACH, { athleteId: W, now: Wingback.baseline.recordedAt });
  await wf.recordAttempts(COACH, { athleteId: W, entries: Wingback.baseline.entries.slice(0, 3) });
  const dropped = await wf.discardDraft(COACH, { athleteId: W });
  assert.equal(dropped.discarded, true);
  const view = await wf.athleteAssessmentView(COACH, { athleteId: W, now: Wingback.baseline.recordedAt });
  assert.equal(view.baseline.complete, false);
  assert.equal(view.history.length, 0);
  assert.equal(view.schedule.status, 'never-assessed');
  assert.equal(view.schedule.nextDueAt, null);
});
