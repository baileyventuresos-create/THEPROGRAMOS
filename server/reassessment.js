/* THE PROGRAM OS — 28-day reassessment engine
 * server/reassessment.js
 *
 * Derivative scheduling: no background job, no paid scheduler, no cron
 * in the repo. Due dates are computed from the athlete's own completed
 * assessment history, and reminders are lists a coach dashboard (or a
 * future scheduled job) reads on demand.
 *
 * Rules (mission §5):
 *   1. The first COMPLETED General Athletic Assessment (battery
 *      'generalAthleticAssessment') establishes the schedule.
 *   2. Reassessment is due 28 days after the previous completed
 *      general assessment.
 *   3. Statuses: never-assessed | not-due | approaching (due within
 *      7 days) | due (due today) | overdue (past due) | deferred
 *      (a coach-approved deferral is active).
 *   4. A missed assessment stays overdue until completed or formally
 *      deferred. Nothing here fabricates a result or marks an
 *      assessment complete.
 *   5. Legacy 'generalAthlete' battery sessions do NOT count toward
 *      the GAA baseline: the universal battery is a different,
 *      standardized set of tests. (Documented in docs/ASSESSMENT_AUDIT.md.)
 *
 * Inputs are plain data, so every function is testable without a
 * database: sessions = [{ id, battery, recordedAt }], results =
 * [{ sessionId, assessmentId, result, modified }], deferrals =
 * [{ athleteId, battery, assessmentId, scope, kind, deferredUntil,
 *    reason, approvedBy }].
 */
'use strict';

const { BATTERY_ID, GAA_MEASURED_IDS } = require('./assessment-battery');

const RETEST_DAYS = 28;
const APPROACHING_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function iso(d) { return d ? d.toISOString() : null; }

/* Due date for the next reassessment after a completed session. */
function nextDueDate(lastCompletedAt) {
  const d = toDate(lastCompletedAt);
  if (!d) return null;
  return new Date(d.getTime() + RETEST_DAYS * DAY_MS);
}

/* Whole-day difference (floor) between two instants. Positive when
 * `to` is after `from`. */
function wholeDays(from, to) {
  return Math.floor((toDate(to) - toDate(from)) / DAY_MS);
}

function dueStatus({ lastCompletedAt, deferredUntil, now } = {}) {
  const n = toDate(now) || new Date();
  const def = toDate(deferredUntil);
  if (def && def > n) return 'deferred';
  const last = toDate(lastCompletedAt);
  if (!last) return 'never-assessed';
  const due = nextDueDate(last);
  const daysUntil = wholeDays(n, due);
  if (daysUntil > APPROACHING_WINDOW_DAYS) return 'not-due';
  if (daysUntil > 0) return 'approaching';
  if (daysUntil === 0) return 'due';
  return 'overdue';
}

/* The latest completed GAA session for an athlete: the latest session
 * with at least one valid measured result. Returns null when none. */
function latestCompletedGaaSession(sessions, results) {
  const gaa = (sessions || []).filter(s => s.battery === BATTERY_ID)
    .sort((a, b) => toDate(a.recordedAt) - toDate(b.recordedAt));
  const bySession = {};
  for (const r of results || []) (bySession[r.sessionId] = bySession[r.sessionId] || []).push(r);
  for (let i = gaa.length - 1; i >= 0; i--) {
    const rows = bySession[gaa[i].id] || [];
    if (rows.some(r => r.result != null)) return { session: gaa[i], results: rows };
  }
  return null;
}

/* Baseline completeness for one athlete. A baseline is complete when
 * every GAA measured test is validly recorded in the baseline session,
 * recorded as modified, excluded, or deferred by a coach-approved
 * exception. The movement assessment counts when an observation was
 * recorded for the session (or it is excluded/deferred). */
