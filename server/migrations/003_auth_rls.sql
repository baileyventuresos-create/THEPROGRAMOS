-- THE PROGRAM OS — Backend Completion (Supabase-only, 2026-11-12)
-- Migration 003: Supabase Auth link + minimum role-scoped RLS policies
--
-- STATUS: version-controlled migration ONLY. NOT applied to production
-- (or anywhere). Applying it to TheProgramOS (ref rkgdwqgmldznczikrjip)
-- requires Marcus's explicit approval — see docs/SUPABASE_HANDOFF.md.
--
-- ASSUMES the auth schema exists: Supabase provides auth.users and the
-- auth.uid() function. A local throwaway Postgres used to rehearse this
-- migration needs a STUB auth.users table and auth.uid() function first;
-- the stub is NOT created here (this file must only ever run where the
-- real auth schema exists, i.e. Supabase).
--
-- What this adds on top of migrations 001 + 002:
-- * app_users.auth_user_id — link from an app role row to a Supabase Auth
--   user. Nullable + unique: no auth users exist yet (0 at inspection
--   2026-11-12), so rows are created unlinked and linked at sign-up.
-- * athletes.app_user_id — link so an athlete-role login can read ONLY
--   its own record. Nullable; set when an athlete account is created.
-- * Role helpers (SECURITY DEFINER, so they can read app_users through
--   its own RLS) and the minimum policies that let an `authenticated`
--   (non-service_role) caller use the API paths in server/api.js:
--   director = full read/write on operational tables; coach = read
--   athletes in cohorts they head + write attendance/reservations for
--   sessions they are assigned to; parent/guardian = read-only own
--   athletes (via athlete_guardians) + book/cancel for them; athlete =
--   read-only own record. Nothing here weakens 001/002: RLS stays
--   enabled everywhere, service_role still bypasses RLS (by design —
--   the API never uses service_role for user requests), and there is no
--   anonymous access (no policies for the `anon` role at all).
-- * These policies are the MINIMUM viable set, not the finished set:
--   they have not been exercised against live Supabase. Before any real
--   athlete record is stored, run the policy checks in
--   docs/SUPABASE_HANDOFF.md against TheProgramOS and record the result.
-- * Idempotent: safe to re-run (IF NOT EXISTS / DROP POLICY IF EXISTS).

BEGIN;

-- ---------------------------------------------------------------------------
-- Auth links
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS app_users
  ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS athletes
  ADD COLUMN IF NOT EXISTS app_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_athletes_app_user ON athletes (app_user_id);

-- ---------------------------------------------------------------------------
-- Role helpers (SECURITY DEFINER: they read app_users past its own RLS)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_user_id() RETURNS UUID
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT id FROM public.app_users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.app_role() RETURNS TEXT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT role FROM public.app_users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.my_coach_id() RETURNS UUID
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT id FROM public.coaches WHERE user_id = public.app_user_id() LIMIT 1;
$$;

-- Athletes belonging to the caller: via guardians (parent) or direct link.
CREATE OR REPLACE FUNCTION public.is_my_athlete(p_athlete_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.athletes a WHERE a.id = p_athlete_id
        AND a.app_user_id = public.app_user_id()
    ) OR EXISTS (
      SELECT 1 FROM public.athlete_guardians ag
      JOIN public.guardians g ON g.id = ag.guardian_id
      WHERE ag.athlete_id = p_athlete_id AND g.user_id = public.app_user_id()
    );
$$;

-- Athletes in cohorts headed by the caller's coach row.
CREATE OR REPLACE FUNCTION public.is_my_cohort_athlete(p_athlete_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.cohort_enrollments ce
      JOIN public.cohorts c ON c.id = ce.cohort_id
      WHERE ce.athlete_id = p_athlete_id AND ce.status = 'enrolled'
        AND c.head_coach_id = public.my_coach_id()
    );
$$;

-- Sessions the caller's coach row is assigned to.
CREATE OR REPLACE FUNCTION public.is_my_session(p_session_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.session_coaches sc
      WHERE sc.session_id = p_session_id AND sc.coach_id = public.my_coach_id()
    ) OR EXISTS (
      SELECT 1 FROM public.training_sessions ts
      JOIN public.cohorts c ON c.id = ts.cohort_id
      WHERE ts.id = p_session_id AND c.head_coach_id = public.my_coach_id()
    );
$$;

-- ---------------------------------------------------------------------------
-- app_users: director full; anyone reads only their own row.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS app_users_director ON app_users;
CREATE POLICY app_users_director ON app_users FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS app_users_self ON app_users;
CREATE POLICY app_users_self ON app_users FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- athletes: director full; coach reads athletes in cohorts they head;
-- parent/guardian reads own athletes; athlete reads only its own record.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS athletes_director ON athletes;
CREATE POLICY athletes_director ON athletes FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS athletes_coach ON athletes;
CREATE POLICY athletes_coach ON athletes FOR SELECT TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_cohort_athlete(id));
DROP POLICY IF EXISTS athletes_guardian ON athletes;
CREATE POLICY athletes_guardian ON athletes FOR SELECT TO authenticated
  USING (public.app_role() = 'parent' AND public.is_my_athlete(id));
