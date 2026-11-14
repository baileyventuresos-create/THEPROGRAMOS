/* SYNTHETIC TEST FIXTURE ONLY — 48-year-old recreational soccer wingback.
 * These are invented values for a SYNTHETIC test athlete used by the
 * automated test suite. They are NOT a real person's assessment
 * results, and they must never be written into a real athlete profile
 * or into the live Supabase project. The athlete is synthetic precisely
 * so the adult end-to-end path can be tested without fabricating a
 * real assessment.
 *
 * Goals: body composition, cardiovascular capacity, acceleration +
 * agility, lower-body power, strength + athletic durability.
 * Equipment: bodyweight, kettlebell up to 35 lb, outdoor hill.
 */
'use strict';

module.exports = {
  athlete: {
    id: 'ath-synth-wingback-48',
    synthetic: true,
    age: 48,
    sport: 'recreational soccer',
    position: 'wingback',
    goals: ['acceleration', 'agility', 'cardiovascular_conditioning', 'power', 'strength'],
    equipment: ['bodyweight', 'kettlebell up to 35 lb', 'outdoor hill'],
  },
  baseline: {
    recordedAt: '2027-01-10T12:00:00Z',
    battery: 'generalAthleticAssessment',
    entries: [
      { assessmentId: '10yd-sprint', attempts: [2.05, 2.01, 2.03] },
      { assessmentId: 'broad-jump', attempts: [78, 80, 79] },
      { assessmentId: '5-10-5-shuttle', attempts: [5.24, 5.20] },
      { assessmentId: 'push-ups', attempts: [18] },
      { assessmentId: 'side-plank-r', attempts: [45] },
      { assessmentId: 'side-plank-l', attempts: [42] },
      { assessmentId: 'single-leg-balance-r', attempts: [38] },
      { assessmentId: 'single-leg-balance-l', attempts: [35] },
      { assessmentId: '6min-walk-run', attempts: [640] },
      { assessmentId: 'movement-assessment', observations: 'Squat: heels lift slightly at depth, knees track inward. Hinge: clean pattern. Overhead reach: full. Single-leg stability: mild wobble on left. Gait: even.' },
    ],
  },
  reassessment: {
    recordedAt: '2027-02-07T12:00:00Z', // baseline + 28 days
    battery: 'generalAthleticAssessment',
    entries: [
      { assessmentId: '10yd-sprint', attempts: [1.98, 1.95, 1.97] },
      { assessmentId: 'broad-jump', attempts: [82, 84, 83] },
      { assessmentId: '5-10-5-shuttle', attempts: [5.05, 5.02] },
      { assessmentId: 'push-ups', attempts: [22] },
      { assessmentId: 'side-plank-r', attempts: [52] },
      { assessmentId: 'side-plank-l', attempts: [50] },
      { assessmentId: 'single-leg-balance-r', attempts: [45] },
      { assessmentId: 'single-leg-balance-l', attempts: [44] },
      { assessmentId: '6min-walk-run', attempts: [690] },
      { assessmentId: 'movement-assessment', observations: 'Squat: heels stay down, knees track better. Hinge: clean. Overhead reach: full. Single-leg stability: steadier both sides. Gait: even.' },
    ],
  },
  // A 12-year-old synthetic youth athlete, used only to check that
  // youth alternatives/accommodations are served, not adult ones.
  youth: { id: 'ath-synth-youth-12', synthetic: true, age: 12 },
};
