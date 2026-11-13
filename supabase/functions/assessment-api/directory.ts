// THE PROGRAM OS — Access directory builder for the Edge Function
// supabase/functions/assessment-api/directory.ts
//
// Turns a verified Supabase Auth UID into the auth context and access
// directory that server/assessment-access.js expects:
//
//   athlete: { id, age, coachIds: [coaches.id...],
//              guardianUserIds: [app_users.auth_user_id...],
//              authUserId: <the athlete's own Supabase Auth UID or null> }
//   coachAuth: { [authUserId]: coachId }
//
// Every value comes from the database via the USER-scoped client, so
// RLS applies to these reads too (a coach only ever sees their own
// athletes here, exactly as the RLS policies allow). Nothing comes
// from client input.
//
// The mappings mirror migration 003's SECURITY DEFINER helpers:
//   - role:        app_users.role WHERE auth_user_id = auth.uid()
//                  (public.app_role())
//   - coachId:     coaches.id WHERE user_id = app_user_id()
//                  (public.my_coach_id())
//   - coachIds[]:  head_coach_id of cohorts the athlete is enrolled
//                  in (status='enrolled') — exactly what
//                  public.is_my_cohort_athlete() computes.
//   - guardianUserIds[]: auth_user_id of guardians linked through
//                  athlete_guardians -> guardians.user_id ->
//                  app_users.auth_user_id (the parent half of
//                  public.is_my_athlete()).
//   - athlete.authUserId: app_users.auth_user_id for the athlete's
//                  athletes.app_user_id (the athlete half of
//                  public.is_my_athlete()).
//
// KNOWN GAP — adult athletes: athletes.age_years is CHECK 5–19 in
// migration 001, so an adult athlete (e.g. the 48-year-old validation
// case) cannot be stored as an athletes row today. The directory
// therefore reports age_years as-is; supporting adult athletes in
// the live database needs migration 005
// (server/migrations/005_unified_athlete_age_and_result_flags.sql,
// written 2026-11-13, NOT applied), which removes the 19 maximum
// (floor of 5 kept). See README.md §4. This is a gap to decide,
// not something this scaffold silently works around.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AuthContext, Role } from "./api.ts";

export interface DirectoryAthlete {
  id: string;
  age: number | null;
  coachIds: string[];
  guardianUserIds: string[];
  authUserId: string | null;
}

export interface DirectoryRow {
  athletes: DirectoryAthlete[];
  coachAuth: Record<string, string>;
  byId: Map<string, DirectoryAthlete>;
}

// Rows coming back from PostgREST are untyped (no generated Database
// types yet); treat them as string-keyed records, never as `any`.
type DbRow = Record<string, unknown>;

function isRole(value: unknown): value is Role {
  return value === "director" || value === "coach" || value === "parent" || value === "athlete";
}

export async function buildDirectory(
  supabase: SupabaseClient,
  authUid: string,
): Promise<{ auth: AuthContext; directory: DirectoryRow }> {
  // 1. The caller's own app_users row: role + id.
  const { data: me, error: meError } = await supabase
    .from("app_users")
    .select("id, role")
    .eq("auth_user_id", authUid)
    .maybeSingle();
  if (meError) throw Object.assign(new Error(meError.message), { code: "INTERNAL" });
  if (!me || !isRole(me.role)) {
    throw Object.assign(
      new Error("No app role is linked to this Supabase Auth user."),
      { code: "FORBIDDEN" },
    );
  }
  const appUserId = me.id as string;
  const role = me.role as Role;

  // 2. Coach mapping: coaches.id WHERE user_id = app_user_id().
  let coachId: string | null = null;
  if (role === "coach" || role === "director") {
    const { data: coach } = await supabase
      .from("coaches")
      .select("id")
      .eq("user_id", appUserId)
      .maybeSingle();
    coachId = (coach?.id as string | undefined) ?? null;
  }

  // 3. Athlete mapping for an athlete-role login.
  let athleteId: string | null = null;
  if (role === "athlete") {
    const { data: athlete } = await supabase
      .from("athletes")
      .select("id")
      .eq("app_user_id", appUserId)
      .maybeSingle();
    athleteId = (athlete?.id as string | undefined) ?? null;
  }

  const auth: AuthContext = { authUserId: authUid, role, coachId, athleteId };

  // 4. Directory rows, from the tables RLS already scopes to the caller.
  const [{ data: athletes }, { data: enrollments }, { data: cohorts },
    { data: links }, { data: guardians }, { data: guardianUsers }] = await Promise.all([
    supabase.from("athletes").select("id, age_years, app_user_id"),
    supabase.from("cohort_enrollments").select("athlete_id, cohort_id, status").eq("status", "enrolled"),
    supabase.from("cohorts").select("id, head_coach_id"),
    supabase.from("athlete_guardians").select("athlete_id, guardian_id"),
    supabase.from("guardians").select("id, user_id"),
    supabase.from("app_users").select("id, auth_user_id"),
  ]);

  const headCoachByCohort = new Map<string, string>();
  for (const c of cohorts ?? []) {
    if (c.head_coach_id) headCoachByCohort.set(String(c.id), String(c.head_coach_id));
  }
  const coachIdsByAthlete = new Map<string, Set<string>>();
  for (const e of enrollments ?? []) {
    const head = headCoachByCohort.get(String(e.cohort_id));
    if (!head) continue;
    const set = coachIdsByAthlete.get(String(e.athlete_id)) ?? new Set<string>();
    set.add(head);
    coachIdsByAthlete.set(String(e.athlete_id), set);
  }

  const authUidByAppUser = new Map<string, string>();
  for (const u of guardianUsers ?? []) {
    if (u.auth_user_id) authUidByAppUser.set(String(u.id), String(u.auth_user_id));
  }
  const guardianAppUserByGuardian = new Map<string, string>();
  for (const g of guardians ?? []) guardianAppUserByGuardian.set(String(g.id), String(g.user_id));
  const guardianUidsByAthlete = new Map<string, Set<string>>();
  for (const l of links ?? []) {
    const appUserId = guardianAppUserByGuardian.get(String(l.guardian_id));
    const uid = appUserId ? authUidByAppUser.get(appUserId) : undefined;
    if (!uid) continue;
    const set = guardianUidsByAthlete.get(String(l.athlete_id)) ?? new Set<string>();
    set.add(uid);
    guardianUidsByAthlete.set(String(l.athlete_id), set);
  }

  const rows: DirectoryAthlete[] = (athletes ?? []).map((a: DbRow) => ({
    id: String(a.id),
    age: typeof a.age_years === "number" ? a.age_years : null,
    coachIds: [...(coachIdsByAthlete.get(String(a.id)) ?? new Set<string>())],
    guardianUserIds: [...(guardianUidsByAthlete.get(String(a.id)) ?? new Set<string>())],
    // athletes.app_user_id is an app_users.id; the access module wants
    // the athlete's own Supabase Auth UID.
    authUserId: a.app_user_id ? (authUidByAppUser.get(String(a.app_user_id)) ?? null) : null,
  }));

  const coachAuth: Record<string, string> = {};
  if (coachId) coachAuth[authUid] = coachId;

  return {
    auth,
    directory: {
      athletes: rows,
      coachAuth,
      byId: new Map(rows.map((a) => [a.id, a])),
    },
  };
}