DROP POLICY IF EXISTS athletes_self ON athletes;
CREATE POLICY athletes_self ON athletes FOR SELECT TO authenticated
  USING (public.app_role() = 'athlete' AND app_user_id = public.app_user_id());

-- ---------------------------------------------------------------------------
-- guardians / athlete_guardians: director full; guardian reads own rows;
-- coach reads guardian links for athletes in their cohorts.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS guardians_director ON guardians;
CREATE POLICY guardians_director ON guardians FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS guardians_self ON guardians;
CREATE POLICY guardians_self ON guardians FOR SELECT TO authenticated
  USING (user_id = public.app_user_id());

DROP POLICY IF EXISTS athlete_guardians_director ON athlete_guardians;
CREATE POLICY athlete_guardians_director ON athlete_guardians FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS athlete_guardians_guardian ON athlete_guardians;
CREATE POLICY athlete_guardians_guardian ON athlete_guardians FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM guardians g WHERE g.id = guardian_id AND g.user_id = public.app_user_id()));
DROP POLICY IF EXISTS athlete_guardians_coach ON athlete_guardians;
CREATE POLICY athlete_guardians_coach ON athlete_guardians FOR SELECT TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id));

-- ---------------------------------------------------------------------------
-- memberships: director full; parent/athlete read own athletes' rows.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS memberships_director ON memberships;
CREATE POLICY memberships_director ON memberships FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS memberships_owner_read ON memberships;
CREATE POLICY memberships_owner_read ON memberships FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

-- ---------------------------------------------------------------------------
-- Reference data (locations, spaces, templates, cohorts, coaches):
-- director full; any authenticated user may read (needed to display
-- availability and book). Writes stay director-only.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS locations_director ON locations;
CREATE POLICY locations_director ON locations FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS locations_read ON locations;
CREATE POLICY locations_read ON locations FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS training_spaces_director ON training_spaces;
CREATE POLICY training_spaces_director ON training_spaces FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS training_spaces_read ON training_spaces;
CREATE POLICY training_spaces_read ON training_spaces FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS session_templates_director ON session_templates;
CREATE POLICY session_templates_director ON session_templates FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS session_templates_read ON session_templates;
CREATE POLICY session_templates_read ON session_templates FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cohorts_director ON cohorts;
CREATE POLICY cohorts_director ON cohorts FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS cohorts_read ON cohorts;
CREATE POLICY cohorts_read ON cohorts FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS coaches_director ON coaches;
CREATE POLICY coaches_director ON coaches FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS coaches_read ON coaches;
CREATE POLICY coaches_read ON coaches FOR SELECT TO authenticated USING (true);

-- coach_availability: director full; a coach manages their own blocks;
-- any authenticated user may read (session planning needs it).
DROP POLICY IF EXISTS coach_availability_director ON coach_availability;
CREATE POLICY coach_availability_director ON coach_availability FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS coach_availability_self ON coach_availability;
CREATE POLICY coach_availability_self ON coach_availability FOR ALL TO authenticated
  USING (coach_id = public.my_coach_id()) WITH CHECK (coach_id = public.my_coach_id());
DROP POLICY IF EXISTS coach_availability_read ON coach_availability;
CREATE POLICY coach_availability_read ON coach_availability FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- cohort_enrollments: director full; coach reads their cohorts';
-- parent/athlete read own athletes'.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS cohort_enrollments_director ON cohort_enrollments;
CREATE POLICY cohort_enrollments_director ON cohort_enrollments FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS cohort_enrollments_coach ON cohort_enrollments;
CREATE POLICY cohort_enrollments_coach ON cohort_enrollments FOR SELECT TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id));
DROP POLICY IF EXISTS cohort_enrollments_owner ON cohort_enrollments;
CREATE POLICY cohort_enrollments_owner ON cohort_enrollments FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

-- ---------------------------------------------------------------------------
-- training_sessions / session_coaches: director writes; anyone
-- authenticated may read scheduled sessions (needed to show availability).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS training_sessions_director ON training_sessions;
CREATE POLICY training_sessions_director ON training_sessions FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS training_sessions_read ON training_sessions;
CREATE POLICY training_sessions_read ON training_sessions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS session_coaches_director ON session_coaches;
CREATE POLICY session_coaches_director ON session_coaches FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS session_coaches_read ON session_coaches;
CREATE POLICY session_coaches_read ON session_coaches FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- reservations / waitlist_entries: director full; coach writes for their
-- sessions; parent books/cancels for own athletes; athlete/parent read
-- own athletes' rows. (The API layer re-checks roles in JS too; RLS is
-- the backstop for any direct PostgREST caller.)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS reservations_director ON reservations;
CREATE POLICY reservations_director ON reservations FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS reservations_coach ON reservations;
CREATE POLICY reservations_coach ON reservations FOR ALL TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_session(session_id))
  WITH CHECK (public.app_role() = 'coach' AND public.is_my_session(session_id));
