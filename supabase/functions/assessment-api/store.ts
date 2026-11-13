// THE PROGRAM OS — PostgREST store adapters for the Edge Function
// supabase/functions/assessment-api/store.ts
//
// The Supabase-backed counterparts of the Node stores the workflow
// was tested against (MemoryAssessmentStore / MemoryReassessmentStore
// / MemoryPlanStore). Same method names, same shapes — the workflow
// (server/assessment-workflow.js) cannot tell which store it is
// talking to. All queries run on the USER-scoped client passed in,
// so Postgres RLS (migrations 003 + 004) applies to every read and
// write. service_role is never used here.
//
// Two mapping rules, both deliberate and documented:
//   1. camelCase <-> snake_case. Node rows use athleteId / sessionId /
//      recordedAt / idempotencyKey; Postgres uses athlete_id /
//      session_id / recorded_at / idempotency_key. Every adapter
//      method maps both ways, so the workflow sees exactly the rows
//      its tests use.
//   2. IDs are UUIDs in Postgres. The Node stores generate string ids
//      like 'asess_…' (uid()), which are NOT valid UUIDs and Postgres
//      would reject. Each insert therefore assigns a fresh
//      crypto.randomUUID() onto the row object IN PLACE before
//      inserting, so the caller's later references (recordAssessment-
//      Session uses sessionRow.id for its results) stay consistent.
//      The returned row carries the UUID.
//
// KNOWN GAP — modified/capped flags (see README.md §4): migration
// 002's assessment_results has NO modified/capped columns, but the
// workflow records them on every result row (server/assessment-
// store.js) and reads them back in athleteAssessmentView. This
// adapter maps them to `modified` / `capped` columns, which DO NOT
// EXIST yet — inserts/selects touching assessment_results will fail
// at PostgREST until migration 005
// (server/migrations/005_unified_athlete_age_and_result_flags.sql,
// written 2026-11-13, NOT applied) adds those two BOOLEAN columns.
// The mapping is written so it works unchanged once the columns
// exist; nothing is silently dropped.
// Do NOT "fix" this by stuffing the flags into the attempts JSONB —
// attempts must stay the preserved numeric attempts.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type Row = Record<string, unknown>;

function storeError(e: { message?: string }): Error & { code: string } {
  return Object.assign(new Error(e.message ?? "PostgREST error"), { code: "STORE_ERROR" });
}

function newId(row: Row): string {
  const id = crypto.randomUUID();
  row.id = id;
  return id;
}

function omitUndefined(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) if (v !== undefined) out[k] = v;
  return out;
}

// --- assessment_sessions / assessment_results / assessment_derived_records ---

function sessionToDb(s: Row): Row {
  newId(s);
  return omitUndefined({
    id: s.id, athlete_id: s.athleteId, coach_id: s.coachId ?? null,
    battery: s.battery, recorded_at: s.recordedAt, context: s.context ?? null,
    engine_version: s.engineVersion, idempotency_key: s.idempotencyKey ?? null,
  });
}
function sessionFromDb(r: Row): Row {
  return {
    id: r.id, athleteId: r.athlete_id, coachId: r.coach_id, battery: r.battery,
    recordedAt: r.recorded_at, context: r.context, engineVersion: r.engine_version,
    idempotencyKey: r.idempotency_key ?? null,
  };
}

function resultToDb(r: Row): Row {
  newId(r);
  return omitUndefined({
    id: r.id, session_id: r.sessionId, athlete_id: r.athleteId,
    assessment_id: r.assessmentId, kind: r.kind ?? "measured",
    attempts: r.attempts, result: r.result ?? null, unit: r.unit,
    direction: r.direction, protocol_version: r.protocolVersion,
    recorded_at: r.recordedAt,
    // GAP §4: these columns do not exist until a 005 adds them.
    modified: r.modified ?? false, capped: r.capped ?? false,
  });
}
function resultFromDb(r: Row): Row {
  return {
    id: r.id, sessionId: r.session_id, athleteId: r.athlete_id,
    assessmentId: r.assessment_id, kind: r.kind, attempts: r.attempts,
    result: r.result, unit: r.unit, direction: r.direction,
    protocolVersion: r.protocol_version, recordedAt: r.recorded_at,
    modified: r.modified ?? false, capped: r.capped ?? false,
  };
}

