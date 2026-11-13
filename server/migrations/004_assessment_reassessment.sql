-- THE PROGRAM OS — Universal Athletic Assessment & 4-Week Reassessment
-- Migration 004: GAA battery definitions, reassessment schedule state,
-- coach-approved deferrals/exclusions/modifications, development-plan
-- gate, assessment-session idempotency
--
-- STATUS: NOT APPLIED. Written and reviewed only; applying it to
-- Supabase project TheProgramOS (ref rkgdwqgmldznczikrjip) is a
-- separate owner decision. Do NOT apply without that approval.
--
-- Postgres 15 compatible (the live project runs 15.8.1.50). Idempotent
-- where practical: IF NOT EXISTS / ON CONFLICT DO NOTHING /
-- DROP POLICY IF EXISTS. Safe to re-run.
--
-- What this adds on top of migrations 001 + 002 + 003:
-- * Five assessment definitions for the universal General Athletic
--   Assessment (GAA v1, protocol server/assessment-battery.js):
--   5-10-5-shuttle, single-leg-balance-r/l, 6min-walk-run (measured)
--   and movement-assessment (observation-only). The existing 10 V1
--   definitions are untouched.
-- * assessment_definitions.kind ('measured' | 'observation'): the
--   movement assessment has no numeric result, so its direction is
--   NULL and its aggregation is 'none'. The direction/aggregation
--   CHECKs are re-issued to allow that; measured definitions are
--   unchanged (direction still required).
-- * assessment_schedules: one derived row per athlete + battery —
--   last completed GAA session, next due date (last + 28 days),
--   status. Written by the reassessment service when a session is
--   recorded or deferred; read by coach/athlete reminders.
-- * assessment_deferrals: coach-approved deferrals, exclusions, and
--   modifications (test- or battery-scoped). A deferral needs a
--   reason and an approving coach; it never marks an assessment
--   complete.
-- * development_plans: minimal plan records so the baseline gate is
--   enforceable in the database, not just in code — a finalized plan
--   MUST carry a baseline_session_id (CHECK). Plans are drafts until
--   the baseline is complete (or an explicit, recorded coach override
--   is applied by the service layer; see server/baseline-gating.js).
-- * assessment_sessions.idempotency_key + a partial unique index:
--   a retried recording with the same key for the same athlete
--   cannot create a duplicate completed assessment.
-- * RLS enabled on every new table, with policies mirroring
--   migration 003 (director full; coach scoped to their athletes;
--   parent/athlete read-only own rows). Deferrals and schedules are
--   coach-operated workflow state, so coaches may also insert/update
--   them (role-checked); the service layer enforces the business
--   rules (readiness, future deferredUntil, coach approval).
-- * No existing table is altered except assessment_definitions (two
--   additive columns/CHECK relaxations above) and assessment_sessions
--   (one nullable column + index). No data is deleted, no history is
--   rewritten, no population norms or medical thresholds are added.

BEGIN;

-- ---------------------------------------------------------------------------
-- assessment_definitions: kind + observation support
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS assessment_definitions
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'measured'
    CHECK (kind IN ('measured', 'observation'));

-- The inline CHECKs from migration 002 were auto-named; drop and
-- re-issue them so an observation definition may have NULL direction
-- and aggregation 'none', while measured definitions still require
-- a direction.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_definitions_direction_check') THEN
    ALTER TABLE assessment_definitions DROP CONSTRAINT assessment_definitions_direction_check;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assessment_definitions_aggregation_check') THEN
    ALTER TABLE assessment_definitions DROP CONSTRAINT assessment_definitions_aggregation_check;
  END IF;
END $$;

ALTER TABLE IF EXISTS assessment_definitions
  ALTER COLUMN direction DROP NOT NULL;
ALTER TABLE IF EXISTS assessment_definitions
  ADD CONSTRAINT assessment_definitions_direction_check
    CHECK (direction IS NULL OR direction IN ('higher', 'lower'));
ALTER TABLE IF EXISTS assessment_definitions
  ADD CONSTRAINT assessment_definitions_aggregation_check
    CHECK (aggregation IN ('best', 'mean', 'median', 'none'));
ALTER TABLE IF EXISTS assessment_definitions
  ADD CONSTRAINT assessment_definitions_kind_direction_check
    CHECK ((kind = 'observation' AND direction IS NULL)
        OR (kind = 'measured' AND direction IS NOT NULL));

-- Seed the GAA definitions. The engine (assessment-engine.js v1.1.0)
-- is the source of truth; this seed must match it.
INSERT INTO assessment_definitions
  (id, name, domain, unit, direction, attempt_count, aggregation, module, pair_id, side, retest_days, kind) VALUES
  ('5-10-5-shuttle', '5-10-5 Shuttle', 'agility', 'sec', 'lower', 2, 'best', NULL, NULL, NULL, 28, 'measured'),
  ('single-leg-balance-r', 'Single-Leg Balance — Right', 'balance', 'sec', 'higher', 1, 'best', NULL, 'single-leg-balance', 'right', 28, 'measured'),
  ('single-leg-balance-l', 'Single-Leg Balance — Left', 'balance', 'sec', 'higher', 1, 'best', NULL, 'single-leg-balance', 'left', 28, 'measured'),
  ('6min-walk-run', '6-Minute Walk/Run', 'cardiovascular', 'm', 'higher', 1, 'best', NULL, NULL, NULL, 28, 'measured'),
  ('movement-assessment', 'Movement Assessment', 'mobility_movement_control', 'observations', NULL, 1, 'none', NULL, NULL, NULL, 28, 'observation')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- assessment_schedules: derived reassessment state, one row per athlete
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  battery TEXT NOT NULL DEFAULT 'generalAthleticAssessment',
  last_completed_at TIMESTAMPTZ, -- NULL until the first completed GAA session
  next_due_at TIMESTAMPTZ, -- last_completed_at + 28 days; NULL until then
  status TEXT NOT NULL DEFAULT 'never-assessed'
    CHECK (status IN ('never-assessed', 'not-due', 'approaching', 'due', 'overdue', 'deferred')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (athlete_id, battery)
);
CREATE INDEX IF NOT EXISTS idx_asched_due ON assessment_schedules (next_due_at) WHERE status IN ('approaching', 'due', 'overdue');