DROP POLICY IF EXISTS reservations_parent_write ON reservations;
CREATE POLICY reservations_parent_write ON reservations FOR INSERT TO authenticated
  WITH CHECK (public.app_role() = 'parent' AND public.is_my_athlete(athlete_id));
DROP POLICY IF EXISTS reservations_parent_update ON reservations;
CREATE POLICY reservations_parent_update ON reservations FOR UPDATE TO authenticated
  USING (public.app_role() = 'parent' AND public.is_my_athlete(athlete_id))
  WITH CHECK (public.app_role() = 'parent' AND public.is_my_athlete(athlete_id));
DROP POLICY IF EXISTS reservations_owner_read ON reservations;
CREATE POLICY reservations_owner_read ON reservations FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id) OR (public.app_role() = 'coach' AND public.is_my_session(session_id)));

DROP POLICY IF EXISTS waitlist_director ON waitlist_entries;
CREATE POLICY waitlist_director ON waitlist_entries FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS waitlist_coach ON waitlist_entries;
CREATE POLICY waitlist_coach ON waitlist_entries FOR ALL TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_session(session_id))
  WITH CHECK (public.app_role() = 'coach' AND public.is_my_session(session_id));
DROP POLICY IF EXISTS waitlist_parent_write ON waitlist_entries;
CREATE POLICY waitlist_parent_write ON waitlist_entries FOR INSERT TO authenticated
  WITH CHECK (public.app_role() = 'parent' AND public.is_my_athlete(athlete_id));
DROP POLICY IF EXISTS waitlist_owner_read ON waitlist_entries;
CREATE POLICY waitlist_owner_read ON waitlist_entries FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id) OR (public.app_role() = 'coach' AND public.is_my_session(session_id)));

-- ---------------------------------------------------------------------------
-- attendance_records: director full; coach writes for their sessions;
-- parent reads own athletes' records.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS attendance_director ON attendance_records;
CREATE POLICY attendance_director ON attendance_records FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS attendance_coach ON attendance_records;
CREATE POLICY attendance_coach ON attendance_records FOR ALL TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_session(session_id))
  WITH CHECK (public.app_role() = 'coach' AND public.is_my_session(session_id));
DROP POLICY IF EXISTS attendance_owner_read ON attendance_records;
CREATE POLICY attendance_owner_read ON attendance_records FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

-- ---------------------------------------------------------------------------
-- operational_audit_events: director full (read +, if ever needed,
-- correct); any authenticated caller may insert (the API/engine audit
-- trail). No update or delete for anyone but the director — audit
-- history is append-only for coaches, parents, and athletes.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS audit_director ON operational_audit_events;
CREATE POLICY audit_director ON operational_audit_events FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS audit_insert ON operational_audit_events;
CREATE POLICY audit_insert ON operational_audit_events FOR INSERT TO authenticated WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Assessment tables (migration 002): director full; definitions readable
-- by anyone authenticated; coach reads results for their athletes;
-- parent/athlete read own athletes' assessment rows.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS adef_director ON assessment_definitions;
CREATE POLICY adef_director ON assessment_definitions FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS adef_read ON assessment_definitions;
CREATE POLICY adef_read ON assessment_definitions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS asess_director ON assessment_sessions;
CREATE POLICY asess_director ON assessment_sessions FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS asess_coach ON assessment_sessions;
CREATE POLICY asess_coach ON assessment_sessions FOR SELECT TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id));
DROP POLICY IF EXISTS asess_owner ON assessment_sessions;
CREATE POLICY asess_owner ON assessment_sessions FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS ares_director ON assessment_results;
CREATE POLICY ares_director ON assessment_results FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS ares_coach ON assessment_results;
CREATE POLICY ares_coach ON assessment_results FOR SELECT TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id));
DROP POLICY IF EXISTS ares_owner ON assessment_results;
CREATE POLICY ares_owner ON assessment_results FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS ader_director ON assessment_derived_records;
CREATE POLICY ader_director ON assessment_derived_records FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS ader_coach ON assessment_derived_records;
CREATE POLICY ader_coach ON assessment_derived_records FOR SELECT TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id));
DROP POLICY IF EXISTS ader_owner ON assessment_derived_records;
CREATE POLICY ader_owner ON assessment_derived_records FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

COMMIT;

-- Rollback (manual, for local dev only — never against production data):
-- DROP POLICY IF EXISTS ... (see statements above, one per policy);
-- DROP FUNCTION IF EXISTS public.is_my_session(UUID);
-- DROP FUNCTION IF EXISTS public.is_my_cohort_athlete(UUID);
-- DROP FUNCTION IF EXISTS public.is_my_athlete(UUID);
-- DROP FUNCTION IF EXISTS public.my_coach_id();
-- DROP FUNCTION IF EXISTS public.app_role();
-- DROP FUNCTION IF EXISTS public.app_user_id();
-- ALTER TABLE athletes DROP COLUMN IF EXISTS app_user_id;
-- ALTER TABLE app_users DROP COLUMN IF EXISTS auth_user_id;
