/* Progress calculator tests.
 * Run: node --test server/tests/progress.test.js
 * Pins direction-correct change, percentage math, zero baselines,
 * personal bests, maintenance bands, and the youth-growth caveat.
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { progressForTest, progressForAthlete } = require('../progress');

const H = (pairs) => pairs.map(([recordedAt, result]) => ({ recordedAt, result }));

test('lower-is-better improvement is positive, higher-is-better regression is negative', () => {
  const sprint = progressForTest('10yd-sprint', H([['2027-01-10', 2.06], ['2027-02-07', 1.97]]));
  assert.equal(sprint.status, 'improved');
  assert.equal(sprint.vsBaseline.improvementPercent > 0, true);
  assert.equal(sprint.baseline, 2.06);
  assert.equal(sprint.current, 1.97);
  assert.equal(sprint.isPersonalBest, true);

  const jump = progressForTest('broad-jump', H([['2027-01-10', 63], ['2027-02-07', 58]]));
  assert.equal(jump.status, 'regressed');
  assert.equal(jump.vsBaseline.improvementPercent < 0, true);
  assert.equal(jump.personalBest, 63);
  assert.equal(jump.isPersonalBest, false);
});

test('percentage math is exact where defined', () => {
  const jump = progressForTest('broad-jump', H([['2027-01-10', 60], ['2027-02-07', 63]]));
  assert.equal(jump.vsBaseline.absolute, 3);
  assert.equal(jump.vsBaseline.percent, 5);
  assert.equal(jump.vsBaseline.improvementPercent, 5);
  const sprint = progressForTest('10yd-sprint', H([['2027-01-10', 2.00], ['2027-02-07', 1.90]]));
  assert.equal(sprint.vsBaseline.percent, -5, 'raw percent is negative when the time drops');
  assert.equal(sprint.vsBaseline.improvementPercent, 5, 'improvement percent is direction-corrected');
});

test('a zero baseline reports absolute change only — no invented percent', () => {
  const pushups = progressForTest('push-ups', H([['2027-01-10', 0], ['2027-02-07', 5]]));
  assert.equal(pushups.vsBaseline.absolute, 5);
  assert.equal(pushups.vsBaseline.percent, null);
  assert.equal(pushups.vsBaseline.improvementPercent, null);
  assert.equal(pushups.vsBaseline.status, 'improved');
  assert.equal(pushups.baseline, 0);
});

test('personal best tracks the best result across all history', () => {
  const jump = progressForTest('broad-jump', H([
    ['2027-01-10', 60], ['2027-02-07', 63], ['2027-03-07', 62]]));
  assert.equal(jump.personalBest, 63);
  assert.equal(jump.previous, 63);
  assert.equal(jump.current, 62);
  assert.equal(jump.vsPrevious.status, 'maintained', '1 in below the previous result is inside the band');
  assert.equal(jump.vsBest.absolute, -1, 'current is 1 in below the personal best');
  assert.equal(jump.vsBaseline.status, 'improved', 'still above the original baseline');
});

test('changes inside the maintenance band are maintained, not improved or regressed', () => {
  const sprint = progressForTest('10yd-sprint', H([['2027-01-10', 2.00], ['2027-02-07', 1.98]]));
  assert.equal(sprint.vsBaseline.status, 'maintained', '0.02s is inside the 0.05s band');
  const jump = progressForTest('broad-jump', H([['2027-01-10', 60], ['2027-02-07', 61]]));
  assert.equal(jump.vsBaseline.status, 'maintained', '1 in is inside the 1 in band');
  const jump2 = progressForTest('broad-jump', H([['2027-01-10', 60], ['2027-02-07', 62]]));
  assert.equal(jump2.vsBaseline.status, 'improved', '2 in exceeds the band');
});

test('one result is baseline-only; no results is no-data', () => {
  const one = progressForTest('broad-jump', H([['2027-01-10', 60]]));
  assert.equal(one.status, 'baseline-only');
  assert.equal(one.vsPrevious, null);
  assert.equal(one.vsBaseline.status, 'maintained', 'baseline vs itself is maintained');
  const none = progressForTest('broad-jump', []);
  assert.equal(none.status, 'no-data');
  assert.equal(none.baseline, null);
  assert.equal(none.vsBaseline, null);
});

test('youth results carry the growth caveat; adult results do not', () => {
  const youth = progressForTest('broad-jump', H([['2027-01-10', 60], ['2027-02-07', 63]]), { age: 16 });
  assert.equal(youth.caveats.length, 1);
  assert.match(youth.caveats[0], /growth and maturation/);
  const adult = progressForTest('broad-jump', H([['2027-01-10', 60], ['2027-02-07', 63]]), { age: 48 });
  assert.equal(adult.caveats.length, 0);
});

test('athlete summary counts statuses across tests', () => {
  const out = progressForAthlete('a1', {
    'broad-jump': H([['2027-01-10', 60], ['2027-02-07', 63]]),
    '10yd-sprint': H([['2027-01-10', 2.00], ['2027-02-07', 2.10]]),
    'push-ups': H([['2027-01-10', 20]]),
  }, { age: 48 });
  assert.equal(out.summary.improved, 1);
  assert.equal(out.summary.regressed, 1);
  assert.equal(out.summary.baselineOnly, 1);
  assert.equal(out.tests['10yd-sprint'].status, 'regressed');
});