function baselineStatus(athleteId, { sessions = [], results = [], deferrals = [] } = {}) {
  const gaa = (sessions || []).filter(s => s.athleteId === athleteId && s.battery === BATTERY_ID)
    .sort((a, b) => toDate(a.recordedAt) - toDate(b.recordedAt));
  const bySession = {};
  for (const r of results || []) {
    if (r.athleteId !== athleteId) continue;
    (bySession[r.sessionId] = bySession[r.sessionId] || []).push(r);
  }
  const activeDeferrals = (deferrals || []).filter(d => d.athleteId === athleteId && d.battery === BATTERY_ID);
  const excluded = new Set(activeDeferrals.filter(d => d.kind === 'exclusion').map(d => d.assessmentId).filter(Boolean));
  const deferred = new Set(activeDeferrals.filter(d => d.kind === 'deferral' && toDate(d.deferredUntil) > new Date()).map(d => d.assessmentId).filter(Boolean));
  const empty = { athleteId, battery: BATTERY_ID, complete: false, completedAt: null, sessionId: null,
    missing: GAA_MEASURED_IDS.slice(), excluded: [...excluded], deferred: [...deferred], modified: [] };
  if (!gaa.length) return empty;
  // The baseline is the earliest session that is complete; if none is
  // complete, report the latest session's gaps so the coach knows
  // exactly what is still missing.
  for (const s of gaa) {
    const rows = bySession[s.id] || [];
    const recorded = new Set(rows.filter(r => r.result != null).map(r => r.assessmentId));
    const modified = rows.filter(r => r.result != null && r.modified).map(r => r.assessmentId);
    const missing = GAA_MEASURED_IDS.filter(id => !recorded.has(id) && !excluded.has(id) && !deferred.has(id));
    if (!missing.length) {
      return { athleteId, battery: BATTERY_ID, complete: true, completedAt: s.recordedAt,
        sessionId: s.id, missing: [], excluded: [...excluded], deferred: [...deferred], modified };
    }
  }
  const latest = gaa[gaa.length - 1];
  const rows = bySession[latest.id] || [];
  const recorded = new Set(rows.filter(r => r.result != null).map(r => r.assessmentId));
  const modified = rows.filter(r => r.result != null && r.modified).map(r => r.assessmentId);
  return { athleteId, battery: BATTERY_ID, complete: false, completedAt: null, sessionId: latest.id,
    missing: GAA_MEASURED_IDS.filter(id => !recorded.has(id) && !excluded.has(id) && !deferred.has(id)),
    excluded: [...excluded], deferred: [...deferred], modified };
}

/* Full schedule state for one athlete. */
function scheduleFor(athleteId, { sessions = [], results = [], deferrals = [] } = {}, now) {
  const n = toDate(now) || new Date();
  const base = baselineStatus(athleteId, { sessions, results, deferrals });
  const latest = latestCompletedGaaSession(
    (sessions || []).filter(s => s.athleteId === athleteId), results);
  const batteryDeferral = (deferrals || []).find(d => d.athleteId === athleteId
    && d.battery === BATTERY_ID && d.scope === 'battery' && d.kind === 'deferral'
    && toDate(d.deferredUntil) > n);
  const lastCompletedAt = latest ? latest.session.recordedAt : null;
  const due = nextDueDate(lastCompletedAt);
  const status = dueStatus({ lastCompletedAt, deferredUntil: batteryDeferral && batteryDeferral.deferredUntil, now: n });
  return {
    athleteId, battery: BATTERY_ID,
    hasBaseline: base.complete, baselineCompletedAt: base.completedAt, baselineSessionId: base.sessionId,
    lastCompletedAt, nextDueAt: iso(due), status,
    daysUntilDue: due ? wholeDays(n, due) : null,
    overdueDays: due && n > due ? wholeDays(due, n) : 0,
    deferredUntil: batteryDeferral ? batteryDeferral.deferredUntil : null,
    missingBaselineTests: base.complete ? [] : base.missing,
  };
}

/* Coach dashboard reminder lists, derived on demand. */
function reassessmentReminders(athletes, { sessions = [], results = [], deferrals = [] } = {}, now) {
  const out = { neverAssessed: [], approaching: [], due: [], overdue: [], deferred: [], notDue: [] };
  for (const a of athletes || []) {
    const id = typeof a === 'string' ? a : a.id;
    const s = scheduleFor(id, { sessions, results, deferrals }, now);
    if (s.status === 'never-assessed') out.neverAssessed.push(s);
    else if (s.status === 'approaching') out.approaching.push(s);
    else if (s.status === 'due') out.due.push(s);
    else if (s.status === 'overdue') out.overdue.push(s);
    else if (s.status === 'deferred') out.deferred.push(s);
    else out.notDue.push(s);
  }
  return out;
}

