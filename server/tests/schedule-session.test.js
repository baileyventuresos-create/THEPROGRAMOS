/* Session-scheduling link tests.
 * Run: node --test server/tests/schedule-session.test.js
 * Pins: a feasible draft produces the correct stored cap + row payload;
 * an over-cap draft is flagged (never auto-raised); a zero-coach draft
 * is infeasible; a draft without human approval is refused.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scheduleSession } = require('../schedule-session');

const P60 = { id: 'p60', dur: 60, phases: { arrive: 5, ignite: 8, build: 24, compete: 15, reset: 5, close: 3 } };

function draft(overrides) {
  return Object.assign({
    template: P60,
    coachesAvailable: 3,
    cohort: { id: 'YAK-A', cap: 20 },
    cohortId: 'YAK-A', locationId: 'YAK', spaceId: 'space-main',
    templateId: 'p60', date: '2027-06-15', startTime: '4:30 PM', durationMin: 60,
    expectedAttendance: 16,
    planId: 'plan-2027-06-15-yaka',
    planApprovedBy: 'Marcus',
    emphasis: ['Acceleration'],
  }, overrides || {});
}

test('feasible draft produces the correct cap and row payload', () => {
  const out = scheduleSession(draft());
  assert.equal(out.feasible, true);
  assert.equal(out.flaggedInfeasible, false);
  assert.deepEqual(out.flagReasons, []);
  assert.equal(out.decision.effectiveCap, 18, '3 coaches x 6 per station');
  assert.equal(out.row.capacity_effective, 18);
  assert.equal(out.row.capacity_preferred, 18);
  assert.equal(out.row.status, 'scheduled');
  assert.equal(out.row.plan_id, 'plan-2027-06-15-yaka');
  assert.equal(out.row.plan_approved_by, 'Marcus');
  assert.equal(out.row.cohort_id, 'YAK-A');
  assert.equal(out.row.template_id, 'p60');
  assert.equal(out.row.date, '2027-06-15');
  assert.deepEqual(out.row.capacity_inputs.template, P60);
  assert.equal(out.row.capacity_inputs.coachesAvailable, 3);
  assert.equal(out.row.capacity_inputs.cohortCap, 20);
});

test('cohort enrollment cap binds the scheduled cap', () => {
  const out = scheduleSession(draft({ cohort: { id: 'CLE-A', cap: 14 }, expectedAttendance: 12 }));
  assert.equal(out.row.capacity_effective, 14);
  assert.equal(out.flaggedInfeasible, false);
});

test('over-cap draft is flagged, never auto-raised', () => {
  const out = scheduleSession(draft({ expectedAttendance: 20 }));
  assert.equal(out.feasible, true, 'the session itself is feasible');
  assert.equal(out.flaggedInfeasible, true, 'expected 20 > cap 18 must be flagged');
  assert.equal(out.row.capacity_effective, 18, 'cap stays 18 — demand does not raise it');
  assert.ok(out.flagReasons.some(r => /Expected attendance \(20\) exceeds/.test(r)));
});

test('zero-coach draft is infeasible and flagged, with cap 0', () => {
  const out = scheduleSession(draft({ coachesAvailable: 0, expectedAttendance: 10 }));
  assert.equal(out.feasible, false);
  assert.equal(out.flaggedInfeasible, true);
  assert.equal(out.row.capacity_effective, 0);
  assert.ok(out.decision.infeasibleReasons.some(r => /No coach/.test(r)));
});

test('equipment-shortfall draft is infeasible', () => {
  const out = scheduleSession(draft({
    coachesAvailable: 3,
    equipment: [{ item: 'cones', have: 0, needPerAthlete: 4 }],
  }));
  assert.equal(out.feasible, false);
  assert.equal(out.flaggedInfeasible, true);
  assert.equal(out.row.capacity_effective, 0);
});

test('draft without human approval is refused', () => {
  assert.throws(() => scheduleSession(draft({ planApprovedBy: '' })), /planApprovedBy is required/);
  assert.throws(() => scheduleSession(draft({ planApprovedBy: null })), /planApprovedBy is required/);
  const noField = draft();
  delete noField.planApprovedBy;
  assert.throws(() => scheduleSession(noField), /planApprovedBy is required/);
});
