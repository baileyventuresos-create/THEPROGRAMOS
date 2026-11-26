-- THE PROGRAM OS — SaaS Expansion (Marcus mission 2026-11-20)
-- Migration 007: training assignments & completions (remote training).
--
-- STATUS: NOT APPLIED. Branch-only; applying to Supabase project
-- TheProgramOS (ref rkgdwqgmldznczikrjip) is a separate owner
-- decision. Do NOT apply without that approval. Design:
-- docs/SAAS_ARCHITECTURE.md §2.2 (migration 007).
--
-- Assignments reference the EXISTING 130-game library by TP2 ID
-- (TEXT, validated server-side against the static library list) —
-- there is no games table and this migration does not create one.
-- No new drill library. Dose/build are the coach's programming,
-- recorded as data (the suitability review's levers). Safety Review
-- / Retired games are rejected by the API at assignment time.
-- Persistent history is a read model over existing tables plus
-- training_completions — nothing is copied.
--
-- Postgres 15 compatible, additive only, idempotent.

BEGIN;

-- A coach-assigned unit of remote training.
CREATE TABLE IF NOT EXISTS training_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  development_plan_id UUID REFERENCES development_plans(id) ON DELETE SET NULL,  -- optional link to the gated plan
  title TEXT NOT NULL,
  instructions TEXT,
  game_ids TEXT[] NOT NULL DEFAULT '{}',   -- TP2-xxx ids from the 130-game library
  build TEXT CHECK (build IS NULL OR build IN ('LEARN','COMPETE','PRESSURE','CHAOS')),
  dose JSONB,  -- coach-set programming: {rounds, workSec, restSec, distance, reps, note}
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','completed','skipped','cancelled')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT  -- auth UID of the actor (audit convention)
);
CREATE INDEX IF NOT EXISTS idx_assign_athlete ON training_assignments (athlete_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_assign_coach ON training_assignments (coach_id, status);
CREATE INDEX IF NOT EXISTS idx_assign_org ON training_assignments (organization_id, status);

-- Athlete-recorded completion. Append-only history; never edited in
-- place (the coach may annotate via coach_note — a separate column;
-- the athlete's record is untouched).
CREATE TABLE IF NOT EXISTS training_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES training_assignments(id) ON DELETE RESTRICT,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_min INT,
  effort_rpe INT CHECK (effort_rpe IS NULL OR effort_rpe BETWEEN 1 AND 10),
  athlete_note TEXT,
  coach_note TEXT,
  UNIQUE (assignment_id)  -- one completion per assignment; re-dos are new assignments
);
CREATE INDEX IF NOT EXISTS idx_completion_athlete ON training_completions (athlete_id, completed_at);

-- ---------------------------------------------------------------------------
-- RLS. Additive policies only; no anon policies.
-- ---------------------------------------------------------------------------
ALTER TABLE training_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assign_director ON training_assignments;
CREATE POLICY assign_director ON training_assignments FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS assign_coach ON training_assignments;
CREATE POLICY assign_coach ON training_assignments FOR ALL TO authenticated
  USING (coach_id = public.my_coach_id()) WITH CHECK (coach_id = public.my_coach_id());
DROP POLICY IF EXISTS assign_org_admin ON training_assignments;
CREATE POLICY assign_org_admin ON training_assignments FOR SELECT TO authenticated
  USING (public.is_my_org_admin(organization_id));
DROP POLICY IF EXISTS assign_athlete_read ON training_assignments;
CREATE POLICY assign_athlete_read ON training_assignments FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS completion_director ON training_completions;
CREATE POLICY completion_director ON training_completions FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS completion_athlete ON training_completions;
CREATE POLICY completion_athlete ON training_completions FOR ALL TO authenticated
  USING (public.is_my_athlete(athlete_id)) WITH CHECK (public.is_my_athlete(athlete_id));
DROP POLICY IF EXISTS completion_coach_read ON training_completions;
CREATE POLICY completion_coach_read ON training_completions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.training_assignments a
    WHERE a.id = training_completions.assignment_id
      AND (a.coach_id = public.my_coach_id()
           OR public.is_my_org_admin(a.organization_id))
  ));

COMMIT;

-- Rollback (manual, local dev only — never against production data):
-- DROP TABLE IF EXISTS training_completions;
-- DROP TABLE IF EXISTS training_assignments;
