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
//   links: [{ coachId, athleteId, organizationId, status }]
//          — active coach-athlete links from migration 006
//   orgMemberships: [{ authUserId, organizationId, orgRole, status }]
//          — organization memberships from migration 006
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
//   - links[]:     coach_athlete_links (migration 006) — the SaaS
//                  roster. An ACTIVE link grants the linked coach
//                  assess/view scope exactly like a cohort enrolment
//                  does; a paused/ended link grants nothing. The
//                  access module filters on status, so rows are
//                  passed through as stored, never pre-filtered here.
//   - orgMemberships[]: organization_memberships (migration 006)
//                  joined to app_users for the member's Auth UID.
//                  An ACTIVE org_admin membership lets that user view
//                  (never assess) athletes linked inside the org.
//                  Rows whose member has no Auth UID are dropped —
//                  they cannot be attributed to a caller.
//
// RESOLVED (Phase 3, 2026-11-14) — adult athletes: migration 005
// (server/migrations/005_unified_athlete_age_and_result_flags.sql)
// was APPLIED to the live project TheProgramOS on 2026-11-13 and
// verified (see server/live-checks/005/RESULTS.md). It removes the
// 19-year-old maximum from athletes.age_years (CHECK is now
// age_years >= 5, floor kept as a sanity guard), so an adult athlete
// (e.g. the 48-year-old validation case) is stored as an athletes
// row like any other, under the unified athlete system — no
// divisions. The directory reports age_years as-is, which is correct
// for all ages; nothing here works around the CHECK, because there
// is no maximum left to work around.

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
  /* SaaS / Pathways scoping (migration 006). Shapes match what
   * server/assessment-access.js createAccessDirectory expects:
   * links are filtered on status='active' there; memberships are
   * matched on the member's Auth UID. */
  links: DirectoryLink[];
  orgMemberships: DirectoryOrgMembership[];
}

export interface DirectoryLink {
  coachId: string;
  athleteId: string;
  organizationId: string;
  status: string;
}

export interface DirectoryOrgMembership {
  authUserId: string;
  organizationId: string;
  orgRole: string;
  status: string;
}

// Rows coming back from PostgREST are untyped (no generated Database
// types yet); treat them as string-keyed records, never as `any`.
type DbRow = Record<string, unknown>;

function isRole(value: unknown): value is Role {
  return value === "director" || value === "coach" || value === "parent" || value === "athlete" || value === "org_admin";
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
    { data: links }, { data: guardians }, { data: guardianUsers },
    { data: saasLinks }, { data: saasMemberships }] = await Promise.all([
    supabase.from("athletes").select("id, age_years, app_user_id"),
    supabase.from("cohort_enrollments").select("athlete_id, cohort_id, status").eq("status", "enrolled"),
    supabase.from("cohorts").select("id, head_coach_id"),
    supabase.from("athlete_guardians").select("athlete_id, guardian_id"),
    supabase.from("guardians").select("id, user_id"),
    supabase.from("app_users").select("id, auth_user_id"),
    // SaaS / Pathways scoping (migration 006): the coach-athlete
    // roster links and the org memberships. RLS scopes these rows
    // to the caller, exactly like the tables above.
    supabase.from("coach_athlete_links").select("coach_id, athlete_id, organization_id, status"),
    supabase.from("organization_memberships").select("organization_id, app_user_id, org_role, status"),
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

  // SaaS links pass through as stored (status included); the access
  // module grants scope only on status='active'. Memberships are
  // keyed by the member's Auth UID; rows without one are dropped.
  const directoryLinks: DirectoryLink[] = (saasLinks ?? []).map((l: DbRow) => ({
    coachId: String(l.coach_id),
    athleteId: String(l.athlete_id),
    organizationId: String(l.organization_id),
    status: String(l.status),
  }));
  const directoryMemberships: DirectoryOrgMembership[] = (saasMemberships ?? [])
    .map((m: DbRow) => {
      const uid = authUidByAppUser.get(String(m.app_user_id));
      return uid
        ? {
          authUserId: uid,
          organizationId: String(m.organization_id),
          orgRole: String(m.org_role),
          status: String(m.status),
        }
        : null;
    })
    .filter((m): m is DirectoryOrgMembership => m !== null);

  return {
    auth,
    directory: {
      athletes: rows,
      coachAuth,
      byId: new Map(rows.map((a) => [a.id, a])),
      links: directoryLinks,
      orgMemberships: directoryMemberships,
    },
  };
}