function derivedToDb(d: Row): Row {
  newId(d);
  return omitUndefined({
    id: d.id, session_id: d.sessionId, athlete_id: d.athleteId,
    assessment_id: d.assessmentId ?? null, kind: d.kind,
    derived_type: d.derivedType ?? null, value: d.value ?? null,
    text: d.text ?? null, source: d.source, engine_version: d.engineVersion ?? null,
    caveat: d.caveat, recorded_at: d.recordedAt,
  });
}
function derivedFromDb(r: Row): Row {
  return {
    id: r.id, sessionId: r.session_id, athleteId: r.athlete_id,
    assessmentId: r.assessment_id, kind: r.kind, derivedType: r.derived_type,
    value: r.value, text: r.text, source: r.source,
    engineVersion: r.engine_version, caveat: r.caveat, recordedAt: r.recorded_at,
  };
}

// --- assessment_drafts (migration 004) ---

function draftToDb(d: Row): Row {
  newId(d);
  return omitUndefined({
    id: d.id, athlete_id: d.athleteId, coach_id: d.coachId ?? null,
    battery: d.battery, entries: d.entries ?? [], context: d.context ?? null,
    idempotency_key: d.idempotencyKey ?? null, updated_at: d.updatedAt ?? new Date().toISOString(),
  });
}
function draftFromDb(r: Row): Row {
  return {
    id: r.id, athleteId: r.athlete_id, coachId: r.coach_id, battery: r.battery,
    entries: r.entries ?? [], context: r.context,
    idempotencyKey: r.idempotency_key ?? null, updatedAt: r.updated_at,
  };
}

// --- assessment_schedules / assessment_deferrals (migration 004) ---

function scheduleToDb(s: Row): Row {
  newId(s);
  return omitUndefined({
    id: s.id, athlete_id: s.athleteId, battery: s.battery,
    last_completed_at: s.lastCompletedAt ?? null, next_due_at: s.nextDueAt ?? null,
    status: s.status, updated_at: s.updatedAt ?? new Date().toISOString(),
  });
}
function scheduleFromDb(r: Row): Row {
  return {
    id: r.id, athleteId: r.athlete_id, battery: r.battery,
    lastCompletedAt: r.last_completed_at, nextDueAt: r.next_due_at,
    status: r.status, updatedAt: r.updated_at,
  };
}

function deferralToDb(d: Row): Row {
  newId(d);
  return omitUndefined({
    id: d.id, athlete_id: d.athleteId, battery: d.battery,
    assessment_id: d.assessmentId ?? null, scope: d.scope, kind: d.kind,
    deferred_until: d.deferredUntil ?? null, reason: d.reason,
    details: d.details ?? null, approved_by: d.approvedBy ?? null,
    created_at: d.createdAt ?? new Date().toISOString(),
  });
}
function deferralFromDb(r: Row): Row {
  return {
    id: r.id, athleteId: r.athlete_id, battery: r.battery,
    assessmentId: r.assessment_id, scope: r.scope, kind: r.kind,
    deferredUntil: r.deferred_until, reason: r.reason, details: r.details,
    approvedBy: r.approved_by, createdAt: r.created_at,
  };
}

// --- development_plans (migration 004) ---

