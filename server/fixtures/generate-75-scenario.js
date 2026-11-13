/* THE PROGRAM OS — 75-athlete capacity scenario (operational foundation V1)
 *
 * Run: node server/fixtures/generate-75-scenario.js
 * Reads server/fixtures/seed-operational.json (prototype cohort data),
 * computes per-session reservation caps with server/session-capacity.js,
 * and writes server/fixtures/scenario-75-athletes.json.
 *
 * Model (flexible attendance, NOT one permanent cohort):
 *   - Each cohort runs its prototype days/week (YAK-A 2x, CLE-B 1x, ...).
 *   - Session cap = capacity adapter output for that cohort's template
 *     with the prototype's default staffing (3 coaches group / 1 small
 *     group), cohort cap, and no facility/equipment binding (those inputs
 *     are unspecified in the prototype — see the warnings in the output).
 *   - Demand = 75 paying athletes x 2 sessions/week (the prototype's
 *     twice-weekly cadence; a planning assumption, labelled as such).
 *   - Weekly seat supply vs demand gives headroom; per-session caps are
 *     what the reservation engine enforces, so the model is the same
 *     arithmetic the live system would use.
 * This is a planning model, not a promise: it assumes the 3-coach
 * staffing the prototype assumes (NEEDS DEFINITION in the prototype —
 * who the 2nd/3rd coaches are is still open) and that members spread
 * across sessions rather than all choosing the same slot.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { computeSessionCapacity } = require('../session-capacity');

const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-operational.json'), 'utf8'));
const templates = Object.fromEntries(seed.templates.map(t => [t.id, t]));

const MEMBERS = 75;
const SESSIONS_PER_ATHLETE_PER_WEEK = 2; // planning assumption (twice-weekly cadence)
const COACHES_GROUP = 3; // prototype default: coachesFor() = 3 for group sessions
const COACHES_SMALL_GROUP = 1;

const perCohort = seed.cohorts.map(c => {
  const tpl = c.format === 'Small group' ? templates.sg45 : templates.p60;
  const coaches = c.format === 'Small group' ? COACHES_SMALL_GROUP : COACHES_GROUP;
  const decision = computeSessionCapacity({
    template: tpl, coachesAvailable: coaches, cohortCap: c.cap,
    location: { spaces: seed.locations.find(l => l.id === c.loc).spaces },
  });
  const sessionsPerWeek = c.days.length;
  return {
    cohort: c.id, location: c.loc, daysPerWeek: sessionsPerWeek,
    enrolledDemo: c.enrolled, enrollmentCap: c.cap,
    coachesAvailable: coaches, template: tpl.id,
    sessionPreferredCap: decision.preferredCap,
    sessionEffectiveCap: decision.effectiveCap,
    weeklySeats: sessionsPerWeek * decision.effectiveCap,
    limitingFactors: decision.limitingFactors.map(l => `${l.constraint}=${l.value}`),
    warnings: decision.warnings,
  };
});

const weeklySeats = perCohort.reduce((a, c) => a + c.weeklySeats, 0);
const weeklyDemand = MEMBERS * SESSIONS_PER_ATHLETE_PER_WEEK;
const scenario = {
  generatedBy: 'server/fixtures/generate-75-scenario.js',
  members: MEMBERS,
  sessionsPerAthletePerWeek: SESSIONS_PER_ATHLETE_PER_WEEK,
  assumptionNote: 'Demand assumes each member books 2 sessions/week (prototype twice-weekly cadence). Staffing assumes the prototype default of 3 coaches per group session / 1 per small group — the prototype flags who the 2nd/3rd coaches are as NEEDS DEFINITION, so this model is conditional on that staffing being hired/confirmed.',
  totalEnrollmentCap: seed.cohorts.reduce((a, c) => a + c.cap, 0),
  sessionsPerWeek: perCohort.reduce((a, c) => a + c.daysPerWeek, 0),
  weeklySeatSupply: weeklySeats,
  weeklyDemand,
  headroomSeatsPerWeek: weeklySeats - weeklyDemand,
  utilizationAtDemand: +(weeklyDemand / weeklySeats).toFixed(3),
  monthlyRevenueAtFullMembership: MEMBERS * 14900, // cents; $149/athlete/month, owner-fixed
  monthlyRevenueDollars: MEMBERS * 149,
  fits: weeklySeats >= weeklyDemand,
  perCohort,
};

fs.writeFileSync(path.join(__dirname, 'scenario-75-athletes.json'), JSON.stringify(scenario, null, 2) + '\n');
console.log(JSON.stringify({ weeklySeatSupply: weeklySeats, weeklyDemand,
  headroom: weeklySeats - weeklyDemand, utilization: scenario.utilizationAtDemand,
  fits: scenario.fits, monthlyRevenueDollars: scenario.monthlyRevenueDollars }, null, 2));
