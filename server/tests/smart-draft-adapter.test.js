/* Smart Draft advisory adapter tests.
 * Run: node --test server/tests/smart-draft-adapter.test.js
 * Pins the advisory-only contract: evidence is ranked input for a
 * human coach, never an automatic program rewrite, and one poor
 * result never rewrites anything.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Adapter = require('../smart-draft-adapter');
const { progressForAthlete } = require('../progress');

const H = (pairs) => pairs.map(([recordedAt, result]) => ({ recordedAt, result }));
function priorities(rows, opts = {}) {
  const { tests } = progressForAthlete('a1', rows, { age: opts.age || 48 });
  return Adapter.developmentPriorities({ athleteId: 'a1', progressByTest: tests, goals: opts.goals || [] });
}

test('every advisory output carries the advisory-only contract', () => {
  const out = priorities({ 'broad-jump': H([['2027-01-10', 63], ['2027-02-07', 58]]) });
  assert.equal(out.advisoryOnly, true);
  assert.equal(out.requiresCoachApproval, true);
  assert.equal(out.autoRewrite, false);
  assert.match(out.caveat, /must not become an automatic program rewrite/);
  assert.equal(typeof Adapter.applyToDraft, 'undefined', 'there is no apply function');
  assert.equal(typeof Adapter.rewritePlan, 'undefined', 'there is no rewrite function');
});

test('a single poor result flags one priority at low confidence — and nothing else', () => {
  const out = priorities({ 'broad-jump': H([['2027-01-10', 63], ['2027-02-07', 58]]) });
  assert.equal(out.priorities.length, 1);
  assert.equal(out.priorities[0].priority, 'power');
  assert.equal(out.priorities[0].displayName, 'Power');
  assert.equal(out.priorities[0].confidence, 'low');
  assert.match(out.priorities[0].note, /single assessment result/);
  assert.equal(out.priorities[0].sources.length, 1);
});

test('improvement creates no need; declines rank by evidence score', () => {
  const better = priorities({ 'broad-jump': H([['2027-01-10', 60], ['2027-02-07', 63]]) });
  assert.equal(better.priorities.length, 0, 'an improvement is not a priority');
  const mixed = priorities({
    'broad-jump': H([['2027-01-10', 63], ['2027-02-07', 58]]),
    '10yd-sprint': H([['2027-01-10', 2.00], ['2027-02-07', 2.20]]),
  });
  assert.equal(mixed.priorities.length, 2);
  assert.equal(mixed.priorities[0].priority, 'acceleration', 'the 10% sprint decline outranks the 8% jump decline');
  assert.equal(mixed.priorities[1].priority, 'power');
});

test('assessment ids map to the mission priority names', () => {
  const out = priorities({
    '5-10-5-shuttle': H([['2027-01-10', 5.0], ['2027-02-07', 5.5]]),
    '6min-walk-run': H([['2027-01-10', 700], ['2027-02-07', 650]]),
    'single-leg-balance-r': H([['2027-01-10', 40], ['2027-02-07', 30]]),
    'push-ups': H([['2027-01-10', 20], ['2027-02-07', 15]]),
  });
  const names = out.priorities.map(p => p.priority).sort();
  assert.deepEqual(names, ['agility', 'cardiovascular_conditioning', 'mobility_movement_control', 'muscular_endurance']);
  assert.equal(Adapter.PRIORITY_NAMES.agility, 'Agility');
  assert.equal(Adapter.PRIORITY_NAMES.cardiovascular_conditioning, 'Cardiovascular conditioning');
});

test('no trend means insufficient evidence, not a fabricated priority', () => {
  const out = priorities({ 'broad-jump': H([['2027-01-10', 60]]) });
  assert.equal(out.insufficientEvidence, true);
  assert.equal(out.priorities.length, 0);
  assert.match(Adapter.summarizeForCoach(out), /insufficient/);
  const empty = priorities({});
  assert.equal(empty.insufficientEvidence, true);
});

test('goals flag alignment without changing evidence scores', () => {
  const rows = { 'broad-jump': H([['2027-01-10', 63], ['2027-02-07', 58]]) };
  const noGoals = priorities(rows);
  const withGoals = priorities(rows, { goals: ['power'] });
  assert.equal(withGoals.priorities[0].evidenceScore, noGoals.priorities[0].evidenceScore);
  assert.equal(withGoals.priorities[0].goalAligned, true);
  assert.equal(noGoals.priorities[0].goalAligned, false);
});

test('prioritiesFromResults builds advisory output straight from stored rows', () => {
  const out = Adapter.prioritiesFromResults('a1', [
    { assessmentId: '10yd-sprint', recordedAt: '2027-01-10', result: 2.00 },
    { assessmentId: '10yd-sprint', recordedAt: '2027-02-07', result: 2.20 },
  ], { age: 48 });
  assert.equal(out.priorities.length, 1);
  assert.equal(out.priorities[0].priority, 'acceleration');
  assert.match(Adapter.summarizeForCoach(out), /advisory only/);
  assert.match(Adapter.summarizeForCoach({ athleteId: 'a1', advisoryOnly: true, requiresCoachApproval: true,
    autoRewrite: false, priorities: [], insufficientEvidence: false }), /no declining priorities/);
});
