-- THE PROGRAM OS — apply migration 005
-- File 1 of 2: PRE-CHECK — verify the live project is in its expected
-- post-004 state and that 005 has NOT been applied yet. Fail fast:
-- any mismatch RAISES and stops the run before anything changes.
--
-- Run order: 00-precheck → (paste migration 005 verbatim, run it) →
-- 01-verify-005. Live project only: TheProgramOS
-- (ref rkgdwqgmldznczikrjip), Postgres 15.8.1.50.
-- Marcus approved applying 005 on 2026-11-13.
--
-- Expected pre-apply state (verified 2026-11-13, §5 run):
--   26 public tables / 15 assessment definitions / 72 public RLS
--   policies / 0 rows in every application table / 0 test auth users
--   004 tables present; 003 RLS helpers present; the age CHECK still
--   carries the 19 maximum; modified/capped columns ABSENT.

DO $$
DECLARE
  v_tables INT;
  v_defs INT;
  v_policies INT;
  v_rows INT;
  v_test_auth INT;
  v_004_tables INT;
  v_helpers INT;
  v_old_check INT;
  v_new_cols INT;
  v_idempotency_idx INT;
BEGIN
  SELECT count(*) INTO v_tables FROM information_schema.tables WHERE table_schema = 'public';
  SELECT count(*) INTO v_defs FROM assessment_definitions;
  SELECT count(*) INTO v_policies FROM pg_policies WHERE schemaname = 'public';
  SELECT (
    (SELECT count(*) FROM athletes) + (SELECT count(*) FROM app_users) +
    (SELECT count(*) FROM guardians) + (SELECT count(*) FROM athlete_guardians) +
    (SELECT count(*) FROM coaches) + (SELECT count(*) FROM cohorts) +
    (SELECT count(*) FROM cohort_enrollments) + (SELECT count(*) FROM locations) +
    (SELECT count(*) FROM memberships) + (SELECT count(*) FROM training_sessions) +
    (SELECT count(*) FROM session_coaches) + (SELECT count(*) FROM reservations) +
    (SELECT count(*) FROM waitlist_entries) + (SELECT count(*) FROM attendance_records) +
    (SELECT count(*) FROM operational_audit_events) +
    (SELECT count(*) FROM assessment_sessions) + (SELECT count(*) FROM assessment_results) +
    (SELECT count(*) FROM assessment_derived_records) +
    (SELECT count(*) FROM assessment_schedules) + (SELECT count(*) FROM assessment_deferrals) +
    (SELECT count(*) FROM assessment_drafts) + (SELECT count(*) FROM development_plans) +
    (SELECT count(*) FROM coach_availability) + (SELECT count(*) FROM training_spaces) +
    (SELECT count(*) FROM session_templates)
  ) INTO v_rows;
  SELECT count(*) INTO v_test_auth FROM auth.users WHERE id IN (
    'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004',
    'a5000000-0000-4000-8000-000000000001');
  -- The four 004 tables must exist.
  SELECT count(*) INTO v_004_tables FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN (
      'assessment_schedules', 'assessment_deferrals',
      'assessment_drafts', 'development_plans');
  -- The 003 RLS helpers must exist.
  SELECT count(*) INTO v_helpers FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'app_role', 'app_user_id', 'is_my_athlete', 'is_my_cohort_athlete');
  -- The OLD age CHECK (19 maximum) must still be present.
  SELECT count(*) INTO v_old_check FROM pg_constraint
    WHERE conrelid = 'public.athletes'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) LIKE '%BETWEEN 5 AND 19%'
        OR (pg_get_constraintdef(oid) LIKE '%age_years%'
            AND pg_get_constraintdef(oid) LIKE '%<= 19%'));
  -- The new columns must NOT exist yet (005 not applied).
  SELECT count(*) INTO v_new_cols FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'assessment_results'
      AND column_name IN ('modified', 'capped');
  -- The 004 idempotency index must exist.
  SELECT count(*) INTO v_idempotency_idx FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uq_asess_idempotency';

  IF v_tables <> 26 OR v_defs <> 15 OR v_policies <> 72 OR v_rows <> 0 OR v_test_auth <> 0
     OR v_004_tables <> 4 OR v_helpers <> 4 OR v_old_check <> 1
     OR v_new_cols <> 0 OR v_idempotency_idx <> 1 THEN
    RAISE EXCEPTION 'PRE-CHECK FAILED: tables=% defs=% policies=% app_rows=% test_auth=% 004_tables=% helpers=% old_age_check=% new_cols=% idempotency_idx=% (expected 26/15/72/0/0/4/4/1/0/1). STOP — do not apply 005 into an unexpected state.',
      v_tables, v_defs, v_policies, v_rows, v_test_auth, v_004_tables, v_helpers, v_old_check, v_new_cols, v_idempotency_idx;
  END IF;
  RAISE NOTICE 'PRE-CHECK PASS: post-004 state intact (26/15/72/0), 004 tables + 003 helpers present, old age CHECK (19 max) still in place, modified/capped absent, idempotency index present.';
END $$;
