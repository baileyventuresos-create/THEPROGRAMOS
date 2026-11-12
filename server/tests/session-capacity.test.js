/* Session capacity adapter tests.
 * Run: node --test server/tests/session-capacity.test.js
 * These tests pin the prototype's own rules (THE PROGRAM OS.html):
 * buildConfigs/slotMath (stations at once <= coaches, preferred 4-6 per
 * station, BUILD slot 5..14 min), coachesFor (3 group / 1 small group),
 * sessionWarnings (stations > coaches is CRIT), and the cohort-cap vs
 * session-cap distinction. No universal athlete limit appears anywhere.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { computeSessionCapacity, recalculateCapacity, layoutFor } = require('../session-capacity');

const P60 = { id: 'p60', dur: 60, phases: { arrive: 5, ignite: 8, build: 24, compete: 15, reset: 5, close: 3 } };
const SG45 = { id: 'sg45', dur: 45, oneGroup: true, phases: { arrive: 4, ignite: 7, build: 21, compete: 8, reset: 2, close: 3 } };

test('capacity is derived from coaches, not a universal limit: 1 vs 3 coaches differ', () => {
  const one = computeSessionCapacity({ template: P60, coachesAvailable: 1 });
  const three = computeSessionCapacity({ template: P60, coachesAvailable: 3 });
  assert.equal(one.preferredCap, 6, '1 coach x 6 per station');
  assert.equal(three.preferredCap, 18, '3 coaches x 6 per station');
  assert.notEqual(one.effectiveCap, three.effectiveCap);
  assert.ok(three.effectiveCap > one.effectiveCap);
});

test('layout mirrors prototype buildConfigs: p60, 16 athletes, 3 coaches fits 4-6/station', () => {
  const layout = layoutFor(16, 24, 3, false);
  assert.equal(layout.feasible, true);
  assert.ok(layout.k <= 3, 'stations at once never exceed coaches');
  assert.ok(layout.size >= 4 && layout.size <= 6, `station size ${layout.size} in preferred 4-6`);
  assert.ok(layout.slotMin >= 5 && layout.slotMin <= 14, `slot ${layout.slotMin} min in 5..14`);
});

test('one coach cannot run a 16-athlete rotation at preferred size', () => {
  const d = computeSessionCapacity({ template: P60, coachesAvailable: 1, cohortCap: 20 });
  assert.equal(d.effectiveCap, 6, '1 coach caps the session at 6 (one station of 6)');
  assert.ok(d.limitingFactors.some(l => l.constraint === 'coached stations (preferred)' && l.value === 6));
  const three = computeSessionCapacity({ template: P60, coachesAvailable: 3, cohortCap: 20 });
  assert.equal(three.effectiveCap, 18, 'the same cohort with 3 coaches fits 18');
});

test('cohort enrollment cap binds the session cap but is not the same thing', () => {
  const d = computeSessionCapacity({ template: P60, coachesAvailable: 3, cohortCap: 14 });
  assert.equal(d.effectiveCap, 14, 'CLE-A style cap 14 binds below the 18 preferred');
  assert.ok(d.limitingFactors.some(l => l.constraint === 'cohort enrollment cap' && l.value === 14));
  assert.ok(d.limitingFactors.some(l => l.constraint === 'coached stations (preferred)' && l.value === 18));
});

test('small-group template: one group, one coach, cap follows cohort cap', () => {
  const d = computeSessionCapacity({ template: SG45, coachesAvailable: 1, cohortCap: 5 });
  assert.equal(d.effectiveCap, 5);
  assert.equal(d.feasible, true);
});

test('equipment binds capacity: cones per athlete vs inventory', () => {
  const d = computeSessionCapacity({ template: P60, coachesAvailable: 3, cohortCap: 20,
    equipment: [{ item: 'cones', have: 60, needPerAthlete: 4 }] });
  assert.equal(d.effectiveCap, 15, '60 cones / 4 per athlete = 15');
  const zero = computeSessionCapacity({ template: P60, coachesAvailable: 3,
    equipment: [{ item: 'pinnies', have: 0, needPerAthlete: 1 }] });
  assert.equal(zero.feasible, false);
  assert.match(zero.infeasibleReasons.join(' '), /Equipment shortfall/);
});

test('zero coaches = infeasible session, never a guessed cap', () => {
  const d = computeSessionCapacity({ template: P60, coachesAvailable: 0 });
  assert.equal(d.feasible, false);
  assert.equal(d.effectiveCap, 0);
  assert.match(d.infeasibleReasons.join(' '), /No coach available/);
});

test('missing facility occupancy is flagged, never inferred from dimensions', () => {
  const d = computeSessionCapacity({ template: P60, coachesAvailable: 3,
    location: { spaces: [{ name: 'Main gym', maxAthletes: 24 }, { name: 'Hallway strip' }] } });
  assert.match(d.warnings.join(' '), /occupancy not fully specified/);
  const full = computeSessionCapacity({ template: P60, coachesAvailable: 3,
    location: { spaces: [{ name: 'Main gym', maxAthletes: 24 }] } });
  assert.equal(full.effectiveCap, 18, 'facility 24 does not bind below preferred 18');
  const tight = computeSessionCapacity({ template: P60, coachesAvailable: 3,
    location: { spaces: [{ name: 'Small room', maxAthletes: 10 }] } });
  assert.equal(tight.effectiveCap, 10, 'facility 10 binds');
});

test('capacity recalculation reports the change and never silently cancels bookings', () => {
  const before = computeSessionCapacity({ template: P60, coachesAvailable: 3, cohortCap: 20 });
  const after = recalculateCapacity(before, { template: P60, coachesAvailable: 2, cohortCap: 20 });
  assert.equal(after.changed, true);
  assert.equal(after.previousEffectiveCap, 18);
  assert.equal(after.next.effectiveCap, 12);
  assert.match(after.note, /NOT cancelled automatically/);
  const same = recalculateCapacity(before, { template: P60, coachesAvailable: 3, cohortCap: 20 });
  assert.equal(same.changed, false);
});

test('75-athlete scenario arithmetic: existing cohorts supply enough weekly seats', () => {
  const scenario = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'scenario-75-athletes.json'), 'utf8'));
  assert.equal(scenario.members, 75);
  assert.equal(scenario.monthlyRevenueDollars, 75 * 149, '$149/athlete/month');
  assert.equal(scenario.totalEnrollmentCap, 111, 'sum of prototype cohort caps 20+20+16+20+16+14+5');
  assert.equal(scenario.sessionsPerWeek, 13, 'twice-weekly cohorts + CLE-B once');
  assert.equal(scenario.weeklySeatSupply, 205);
  assert.equal(scenario.weeklyDemand, 150, '75 members x 2 sessions/week');
  assert.equal(scenario.fits, true);
  assert.ok(scenario.utilizationAtDemand < 0.8, 'headroom remains at planning demand');
  for (const c of scenario.perCohort) {
    assert.ok(c.sessionEffectiveCap <= c.enrollmentCap, `${c.cohort}: session cap never exceeds enrollment cap`);
  }
});

test('prototype session-planning behaviour is preserved: key rules still present in the HTML', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'THE PROGRAM OS.html'), 'utf8');
  for (const needle of [
    'STATION_DEFAULT = [4,6]',
    'stations at once but only',
    'Self-directed stations are not designed or approved',
    'Generated sessions are drafts. A human approves every session.',
    'coachesFor',
    'function buildConfigs',
    'function draftSession',
    'function checkGame',
    'No invented athlete ratings',
  ]) assert.ok(html.includes(needle), `prototype must still contain: ${needle}`);
});
