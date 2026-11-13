-- THE PROGRAM OS — apply migration 005
-- File 2 of 2: VERIFY — post-apply checks, each ASSERTING with a
-- recorded PASS/FAIL in a temp results table (same harness pattern as
-- the §5 checks in server/live-checks/004/02-checks.sql).
--
-- Run ONLY after migration 005 has been applied (paste it verbatim and
-- run it first). Live project only: TheProgramOS
-- (ref rkgdwqgmldznczikrjip), Postgres 15.8.1.50.
--
-- WHAT THIS PROVES (Marcus's verification list, 2026-11-13):
--   V1  Counts unchanged: 26 tables / 15 definitions / 72 policies / 0 rows
--       (005 adds no tables, definitions, or policies).
--   V2  modified / capped exist on assessment_results: BOOLEAN,
--       NOT NULL, DEFAULT FALSE.
--   V3  The age CHECK is now `age_years >= 5` with NO upper bound
--       (no 19 anywhere in its definition).
--   V4  No division column on athletes (no division/division_id/
--       age_group column) — one unified athlete system.
--   V5  An adult athlete (age 48) inserts — same table, same workflow.
--   V6  The floor is KEPT: age 5 inserts; age 4 is rejected (23514).
--   V7  Assessment recording + retrieval with the new flags: a result
--       row with modified=true, capped=true round-trips, attempts
--       JSONB is untouched; a second result omitting both flags gets
--       FALSE/FALSE from the defaults.
--   V8  Authorization policies intact: 72 policies AND all 25
--       assessment policies present by name (003 read/director +
--       004 schedules/deferrals/plans/write/draft).
--
-- TEST ROWS (synthetic only, fixed UUIDs, deleted by this script):
--   AUTH_005_COACH a5000000-0000-4000-8000-000000000001
--   APP_005_COACH  b5000000-0000-4000-8000-000000000001
--   COACH_005      c5000000-0000-4000-8000-000000000001
--   ATH_ADULT      d5000000-0000-4000-8000-000000000001 (age 48)
--   ATH_YOUTH      d5000000-0000-4000-8000-000000000002 (age 12)
--   ATH_AGE5       d5000000-0000-4000-8000-000000000003 (age 5)
--   SESSION_005    15000000-0000-4000-8000-000000000001
--   RESULT_005     25000000-0000-4000-8000-000000000001 (flags set)
--   RESULT_005_DEF 25000000-0000-4000-8000-000000000002 (flags omitted)
-- Cleanup deletes exactly these UUIDs, in dependency order, then
-- re-verifies 26/15/72/0. Safe to run twice.

-- ---------------------------------------------------------------------------
-- Results table.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS _tst005_results;
CREATE TEMP TABLE _tst005_results (
  check_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL')),
  detail TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helper: record a verdict. (Used inside the DO blocks below via
-- direct INSERTs; kept as plain inserts to match the §5 pattern.)

-- ===========================================================================
-- V1 — counts unchanged: 26 tables / 15 definitions / 72 policies / 0 rows
-- ===========================================================================
DO $$
DECLARE v_t INT; v_d INT; v_p INT; v_r INT;
BEGIN
  SELECT count(*) INTO v_t FROM information_schema.tables WHERE table_schema = 'public';
  SELECT count(*) INTO v_d FROM assessment_definitions;
  SELECT count(*) INTO v_p FROM pg_policies WHERE schemaname = 'public';
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
  ) INTO v_r;
  IF v_t = 26 AND v_d = 15 AND v_p = 72 AND v_r = 0 THEN
    INSERT INTO _tst005_results VALUES ('V1-counts-unchanged', 'PASS', '26 tables / 15 definitions / 72 policies / 0 app rows');
    RAISE NOTICE 'V1-counts-unchanged PASS';
  ELSE
    INSERT INTO _tst005_results VALUES ('V1-counts-unchanged', 'FAIL', 'tables=' || v_t || ' defs=' || v_d || ' policies=' || v_p || ' rows=' || v_r || ' (expected 26/15/72/0)');
    RAISE NOTICE 'V1-counts-unchanged FAIL: tables=% defs=% policies=% rows=%', v_t, v_d, v_p, v_r;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V1-counts-unchanged HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- ===========================================================================
-- V2 — modified / capped columns: BOOLEAN, NOT NULL, DEFAULT FALSE
-- ===========================================================================
DO $$
DECLARE v_mod INT; v_cap INT;
BEGIN
  SELECT count(*) INTO v_mod FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'assessment_results'
      AND column_name = 'modified' AND data_type = 'boolean'
      AND is_nullable = 'NO' AND column_default = 'false';
  SELECT count(*) INTO v_cap FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'assessment_results'
      AND column_name = 'capped' AND data_type = 'boolean'
      AND is_nullable = 'NO' AND column_default = 'false';
  IF v_mod = 1 AND v_cap = 1 THEN
    INSERT INTO _tst005_results VALUES ('V2-flag-columns', 'PASS', 'modified + capped: BOOLEAN NOT NULL DEFAULT FALSE on assessment_results');
    RAISE NOTICE 'V2-flag-columns PASS';
  ELSE
    INSERT INTO _tst005_results VALUES ('V2-flag-columns', 'FAIL', 'modified_match=' || v_mod || ' capped_match=' || v_cap || ' (expected 1/1)');
    RAISE NOTICE 'V2-flag-columns FAIL: modified=% capped=%', v_mod, v_cap;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V2-flag-columns HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- ===========================================================================
-- V3 — age CHECK is now `age_years >= 5`, no upper bound, no 19
-- ===========================================================================
DO $$
DECLARE v_def TEXT; v_n INT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
    WHERE conrelid = 'public.athletes'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%age_years%';
  SELECT count(*) INTO v_n FROM pg_constraint
    WHERE conrelid = 'public.athletes'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%age_years%';
  IF v_n = 1 AND v_def LIKE '%age_years >= 5%' AND v_def NOT LIKE '%19%' AND v_def NOT LIKE '%<=%' THEN
    INSERT INTO _tst005_results VALUES ('V3-age-check-relaxed', 'PASS', 'age CHECK is now: ' || v_def);
    RAISE NOTICE 'V3-age-check-relaxed PASS: %', v_def;
  ELSE
    INSERT INTO _tst005_results VALUES ('V3-age-check-relaxed', 'FAIL', 'age CHECK count=' || v_n || ' definition=' || COALESCE(v_def, 'null'));
    RAISE NOTICE 'V3-age-check-relaxed FAIL: count=% def=%', v_n, v_def;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V3-age-check-relaxed HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- ===========================================================================
-- V4 — no division column on athletes (one unified athlete system)
-- ===========================================================================
DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'athletes'
      AND column_name IN ('division', 'division_id', 'age_group', 'age_division');
  IF v_n = 0 THEN
    INSERT INTO _tst005_results VALUES ('V4-no-divisions', 'PASS', 'athletes has no division/division_id/age_group/age_division column');
    RAISE NOTICE 'V4-no-divisions PASS';
  ELSE
    INSERT INTO _tst005_results VALUES ('V4-no-divisions', 'FAIL', 'found ' || v_n || ' division-like columns on athletes');
    RAISE NOTICE 'V4-no-divisions FAIL: % division-like columns', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V4-no-divisions HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- ===========================================================================
-- V5 + V6 — age representation: adult 48 inserts, youth 12 inserts,
-- age 5 inserts (floor kept), age 4 rejected with 23514.
-- Runs as postgres (RLS bypassed); this proves the CHECK, not a policy.
-- ===========================================================================
DO $$
DECLARE v_adult INT; v_youth INT; v_age5 INT;
BEGIN
  BEGIN
    INSERT INTO athletes (id, first_name, last_name, dob, age_years, sports, restrictions)
    VALUES ('d5000000-0000-4000-8000-000000000001', 'TEST-005', 'Adult', '1978-01-01', 48, '{}', '{}');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005_results VALUES ('V5-adult-athlete', 'FAIL', 'age-48 insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'V5-adult-athlete FAIL: % %', SQLSTATE, SQLERRM;
  END;
  BEGIN
    INSERT INTO athletes (id, first_name, last_name, dob, age_years, sports, restrictions)
    VALUES ('d5000000-0000-4000-8000-000000000002', 'TEST-005', 'Youth', '2014-01-01', 12, '{}', '{}');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005_results VALUES ('V5-adult-athlete', 'FAIL', 'age-12 insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'V5-adult-athlete FAIL (youth leg): % %', SQLSTATE, SQLERRM;
  END;
  SELECT count(*) INTO v_adult FROM athletes WHERE id = 'd5000000-0000-4000-8000-000000000001' AND age_years = 48;
  SELECT count(*) INTO v_youth FROM athletes WHERE id = 'd5000000-0000-4000-8000-000000000002' AND age_years = 12;
  IF v_adult = 1 AND v_youth = 1 THEN
    INSERT INTO _tst005_results VALUES ('V5-adult-athlete', 'PASS', 'age-48 adult and age-12 youth both stored in the same athletes table, no divisions');
    RAISE NOTICE 'V5-adult-athlete PASS';
  ELSIF NOT EXISTS (SELECT 1 FROM _tst005_results WHERE check_id = 'V5-adult-athlete') THEN
    INSERT INTO _tst005_results VALUES ('V5-adult-athlete', 'FAIL', 'adult=' || v_adult || ' youth=' || v_youth || ' (expected 1/1)');
    RAISE NOTICE 'V5-adult-athlete FAIL: adult=% youth=%', v_adult, v_youth;
  END IF;

  -- Floor kept: age 5 inserts.
  BEGIN
    INSERT INTO athletes (id, first_name, last_name, dob, age_years, sports, restrictions)
    VALUES ('d5000000-0000-4000-8000-000000000003', 'TEST-005', 'AgeFive', '2021-01-01', 5, '{}', '{}');
    SELECT count(*) INTO v_age5 FROM athletes WHERE id = 'd5000000-0000-4000-8000-000000000003' AND age_years = 5;
    IF v_age5 = 1 THEN
      INSERT INTO _tst005_results VALUES ('V6a-floor-age5', 'PASS', 'age 5 inserts (floor kept as sanity guard)');
      RAISE NOTICE 'V6a-floor-age5 PASS';
    ELSE
      INSERT INTO _tst005_results VALUES ('V6a-floor-age5', 'FAIL', 'age-5 row not found after insert');
      RAISE NOTICE 'V6a-floor-age5 FAIL';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005_results VALUES ('V6a-floor-age5', 'FAIL', 'age-5 insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'V6a-floor-age5 FAIL: % %', SQLSTATE, SQLERRM;
  END;

  -- Floor kept: age 4 rejected with check_violation 23514.
  BEGIN
    INSERT INTO athletes (id, first_name, last_name, dob, age_years, sports, restrictions)
    VALUES ('d5000000-0000-4000-8000-000000000004', 'TEST-005', 'AgeFour', '2022-01-01', 4, '{}', '{}');
    INSERT INTO _tst005_results VALUES ('V6b-floor-age4-rejected', 'FAIL', 'age-4 insert SUCCEEDED but the floor CHECK should have rejected it (23514)');
    RAISE NOTICE 'V6b-floor-age4-rejected FAIL: age-4 insert succeeded';
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _tst005_results VALUES ('V6b-floor-age4-rejected', 'PASS', 'age-4 insert rejected with 23514 check_violation (floor kept)');
    RAISE NOTICE 'V6b-floor-age4-rejected PASS';
  WHEN OTHERS THEN
    INSERT INTO _tst005_results VALUES ('V6b-floor-age4-rejected', 'FAIL', 'wrong error: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'V6b-floor-age4-rejected FAIL: wrong error %: %', SQLSTATE, SQLERRM;
  END;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V5/V6 HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- ===========================================================================
-- V7 — assessment recording + retrieval with the new flags.
-- Minimal fixtures as postgres: 1 auth user + 1 app user + 1 coach,
-- then a session for the adult athlete and two result rows (one with
-- flags set, one omitting them to prove the defaults).
-- ===========================================================================
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

DO $$
DECLARE v_s INT; v_r INT; v_mod BOOLEAN; v_cap BOOLEAN; v_att JSONB;
        v_mod2 BOOLEAN; v_cap2 BOOLEAN;
BEGIN
  -- Session for the adult athlete (same shape as §5 check 1a).
  BEGIN
    INSERT INTO assessment_sessions (id, athlete_id, coach_id, battery, recorded_at, context, engine_version, idempotency_key)
    VALUES ('15000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001',
            'generalAthleticAssessment', '2026-11-13 12:00:00+00', NULL, '1.1.0', 'TEST-005-VERIFY-001');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005_results VALUES ('V7a-record-with-flags', 'FAIL', 'session insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'V7a-record-with-flags FAIL (session): % %', SQLSTATE, SQLERRM;
  END;
  -- Result WITH flags set (the store's write shape).
  BEGIN
    INSERT INTO assessment_results (id, session_id, athlete_id, assessment_id, kind, attempts, result, unit, direction, protocol_version, recorded_at, modified, capped)
    VALUES ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001',
            '10yd-sprint', 'measured', '[2.01, 1.98, 2.03]'::jsonb, 1.98, 'sec', 'lower', 'v1-retest-28d', '2026-11-13 12:00:00+00', true, true);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005_results VALUES ('V7a-record-with-flags', 'FAIL', 'result insert with flags failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'V7a-record-with-flags FAIL (result): % %', SQLSTATE, SQLERRM;
  END;
  -- Result OMITTING the flags (proves the DEFAULT FALSE).
  BEGIN
    INSERT INTO assessment_results (id, session_id, athlete_id, assessment_id, kind, attempts, result, unit, direction, protocol_version, recorded_at)
    VALUES ('25000000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001',
            'broad-jump', 'measured', '[1.85, 1.90]'::jsonb, 1.90, 'm', 'higher', 'v1-retest-28d', '2026-11-13 12:00:00+00');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst005_results VALUES ('V7b-defaults-false', 'FAIL', 'result insert omitting flags failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'V7b-defaults-false FAIL (insert): % %', SQLSTATE, SQLERRM;
  END;
  -- Retrieval: flags round-trip, attempts JSONB untouched, defaults FALSE.
  SELECT count(*) INTO v_s FROM assessment_sessions WHERE id = '15000000-0000-4000-8000-000000000001';
  SELECT modified, capped, attempts INTO v_mod, v_cap, v_att FROM assessment_results WHERE id = '25000000-0000-4000-8000-000000000001';
  SELECT modified, capped INTO v_mod2, v_cap2 FROM assessment_results WHERE id = '25000000-0000-4000-8000-000000000002';
  SELECT count(*) INTO v_r FROM assessment_results WHERE id IN ('25000000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000002');
  IF v_s = 1 AND v_r = 2 AND v_mod = true AND v_cap = true AND v_att = '[2.01, 1.98, 2.03]'::jsonb THEN
    IF NOT EXISTS (SELECT 1 FROM _tst005_results WHERE check_id = 'V7a-record-with-flags') THEN
      INSERT INTO _tst005_results VALUES ('V7a-record-with-flags', 'PASS', 'session + result with modified=true, capped=true round-trip; attempts JSONB untouched');
      RAISE NOTICE 'V7a-record-with-flags PASS';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM _tst005_results WHERE check_id = 'V7a-record-with-flags') THEN
    INSERT INTO _tst005_results VALUES ('V7a-record-with-flags', 'FAIL', 'session=' || v_s || ' results=' || v_r || ' modified=' || COALESCE(v_mod::text, 'null') || ' capped=' || COALESCE(v_cap::text, 'null'));
    RAISE NOTICE 'V7a-record-with-flags FAIL: session=% results=% modified=% capped=%', v_s, v_r, v_mod, v_cap;
  END IF;
  IF v_mod2 = false AND v_cap2 = false THEN
    IF NOT EXISTS (SELECT 1 FROM _tst005_results WHERE check_id = 'V7b-defaults-false') THEN
      INSERT INTO _tst005_results VALUES ('V7b-defaults-false', 'PASS', 'result omitting flags retrieved as modified=false, capped=false (defaults)');
      RAISE NOTICE 'V7b-defaults-false PASS';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM _tst005_results WHERE check_id = 'V7b-defaults-false') THEN
    INSERT INTO _tst005_results VALUES ('V7b-defaults-false', 'FAIL', 'omitted flags retrieved as modified=' || COALESCE(v_mod2::text, 'null') || ' capped=' || COALESCE(v_cap2::text, 'null') || ' (expected false/false)');
    RAISE NOTICE 'V7b-defaults-false FAIL: modified=% capped=%', v_mod2, v_cap2;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V7 HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- ===========================================================================
-- V8 — authorization policies intact: 72 total + all 25 assessment
-- policies present by name (003 read/director + 004 write/draft).
-- ===========================================================================
DO $$
DECLARE v_p INT; v_assess INT;
BEGIN
  SELECT count(*) INTO v_p FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_assess FROM pg_policies
    WHERE schemaname = 'public' AND policyname IN (
      'adef_director', 'adef_read',
      'asess_director', 'asess_coach', 'asess_owner', 'asess_coach_write',
      'ares_director', 'ares_coach', 'ares_owner', 'ares_coach_write',
      'ader_director', 'ader_coach', 'ader_owner', 'ader_coach_write',
      'asched_director', 'asched_coach', 'asched_owner',
      'adefr_director', 'adefr_coach', 'adefr_owner',
      'dplan_director', 'dplan_coach', 'dplan_owner',
      'adrft_director', 'adrft_coach');
  IF v_p = 72 AND v_assess = 25 THEN
    INSERT INTO _tst005_results VALUES ('V8-policies-intact', 'PASS', '72 policies total; all 25 assessment policies present by name');
    RAISE NOTICE 'V8-policies-intact PASS';
  ELSE
    INSERT INTO _tst005_results VALUES ('V8-policies-intact', 'FAIL', 'total policies=' || v_p || ' assessment policies by name=' || v_assess || ' (expected 72/25)');
    RAISE NOTICE 'V8-policies-intact FAIL: total=% assess=%', v_p, v_assess;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'V8-policies-intact HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- SUMMARY — one row per check.
-- ---------------------------------------------------------------------------
SELECT check_id, status, detail, checked_at FROM _tst005_results ORDER BY check_id;
SELECT count(*) FILTER (WHERE status = 'PASS') AS pass_count,
       count(*) FILTER (WHERE status = 'FAIL') AS fail_count,
       count(*) AS total FROM _tst005_results;

-- ---------------------------------------------------------------------------
-- CLEANUP — delete every test row created by this script, by fixed UUID,
-- in dependency order. Then re-verify the project is back to 26/15/72/0.
-- ---------------------------------------------------------------------------
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

SELECT count(*) AS public_tables FROM information_schema.tables WHERE table_schema = 'public';
SELECT count(*) AS assessment_definitions FROM assessment_definitions;
SELECT count(*) AS public_policies FROM pg_policies WHERE schemaname = 'public';
SELECT count(*) AS test_auth_users_remaining FROM auth.users WHERE id IN (
  'a5000000-0000-4000-8000-000000000001');

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
    RAISE NOTICE 'VERIFY-005 CLEANUP PASS: back to 26 tables / 15 definitions / 72 policies / 0 app rows / 0 test auth users. No test data remains.';
  ELSE
    RAISE NOTICE 'VERIFY-005 CLEANUP FAIL: tables=% definitions=% policies=% app_rows=% test_auth_users=% (expected 26/15/72/0/0).',
      v_tables, v_defs, v_policies, v_rows, v_test_auth;
  END IF;
END $$;
