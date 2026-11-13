/* THE PROGRAM OS — Assessment workflow service
 * server/assessment-workflow.js
 *
 * The end-to-end assessment workflow, wired over the existing engine
 * and stores WITHOUT rewriting the prototype HTML or the engine:
 *
 *   engine (assessment-engine.js)         — calculation source of truth
 *   battery (assessment-battery.js)       — GAA protocol source of truth
 *   assessment-store.js                   — persistence adapter (sessions,
 *                                           results, derived; drafts added
 *                                           for in-progress work)
 *   reassessment.js                       — 28-day due math, baselines,
 *                                           deferrals/exclusions
 *   baseline-gating.js                    — plan-finalization gate
 *   progress.js                           — baseline/previous/PB comparison
 *   smart-draft-adapter.js                — advisory-only priorities
 *   assessment-access.js                  — who may assess/view whom
 *
 * Coach workflow (mission §2, steps 1–10):
 *   1. listAthletes()                     — select an athlete
 *   2. startAssessment()                  — start (or resume) a GAA draft
 *   3. recordAttempts()                   — record battery tests into the draft
 *   4. getDraft() / recordAttempts()      — save incomplete, resume later
 *   5. completeAssessment()               — validate + record the session
 *   6. baseline (returned + in view)      — baseline established
 *   7. athleteAssessmentView()            — history + personal bests
 *   8. athleteAssessmentView()            — vs baseline / vs previous
 *   9. athleteAssessmentView() / coachDashboard() — status + due dates
 * 10. completeAssessment() / recordDeferral() — reassess or formally defer
 *
 * Athletes/parents see their own results through athleteAssessmentView()
 * only (history, PBs, progress, next due date). They never see drafts,
 * never see other athletes, and never see programming diagnostics.
 *
 * Deliberate limits (do not weaken them):
 *   - A draft is working state, not history: it never counts toward a
 *     baseline, progress, or a due date, and it is deleted on completion.
 *   - Completion requires every GAA measured test to be validly
 *     recorded, recorded as modified, excluded, or actively deferred
 *     by coach approval — the same completeness rule as baselineStatus().
 *   - Recording is coach/director only. Parents and athletes are
 *     read-only, and only for their own athletes / themselves.
 *   - The 28-day cycle is preserved: completing a session sets the
 *     next due date to recordedAt + 28 days.
 *   - Nothing here writes or rewrites a training plan. finalizePlan()
 *     is the only plan mutation, and it refuses an unready plan unless
 *     an explicit, recorded coach override is supplied.
 *   - All methods take an injected auth context { authUserId, role,
 *     coachId?, athleteId? } as the FIRST argument (same convention as
 *     server/api.js). The actor is always the auth UID.
 */
'use strict';

const { recordAssessmentSession, MemoryAssessmentStore } = require('./assessment-store');
const {
  BATTERY_ID, GAA_TESTS, GAA_MEASURED_IDS, validateAttempts, protocolFor,
} = require('./assessment-battery');
const {
  baselineStatus, scheduleFor, reassessmentReminders, athleteReminder,
  recordDeferral, MemoryReassessmentStore,
} = require('./reassessment');
const { assessPlanReadiness, finalizePlan } = require('./baseline-gating');
const { progressForAthlete } = require('./progress');
const { prioritiesFromResults } = require('./smart-draft-adapter');

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}
function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* In-memory development-plan records. Postgres side: development_plans
 * in migration 004 (CHECK: finalized requires a baseline session or a
 * recorded override). */
class MemoryPlanStore {
  constructor() { this.plans = []; }
  async insertPlan(row) { this.plans.push(clone(row)); return clone(row); }
  async getPlan(id) {
    const p = this.plans.find(p => p.id === id);
    return p ? clone(p) : null;
  }
  async updatePlan(row) {
    const i = this.plans.findIndex(p => p.id === row.id);
    if (i < 0) throw new Error('Plan not found: ' + row.id);
    this.plans[i] = clone(row);
    return clone(row);
  }
  async listPlans(athleteId) {
    return this.plans.filter(p => !athleteId || p.athleteId === athleteId).map(clone);
  }
}

