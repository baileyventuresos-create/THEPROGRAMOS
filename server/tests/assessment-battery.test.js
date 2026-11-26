/* GAA battery protocol tests.
 * Run: node --test server/tests/assessment-battery.test.js
 * Pins the standardized battery: 8 tests, complete protocols, correct
 * improvement directions, adult + youth handling, no norms.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Battery = require('../assessment-battery');
const Engine = require('../../assessment-engine/assessment-engine.js');

const REQUIRED_FIELDS = ['instructions', 'conditions', 'warmup', 'safety',
  'validCriteria', 'invalidCriteria', 'alternatives'];

test('battery covers exactly the 8 mission tests', () => {
  assert.equal(Battery.GAA_TESTS.length, 8);
  assert.deepEqual(Battery.GAA_TESTS.map(t => t.id), [
    '10yd-sprint', 'broad-jump', '5-10-5-shuttle', 'push-ups',
    'side-plank', 'single-leg-balance', '6min-walk-run', 'movement-assessment',
  ]);
  assert.equal(Battery.PROTOCOL_VERSION, 'gaa-v1');
  assert.equal(Battery.BATTERY_ID, 'generalAthleticAssessment');
  // Bilateral tests list both sides: 9 definition ids for 8 tests.
  assert.equal(Battery.GAA_DEFINITION_IDS.length, 9);
  assert.equal(Battery.GAA_MEASURED_IDS.length, 9);
});

test('every test has a complete standardized protocol', () => {
  for (const t of Battery.GAA_TESTS) {
    for (const f of REQUIRED_FIELDS) {
      assert.ok(t[f], `${t.id} is missing ${f}`);
    }
    assert.ok(t.alternatives.youth, `${t.id} missing youth alternative`);
    assert.ok(t.alternatives.adult, `${t.id} missing adult alternative`);
    assert.ok(Array.isArray(t.alternatives.accommodations), `${t.id} missing accommodations`);
    assert.ok(t.maintenanceBand != null || t.kind === 'observation', `${t.id} missing maintenance band`);
  }
});

test('improvement directions match the mission (lower is better for timed tests)', () => {
  const dir = Object.fromEntries(Battery.GAA_TESTS.map(t => [t.id, t.direction]));
  assert.equal(dir['10yd-sprint'], 'lower');
  assert.equal(dir['5-10-5-shuttle'], 'lower');
  assert.equal(dir['broad-jump'], 'higher');
  assert.equal(dir['push-ups'], 'higher');
  assert.equal(dir['side-plank'], 'higher');
  assert.equal(dir['single-leg-balance'], 'higher');
  assert.equal(dir['6min-walk-run'], 'higher');
  assert.equal(dir['movement-assessment'], null, 'observation-only test has no direction');
});

test('every measured test maps to engine definitions with matching direction/unit', () => {
  for (const t of Battery.GAA_TESTS.filter(x => x.kind === 'measured')) {
    for (const id of t.definitionIds) {
      const def = Engine.definitions[id];
      assert.ok(def, `engine is missing ${id}`);
      assert.equal(def.direction, t.direction, `${id} direction mismatch`);
      assert.equal(def.unit, t.unit, `${id} unit mismatch`);
      assert.equal(def.attempts, t.attempts, `${id} attempt count mismatch`);
      assert.equal(def.retestDays, 28, `${id} retest interval must be 28 days`);
    }
  }
  assert.deepEqual(Engine.batteries.generalAthleticAssessment, Battery.GAA_DEFINITION_IDS);
  assert.equal(Engine.version, '1.1.0');
});

test('movement assessment is observation-only and never a number', () => {
  const t = Battery.protocolFor('movement-assessment');
  assert.equal(t.kind, 'observation');
  assert.equal(t.unit, 'observations');
  assert.deepEqual(t.definitionIds, []);
  assert.equal(Battery.isMeasured('movement-assessment'), false);
  assert.equal(Battery.validateAttempts('movement-assessment', [1]).ok, false);
  assert.throws(() => Engine.result('movement-assessment', [1]), /Unknown assessment/);
});

test('attempt validation enforces the protocol', () => {
  assert.equal(Battery.validateAttempts('10yd-sprint', [2.1, 2.0]).ok, true);
  assert.equal(Battery.validateAttempts('10yd-sprint', [2.0, 2.0, 2.0, 2.0]).ok, false, 'too many attempts');
  assert.equal(Battery.validateAttempts('10yd-sprint', []).ok, false, 'no attempts');
  assert.equal(Battery.validateAttempts('10yd-sprint', [-1]).ok, false, 'negative attempt');
  assert.equal(Battery.validateAttempts('side-plank-r', [121]).ok, false, 'over the 120s cap');
  assert.equal(Battery.validateAttempts('side-plank-r', [120]).ok, true, 'at the cap is valid');
  assert.equal(Battery.validateAttempts('push-ups', [18.5]).ok, false, 'push-ups must be whole reps');
  assert.equal(Battery.validateAttempts('push-ups', [18]).ok, true);
});

test('youth and adult athletes get age-appropriate alternatives', () => {
  assert.equal(Battery.ageBandFor(12), 'youth');
  assert.equal(Battery.ageBandFor(17), 'youth');
  assert.equal(Battery.ageBandFor(18), 'adult');
  assert.equal(Battery.ageBandFor(48), 'adult');
  const youth = Battery.accommodationsFor('push-ups', { age: 12 });
  const adult = Battery.accommodationsFor('push-ups', { age: 48 });
  assert.equal(youth.ageBand, 'youth');
  assert.equal(adult.ageBand, 'adult');
  assert.notEqual(youth.alternative, adult.alternative, 'youth and adult alternatives differ');
  assert.match(youth.note, /never compared against a standard-protocol baseline/);
});

test('the protocol invents no population norms or medical thresholds', () => {
  const text = JSON.stringify(Battery.GAA_TESTS);
  assert.ok(!/percentile/i.test(text), 'no percentiles');
  assert.ok(!/population norm/i.test(text), 'no population norms');
  assert.ok(!/medical threshold/i.test(text), 'no medical thresholds');
  assert.ok(!/below normal|weak|dysfunctional/i.test(text), 'no normative labels');
  // 'Diagnose' appears exactly once, as something the movement
  // assessment must NOT do — a prohibition, not a claim.
  const t = Battery.protocolFor('movement-assessment');
  assert.ok(t.invalidCriteria.some(c => c.includes('diagnose')),
    'diagnosis is listed as invalid, never produced');
});