function planToDb(p: Row): Row {
  newId(p);
  return omitUndefined({
    id: p.id, athlete_id: p.athleteId, status: p.status,
    baseline_session_id: p.baselineSessionId ?? null,
    finalized_by: p.finalizedBy ?? null, finalized_at: p.finalizedAt ?? null,
    override_reason: p.overrideReason ?? null,
    override_approved_by: p.overrideApprovedBy ?? null,
    created_at: p.createdAt ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}
function planFromDb(r: Row): Row {
  return {
    id: r.id, athleteId: r.athlete_id, status: r.status,
    baselineSessionId: r.baseline_session_id, finalizedBy: r.finalized_by,
    finalizedAt: r.finalized_at, overrideReason: r.override_reason,
    overrideApprovedBy: r.override_approved_by, createdAt: r.created_at,
  };
}

export function createSupabaseStores(supabase: SupabaseClient) {
  async function one<T>(q: PromiseLike<{ data: T | null; error: { message?: string } | null }>): Promise<T> {
    const { data, error } = await q;
    if (error) throw storeError(error);
    return data as T;
  }

  const store = {
    // -- assessment store (server/assessment-store.js interface) --
    async insertSession(row: Row): Promise<Row> {
      const saved = await one(supabase.from("assessment_sessions").insert(sessionToDb(row)).select().single());
      return sessionFromDb(saved as Row);
    },
    async insertResult(row: Row): Promise<Row> {
      const saved = await one(supabase.from("assessment_results").insert(resultToDb(row)).select().single());
      return resultFromDb(saved as Row);
    },
    async insertDerived(row: Row): Promise<Row> {
      const saved = await one(supabase.from("assessment_derived_records").insert(derivedToDb(row)).select().single());
      return derivedFromDb(saved as Row);
    },
    async listSessions(athleteId: string): Promise<Row[]> {
      const { data, error } = await supabase.from("assessment_sessions")
        .select("*").eq("athlete_id", athleteId).order("recorded_at", { ascending: true });
      if (error) throw storeError(error);
      return (data as Row[]).map(sessionFromDb);
    },
    async listResults(athleteId: string, assessmentId?: string): Promise<Row[]> {
      let q = supabase.from("assessment_results").select("*").eq("athlete_id", athleteId);
      if (assessmentId) q = q.eq("assessment_id", assessmentId);
      const { data, error } = await q.order("recorded_at", { ascending: true });
      if (error) throw storeError(error);
      return (data as Row[]).map(resultFromDb);
    },
    async findSessionByIdempotencyKey(athleteId: string, key: string): Promise<Row | null> {
      if (!key) return null;
      const { data, error } = await supabase.from("assessment_sessions")
        .select("*").eq("athlete_id", athleteId).eq("idempotency_key", key).maybeSingle();
      if (error) throw storeError(error);
      return data ? sessionFromDb(data as Row) : null;
    },
    async listDerivedBySession(sessionId: string): Promise<Row[]> {
      const { data, error } = await supabase.from("assessment_derived_records")
        .select("*").eq("session_id", sessionId);
      if (error) throw storeError(error);
      return (data as Row[]).map(derivedFromDb);
    },
    async getDraft(athleteId: string, battery: string): Promise<Row | null> {
      const { data, error } = await supabase.from("assessment_drafts")
        .select("*").eq("athlete_id", athleteId).eq("battery", battery).maybeSingle();
      if (error) throw storeError(error);
      return data ? draftFromDb(data as Row) : null;
    },
    async upsertDraft(row: Row): Promise<Row> {
      const saved = await one(supabase.from("assessment_drafts")
        .upsert(draftToDb(row), { onConflict: "athlete_id,battery" }).select().single());
      return draftFromDb(saved as Row);
    },
    async deleteDraft(athleteId: string, battery: string): Promise<boolean> {
      const { error } = await supabase.from("assessment_drafts")
        .delete().eq("athlete_id", athleteId).eq("battery", battery);
      if (error) throw storeError(error);
      return true;
    },
  };

  const reassessmentStore = {
    // -- reassessment store (server/reassessment.js interface) --
    async insertDeferral(row: Row): Promise<Row> {
      const saved = await one(supabase.from("assessment_deferrals").insert(deferralToDb(row)).select().single());
      return deferralFromDb(saved as Row);
    },
    async listDeferrals(athleteId?: string): Promise<Row[]> {
      let q = supabase.from("assessment_deferrals").select("*");
      if (athleteId) q = q.eq("athlete_id", athleteId);
      const { data, error } = await q.order("created_at", { ascending: true });
      if (error) throw storeError(error);
      return (data as Row[]).map(deferralFromDb);
    },
    async upsertSchedule(row: Row): Promise<Row> {
      const saved = await one(supabase.from("assessment_schedules")
        .upsert(scheduleToDb(row), { onConflict: "athlete_id,battery" }).select().single());
      return scheduleFromDb(saved as Row);
    },
    async listSchedules(): Promise<Row[]> {
      const { data, error } = await supabase.from("assessment_schedules").select("*");
      if (error) throw storeError(error);
      return (data as Row[]).map(scheduleFromDb);
    },
  };

  const planStore = {
    // -- plan store (MemoryPlanStore interface in server/assessment-workflow.js) --
    async insertPlan(row: Row): Promise<Row> {
      const saved = await one(supabase.from("development_plans").insert(planToDb(row)).select().single());
      return planFromDb(saved as Row);
    },
    async getPlan(id: string): Promise<Row | null> {
      const { data, error } = await supabase.from("development_plans").select("*").eq("id", id).maybeSingle();
      if (error) throw storeError(error);
      return data ? planFromDb(data as Row) : null;
    },
    async updatePlan(row: Row): Promise<Row> {
      const db = planToDb({ ...row, id: row.id });
      // Keep the caller's id: planToDb generates a fresh UUID, so restore it.
      db.id = row.id;
      db.updated_at = new Date().toISOString();
      const saved = await one(supabase.from("development_plans").update(db).eq("id", row.id as string).select().single());
      return planFromDb(saved as Row);
    },
    async listPlans(athleteId?: string): Promise<Row[]> {
      let q = supabase.from("development_plans").select("*");
      if (athleteId) q = q.eq("athlete_id", athleteId);
      const { data, error } = await q;
      if (error) throw storeError(error);
      return (data as Row[]).map(planFromDb);
    },
  };

  return { store, reassessmentStore, planStore };
}
