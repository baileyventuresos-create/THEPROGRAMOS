-- THE PROGRAM OS — §5 live functional checks for migration 004
-- File 1 of 3: SETUP — synthetic test fixtures only
--
-- Run order: 01-setup → 02-checks → 03-cleanup (see server/live-checks/004/README.md).
-- Runs in the Supabase dashboard SQL editor against project TheProgramOS
-- (ref rkgdwqgmldznczikrjip), signed in as the dashboard postgres role.
--
-- WHAT THIS CREATES — synthetic test data ONLY. Every identity is
-- obviously synthetic: fixed UUIDs below, names prefixed TEST, emails
-- on the test-programos.test domain (the same convention checks A/B/C
-- used for 001–003, see docs/SUPABASE_HANDOFF.md). No real athlete,
-- coach, parent, or auth data is created, read, or touched.
--
--   auth.users: 4 rows (TEST coach / parent / athlete A / athlete B)
--     — required because app_users.auth_user_id is a foreign key to
--     auth.users(id); the RLS helpers resolve a role from the
--     impersonated JWT claim, so the link must exist for the checks
--     to exercise real policies. These auth users are never logged
--     in with (encrypted_password is a disabled placeholder).
--   app_users: 4 rows (coach / parent / athlete A / athlete B)
--   guardians: 1 row (TEST Parent, linked to athlete A only)
--   athletes: 2 rows (TEST Athlete A, age 12; TEST Athlete B, age 12)
--   coaches: 1 row (TEST Coach 004, heads cohort TST-A only)
--   locations: 1 row (TST); cohorts: 2 rows (TST-A headed by the
--     TEST coach, TST-B headless); enrollments: A→TST-A, B→TST-B
--   athlete_guardians: A linked to TEST Parent only (B has none)
--
-- SAFETY:
--   * The PRE-FLIGHT block below runs FIRST and RAISES (stopping the
--     script) unless the project is in its verified post-004 state
--     (26 public tables / 15 definitions / 72 policies / 0 app rows)
--     and none of the test UUIDs exist yet. Nothing is created into
--     an unexpected state.
--   * Every INSERT is ON CONFLICT DO NOTHING on its primary key, so
--     re-running setup after a failed run is safe.
--   * This file writes test rows by design. It is for the live project
--     ONLY with Marcus's approval (given for the §5 run, 2026-11-13).
--     It must be followed by 03-cleanup.sql in the same session.
--
-- FIXED TEST IDENTITIES (cleanup deletes exactly these UUIDs):
--   AUTH_COACH  a0000000-0000-4000-8000-000000000001
--   AUTH_PARENT a0000000-0000-4000-8000-000000000002
--   AUTH_A      a0000000-0000-4000-8000-000000000003
--   AUTH_B      a0000000-0000-4000-8000-000000000004
--   APP_COACH   b0000000-0000-4000-8000-000000000001
--   APP_PARENT  b0000000-0000-4000-8000-000000000002
--   APP_A       b0000000-0000-4000-8000-000000000003
--   APP_B       b0000000-0000-4000-8000-000000000004
--   COACH       c0000000-0000-4000-8000-000000000001
--   ATH_A       d0000000-0000-4000-8000-000000000001
--   ATH_B       d0000000-0000-4000-8000-000000000002
--   GUARDIAN    e0000000-0000-4000-8000-000000000001
--   LOCATION    f0000000-0000-4000-8000-000000000001
--   COHORT_A    f0000000-0000-4000-8000-000000000002
--   COHORT_B    f0000000-0000-4000-8000-000000000003

-- ---------------------------------------------------------------------------
-- PRE-FLIGHT: fail fast unless the project is in its verified post-004
-- state and no test UUID exists yet. Raises before anything is created.
-- ---------------------------------------------------------------------------
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
    'a0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000004');
  IF v_tables <> 26 OR v_defs <> 15 OR v_policies <> 72 OR v_rows <> 0 OR v_test_auth <> 0 THEN
    RAISE EXCEPTION 'PRE-FLIGHT FAILED: tables=% definitions=% policies=% app_rows=% test_auth_users=% (expected 26/15/72/0/0). STOP — do not run setup into an unexpected state.',
      v_tables, v_defs, v_policies, v_rows, v_test_auth;
  END IF;
  RAISE NOTICE 'PRE-FLIGHT PASS: 26 tables / 15 definitions / 72 policies / 0 app rows / 0 test auth users.';
END $$;

BEGIN;

