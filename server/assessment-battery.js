/* THE PROGRAM OS — Universal General Athletic Assessment (GAA) battery
 * Protocol definitions, server/assessment-battery.js
 *
 * The standardized 8-test General Athletic Assessment every athlete
 * completes as a baseline and repeats every 28 days. Protocol version
 * 'gaa-v1'. This module is the protocol source of truth; the engine
 * (assessment-engine/assessment-engine.js) remains the calculation
 * source of truth for measured tests.
 *
 * What lives here vs the engine:
 *   - Engine DEFINITIONS: numeric aggregation (best), unit, direction,
 *     attempts, retestDays. Extended in engine v1.1.0 with the three
 *     measured tests the GAA adds (5-10-5 shuttle, single-leg balance
 *     L/R, 6-minute walk/run).
 *   - This module: the human protocol for each test — instructions,
 *     testing conditions, warm-up + safety, valid/invalid attempt
 *     criteria, precision, maintenance band, and age-appropriate
 *     alternatives + accommodations.
 *
 * The movement assessment is OBSERVATION-ONLY: no numeric result, no
 * direction, no aggregation. It is recorded as coach observations
 * (assessment-store observation records), never as a measurement.
 *
 * Deliberate limits (do not weaken them):
 *   - No population norms, percentiles, rankings, or medical thresholds
 *     anywhere in this module. Athletes are compared only to their own
 *     baseline, previous result, and personal best.
 *   - "Maintenance band" values are product thresholds for reading
 *     change (see server/progress.js), not scientific claims about
 *     measurement error. They are labelled as such.
 *   - Caps (side plank 120s, single-leg balance 60s) end an attempt;
 *     a capped result is recorded as the cap value with a 'capped' flag
 *     in the attempt notes, never as an exact time beyond the cap.
 *   - Youth (<18) and adult (>=18) athletes use the same battery and
 *     the same protocol version; alternatives below change HOW a test is
 *     performed when it is unsafe or inappropriate, never what the
 *     numbers mean. An alternative/modified result is flagged
 *     'modified' and is never compared against a standard-protocol
 *     baseline as if it were the same test.
 */
'use strict';

const PROTOCOL_VERSION = 'gaa-v1';
const BATTERY_ID = 'generalAthleticAssessment';
const RETEST_DAYS = 28;
const APPROACHING_WINDOW_DAYS = 7;

/* One entry per mission test. Bilateral tests (side plank, single-leg
 * balance) carry both definition ids; the battery lists 9 definition
 * ids for 8 tests. */
