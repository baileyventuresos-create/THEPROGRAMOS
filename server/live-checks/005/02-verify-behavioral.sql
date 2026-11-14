-- THE PROGRAM OS — apply migration 005
-- File 3 of 3: BEHAVIORAL RE-CHECK — closes the evidence gap left by
-- 01-verify-005.sql. That script ran to completion with no error, but
-- the dashboard SQL editor shows only the LAST result set of a
-- multi-statement run, so its per-check summary was never visible —
-- and because its checks record FAILs instead of aborting, "ran
-- without error" alone does not prove they passed.
--
-- This script re-runs ONLY the behavioral checks (V5–V7) in a form
-- that produces visible evidence:
--   * every check ASSERTS into a temp results table (same as before),
--   * the summary SELECT is the LAST statement in the file, so it IS
--     the result set the editor displays,
--   * cleanup runs BEFORE the summary, and the final-state check is
--     recorded as a verdict row inside the summary itself.
-- A visible summary of all PASS rows is the proof. Any FAIL row is
-- visible in the same grid.
--
-- Live project only: TheProgramOS (ref rkgdwqgmldznczikrjip).
-- Synthetic test rows only (same fixed UUIDs as 01-verify-005.sql,
-- already cleaned by that run); deleted by this script. Safe to run
-- twice. No schema changes in this file.