function createAssessmentWorkflow({ store, reassessmentStore, planStore, directory } = {}) {
  if (!directory) throw new Error('createAssessmentWorkflow requires a directory (assessment-access.js).');
  const st = store || new MemoryAssessmentStore();
  const rs = reassessmentStore || new MemoryReassessmentStore();
  const ps = planStore || new MemoryPlanStore();
  if (typeof st.getDraft !== 'function' || typeof st.upsertDraft !== 'function' || typeof st.deleteDraft !== 'function') {
    throw new Error('Assessment store must implement getDraft/upsertDraft/deleteDraft (see assessment-store.js).');
  }

  function coachIdFor(auth) {
    return (typeof directory.coachIdFor === 'function' && directory.coachIdFor(auth))
      || (auth.role === 'director' ? auth.authUserId : null);
  }

  async function loadData(athleteId) {
    const sessions = (await st.listSessions(athleteId)).map(s => ({
      id: s.id, athleteId: s.athleteId, battery: s.battery, recordedAt: s.recordedAt,
    }));
    const results = (await st.listResults(athleteId)).map(r => ({
      sessionId: r.sessionId, athleteId: r.athleteId, assessmentId: r.assessmentId,
      result: r.result, modified: r.modified, recordedAt: r.recordedAt,
    }));
    const deferrals = await rs.listDeferrals(athleteId);
    return { sessions, results, deferrals };
  }

  /* Which GAA tests are still uncovered by these entries, given the
   * athlete's coach-approved exclusions / active deferrals? A test is
   * covered by a valid entry, an exclusion, or an active deferral. */
  function missingTests(entries, deferrals, now) {
    const n = toDate(now) || new Date();
    const byId = {};
    for (const e of entries || []) byId[e.assessmentId] = e;
    const excluded = new Set((deferrals || []).filter(d => d.kind === 'exclusion').map(d => d.assessmentId).filter(Boolean));
    const deferred = new Set((deferrals || []).filter(d => d.kind === 'deferral' && toDate(d.deferredUntil) > n).map(d => d.assessmentId).filter(Boolean));
    const missing = [];
    for (const id of GAA_MEASURED_IDS) {
      const e = byId[id];
      const hasValid = e && Array.isArray(e.attempts) && e.attempts.map(Number).some(Number.isFinite);
      if (!hasValid && !excluded.has(id) && !deferred.has(id)) missing.push(id);
    }
    const movement = byId['movement-assessment'];
    const movementCovered = (movement && typeof (movement.observations || movement.text || movement.notes) === 'string'
        && (movement.observations || movement.text || movement.notes).trim().length > 0)
      || excluded.has('movement-assessment') || deferred.has('movement-assessment');
    if (!movementCovered) missing.push('movement-assessment');
    return missing;
  }

  function mergeEntries(existing, incoming) {
    const byId = {};
    for (const e of existing || []) byId[e.assessmentId] = clone(e);
    for (const e of incoming || []) byId[e.assessmentId] = clone(e);
    return Object.values(byId);
  }

  function shapeCheckEntries(entries) {
    const problems = [];
    for (const e of entries || []) {
      if (!e || typeof e.assessmentId !== 'string') { problems.push('Every entry needs an assessmentId.'); continue; }
      if (e.assessmentId === 'movement-assessment') {
        const text = e.observations || e.text || e.notes;
        if (typeof text !== 'string' || !text.trim()) problems.push('Movement assessment needs written observations.');
        continue;
      }
      let known = true;
      try { protocolFor(e.assessmentId); } catch { known = false; }
      if (!known) { problems.push(`Unknown assessment: ${e.assessmentId}.`); continue; }
      if (!Array.isArray(e.attempts) || !e.attempts.map(Number).some(Number.isFinite)) {
        problems.push(`${e.assessmentId}: at least one numeric attempt is required.`);
      }
    }
    return problems;
  }

  async function refreshSchedule(athleteId, now) {
    const data = await loadData(athleteId);
    const s = scheduleFor(athleteId, data, now);
    await rs.upsertSchedule({
      athleteId, battery: BATTERY_ID,
      lastCompletedAt: s.lastCompletedAt, nextDueAt: s.nextDueAt,
      status: s.status, updatedAt: new Date().toISOString(),
    });
    return s;
  }

  function draftView(draft, data, now) {
    const missing = missingTests(draft.entries, data.deferrals, now);
    return {
      draftId: draft.id, athleteId: draft.athleteId, battery: draft.battery,
      coachId: draft.coachId, updatedAt: draft.updatedAt,
      entries: clone(draft.entries), context: clone(draft.context),
      tests: GAA_TESTS.map(t => ({ id: t.id, name: t.name, category: t.category,
        unit: t.unit, direction: t.direction, attempts: t.attempts, kind: t.kind })),
      missing, complete: missing.length === 0,
    };
  }

  return {
    store: st, reassessmentStore: rs, planStore: ps, directory,

    /* (1) Select an athlete: the athletes this caller may assess
     * (coach/director) or view (parent/athlete). */
    listAthletes(auth) {
      return directory.listAthletes(auth);
    },

    /* (2) Start a GAA assessment — or resume the saved draft. */
    async startAssessment(auth, { athleteId, context, now } = {}) {
      directory.requireAssess(auth, athleteId);
      const n = toDate(now) || new Date();
      const data = await loadData(athleteId);
      const sched = scheduleFor(athleteId, data, n);
      let draft = await st.getDraft(athleteId, BATTERY_ID);
      if (!draft) {
        draft = {
          id: uid('adrft'), athleteId: String(athleteId), coachId: coachIdFor(auth),
          battery: BATTERY_ID, entries: [], context: context || null,
          idempotencyKey: null, updatedAt: n.toISOString(),
        };
        await st.upsertDraft(draft);
      }
      return {
        ...draftView(draft, data, n),
        isReassessment: !!sched.lastCompletedAt,
        lastCompletedAt: sched.lastCompletedAt, nextDueAt: sched.nextDueAt,
        reassessmentStatus: sched.status,
      };
    },

    /* (3)+(4) Record attempts into the draft — this is the save step.
     * Partial entries are fine; full protocol validation runs at
     * completion. Returns the draft state and what is still missing. */
    async recordAttempts(auth, { athleteId, entries, context, now } = {}) {
      directory.requireAssess(auth, athleteId);
      const problems = shapeCheckEntries(entries);
      if (problems.length) { const e = err('INVALID_ATTEMPTS', problems.join(' ')); e.problems = problems; throw e; }
      const n = toDate(now) || new Date();
      let draft = await st.getDraft(athleteId, BATTERY_ID);
      if (!draft) {
        draft = { id: uid('adrft'), athleteId: String(athleteId), coachId: coachIdFor(auth),
          battery: BATTERY_ID, entries: [], context: context || null,
          idempotencyKey: null, updatedAt: n.toISOString() };
      }
      draft.entries = mergeEntries(draft.entries, entries);
      if (context !== undefined) draft.context = context;
      draft.coachId = coachIdFor(auth);
      draft.updatedAt = n.toISOString();
      await st.upsertDraft(draft);
      const data = await loadData(athleteId);
      return draftView(draft, data, n);
    },

    /* (4) Resume: read the saved draft, or null when there is none. */
    async getDraft(auth, { athleteId, now } = {}) {
      directory.requireAssess(auth, athleteId);
      const draft = await st.getDraft(athleteId, BATTERY_ID);
      if (!draft) return null;
      const data = await loadData(athleteId);
      return draftView(draft, data, toDate(now) || new Date());
    },

    /* Discard an in-progress draft. Drafts are working state, not
     * history — discarding one deletes no record. */
    async discardDraft(auth, { athleteId } = {}) {
      directory.requireAssess(auth, athleteId);
      await st.deleteDraft(athleteId, BATTERY_ID);
      return { athleteId, battery: BATTERY_ID, discarded: true };
    },

    /* (5)+(6) Complete + validate an assessment and establish the
     * baseline. Merges the saved draft with any entries supplied now.
     * Retries with the same idempotencyKey return the original
     * session and insert nothing. */
    async completeAssessment(auth, { athleteId, entries, idempotencyKey, context, now } = {}) {
      directory.requireAssess(auth, athleteId);
      const n = toDate(now) || new Date();
      const key = idempotencyKey || null;
      if (key && typeof st.findSessionByIdempotencyKey === 'function') {
        const existing = await st.findSessionByIdempotencyKey(String(athleteId), key);
        if (existing) {
          await st.deleteDraft(athleteId, BATTERY_ID);
          const data = await loadData(athleteId);
          const schedule = await refreshSchedule(athleteId, n);
          return { session: existing, idempotentReplay: true,
            baseline: baselineStatus(athleteId, data), schedule };
        }
      }
      const draft = await st.getDraft(athleteId, BATTERY_ID);
      const merged = mergeEntries(draft ? draft.entries : [], entries);
      const data = await loadData(athleteId);
      const missing = missingTests(merged, data.deferrals, n);
      if (missing.length) {
        const e = err('INCOMPLETE_ASSESSMENT',
          `Assessment is incomplete: still missing ${missing.join(', ')}. Record the tests, or record a coach-approved exclusion/deferral for them.`);
        e.missing = missing;
        throw e;
      }
      for (const e of merged) {
        if (e.assessmentId === 'movement-assessment') continue;
        const check = validateAttempts(e.assessmentId, e.attempts);
        if (!check.ok) {
          const ex = err('INVALID_ATTEMPTS', `Invalid attempts for ${e.assessmentId}: ${check.reasons.join(' ')}`);
          ex.assessmentId = e.assessmentId;
          throw ex;
        }
      }
      const recorded = await recordAssessmentSession(st, {
        athleteId, coachId: coachIdFor(auth), entries: merged,
        meta: { battery: BATTERY_ID, recordedAt: n.toISOString(), idempotencyKey: key,
          context: context !== undefined ? context : (draft ? draft.context : null) },
      });
      await st.deleteDraft(athleteId, BATTERY_ID);
      const after = await loadData(athleteId);
      const schedule = await refreshSchedule(athleteId, n);
      return { ...recorded, idempotentReplay: false,
        baseline: baselineStatus(athleteId, after), schedule };
    },

    /* (7)+(8)+(9) Athlete view: history, personal bests, progress
     * (vs baseline / vs previous / vs PB), baseline, schedule,
     * reminders, advisory priorities. Coach (scoped), director,
     * parent (own athlete), athlete (self). */
    async athleteAssessmentView(auth, { athleteId, goals, now } = {}) {
      directory.requireView(auth, athleteId);
      const n = toDate(now) || new Date();
      const athlete = directory.byId.get(String(athleteId));
      const age = athlete ? athlete.age : undefined;
      const data = await loadData(athleteId);
      const byAssessment = {};
      for (const r of data.results) {
        (byAssessment[r.assessmentId] = byAssessment[r.assessmentId] || [])
          .push({ recordedAt: r.recordedAt, result: r.result });
      }
      const progress = progressForAthlete(athleteId, byAssessment, { age });
      const personalBests = {};
      for (const [id, p] of Object.entries(progress.tests)) {
        personalBests[id] = { value: p.personalBest, unit: p.unit,
          isCurrentBest: p.isPersonalBest, status: p.status };
      }
      const sessions = await st.listSessions(athleteId);
      const history = [];
      for (const s of sessions) {
        const rows = data.results.filter(r => r.sessionId === s.id);
        history.push({ sessionId: s.id, battery: s.battery, recordedAt: s.recordedAt,
          coachId: s.coachId, results: rows.map(r => ({ assessmentId: r.assessmentId,
            attempts: r.attempts, result: r.result, unit: r.unit,
            modified: !!r.modified, capped: !!r.capped })) });
      }
      return {
        athleteId, age: age ?? null,
        baseline: baselineStatus(athleteId, data),
        schedule: scheduleFor(athleteId, data, n),
        reminder: athleteReminder(athleteId, data, n),
        history, personalBests, progress,
        advisory: prioritiesFromResults(athleteId, data.results, { age, goals: goals || [] }),
      };
    },

    /* (9) Coach dashboard: reminder buckets across the caller's own
     * athletes, derived on demand (no cron, no stored job). */
    async coachDashboard(auth, { now } = {}) {
      directory.requireAuth(auth);
      if (auth.role !== 'coach' && auth.role !== 'director') {
        throw err('FORBIDDEN', `Role '${auth.role}' has no coach dashboard.`);
      }
      const n = toDate(now) || new Date();
      const athletes = directory.listAthletes(auth);
      const sessions = [];
      const results = [];
      const deferrals = [];
      for (const a of athletes) {
        const d = await loadData(a.id);
        sessions.push(...d.sessions);
        results.push(...d.results);
        deferrals.push(...d.deferrals);
      }
      return { coachId: coachIdFor(auth), athletes: athletes.map(a => ({ id: a.id, age: a.age ?? null })),
        reminders: reassessmentReminders(athletes, { sessions, results, deferrals }, n) };
    },

    /* (10) Formally defer / exclude / modify — coach-approved only.
     * Never marks an assessment complete. */
    async recordDeferral(auth, input) {
      directory.requireAssess(auth, input && input.athleteId);
      const row = await recordDeferral(rs, {
        ...input, battery: input.battery || BATTERY_ID,
        approvedBy: input.approvedBy || coachIdFor(auth),
      });
      await refreshSchedule(input.athleteId, input.now);
      return row;
    },

    /* Training-plan controls. */
    async planReadiness(auth, { athleteId } = {}) {
      directory.requireView(auth, athleteId);
      const data = await loadData(athleteId);
      return assessPlanReadiness({ athleteId, ...data });
    },

    async createPlan(auth, { athleteId } = {}) {
      directory.requireAssess(auth, athleteId);
      const plan = { id: uid('dplan'), athleteId: String(athleteId), status: 'draft',
        baselineSessionId: null, finalizedBy: null, finalizedAt: null,
        overrideReason: null, overrideApprovedBy: null, createdAt: new Date().toISOString() };
      await ps.insertPlan(plan);
      return plan;
    },

    /* Finalize a draft plan. Refuses an unready plan unless an
     * explicit coach override (reason + approver) is supplied; the
     * override is recorded on the plan itself. */
    async finalizePlan(auth, { planId, override, now } = {}) {
      const plan = await ps.getPlan(planId);
      if (!plan) throw err('PLAN_NOT_FOUND', 'Plan not found: ' + planId);
      directory.requireAssess(auth, plan.athleteId);
      const coachId = coachIdFor(auth);
      if (!coachId) throw err('FORBIDDEN', 'Finalization must name the coach who approved it.');
      const data = await loadData(plan.athleteId);
      const readiness = assessPlanReadiness({ athleteId: plan.athleteId, ...data });
      const finalized = finalizePlan({ plan, readiness, coachId, override, now });
      await ps.updatePlan(finalized);
      return finalized;
    },

    /* Advisory priorities for Smart Draft — read-only evidence, never
     * a program change. */
    async advisoryPriorities(auth, { athleteId, goals } = {}) {
      directory.requireView(auth, athleteId);
      const athlete = directory.byId.get(String(athleteId));
      const data = await loadData(athleteId);
      return prioritiesFromResults(athleteId, data.results, { age: athlete ? athlete.age : undefined, goals: goals || [] });
    },
  };
}

module.exports = { createAssessmentWorkflow, MemoryPlanStore };