const GAA_TESTS = [
  {
    id: '10yd-sprint', name: '10-Yard Sprint', category: 'Acceleration',
    domain: 'acceleration', kind: 'measured', definitionIds: ['10yd-sprint'],
    unit: 'sec', precision: 0.01, direction: 'lower', attempts: 3, aggregation: 'best',
    maintenanceBand: 0.05,
    instructions: 'Start from a stationary standing or 3-point stance behind the line, on the coach\'s signal sprint 10 yards through the finish line without slowing before it. Three attempts; the fastest counts. Rest at least 60 seconds between attempts.',
    conditions: 'Flat, dry, non-slip surface, marked 10-yard course. Same surface and timing method every session; record the timing method (hand-timed stopwatch or gates) in the session context.',
    warmup: 'General dynamic warm-up (5–10 min) plus 2 submaximal build-up sprints at ~70% and ~90% effort.',
    safety: 'Stop the test for pain, dizziness, or a pulled muscle. Athlete must be able to sprint without limping; do not test an athlete returning from a lower-body injury without coach clearance.',
    validCriteria: ['Started stationary behind the line', 'Ran the full 10 yards without cutting the course', 'Timed from first movement to crossing the finish line'],
    invalidCriteria: ['False start (movement before the signal)', 'Timing fault (stopwatch not started/stopped cleanly)', 'Athlete slowed or stopped before the finish line'],
    alternatives: {
      youth: 'Same protocol. Younger athletes (9–12) may use a standing start only; record start type in the session context.',
      adult: 'Same protocol. Athletes 40+ use the same test; allow a longer warm-up and an extra build-up sprint.',
      accommodations: ['Hand timing instead of gates (record method; do not mix methods within one athlete\'s history without noting it)', 'Standing start instead of 3-point stance for athletes who cannot hold the stance safely'],
    },
  },
  {
    id: 'broad-jump', name: 'Standing Broad Jump', category: 'Power',
    domain: 'power', kind: 'measured', definitionIds: ['broad-jump'],
    unit: 'in', precision: 0.5, direction: 'higher', attempts: 3, aggregation: 'best',
    maintenanceBand: 1,
    instructions: 'Stand with toes behind the take-off line, feet shoulder-width apart. Jump forward as far as possible with a two-foot take-off and two-foot landing. Measure from the line to the back of the rearmost heel at landing. Three attempts; the longest counts.',
    conditions: 'Flat, dry, non-slip surface with a marked take-off line and tape measure. Same surface every session.',
    warmup: 'General dynamic warm-up plus 2 submaximal practice jumps at ~70% effort.',
    safety: 'Land with soft knees; stop for knee/ankle pain or loss of balance on landing. Clear the landing area before each attempt.',
    validCriteria: ['Two-foot take-off from behind the line', 'Two-foot landing without falling backward', 'Measurement taken at the rearmost heel'],
    invalidCriteria: ['Stepping over the line before take-off', 'Falling backward or touching the ground behind the heels on landing', 'Single-foot take-off'],
    alternatives: {
      youth: 'Same protocol. Younger athletes may jump from a marked line on a mat; record the surface.',
      adult: 'Same protocol. Athletes with knee/ankle history use a soft landing surface (mat or turf) and may reduce to 2 attempts with coach approval.',
      accommodations: ['Landing mat or turf instead of hard floor', 'Two attempts instead of three with coach approval (recorded as modified)'],
    },
  },
  {
    id: '5-10-5-shuttle', name: '5-10-5 Shuttle', category: 'Agility',
    domain: 'agility', kind: 'measured', definitionIds: ['5-10-5-shuttle'],
    unit: 'sec', precision: 0.01, direction: 'lower', attempts: 2, aggregation: 'best',
    maintenanceBand: 0.05,
    instructions: 'Start straddling the middle line. Sprint 5 yards to the right line and touch it with the hand, sprint 10 yards to the far left line and touch it, then sprint 5 yards back through the middle line. Two attempts (one starting each direction if the coach chooses); the fastest counts. Rest at least 90 seconds between attempts.',
    conditions: 'Flat, dry, non-slip surface, three lines 5 yards apart. Same surface and timing method every session; record start direction in the session context.',
    warmup: 'General dynamic warm-up plus lateral shuffles and 2 submaximal change-of-direction reps at ~70% effort.',
    safety: 'Stop for ankle/knee pain or loss of footing. Athletes must be able to decelerate and change direction without limping.',
    validCriteria: ['Touched each outside line with the hand', 'Ran the full 5-10-5 pattern in order', 'Finished through the middle line'],
    invalidCriteria: ['Missed a line touch', 'Cut the pattern short', 'Timing fault'],
    alternatives: {
      youth: 'Same protocol with the standard 5-yard spacing. Younger athletes may walk the pattern once before timed attempts.',
      adult: 'Same protocol. Athletes 40+ may take a longer rest (2 minutes) between attempts.',
      accommodations: ['Verbal cue at each line for athletes who struggle with the pattern on the first attempt (practice rep, not timed)'],
    },
  },
  {
    id: 'push-ups', name: 'Push-Ups', category: 'Muscular endurance',
    domain: 'muscular_endurance', kind: 'measured', definitionIds: ['push-ups'],
    unit: 'reps', precision: 1, direction: 'higher', attempts: 1, aggregation: 'best',
    maintenanceBand: 1,
    instructions: 'One continuous set to failure. Start in a plank with hands under shoulders. Lower the chest to fist-height above the floor, then press to full arm lockout. Count only valid repetitions. The set ends when the athlete cannot complete another valid rep, breaks form, or rests on the floor.',
    conditions: 'Flat floor. Same hand position and chest-depth standard every session; record the standard used in the session context.',
    warmup: 'General dynamic warm-up plus 5–10 easy push-ups or incline push-ups at ~50% effort.',
    safety: 'Stop for shoulder, wrist, or lower-back pain. Athlete may stop the set at any time; a stopped set is a completed attempt, not a failure.',
    validCriteria: ['Chest reaches the set depth on every counted rep', 'Full elbow lockout at the top of every counted rep', 'Straight body line (no sagging or piking) on every counted rep'],
    invalidCriteria: ['Partial range of motion', 'Hips sagging or piked', 'Resting on the floor mid-set (knees/chest down) and resuming'],
    alternatives: {
      youth: 'Same protocol. Athletes who cannot complete a standard push-up use an incline (hands on a bench/box) and the result is recorded as modified — not comparable to a standard-protocol baseline.',
      adult: 'Same protocol. Athletes with wrist pain may use fists or push-up handles; record the variation.',
      accommodations: ['Incline push-ups (recorded as modified)', 'Fists or handles for wrist pain (recorded as modified)'],
    },
  },
  {
    id: 'side-plank', name: 'Side Plank (Left / Right)', category: 'Core endurance',
    domain: 'muscular_endurance', kind: 'measured',
    definitionIds: ['side-plank-r', 'side-plank-l'],
    unit: 'sec', precision: 1, direction: 'higher', attempts: 1, aggregation: 'best',
    maintenanceBand: 3, capSeconds: 120,
    instructions: 'Lie on one side, elbow under the shoulder, feet stacked. Lift the hips to a straight side-plank line and hold as long as possible, up to a 120-second cap. Test the right side, rest 60 seconds, then the left side. Time stops when the hips drop or the position breaks.',
    conditions: 'Flat floor or mat. Same support (elbow) and foot position every session.',
    warmup: 'General dynamic warm-up plus a 10-second practice hold per side.',
    safety: 'Stop for shoulder or lower-back pain. Athlete may come down at any time; a stopped hold is a completed attempt.',
    validCriteria: ['Straight line from head to feet for the full counted time', 'Elbow under the shoulder, hips lifted', 'Time stopped at the first visible break in position'],
    invalidCriteria: ['Hips sagging or piked for more than a brief correction', 'Rolling forward or backward out of the side position', 'Supporting with the free hand on the floor'],
    alternatives: {
      youth: 'Same protocol. Athletes who cannot hold the full position use knees bent (short-lever) and the result is recorded as modified.',
      adult: 'Same protocol. Athletes with shoulder history use the forearm position only and stop at pain.',
      accommodations: ['Short-lever (knees bent) variation (recorded as modified)', '120-second cap applies to everyone; a capped result is recorded as 120 with a capped flag'],
    },
  },
  {
    id: 'single-leg-balance', name: 'Single-Leg Balance (Left / Right)', category: 'Balance',
    domain: 'mobility_movement_control', kind: 'measured',
    definitionIds: ['single-leg-balance-r', 'single-leg-balance-l'],
    unit: 'sec', precision: 1, direction: 'higher', attempts: 1, aggregation: 'best',
    maintenanceBand: 3, capSeconds: 60,
    instructions: 'Stand on one leg, hands on hips, eyes open, the free foot held off the floor without touching the standing leg. Hold as long as possible, up to a 60-second cap. Test the right leg, rest 30 seconds, then the left leg. Time stops on the first fault.',
    conditions: 'Flat, dry floor, barefoot or flat shoes — same footwear every session. Coach stands close enough to steady the athlete if needed.',
    warmup: 'No specific warm-up; 1 practice hold of up to 10 seconds per leg.',
    safety: 'Coach stays within arm\'s reach. Stop for dizziness or loss of balance; the athlete may step down at any time.',
    validCriteria: ['Single-leg stance held with hands on hips', 'Free foot clear of the floor and the standing leg', 'Eyes open for the full counted time'],
    invalidCriteria: ['Free foot touches the floor or the standing leg', 'Hop or step with the standing foot', 'Hands leave the hips', 'Eyes closed'],
    alternatives: {
      youth: 'Same protocol. Younger athletes may stand near a wall (not touching it) for confidence; touching the wall ends the attempt.',
      adult: 'Same protocol. Athletes 40+ use the same eyes-open test; do not use eyes-closed as a substitute.',
      accommodations: ['Near-wall position for confidence (touching ends the attempt)', '60-second cap applies to everyone; a capped result is recorded as 60 with a capped flag'],
    },
  },
  {
    id: '6min-walk-run', name: '6-Minute Walk/Run', category: 'Cardiovascular',
    domain: 'cardiovascular_conditioning', kind: 'measured', definitionIds: ['6min-walk-run'],
    unit: 'm', precision: 1, direction: 'higher', attempts: 1, aggregation: 'best',
    maintenanceBand: 10,
    instructions: 'Cover as much distance as possible in 6 minutes on a measured course, walking, running, or mixing both. The athlete sets their own pace and may walk at any point. One attempt. Record total distance in metres and whether the athlete ran, walked, or mixed.',
    conditions: 'Measured, flat course (marked loop or out-and-back) of known length, same course every session. Record the course and the run/walk mix in the session context.',
    warmup: 'General dynamic warm-up plus 3–5 minutes of easy walking.',
    safety: 'Stop for chest pain, severe breathlessness, dizziness, or joint pain. Athlete may stop or walk at any time; the distance covered still counts.',
    validCriteria: ['Full 6 minutes completed on the measured course', 'Distance measured along the course (no shortcuts)', 'Run/walk mix recorded'],
    invalidCriteria: ['Course cut short', 'Timer stopped early', 'Distance estimated instead of measured'],
    alternatives: {
      youth: 'Same protocol on a shorter measured loop if needed. Younger athletes may walk the full 6 minutes; the mix is recorded, not judged.',
      adult: 'Same protocol. Adults returning to training may walk the full 6 minutes; improvement is measured against their own baseline, not against other athletes.',
      accommodations: ['Shorter measured loop (same total-distance method)', 'Walk-only effort (recorded as the run/walk mix)'],
    },
  },
  {
    id: 'movement-assessment', name: 'Movement Assessment', category: 'Mobility',
    domain: 'mobility_movement_control', kind: 'observation', definitionIds: [],
    unit: 'observations', precision: null, direction: null, attempts: 1, aggregation: 'none',
    maintenanceBand: null,
    instructions: 'Coach-observed movement screen, recorded as written observations only — no score, no grade, no pass/fail. Observe: bodyweight squat pattern, hip hinge pattern, overhead reach, single-leg stability, and gait. For each, the coach records what they saw in plain language (e.g. "heels lift at the bottom of the squat, knees track inward").',
    conditions: 'Open floor space, same prompts every session. Observations are recorded in the session notes, linked to this test.',
    warmup: 'General dynamic warm-up; the screen itself is low intensity.',
    safety: 'Stop any pattern that causes pain. Do not push range of motion; observe only what the athlete can do comfortably.',
    validCriteria: ['Each of the five patterns observed and noted', 'Notes describe what was seen, not a diagnosis'],
    invalidCriteria: ['A numeric score or grade assigned to any pattern', 'Notes that diagnose, label an injury, or claim a medical finding', 'Patterns skipped without a recorded reason'],
    alternatives: {
      youth: 'Same prompts. Use language the athlete understands; keep the screen short and playful where appropriate.',
      adult: 'Same prompts. Adults may show long-standing movement habits; record what is seen without labelling it as a problem.',
      accommodations: ['Skip a pattern that causes pain and record the reason', 'Seated or supported variation for a pattern the athlete cannot perform standing (recorded as modified)'],
    },
  },
];

