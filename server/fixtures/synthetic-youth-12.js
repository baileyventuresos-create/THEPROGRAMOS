/* SYNTHETIC TEST FIXTURE ONLY — 12-year-old youth athlete.
 * These are invented values for a SYNTHETIC test athlete used by the
 * automated test suite. They are NOT a real person's assessment
 * results, and they must never be written into a real athlete profile
 * or into the live Supabase project. The athlete is synthetic precisely
 * so the youth end-to-end path — accommodations, modified results,
 * and the under-18 growth caveat — can be tested without fabricating
 * a real assessment.
 *
 * The youth battery is the same GAA v1 battery as the adult case.
 * One test (push-ups) is recorded as modified: knee push-ups, the
 * age-appropriate alternative from server/assessment-battery.js,
 * flagged modified so it is never compared against a standard-
 * protocol baseline as if it were the same test.
 */
'use strict';

module.exports = {
  athlete: {
    id: 'ath-synth-youth-12',
    synthetic: true,
    age: 12,
    sport: 'multi-sport',
    goals: ['agility', 'power'],
    equipment: ['bodyweight', 'stopwatch'],
  },
  baseline: {
    recordedAt: '2027-01-10T12:00:00Z',
    battery: 'generalAthleticAssessment',
    entries: [
      { assessmentId: '10yd-sprint', attempts: [2.35, 2.30, 2.32] },
      { assessmentId: 'broad-jump', attempts: [62, 64, 63] },
      { assessmentId: '5-10-5-shuttle', attempts: [5.80, 5.75] },
      { assessmentId: 'push-ups', attempts: [12], modified: true },
      { assessmentId: 'side-plank-r', attempts: [38] },
      { assessmentId: 'side-plank-l', attempts: [35] },
      { assessmentId: 'single-leg-balance-r', attempts: [28] },
      { assessmentId: 'single-leg-balance-l', attempts: [25] },
      { assessmentId: '6min-walk-run', attempts: [520] },
      { assessmentId: 'movement-assessment', observations: 'Squat: knees track inward at depth. Hinge: rounds the lower back slightly. Overhead reach: full. Single-leg stability: wobbles on left. Gait: even.' },
    ],
  },
  reassessment: {
    recordedAt: '2027-02-07T12:00:00Z', // baseline + 28 days
    battery: 'generalAthleticAssessment',
    entries: [
      { assessmentId: '10yd-sprint', attempts: [2.28, 2.25, 2.27] },
      { assessmentId: 'broad-jump', attempts: [66, 68, 67] },
      { assessmentId: '5-10-5-shuttle', attempts: [5.70, 5.66] },
      { assessmentId: 'push-ups', attempts: [15], modified: true },
      { assessmentId: 'side-plank-r', attempts: [44] },
      { assessmentId: 'side-plank-l', attempts: [40] },
      { assessmentId: 'single-leg-balance-r', attempts: [35] },
      { assessmentId: 'single-leg-balance-l', attempts: [32] },
      { assessmentId: '6min-walk-run', attempts: [560] },
      { assessmentId: 'movement-assessment', observations: 'Squat: knees track better. Hinge: flatter back. Overhead reach: full. Single-leg stability: steadier. Gait: even.' },
    ],
  },
};
