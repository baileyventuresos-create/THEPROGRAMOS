/* 28-day reassessment engine tests.
 * Run: node --test server/tests/reassessment.test.js
 * Pins the schedule: 28 days after the previous completed GAA
 * session; approaching/due/overdue/deferred transitions; baseline
 * completeness; coach-approved deferrals/exclusions.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const R = require('../reassessment');
const { recordAssessmentSession, MemoryAssessmentStore } = require('../assessment-store');
const { GAA_MEASURED_IDS } = require('../assessment-battery');

const T0 = '2027-01-10T12:00:00Z';
const day = n => new Date(new Date(T0).getTime() + n * 86400000).toISOString();

function gaaSession(athleteId, recordedAt, resultMap) {
  const id = `s_${recordedAt}`;
  const results = Object.entries(resultMap || {}).map(([assessmentId, result]) =>
    ({ sessionId: id, athleteId, assessmentId, result, recordedAt }));
  return { sessions: [{ id, athleteId, battery: 'generalAthleticAssessment', recordedAt }], results };
}

test('next due date is exactly 28 days after the completed session', () => {
  assert.equal(R.nextDueDate(T0).toISOString(), '2027-02-07T12:00:00.000Z');
  assert.equal(R.nextDueDate(null), null);
  assert.equal(R.RETEST_DAYS, 28);
});

test('due status transitions: never-assessed, not-due, approaching, due, overdue', () => {
  assert.equal(R.dueStatus({ now: T0 }), 'never-assessed');
  assert.equal(R.dueStatus({ lastCompletedAt: T0, now: day(10) }), 'not-due', '18 days out');
  assert.equal(R.dueStatus({ lastCompletedAt: T0, now: day(20) }), 'not-due', '8 days out');
  assert.equal(R.dueStatus({ lastCompletedAt: T0, now: day(21) }), 'approaching', '7 days out');
  assert.equal(R.dueStatus({ lastCompletedAt: T0, now: day(27) }), 'approaching', '1 day out');
  assert.equal(R.dueStatus({ lastCompletedAt: T0, now: day(28) }), 'due', 'due today');
  assert.equal(R.dueStatus({ lastCompletedAt: T0, now: day(29) }), 'overdue', '1 day past');
  assert.equal(R.dueStatus({ lastCompletedAt: T0, now: day(40) }), 'overdue', '12 days past');
});

test('an active deferral pauses the schedule; an expired one does not', () => {
  assert.equal(R.dueStatus({ lastCompletedAt: T0, deferredUntil: day(40), now: day(30) }), 'deferred');
  assert.equal(R.dueStatus({ lastCompletedAt: T0, deferredUntil: day(40), now: day(41) }), 'overdue',
    'after the deferral expires the overdue status returns');
  assert.equal(R.dueStatus({ deferredUntil: day(40), now: day(10) }), 'deferred',
    'a never-assessed athlete can still be deferred');
});

test('a missed assessment stays overdue until completed or deferred', () => {
  const { sessions, results } = gaaSession('a1', T0, { '10yd-sprint': 2.0 });
  const s40 = R.scheduleFor('a1', { sessions, results }, day(40));
  assert.equal(s40.status, 'overdue');
  assert.equal(s40.overdueDays, 12);
  // Completing a new session resets the clock from the new date.
  const second = gaaSession('a1', day(40), { '10yd-sprint': 1.98 });
  const s41 = R.scheduleFor('a1', { sessions: [...sessions, ...second.sessions], results: [...results, ...second.results] }, day(41));
  assert.equal(s41.status, 'not-due');
  assert.equal(s41.lastCompletedAt, day(40));
});

test('legacy generalAthlete sessions do not count toward the GAA baseline', () => {
  const sessions = [{ id: 's1', athleteId: 'a1', battery: 'generalAthlete', recordedAt: T0 }];
  const results = [{ sessionId: 's1', athleteId: 'a1', assessmentId: '10yd-sprint', result: 2.0, recordedAt: T0 }];
  const s = R.scheduleFor('a1', { sessions, results }, day(10));
  assert.equal(s.status, 'never-assessed');
  assert.equal(s.hasBaseline, false);
});

test('baseline is complete only when every GAA test is recorded, modified, excluded, or deferred', () => {
  const full = Object.fromEntries(GAA_MEASURED_IDS.map(id => [id, 10]));
  const { sessions, results } = gaaSession('a1', T0, full);
  const base = R.baselineStatus('a1', { sessions, results });
  assert.equal(base.complete, true);
  assert.equal(base.sessionId, 's_' + T0);
  assert.deepEqual(base.missing, []);

  const partial = gaaSession('a1', T0, { '10yd-sprint': 2.0, 'broad-jump': 60 });
  const incomplete = R.baselineStatus('a1', partial);
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.missing.includes('5-10-5-shuttle'));
  assert.ok(!incomplete.missing.includes('10yd-sprint'));

  // A coach-approved exclusion removes a test from the requirement.
  const deferrals = [{ athleteId: 'a1', battery: 'generalAthleticAssessment',
    assessmentId: '6min-walk-run', scope: 'test', kind: 'exclusion',
    reason: 'Ankle injury — running contraindicated', approvedBy: 'coach-1' }];
  const partial2 = gaaSession('a1', T0, Object.fromEntries(
    GAA_MEASURED_IDS.filter(id => id !== '6min-walk-run').map(id => [id, 10])));
  const withExclusion = R.baselineStatus('a1', { ...partial2, deferrals });
  assert.equal(withExclusion.complete, true);
  assert.deepEqual(withExclusion.excluded, ['6min-walk-run']);
});

test('the baseline is the earliest complete session; later sessions do not move it', async () => {
  const store = new MemoryAssessmentStore();
  const full = Object.fromEntries(GAA_MEASURED_IDS.map(id => [id, 10]));
  const entries = Object.entries(full).map(([assessmentId, v]) => ({ assessmentId, attempts: [v] }));
  const first = await recordAssessmentSession(store, { athleteId: 'a1', coachId: 'c1',
    entries, meta: { battery: 'generalAthleticAssessment', recordedAt: T0 } });
  await recordAssessmentSession(store, { athleteId: 'a1', coachId: 'c1',
    entries, meta: { battery: 'generalAthleticAssessment', recordedAt: day(28) } });
  const sessions = store.sessions.map(s => ({ id: s.id, athleteId: s.athleteId, battery: s.battery, recordedAt: s.recordedAt }));
  const results = store.results.map(r => ({ sessionId: r.sessionId, athleteId: r.athleteId, assessmentId: r.assessmentId, result: r.result, recordedAt: r.recordedAt }));
  const base = R.baselineStatus('a1', { sessions, results });
  assert.equal(base.complete, true);
  assert.equal(base.sessionId, first.session.id, 'baseline stays the first complete session');
  assert.equal(base.completedAt, T0);
});

test('coach dashboard reminders bucket athletes correctly', () => {
  const a = gaaSession('a-due', day(-28), { '10yd-sprint': 2.0 });
  const b = gaaSession('a-approaching', day(-22), { '10yd-sprint': 2.0 });
  const c = gaaSession('a-overdue', day(-40), { '10yd-sprint': 2.0 });
  const sessions = [...a.sessions, ...b.sessions, ...c.sessions];
  const results = [...a.results, ...b.results, ...c.results];
  const rem = R.reassessmentReminders(['a-due', 'a-approaching', 'a-overdue', 'a-never'],
    { sessions, results }, T0);
  assert.deepEqual(rem.due.map(s => s.athleteId), ['a-due']);
  assert.deepEqual(rem.approaching.map(s => s.athleteId), ['a-approaching']);
  assert.deepEqual(rem.overdue.map(s => s.athleteId), ['a-overdue']);
  assert.deepEqual(rem.neverAssessed.map(s => s.athleteId), ['a-never']);
  const athleteView = R.athleteReminder('a-overdue', { sessions, results }, T0);
  assert.equal(athleteView.status, 'overdue');
  assert.match(athleteView.message, /overdue/);
});

test('deferrals require coach approval, a reason, and a future date', async () => {
  const store = new R.MemoryReassessmentStore();
  await assert.rejects(R.recordDeferral(store, { athleteId: 'a1', battery: 'generalAthleticAssessment',
    scope: 'battery', kind: 'deferral', deferredUntil: day(14), reason: 'Holiday' }),
    /approvedBy/, 'no coach approval');
  await assert.rejects(R.recordDeferral(store, { athleteId: 'a1', battery: 'generalAthleticAssessment',
    scope: 'battery', kind: 'deferral', deferredUntil: day(14), approvedBy: 'coach-1' }),
    /reason/, 'no reason');
  await assert.rejects(R.recordDeferral(store, { athleteId: 'a1', battery: 'generalAthleticAssessment',
    scope: 'battery', kind: 'deferral', deferredUntil: '2020-01-01T00:00:00Z', reason: 'Holiday', approvedBy: 'coach-1' }),
    /future/, 'past deferredUntil (a date genuinely in the past, not just before the test fixture date)');
  await assert.rejects(R.recordDeferral(store, { athleteId: 'a1', battery: 'generalAthleticAssessment',
    scope: 'test', kind: 'deferral', deferredUntil: day(14), reason: 'x', approvedBy: 'coach-1' }),
    /assessmentId/, 'test scope needs an assessment');
  const ok = await R.recordDeferral(store, { athleteId: 'a1', battery: 'generalAthleticAssessment',
    scope: 'battery', kind: 'deferral', deferredUntil: day(14), reason: 'Holiday break', approvedBy: 'coach-1' });
  assert.equal(ok.kind, 'deferral');
  assert.equal((await store.listDeferrals('a1')).length, 1);
});