-- ---------------------------------------------------------------------------
-- assessment_deferrals: coach-approved exceptions (never completions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assessment_deferrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  battery TEXT NOT NULL DEFAULT 'generalAthleticAssessment',
  assessment_id TEXT REFERENCES assessment_definitions(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK (scope IN ('test', 'battery')),
  kind TEXT NOT NULL CHECK (kind IN ('deferral', 'exclusion', 'modification')),
  deferred_until TIMESTAMPTZ, -- required for kind='deferral'; NULL otherwise
  reason TEXT NOT NULL, -- why the test/battery is deferred, excluded, or modified
  details JSONB, -- how the test was modified, if kind='modification'
  approved_by UUID REFERENCES coaches(id) ON DELETE SET NULL, -- coach approval is required
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope = 'battery' AND assessment_id IS NULL)
      OR (scope = 'test' AND assessment_id IS NOT NULL)),
  CHECK ((kind = 'deferral' AND deferred_until IS NOT NULL)
      OR (kind <> 'deferral'))
);
CREATE INDEX IF NOT EXISTS idx_adef_athlete ON assessment_deferrals (athlete_id, battery);

-- ---------------------------------------------------------------------------
-- development_plans: minimal plan records; the baseline gate lives here
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS development_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
  baseline_session_id UUID REFERENCES assessment_sessions(id) ON DELETE RESTRICT,
  finalized_by UUID REFERENCES coaches(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  override_reason TEXT, -- set only when finalized by explicit recorded coach override
  override_approved_by UUID REFERENCES coaches(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A finalized plan MUST name the baseline session it was finalized on.
  CHECK (status <> 'finalized' OR baseline_session_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_dplan_athlete ON development_plans (athlete_id, status);

-- ---------------------------------------------------------------------------
-- assessment_sessions: idempotency key (retries cannot duplicate a
-- completed assessment)
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS assessment_sessions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_asess_idempotency
  ON assessment_sessions (athlete_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS (mirrors migration 003: director full; coach scoped; owner read)
-- ---------------------------------------------------------------------------
ALTER TABLE assessment_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_deferrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asched_director ON assessment_schedules;
CREATE POLICY asched_director ON assessment_schedules FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS asched_coach ON assessment_schedules;
CREATE POLICY asched_coach ON assessment_schedules FOR ALL TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id))
  WITH CHECK (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id));
DROP POLICY IF EXISTS asched_owner ON assessment_schedules;
CREATE POLICY asched_owner ON assessment_schedules FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS adefr_director ON assessment_deferrals;
CREATE POLICY adefr_director ON assessment_deferrals FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS adefr_coach ON assessment_deferrals;
CREATE POLICY adefr_coach ON assessment_deferrals FOR ALL TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id))
  WITH CHECK (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id));
DROP POLICY IF EXISTS adefr_owner ON assessment_deferrals;
CREATE POLICY adefr_owner ON assessment_deferrals FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS dplan_director ON development_plans;
CREATE POLICY dplan_director ON development_plans FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS dplan_coach ON development_plans;
CREATE POLICY dplan_coach ON development_plans FOR ALL TO authenticated
  USING (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id))
  WITH CHECK (public.app_role() = 'coach' AND public.is_my_cohort_athlete(athlete_id));
DROP POLICY IF EXISTS dplan_owner ON development_plans;
CREATE POLICY dplan_owner ON development_plans FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

COMMIT;

-- Rollback (manual, for local dev only — never against production data):
-- DROP POLICY IF EXISTS asched_director ON assessment_schedules;
-- DROP POLICY IF EXISTS asched_coach ON assessment_schedules;
-- DROP POLICY IF EXISTS asched_owner ON assessment_schedules;
-- DROP POLICY IF EXISTS adefr_director ON assessment_deferrals;
-- DROP POLICY IF EXISTS adefr_coach ON assessment_deferrals;
-- DROP POLICY IF EXISTS adefr_owner ON assessment_deferrals;
-- DROP POLICY IF EXISTS dplan_director ON development_plans;
-- DROP POLICY IF EXISTS dplan_coach ON development_plans;
-- DROP POLICY IF EXISTS dplan_owner ON development_plans;
-- DROP INDEX IF EXISTS uq_asess_idempotency;
-- ALTER TABLE assessment_sessions DROP COLUMN IF EXISTS idempotency_key;
-- DROP TABLE IF EXISTS development_plans;
-- DROP TABLE IF EXISTS assessment_deferrals;
-- DROP TABLE IF EXISTS assessment_schedules;
-- DELETE FROM assessment_definitions WHERE id IN ('5-10-5-shuttle','single-leg-balance-r','single-leg-balance-l','6min-walk-run','movement-assessment');
-- (The kind column and CHECK relaxations on assessment_definitions are
--  left in place on rollback; re-applying 004 is idempotent.)
