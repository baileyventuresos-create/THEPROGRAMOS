/* THE PROGRAM OS — Baseline gating for development-plan finalization
 * server/baseline-gating.js
 *
 * SCOPE: this gate applies ONLY to finalizing an individualized
 * development plan. An incomplete assessment must NOT prevent an
 * athlete from accessing unrelated application features — and nothing
 * in this module does that: the only function that can refuse anything
 * is finalizePlan(), and it takes a plan record as its input. There is
 * no athlete-level block anywhere in this module.
 *
 * Rule (mission §4): a plan may be finalized only once the athlete's
 * General Athletic Assessment baseline is complete — every GAA test
 * validly recorded, recorded as modified, excluded, or deferred with
 * coach approval (see server/reassessment.js baselineStatus()).
 *
 * The exceptional path is an EXPLICIT coach override: a coach may
 * finalize without a complete baseline only by supplying a reason and
 * their own id. The override is recorded on the plan itself
 * (overrideReason / overrideApprovedBy) so it is auditable, never
 * silent. There is no way to finalize an unready plan without either
 * a complete baseline or a recorded override.
 *
 * Plans are plain records: { id, athleteId, status: 'draft' |
 * 'finalized', baselineSessionId, finalizedBy, finalizedAt,
 * overrideReason, overrideApprovedBy }. Persistence of plans is the
 * caller's job; migration 004 adds a development_plans table with a
 * CHECK that a finalized row always carries a baseline_session_id.
 */
'use strict';

const { baselineStatus } = require('./reassessment');

const GATE_SCOPE = 'plan-finalization-only';

function assessPlanReadiness({ athleteId, sessions, results, deferrals }) {
  if (!athleteId) throw new Error('athleteId is required.');
  const base = baselineStatus(athleteId, { sessions, results, deferrals });
  return {
    ready: base.complete,
    athleteId, battery: base.battery,
    baselineSessionId: base.sessionId, baselineCompletedAt: base.completedAt,
    missing: base.missing, excluded: base.excluded, deferred: base.deferred, modified: base.modified,
    reason: base.complete
      ? 'Baseline complete: every GAA test recorded, modified, excluded, or deferred with coach approval.'
      : `Baseline incomplete: still missing ${base.missing.join(', ') || 'nothing — see excluded/deferred'}.`,
  };
}

/* Finalize a draft plan. Throws PLAN_NOT_READY unless the baseline is
 * complete or an explicit coach override is supplied. Never mutates
 * the input plan; returns a new finalized record. */
function finalizePlan({ plan, readiness, coachId, override, now } = {}) {
  if (!plan || !plan.id || !plan.athleteId) throw new Error('A draft plan with id and athleteId is required.');
  if (plan.status === 'finalized') throw new Error('Plan is already finalized.');
  if (plan.status !== 'draft') throw new Error(`Only a draft plan can be finalized (status: ${plan.status}).`);
  if (!coachId) throw new Error('coachId is required: finalization must name the coach who approved it.');
  if (!readiness || readiness.athleteId !== plan.athleteId) {
    throw new Error('A readiness assessment for this athlete is required.');
  }
  const finalizedAt = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  if (readiness.ready) {
    return { ...plan, status: 'finalized', baselineSessionId: readiness.baselineSessionId,
      finalizedBy: coachId, finalizedAt, overrideReason: null, overrideApprovedBy: null };
  }
  if (override && override.reason && override.approvedBy) {
    return { ...plan, status: 'finalized', baselineSessionId: readiness.baselineSessionId || null,
      finalizedBy: coachId, finalizedAt,
      overrideReason: String(override.reason), overrideApprovedBy: String(override.approvedBy),
      overrideMissingAtFinalization: readiness.missing.slice() };
  }
  const e = new Error(`Plan is not ready to finalize: baseline incomplete, still missing ${readiness.missing.join(', ') || 'required tests'}. Complete the assessment, record a coach-approved exclusion/deferral, or finalize with an explicit recorded override.`);
  e.code = 'PLAN_NOT_READY';
  e.missing = readiness.missing.slice();
  throw e;
}

module.exports = { GATE_SCOPE, assessPlanReadiness, finalizePlan };