const GAA_DEFINITION_IDS = GAA_TESTS.flatMap(t => t.definitionIds);
const GAA_MEASURED_IDS = GAA_TESTS.filter(t => t.kind === 'measured').flatMap(t => t.definitionIds);

function protocolFor(id) {
  const test = GAA_TESTS.find(t => t.id === id || t.definitionIds.includes(id));
  if (!test) throw new Error('Unknown GAA test: ' + id);
  return test;
}
function isMeasured(id) {
  const test = GAA_TESTS.find(t => t.id === id || t.definitionIds.includes(id));
  if (!test) throw new Error('Unknown GAA test: ' + id);
  return test.kind === 'measured';
}

/* Validate raw attempts against the protocol before they reach the
 * engine. Returns { ok, reasons[] }. A capped timed hold (side plank
 * 120s, balance 60s) is valid; the cap is enforced by the recorder
 * noting it, not by rejecting the value. */
function validateAttempts(id, attempts) {
  const test = protocolFor(id);
  const reasons = [];
  if (test.kind !== 'measured') {
    return { ok: false, reasons: ['Movement assessment is observation-only; it has no numeric attempts.'] };
  }
  const vals = (attempts || []).map(Number).filter(Number.isFinite);
  if (!vals.length) reasons.push('At least one numeric attempt is required.');
  if (vals.length > test.attempts) reasons.push(`Too many attempts: ${vals.length} given, protocol allows ${test.attempts}.`);
  if (vals.some(v => v < 0)) reasons.push('Attempts must not be negative.');
  if (test.capSeconds != null && vals.some(v => v > test.capSeconds)) {
    reasons.push(`Attempt exceeds the ${test.capSeconds}s cap; record the cap value with a capped flag.`);
  }
  if (test.unit === 'reps' && vals.some(v => !Number.isInteger(v))) reasons.push('Push-up attempts must be whole repetitions.');
  return { ok: reasons.length === 0, reasons };
}

function ageBandFor(age) {
  const a = Number(age);
  if (!Number.isFinite(a)) return null;
  return a < 18 ? 'youth' : 'adult';
}

/* Age-appropriate alternatives + accommodations for one test. Returns
 * the protocol's youth or adult alternative plus the accommodation
 * list; never changes what the numbers mean. */
function accommodationsFor(id, { age } = {}) {
  const test = protocolFor(id);
  const band = ageBandFor(age);
  return {
    testId: test.id, ageBand: band,
    alternative: band ? test.alternatives[band] : null,
    accommodations: test.alternatives.accommodations.slice(),
    note: 'Alternatives change how a test is performed when it is unsafe or inappropriate. A modified result is flagged modified and is never compared against a standard-protocol baseline as if it were the same test.',
  };
}

module.exports = {
  PROTOCOL_VERSION, BATTERY_ID, RETEST_DAYS, APPROACHING_WINDOW_DAYS,
  GAA_TESTS, GAA_DEFINITION_IDS, GAA_MEASURED_IDS,
  protocolFor, isMeasured, validateAttempts, ageBandFor, accommodationsFor,
};
