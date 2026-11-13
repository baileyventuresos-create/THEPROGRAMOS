/* THE PROGRAM OS — Assessment progress calculator
 * server/progress.js
 *
 * Compares an athlete's assessment results against their own history
 * only: initial baseline, previous assessment, and personal best.
 * Never against population norms (none exist in this system) and never
 * against other athletes.
 *
 * Change classification:
 *   - improvement: direction-corrected change larger than the test's
 *     maintenance band (a product threshold from
 *     server/assessment-battery.js, NOT a scientific measurement-error
 *     claim — see that module's header).
 *   - maintained: direction-corrected change within the band.
 *   - regressed: direction-corrected change worse than the band.
 * Percentage change is shown only where it is mathematically defined:
 * when the reference value is 0 (e.g. a first push-up baseline of 0
 * valid reps) the percent is null and only the absolute change is
 * reported. A zero baseline with a positive current result is still
 * an improvement.
 *
 * Youth caveat: for athletes under 18, every progress record carries
 * a caveat that growth and maturation can change results
 * independently of training. Change is never automatically read as
 * training effectiveness.
 */
'use strict';

const Engine = require('../assessment-engine/assessment-engine.js');
const { protocolFor } = require('./assessment-battery');

function round3(v) { return Number(v.toFixed(3)); }
function round2(v) { return Number(v.toFixed(2)); }

/* Compare current against a reference value for one test.
 * Returns { absolute, percent, improvementPercent, status }.
 * percent / improvementPercent are null when the reference is 0. */
function compareValues(assessmentId, reference, current, tolerance) {
  const def = Engine.definitions[assessmentId];
  if (reference == null || current == null || !def) return null;
  const raw = current - reference;
  const dir = def.direction === 'lower' ? -1 : 1;
  const improvement = raw * dir;
  const status = Math.abs(improvement) <= tolerance ? 'maintained'
    : (improvement > 0 ? 'improved' : 'regressed');
  const percent = reference === 0 ? null : round2((raw / Math.abs(reference)) * 100);
  const improvementPercent = percent == null ? null : round2(percent * dir);
  return { absolute: round3(raw), percent, improvementPercent, status };
}

/* Progress for one test across a sorted history of { recordedAt, result }.
 * history must be sorted ascending by recordedAt. */
function progressForTest(assessmentId, history, { age } = {}) {
  const def = Engine.definitions[assessmentId];
  if (!def) throw new Error('Unknown assessment: ' + assessmentId);
  const protocol = protocolFor(assessmentId);
  const tolerance = protocol.maintenanceBand != null ? protocol.maintenanceBand : 0;
  const valid = (history || []).filter(h => h && h.result != null)
    .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
  const caveats = [];
  if (age != null && Number(age) < 18) {
    caveats.push('Athlete is under 18: growth and maturation can change results independently of training. Do not read change as training effectiveness alone.');
  }
  if (!valid.length) {
    return { assessmentId, unit: def.unit, direction: def.direction, status: 'no-data',
      baseline: null, previous: null, current: null, personalBest: null, isPersonalBest: false,
      vsBaseline: null, vsPrevious: null, vsBest: null, caveats };
  }
  const baseline = valid[0].result;
  const current = valid[valid.length - 1].result;
  const previous = valid.length >= 2 ? valid[valid.length - 2].result : null;
  const personalBest = def.direction === 'lower'
    ? Math.min.apply(null, valid.map(v => v.result))
    : Math.max.apply(null, valid.map(v => v.result));
  const vsBaseline = compareValues(assessmentId, baseline, current, tolerance);
  const vsPrevious = previous == null ? null : compareValues(assessmentId, previous, current, tolerance);
  const vsBest = compareValues(assessmentId, personalBest, current, tolerance);
  const status = valid.length === 1 ? 'baseline-only' : vsBaseline.status;
  return { assessmentId, unit: def.unit, direction: def.direction, status,
    baseline, previous, current, personalBest, isPersonalBest: current === personalBest,
    vsBaseline, vsPrevious, vsBest, caveats };
}

/* Progress across all tests for one athlete. resultsByAssessment is
 * { assessmentId: [{ recordedAt, result }] }. */
function progressForAthlete(athleteId, resultsByAssessment, { age } = {}) {
  const tests = {};
  const summary = { improved: 0, maintained: 0, regressed: 0, baselineOnly: 0, noData: 0 };
  for (const [assessmentId, history] of Object.entries(resultsByAssessment || {})) {
    const p = progressForTest(assessmentId, history, { age });
    tests[assessmentId] = p;
    if (p.status === 'improved') summary.improved++;
    else if (p.status === 'maintained') summary.maintained++;
    else if (p.status === 'regressed') summary.regressed++;
    else if (p.status === 'baseline-only') summary.baselineOnly++;
    else summary.noData++;
  }
  return { athleteId, tests, summary };
}

module.exports = { compareValues, progressForTest, progressForAthlete };
