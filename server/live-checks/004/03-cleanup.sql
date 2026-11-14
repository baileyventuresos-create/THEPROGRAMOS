-- THE PROGRAM OS — §5 live functional checks for migration 004
-- File 3 of 3: CLEANUP — deletes EVERY test row created by 01-setup
-- and 02-checks, then verifies the project back to its pre-check state.
--
-- Run order: 01-setup → 02-checks → 03-cleanup (see
-- server/live-checks/004/README.md). Run it EVEN IF a check failed
-- midway — every DELETE targets the documented fixed synthetic UUIDs
-- only, so it is safe at any point and safe to run twice.
--
-- SAFETY:
--   * Deletes by fixed synthetic UUIDs / test identifiers ONLY — never
--     by "delete everything" and never by a range. If a row does not
--     exist (check failed, or cleanup already ran), the DELETE matches
--     0 rows and moves on.
--   * No DROP / TRUNCATE / DELETE without a WHERE in this file.
--   * No transaction wrapper and no RAISE EXCEPTION: the verification
--     at the end reports PASS/FAIL via NOTICE and SELECTs, and must
--     never roll back deletes that already happened.
--   * Order is dependency order (children first) so RESTRICT foreign
--     keys cannot block a delete: results/derived → sessions →
--     drafts → plans → schedules/deferrals (none expected) →
--     enrollments → guardian links → athletes → guardians →
--     coaches → cohorts → locations → app_users → auth.users.
--
-- EXPECTED FINAL STATE (identical to the pre-check state verified by
-- 01-setup's pre-flight): 26 public tables / 15 assessment
-- definitions / 72 public RLS policies / 0 rows in every application
-- table / 0 test auth.users rows. The verification queries below
-- report that state; they do not delete anything else.

-- ---------------------------------------------------------------------------
-- 1. Assessment data created by the checks (Check 1, 2, 5, 4).
-- ---------------------------------------------------------------------------
DELETE FROM assessment_results
  WHERE id = '20000000-0000-4000-8000-000000000001';
DELETE FROM assessment_derived_records
  WHERE id = '30000000-0000-4000-8000-000000000001';
DELETE FROM assessment_sessions
  WHERE id IN ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003');
DELETE FROM assessment_drafts
  WHERE id = '40000000-0000-4000-8000-000000000001';
DELETE FROM development_plans
  WHERE id = '50000000-0000-4000-8000-000000000001';
-- None were created, but delete by athlete if any were (belt and braces).
DELETE FROM assessment_schedules
  WHERE athlete_id IN ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
DELETE FROM assessment_deferrals
  WHERE athlete_id IN ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');

-- ---------------------------------------------------------------------------
-- 2. Fixtures created by setup (enrollments → links → athletes →
--    guardians → coaches → cohorts → locations).
-- ---------------------------------------------------------------------------
DELETE FROM cohort_enrollments
  WHERE athlete_id IN ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
DELETE FROM athlete_guardians
  WHERE athlete_id IN ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
DELETE FROM athletes
  WHERE id IN ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
DELETE FROM guardians
  WHERE id = 'e0000000-0000-4000-8000-000000000001';
DELETE FROM coaches
  WHERE id = 'c0000000-0000-4000-8000-000000000001';
DELETE FROM cohorts
  WHERE id IN ('f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003');
DELETE FROM locations
  WHERE id = 'f0000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- 3. Identities (app_users first, then auth.users — the FK is
--    auth_user_id → auth.users, so app_users must go first... in fact
--    the FK is SET NULL on delete, so either order works; this order
--    is the clean one).
-- ---------------------------------------------------------------------------
DELETE FROM app_users
  WHERE id IN ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
               'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000004');
DELETE FROM auth.users
  WHERE id IN ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
               'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004');

-- ---------------------------------------------------------------------------
-- 4. VERIFICATION — the project must be back to its pre-check state.
--    Expected: 26 / 15 / 72 / 0 / 0. Report only; nothing deleted here.
-- ---------------------------------------------------------------------------
SELECT count(*) AS public_tables FROM information_schema.tables WHERE table_schema = 'public';
SELECT count(*) AS assessment_definitions FROM assessment_definitions;
SELECT count(*) AS public_policies FROM pg_policies WHERE schemaname = 'public';
SELECT count(*) AS test_auth_users_remaining FROM auth.users WHERE id IN (
  'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004');

-- Per-table row counts for every application table — all must be 0
-- except assessment_definitions (seeded by migration 004, counted above).
SELECT 'athletes' AS tbl, count(*) AS rows FROM athletes
UNION ALL SELECT 'app_users', count(*) FROM app_users
UNION ALL SELECT 'guardians', count(*) FROM guardians
UNION ALL SELECT 'athlete_guardians', count(*) FROM athlete_guardians
UNION ALL SELECT 'coaches', count(*) FROM coaches
UNION ALL SELECT 'cohorts', count(*) FROM cohorts
UNION ALL SELECT 'cohort_enrollments', count(*) FROM cohort_enrollments
UNION ALL SELECT 'locations', count(*) FROM locations
UNION ALL SELECT 'memberships', count(*) FROM memberships
UNION ALL SELECT 'training_sessions', count(*) FROM training_sessions
UNION ALL SELECT 'session_coaches', count(*) FROM session_coaches
UNION ALL SELECT 'reservations', count(*) FROM reservations
UNION ALL SELECT 'waitlist_entries', count(*) FROM waitlist_entries
UNION ALL SELECT 'attendance_records', count(*) FROM attendance_records
UNION ALL SELECT 'operational_audit_events', count(*) FROM operational_audit_events
UNION ALL SELECT 'assessment_sessions', count(*) FROM assessment_sessions
UNION ALL SELECT 'assessment_results', count(*) FROM assessment_results
UNION ALL SELECT 'assessment_derived_records', count(*) FROM assessment_derived_records
UNION ALL SELECT 'assessment_schedules', count(*) FROM assessment_schedules
UNION ALL SELECT 'assessment_deferrals', count(*) FROM assessment_deferrals
UNION ALL SELECT 'assessment_drafts', count(*) FROM assessment_drafts
UNION ALL SELECT 'development_plans', count(*) FROM development_plans
UNION ALL SELECT 'coach_availability', count(*) FROM coach_availability
UNION ALL SELECT 'training_spaces', count(*) FROM training_spaces
UNION ALL SELECT 'session_templates', count(*) FROM session_templates
ORDER BY tbl;

DO $$
DECLARE
  v_tables INT;
  v_defs INT;
  v_policies INT;
  v_rows INT;
  v_test_auth INT;
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
    'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004');
  IF v_tables = 26 AND v_defs = 15 AND v_policies = 72 AND v_rows = 0 AND v_test_auth = 0 THEN
    RAISE NOTICE 'CLEANUP PASS: back to 26 tables / 15 definitions / 72 policies / 0 app rows / 0 test auth users. No test data remains.';
  ELSE
    RAISE NOTICE 'CLEANUP FAIL: tables=% definitions=% policies=% app_rows=% test_auth_users=% (expected 26/15/72/0/0). Inspect the per-table counts above and delete the remaining test rows by their fixed UUIDs.',
      v_tables, v_defs, v_policies, v_rows, v_test_auth;
  END IF;
END $$;