DROP TABLE IF EXISTS _tst005b_results;
CREATE TEMP TABLE _tst005b_results (
  check_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL')),
  detail TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fixtures (same as 01-verify-005.sql V7; re-created, then deleted).
INSERT INTO auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('00000000-0000-0000-0000-000000000000', 'a5000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'tst-coach-005@test-programos.test', 'TEST-DISABLED-NO-LOGIN', now(), now(), now(), '{}'::jsonb, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
INSERT INTO app_users (id, email, display_name, role, auth_user_id) VALUES
  ('b5000000-0000-4000-8000-000000000001', 'tst-coach-005@test-programos.test', 'TEST Coach 005', 'coach', 'a5000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;
INSERT INTO coaches (id, user_id, name, role, home_location_ids, status) VALUES
  ('c5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 'TEST Coach 005', 'coach', '{}', 'active')
ON CONFLICT (id) DO NOTHING;

-- V5 — adult 48 + youth 12 insert into the same athletes table.
DO $$
DECLARE v_adult INT; v_youth INT;
BEGIN
  BEGIN
    INSERT INTO athletes (id, first_name, last_name, dob, age_years, sports, restrictions)
    VALUES ('d5000000-0000-4000-8000-000000000001', 'TEST-005', 'Adult', '1978-01-01', 48, '{}', '{}');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005b_results VALUES ('V5-adult-athlete', 'FAIL', 'age-48 insert failed: ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO athletes (id, first_name, last_name, dob, age_years, sports, restrictions)
    VALUES ('d5000000-0000-4000-8000-000000000002', 'TEST-005', 'Youth', '2014-01-01', 12, '{}', '{}');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005b_results VALUES ('V5-adult-athlete', 'FAIL', 'age-12 insert failed: ' || SQLSTATE || ' ' || SQLERRM);
  END;
  SELECT count(*) INTO v_adult FROM athletes WHERE id = 'd5000000-0000-4000-8000-000000000001' AND age_years = 48;
  SELECT count(*) INTO v_youth FROM athletes WHERE id = 'd5000000-0000-4000-8000-000000000002' AND age_years = 12;
  IF v_adult = 1 AND v_youth = 1 THEN
    INSERT INTO _tst005b_results VALUES ('V5-adult-athlete', 'PASS', 'age-48 adult and age-12 youth both stored in the same athletes table');
  ELSIF NOT EXISTS (SELECT 1 FROM _tst005b_results WHERE check_id = 'V5-adult-athlete') THEN
    INSERT INTO _tst005b_results VALUES ('V5-adult-athlete', 'FAIL', 'adult=' || v_adult || ' youth=' || v_youth || ' (expected 1/1)');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V5 HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- V6a — age 5 inserts (floor kept). V6b — age 4 rejected (23514).
DO $$
DECLARE v_age5 INT;
BEGIN
  BEGIN
    INSERT INTO athletes (id, first_name, last_name, dob, age_years, sports, restrictions)
    VALUES ('d5000000-0000-4000-8000-000000000003', 'TEST-005', 'AgeFive', '2021-01-01', 5, '{}', '{}');
    SELECT count(*) INTO v_age5 FROM athletes WHERE id = 'd5000000-0000-4000-8000-000000000003' AND age_years = 5;
    IF v_age5 = 1 THEN
      INSERT INTO _tst005b_results VALUES ('V6a-floor-age5', 'PASS', 'age 5 inserts (floor kept as sanity guard)');
    ELSE
      INSERT INTO _tst005b_results VALUES ('V6a-floor-age5', 'FAIL', 'age-5 row not found after insert');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005b_results VALUES ('V6a-floor-age5', 'FAIL', 'age-5 insert failed: ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO athletes (id, first_name, last_name, dob, age_years, sports, restrictions)
    VALUES ('d5000000-0000-4000-8000-000000000004', 'TEST-005', 'AgeFour', '2022-01-01', 4, '{}', '{}');
    INSERT INTO _tst005b_results VALUES ('V6b-floor-age4-rejected', 'FAIL', 'age-4 insert SUCCEEDED but the floor CHECK should have rejected it (23514)');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _tst005b_results VALUES ('V6b-floor-age4-rejected', 'PASS', 'age-4 insert rejected with 23514 check_violation (floor kept)');
  WHEN OTHERS THEN
    INSERT INTO _tst005b_results VALUES ('V6b-floor-age4-rejected', 'FAIL', 'wrong error: ' || SQLSTATE || ' ' || SQLERRM);
  END;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V6 HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- V7a — result with flags round-trips. V7b — omitted flags default FALSE.
DO $$
DECLARE v_s INT; v_r INT; v_mod BOOLEAN; v_cap BOOLEAN; v_att JSONB;
        v_mod2 BOOLEAN; v_cap2 BOOLEAN;
BEGIN
  BEGIN
    INSERT INTO assessment_sessions (id, athlete_id, coach_id, battery, recorded_at, context, engine_version, idempotency_key)
    VALUES ('15000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001',
            'generalAthleticAssessment', '2026-11-13 12:00:00+00', NULL, '1.1.0', 'TEST-005-VERIFY-001');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005b_results VALUES ('V7a-record-with-flags', 'FAIL', 'session insert failed: ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO assessment_results (id, session_id, athlete_id, assessment_id, kind, attempts, result, unit, direction, protocol_version, recorded_at, modified, capped)
    VALUES ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001',
            '10yd-sprint', 'measured', '[2.01, 1.98, 2.03]'::jsonb, 1.98, 'sec', 'lower', 'v1-retest-28d', '2026-11-13 12:00:00+00', true, true);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005b_results VALUES ('V7a-record-with-flags', 'FAIL', 'result insert with flags failed: ' || SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO assessment_results (id, session_id, athlete_id, assessment_id, kind, attempts, result, unit, direction, protocol_version, recorded_at)
    VALUES ('25000000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001',
            'broad-jump', 'measured', '[1.85, 1.90]'::jsonb, 1.90, 'm', 'higher', 'v1-retest-28d', '2026-11-13 12:00:00+00');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005b_results VALUES ('V7b-defaults-false', 'FAIL', 'result insert omitting flags failed: ' || SQLSTATE || ' ' || SQLERRM);
  END;
  SELECT count(*) INTO v_s FROM assessment_sessions WHERE id = '15000000-0000-4000-8000-000000000001';
  SELECT modified, capped, attempts INTO v_mod, v_cap, v_att FROM assessment_results WHERE id = '25000000-0000-4000-8000-000000000001';
  SELECT modified, capped INTO v_mod2, v_cap2 FROM assessment_results WHERE id = '25000000-0000-4000-8000-000000000002';
  SELECT count(*) INTO v_r FROM assessment_results WHERE id IN ('25000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000002');
  IF v_s = 1 AND v_r = 2 AND v_mod = true AND v_cap = true AND v_att = '[2.01, 1.98, 2.03]'::jsonb THEN
    IF NOT EXISTS (SELECT 1 FROM _tst005b_results WHERE check_id = 'V7a-record-with-flags') THEN
      INSERT INTO _tst005b_results VALUES ('V7a-record-with-flags', 'PASS', 'session + result with modified=true, capped=true round-trip; attempts JSONB untouched');
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM _tst005b_results WHERE check_id = 'V7a-record-with-flags') THEN
    INSERT INTO _tst005b_results VALUES ('V7a-record-with-flags', 'FAIL', 'session=' || v_s || ' results=' || v_r || ' modified=' || COALESCE(v_mod::text, 'null') || ' capped=' || COALESCE(v_cap::text, 'null'));
  END IF;
  IF v_mod2 = false AND v_cap2 = false THEN
    IF NOT EXISTS (SELECT 1 FROM _tst005b_results WHERE check_id = 'V7b-defaults-false') THEN
      INSERT INTO _tst005b_results VALUES ('V7b-defaults-false', 'PASS', 'result omitting flags retrieved as modified=false, capped=false (defaults)');
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM _tst005b_results WHERE check_id = 'V7b-defaults-false') THEN
    INSERT INTO _tst005b_results VALUES ('V7b-defaults-false', 'FAIL', 'omitted flags retrieved as modified=' || COALESCE(v_mod2::text, 'null') || ' capped=' || COALESCE(v_cap2::text, 'null') || ' (expected false/false)');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V7 HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- CLEANUP — delete every test row by fixed UUID, in dependency order.
DELETE FROM assessment_results
  WHERE id IN ('25000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000002');
DELETE FROM assessment_sessions
  WHERE id = '15000000-0000-4000-8000-000000000001';
DELETE FROM athletes
  WHERE id IN ('d5000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002',
               'd5000000-0000-4000-8000-000000000003');
DELETE FROM coaches
  WHERE id = 'c5000000-0000-4000-8000-000000000001';
DELETE FROM app_users
  WHERE id = 'b5000000-0000-4000-8000-000000000001';
DELETE FROM auth.users
  WHERE id = 'a5000000-0000-4000-8000-000000000001';

-- Final-state verdict, recorded as a row so it appears in the summary.
DO $$
DECLARE
  v_tables INT; v_defs INT; v_policies INT; v_rows INT; v_test_auth INT;
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
  SELECT count(*) INTO v_test_auth FROM auth.users WHERE id = 'a5000000-0000-4000-8000-000000000001';
  IF v_tables = 26 AND v_defs = 15 AND v_policies = 72 AND v_rows = 0 AND v_test_auth = 0 THEN
    INSERT INTO _tst005b_results VALUES ('CLEANUP-back-to-26-15-72-0', 'PASS', '26 tables / 15 definitions / 72 policies / 0 app rows / 0 test auth users');
  ELSE
    INSERT INTO _tst005b_results VALUES ('CLEANUP-back-to-26-15-72-0', 'FAIL', 'tables=' || v_tables || ' defs=' || v_defs || ' policies=' || v_policies || ' rows=' || v_rows || ' test_auth=' || v_test_auth || ' (expected 26/15/72/0/0)');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CLEANUP HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- SUMMARY — THE LAST STATEMENT. This is the result set the dashboard
-- displays. All 6 rows must be PASS.
SELECT check_id, status, detail FROM _tst005b_results ORDER BY check_id;
