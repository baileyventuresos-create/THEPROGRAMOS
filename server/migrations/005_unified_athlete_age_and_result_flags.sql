-- THE PROGRAM OS — Unified Athlete System (no youth/adult divisions)
-- Migration 005: remove the 19-year-old athlete maximum; add the
-- modified/capped assessment-result flags
--
-- STATUS: NOT APPLIED. Written and reviewed only; applying it to
-- Supabase project TheProgramOS (ref rkgdwqgmldznczikrjip) is a
-- separate owner decision. Do NOT apply without that approval.
--
-- Marcus correction 2026-11-13: The Program OS serves athletes of
-- all ages under ONE unified athlete system. Age is an athlete
-- attribute, not a division. There are no youth/adult divisions, no
-- new membership categories, and no pricing change ($149/month
-- unchanged). The 19-year-old maximum in migration 001 was arbitrary
-- and is removed by this migration.
--
-- Postgres 15 compatible (the live project runs 15.8.1.50). Additive
-- only: this migration relaxes one CHECK and adds two columns. No
-- new tables, no policy changes, no seed data, no rows deleted or
-- rewritten, no data loss. Idempotent where practical (IF NOT
-- EXISTS / guarded re-issue), so a re-run is safe.
--
-- Ordering: 005 does not depend on 004 — it touches only 001's
-- athletes table and 002's assessment_results table — and applies in
-- order after it: 001 → 002 → 003 → 004 → 005.
--
-- What this changes (and nothing else):
-- * athletes.age_years: the maximum of 19 is removed. The floor of
--   5 is KEPT as a data-sanity guard: it is the minimum from the
--   original 001 CHECK, the youngest cohort starts at 8, and a floor
--   guards against negative or zero ages. No upper bound remains —
--   a 20-, 48-, or 65-year-old athlete is stored the same way as a
--   12-year-old, through the same profiles, assessments, and
--   training workflows. Cohort age bands (cohorts.age_min/max) are
--   UNCHANGED: they are per-cohort eligibility, not divisions.
-- * assessment_results.modified / .capped: BOOLEAN NOT NULL DEFAULT
--   FALSE. server/assessment-store.js already records these flags
--   on every result row (a modified result used an age-appropriate
--   alternative or accommodation; a capped result hit a protocol
--   cap), and the Edge Function scaffold's store.ts already maps
--   them — but migration 002's table has no such columns, so
--   inserts/selects touching assessment_results fail at PostgREST
--   until these columns exist. Existing rows (none live; the
--   project holds 0 rows) get FALSE. The flags are never stuffed
--   into attempts JSONB: attempts stay the preserved numeric
--   attempts.

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Remove the 19-year-old maximum from athletes.age_years
-- ---------------------------------------------------------------------------
-- The 001 CHECK was written inline, so Postgres auto-named it
-- (athletes_age_years_check) and stored its definition with BETWEEN
-- expanded to >= / <=. Match by definition, not by name, so this
-- works regardless of the stored name; match the old range form in
-- either spelling. Re-runs find nothing to drop (the new CHECK's
-- definition contains no upper bound) and skip the re-add.
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.athletes'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) LIKE '%BETWEEN 5 AND 19%'
        OR (pg_get_constraintdef(oid) LIKE '%age_years%'
            AND pg_get_constraintdef(oid) LIKE '%<= 19%'))
  LOOP
    EXECUTE format('ALTER TABLE public.athletes DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.athletes'::regclass
      AND conname = 'athletes_age_years_check'
  ) THEN
    ALTER TABLE public.athletes
      ADD CONSTRAINT athletes_age_years_check CHECK (age_years >= 5);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- B. modified / capped flags on assessment_results
-- ---------------------------------------------------------------------------
ALTER TABLE IF EXISTS assessment_results
  ADD COLUMN IF NOT EXISTS modified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS assessment_results
  ADD COLUMN IF NOT EXISTS capped BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;

-- Rollback (manual, for local dev only — never against production data):
-- ALTER TABLE assessment_results DROP COLUMN IF EXISTS modified;
-- ALTER TABLE assessment_results DROP COLUMN IF EXISTS capped;
-- (The relaxed age CHECK is left in place on rollback; re-applying
--  005 is idempotent.)