-- Auth identities. instance_id is the zero UUID: these rows exist only
-- so app_users.auth_user_id (FK to auth.users) can link to them; the
-- RLS helpers resolve roles from the impersonated JWT claim, not from
-- a real login. Nobody logs in with these rows.
INSERT INTO auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'tst-coach-004@test-programos.test', 'TEST-DISABLED-NO-LOGIN', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'tst-parent-004@test-programos.test', 'TEST-DISABLED-NO-LOGIN', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-0000-0000-000000000000', 'a0000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'tst-athlete-a-004@test-programos.test', 'TEST-DISABLED-NO-LOGIN', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('00000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'tst-athlete-b-004@test-programos.test', 'TEST-DISABLED-NO-LOGIN', now(), now(), now(), '{}'::jsonb, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- App roles. The coach row is the head coach of cohort TST-A only;
-- the parent is guardian of athlete A only; each athlete links to its
-- own app_users row (athletes.app_user_id) for the athlete-self policy.
INSERT INTO app_users (id, email, display_name, role, auth_user_id) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'tst-coach-004@test-programos.test', 'TEST Coach 004', 'coach', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000002', 'tst-parent-004@test-programos.test', 'TEST Parent 004', 'parent', 'a0000000-0000-4000-8000-000000000002'),
  ('b0000000-0000-4000-8000-000000000003', 'tst-athlete-a-004@test-programos.test', 'TEST Athlete A 004', 'athlete', 'a0000000-0000-4000-8000-000000000003'),
  ('b0000000-0000-4000-8000-000000000004', 'tst-athlete-b-004@test-programos.test', 'TEST Athlete B 004', 'athlete', 'a0000000-0000-4000-8000-000000000004')
ON CONFLICT (id) DO NOTHING;

INSERT INTO guardians (id, user_id, first_name, last_name, phone, email) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 'TEST', 'Parent', NULL, 'tst-parent-004@test-programos.test')
ON CONFLICT (id) DO NOTHING;

-- Athletes are 12 years old (inside the 001 CHECK age_years 5–19;
-- migration 005, which relaxes the max, is NOT applied). dob is a
-- synthetic date matching age 12. No real personal data.
INSERT INTO athletes (id, first_name, last_name, dob, age_years, sports, restrictions) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'TEST-A', 'Athlete', '2014-01-01', 12, '{}', '{}'),
  ('d0000000-0000-4000-8000-000000000002', 'TEST-B', 'Athlete', '2014-01-01', 12, '{}', '{}')
ON CONFLICT (id) DO NOTHING;

-- Link each athlete to its own app_users row (athlete-self policy).
UPDATE athletes SET app_user_id = 'b0000000-0000-4000-8000-000000000003'
  WHERE id = 'd0000000-0000-4000-8000-000000000001';
UPDATE athletes SET app_user_id = 'b0000000-0000-4000-8000-000000000004'
  WHERE id = 'd0000000-0000-4000-8000-000000000002';

INSERT INTO athlete_guardians (athlete_id, guardian_id, relationship, is_primary) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'parent', true)
ON CONFLICT (athlete_id, guardian_id) DO NOTHING;

INSERT INTO locations (id, code, name, facility, arrangement) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'TST', 'TEST Location', 'TEST Facility', 'TEST')
ON CONFLICT (id) DO NOTHING;

INSERT INTO coaches (id, user_id, name, role, home_location_ids, status) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'TEST Coach 004', 'coach', '{}', 'active')
ON CONFLICT (id) DO NOTHING;

-- TST-A is headed by the TEST coach; TST-B is headless on purpose, so
-- the coach-scope check proves cohort membership, not "athlete has any
-- coach at all". Same age band (12–14) in both, so the ONLY difference
-- between athlete A and athlete B is which cohort they belong to.
INSERT INTO cohorts (id, code, location_id, name, age_min, age_max, days, start_time, enrollment_cap, format, emphasis, head_coach_id) VALUES
  ('f0000000-0000-4000-8000-000000000002', 'TST-A', 'f0000000-0000-4000-8000-000000000001', 'TEST Ages 12-14 A', 12, 14, '{}', '4:30 PM', 10, 'Group', '{}', 'c0000000-0000-4000-8000-000000000001'),
  ('f0000000-0000-4000-8000-000000000003', 'TST-B', 'f0000000-0000-4000-8000-000000000001', 'TEST Ages 12-14 B', 12, 14, '{}', '4:30 PM', 10, 'Group', '{}', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO cohort_enrollments (athlete_id, cohort_id, enrolled_on, status) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002', CURRENT_DATE, 'enrolled'),
  ('d0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003', CURRENT_DATE, 'enrolled')
ON CONFLICT (athlete_id, cohort_id) DO NOTHING;

COMMIT;

-- Verification: what setup created (expected: 4 / 4 / 2 / 2 / 1 / 1 / 2 / 1).
SELECT 'auth.users test rows' AS what, count(*) AS n FROM auth.users WHERE id IN (
  'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004');
SELECT 'app_users test rows' AS what, count(*) AS n FROM app_users WHERE id IN (
  'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
  'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000004');
SELECT 'athletes test rows' AS what, count(*) AS n FROM athletes WHERE id IN (
  'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
SELECT 'cohorts test rows' AS what, count(*) AS n FROM cohorts WHERE id IN (
  'f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000003');
SELECT 'enrollments test rows' AS what, count(*) AS n FROM cohort_enrollments
  WHERE athlete_id IN ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
SELECT 'guardian links test rows' AS what, count(*) AS n FROM athlete_guardians
  WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
