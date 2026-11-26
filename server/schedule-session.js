/* THE PROGRAM OS — Session-scheduling link (backend completion)
 *
 * Pure function: given a HUMAN-APPROVED draft, compute the session's
 * reservation cap and build the training_sessions row payload for it.
 * No database write happens here — the API / Director scheduling step
 * owns writes (and owns applying migrations first). This is the link
 * INTEGRATION_STRATEGY.md step 5 called for: capacityInput computed by
 * server/session-capacity.js and stored on the session row, so the
 * reservation engine never guesses a cap.
 *
 * Human approval is structural, not optional: a draft without
 * planApprovedBy is refused outright. This function books nothing and
 * approves no session content — it only derives capacity from an
 * already-approved plan (prototype: draftSession + Director approval).
 *
 * Draft shape:
 *   { template, coachesAvailable, cohort: { id, cap }, location,
 *     equipment, gameGroupMax, sessionMinutes, expectedAttendance,
 *     planId, planApprovedBy,
 *     cohortId, locationId, spaceId, templateId, date, startTime,
 *     durationMin, emphasis }
 *   - template / coachesAvailable / cohort / location / equipment /
 *     gameGroupMax / sessionMinutes are the capacity inputs (see
 *     session-capacity.js). cohort.cap is the cohort ENROLLMENT cap.
 *   - expectedAttendance is the draft's expected headcount, used only
 *     for flagging — capacity is NEVER auto-raised to fit demand.
 *
 * Returns { row, decision, feasible, flaggedInfeasible, flagReasons }:
 *   - row: the training_sessions payload (snake_case columns, matching
 *     migration 001): capacity_effective, capacity_preferred,
 *     capacity_inputs (the exact inputs fed to the adapter, for audit),
 *     plan_id, plan_approved_by, status 'scheduled', ...
 *   - decision: the full computeSessionCapacity() output.
 *   - feasible: decision.feasible (false = no coach / equipment
 *     shortfall / no BUILD minutes).
 *   - flaggedInfeasible: true when the session is infeasible OR the
 *     expected attendance exceeds the computed cap. A flagged draft is
 *     returned, not silently fixed — a Director decides what happens
 *     (add a coach, change space/equipment, split the session, or
 *     accept a waitlist). Nothing here raises capacity.
 */
'use strict';

const { computeSessionCapacity } = require('./session-capacity');

function scheduleSession(draft) {
  const d = draft || {};
  if (!d.planApprovedBy || !String(d.planApprovedBy).trim()) {
    throw new Error('planApprovedBy is required: a session is only scheduled from a human-approved draft — sessions are never auto-approved.');
  }
  const capacityInput = {
    template: d.template || null,
    coachesAvailable: d.coachesAvailable,
    cohortCap: d.cohort ? d.cohort.cap : (d.cohortCap != null ? d.cohortCap : null),
    cohortEnrolled: d.cohort ? d.cohort.enrolled : (d.cohortEnrolled != null ? d.cohortEnrolled : null),
    location: d.location || null,
    equipment: d.equipment || null,
    gameGroupMax: d.gameGroupMax != null ? d.gameGroupMax : null,
    sessionMinutes: d.sessionMinutes != null ? d.sessionMinutes : null,
  };
  const decision = computeSessionCapacity(capacityInput);
  const flagReasons = [];
  if (!decision.feasible) flagReasons.push(...decision.infeasibleReasons);
  const expected = d.expectedAttendance;
  const overCap = Number.isFinite(+expected) && +expected > decision.effectiveCap;
  if (overCap) {
    flagReasons.push(
      `Expected attendance (${+expected}) exceeds the computed reservation cap (${decision.effectiveCap}); capacity is not auto-raised.`);
  }
  const row = {
    cohort_id: (d.cohort && d.cohort.id) || d.cohortId || null,
    location_id: d.locationId || null,
    space_id: d.spaceId || null,
    template_id: (d.template && d.template.id) || d.templateId || null,
    date: d.date || null,
    start_time: d.startTime || null,
    duration_min: d.durationMin != null ? d.durationMin : (d.template ? d.template.dur : null),
    status: 'scheduled',
    capacity_effective: decision.effectiveCap,
    capacity_preferred: decision.preferredCap,
    capacity_inputs: capacityInput,
    capacity_recalc_note: null,
    plan_id: d.planId || null,
    plan_approved_by: d.planApprovedBy,
    emphasis: d.emphasis || [],
  };
  return {
    row,
    decision,
    feasible: decision.feasible,
    flaggedInfeasible: !decision.feasible || overCap,
    flagReasons,
  };
}

module.exports = { scheduleSession };