/* Athlete-facing view: what the athlete sees in-app (per INTEGRATION.md,
 * athletes see progress, not programming diagnostics). */
function athleteReminder(athleteId, data, now) {
  const s = scheduleFor(athleteId, data, now);
  const messages = {
    'never-assessed': 'Your first General Athletic Assessment is due — it sets your personal baseline.',
    'not-due': 'Your next reassessment is scheduled.',
    approaching: 'Your reassessment is coming up soon.',
    due: 'Your reassessment is due today.',
    overdue: 'Your reassessment is overdue — please complete it at your next session.',
    deferred: 'Your reassessment has been deferred by your coach.',
  };
  return { athleteId, status: s.status, nextDueAt: s.nextDueAt,
    daysUntilDue: s.daysUntilDue, message: messages[s.status] };
}

/* Record a coach-approved deferral / exclusion / modification.
 * Validation is deliberate: a deferral needs a coach approver, a
 * reason, and (for kind 'deferral') a future deferredUntil. An
 * exclusion removes a test from the baseline requirement; a
 * modification records how the test was adapted. Nothing here marks
 * an assessment complete. */
function validateDeferral(input) {
  const errors = [];
  if (!input || !input.athleteId) errors.push('athleteId is required.');
  if (!input.battery) errors.push('battery is required.');
  if (!input.approvedBy) errors.push('approvedBy (coach) is required: deferrals, exclusions and modifications must be coach-approved.');
  if (!input.reason) errors.push('reason is required.');
  if (!['deferral', 'exclusion', 'modification'].includes(input.kind)) errors.push("kind must be 'deferral', 'exclusion' or 'modification'.");
  if (!['test', 'battery'].includes(input.scope)) errors.push("scope must be 'test' or 'battery'.");
  if (input.scope === 'test' && !input.assessmentId) errors.push('assessmentId is required when scope is test.');
  if (input.scope === 'battery' && input.assessmentId) errors.push('assessmentId must be empty when scope is battery.');
  if (input.kind === 'deferral') {
    const until = toDate(input.deferredUntil);
    if (!until) errors.push('deferredUntil is required for a deferral.');
    else if (until <= new Date()) errors.push('deferredUntil must be in the future.');
  }
  return errors;
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

class MemoryReassessmentStore {
  constructor() { this.deferrals = []; this.schedules = []; }
  async insertDeferral(row) { this.deferrals.push(JSON.parse(JSON.stringify(row))); return row; }
  async listDeferrals(athleteId) {
    return this.deferrals.filter(d => !athleteId || d.athleteId === athleteId)
      .map(d => JSON.parse(JSON.stringify(d)));
  }
  async upsertSchedule(row) {
    const i = this.schedules.findIndex(s => s.athleteId === row.athleteId && s.battery === row.battery);
    if (i >= 0) this.schedules[i] = JSON.parse(JSON.stringify(row));
    else this.schedules.push(JSON.parse(JSON.stringify(row)));
    return row;
  }
  async listSchedules() { return this.schedules.map(s => JSON.parse(JSON.stringify(s))); }
}

async function recordDeferral(store, input) {
  const errors = validateDeferral(input);
  if (errors.length) { const e = new Error('Invalid deferral: ' + errors.join(' ')); e.code = 'INVALID_DEFERRAL'; throw e; }
  const row = {
    id: uid('adef'), athleteId: String(input.athleteId), battery: input.battery,
    assessmentId: input.assessmentId || null, scope: input.scope, kind: input.kind,
    deferredUntil: input.deferredUntil || null, reason: input.reason,
    details: input.details || null, approvedBy: input.approvedBy,
    createdAt: new Date().toISOString(),
  };
  if (typeof store.insertDeferral !== 'function') throw new Error('Store must implement insertDeferral.');
  await store.insertDeferral(row);
  return row;
}

module.exports = {
  RETEST_DAYS, APPROACHING_WINDOW_DAYS, BATTERY_ID,
  nextDueDate, dueStatus, latestCompletedGaaSession, baselineStatus,
  scheduleFor, reassessmentReminders, athleteReminder,
  validateDeferral, recordDeferral, MemoryReassessmentStore,
};
