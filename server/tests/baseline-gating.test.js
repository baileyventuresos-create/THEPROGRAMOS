/* Baseline gating tests.
 * Run: node --test server/tests/baseline-gating.test.js
 * Pins the rule: a development plan is finalized only after a
 * complete baseline (or an explicit, recorded coach override). The
 * gate touches plan finalization only — nothing else.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { GATE_SCOPE, assessPlanReadiness, finalizePlan } = require('../baseline-gating');
const { GAA_MEASURED_IDS } = require('../assessment-battery');

const T0 = '2027-01-10T12:00:00Z';
function fullSession(athleteId) {
  const id = 's_base';
  const results = GAA_MEASURED_IDS.map(aid => ({ sessionId: id, athleteId, assessmentId: aid, result: 10, recordedAt: T0 }));
  return { sessions: [{ id, athleteId, battery: 'generalAthleticAssessment', recordedAt: T0 }], results };
}
const plan = (over = {}) => ({ id: 'plan-1', athleteId: 'a1', status: 'draft', ...over });

test('gate scope is plan finalization only', () => {
  assert.equal(GATE_SCOPE, 'plan-finalization-only');
});

test('a plan is not finalizable without a baseline', () => {
  const readiness = assessPlanReadiness({ athleteId: 'a1', sessions: [], results: [], deferrals: [] });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.missing.length > 0);
  assert.throws(() => finalizePlan({ plan: plan(), readiness, coachId: 'coach-1' }),
    e => e.code === 'PLAN_NOT_READY' && e.missing.includes('10yd-sprint'));
});

test('a plan finalizes once the baseline is complete', () => {
  const data = fullSession('a1');
  const readiness = assessPlanReadiness({ athleteId: 'a1', ...data, deferrals: [] });
  assert.equal(readiness.ready, true);
  const done = finalizePlan({ plan: plan(), readiness, coachId: 'coach-1', now: T0 });
  assert.equal(done.status, 'finalized');
  assert.equal(done.baselineSessionId, 's_base');
  assert.equal(done.finalizedBy, 'coach-1');
  assert.equal(done.finalizedAt, '2027-01-10T12:00:00.000Z');
  assert.equal(done.overrideReason, null);
});

test('a coach-approved exclusion lets the plan finalize', () => {
  const missing = GAA_MEASURED_IDS.filter(id => id !== '6min-walk-run');
  const id = 's_base';
  const data = { sessions: [{ id, athleteId: 'a1', battery: 'generalAthleticAssessment', recordedAt: T0 }],
    results: missing.map(aid => ({ sessionId: id, athleteId: 'a1', assessmentId: aid, result: 10, recordedAt: T0 })) };
  const deferrals = [{ athleteId: 'a1', battery: 'generalAthleticAssessment', assessmentId: '6min-walk-run',
    scope: 'test', kind: 'exclusion', reason: 'Ankle injury', approvedBy: 'coach-1' }];
  const readiness = assessPlanReadiness({ athleteId: 'a1', ...data, deferrals });
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.excluded, ['6min-walk-run']);
  const done = finalizePlan({ plan: plan(), readiness, coachId: 'coach-1' });
  assert.equal(done.status, 'finalized');
});

test('an explicit recorded override finalizes; a silent one does not', () => {
  const readiness = assessPlanReadiness({ athleteId: 'a1', sessions: [], results: [], deferrals: [] });
  assert.throws(() => finalizePlan({ plan: plan(), readiness, coachId: 'coach-1', override: { approvedBy: 'coach-1' } }),
    /explicit recorded override|PLAN_NOT_READY/, 'override without a reason is refused');
  const done = finalizePlan({ plan: plan(), readiness, coachId: 'coach-1',
    override: { reason: 'Athlete relocating; baseline scheduled next month', approvedBy: 'coach-1' } });
  assert.equal(done.status, 'finalized');
  assert.equal(done.overrideReason, 'Athlete relocating; baseline scheduled next month');
  assert.equal(done.overrideApprovedBy, 'coach-1');
  assert.deepEqual(done.overrideMissingAtFinalization, readiness.missing);
});

test('finalization refuses bad inputs instead of finalizing anyway', () => {
  const data = fullSession('a1');
  const readiness = assessPlanReadiness({ athleteId: 'a1', ...data, deferrals: [] });
  assert.throws(() => finalizePlan({ plan: plan({ status: 'finalized' }), readiness, coachId: 'coach-1' }), /already finalized/);
  assert.throws(() => finalizePlan({ plan: plan(), readiness }), /coachId is required/);
  assert.throws(() => finalizePlan({ plan: plan(), readiness: assessPlanReadiness({ athleteId: 'a2', sessions: [], results: [], deferrals: [] }), coachId: 'coach-1' }),
    /readiness assessment for this athlete/);
});

test('readiness never throws for an athlete with no assessments', () => {
  const readiness = assessPlanReadiness({ athleteId: 'a-new', sessions: [], results: [], deferrals: [] });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.baselineSessionId, null);
});
