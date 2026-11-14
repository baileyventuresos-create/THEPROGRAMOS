-- THE PROGRAM OS — §5 live functional checks for migration 004
-- File 2 of 3: CHECKS — the five §5 checks, each ASSERTING with a
-- recorded PASS/FAIL (never a bare statement whose output needs
-- interpretation).
--
-- Run order: 01-setup → 02-checks → 03-cleanup (see
-- server/live-checks/004/README.md). Run ONLY after 01-setup
-- completed; the PRE-FLIGHT block below stops the script if the
-- fixtures are missing.
--
-- METHOD — JWT-claim impersonation, exactly as checks A/B/C used for
-- 001–003 (docs/SUPABASE_HANDOFF.md). The dashboard SQL editor
-- connects as superuser postgres, which BYPASSES RLS — so each
-- impersonated block is an explicit transaction that first does
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claims = '{"sub": "<test auth UUID>", "role": "authenticated", "aud": "authenticated"}';
-- and ends with COMMIT (never ROLLBACK: a write check's row must
-- persist for the later checks; the anon block commits nothing).
-- The RLS helpers (migration 003) resolve role and identity from
-- auth.uid(), which reads request.jwt.claims. These are NOT real
-- JWTs and there is no real login flow — the claim is exactly what
-- Supabase sets for a real authenticated session, so the policies
-- execute the same code path. The honest limit (same as A/B/C):
-- this proves the policy logic against the claim, not the
-- end-to-end login → JWT issue path.
--
-- HOW A CHECK ASSERTS: every check is a DO block whose inner
-- BEGIN/EXCEPTION records a row in the TEMP table _tst004_results
-- and raises a NOTICE; the outer EXCEPTION catches harness errors
-- (e.g. a problem with the results table itself) so a failure in
-- one check can never abort the rest of the pasted script. At the
-- end, a summary SELECT lists every verdict. Expected SQLSTATEs:
--   23505 unique_violation    (Check 1 — duplicate idempotency key)
--   42501 insufficient_privilege (Check 2 — RLS denial)
--   23514 check_violation     (Check 4 — plan without baseline or override)
-- The temp results table is GRANTed to authenticated/anon below so
-- the impersonated blocks can record verdicts into it.
--
-- GRANTS PRE-FLIGHT: RLS and table grants are separate layers and
-- both deny with SQLSTATE 42501. Before any check runs, the file
-- verifies (as postgres) that authenticated/anon hold the SELECT and
-- INSERT privileges the checks need. If any grant is missing it
-- RAISES and stops — a missing grant would make every write check
-- fail for the wrong reason and make check 2a "pass" vacuously.
-- This matters because Supabase stopped auto-granting new public
-- tables to anon/authenticated on 30 Oct 2026, and migrations
-- 001–004 (applied 12–13 Nov 2026) grant no table privileges; check
-- B proved live SELECT works, but INSERT was never exercised live.
-- The pre-flight does NOT grant anything: a missing grant is fixed
-- by a GRANT, a live access-control change needing Marcus's separate
-- approval.
--
-- TEST IDENTITIES (fixed UUIDs, created by 01-setup):
--   Coach  auth a0000000-0000-4000-8000-000000000001  app b0000000-...-0001  coach row c0000000-...-0001
--   Parent auth a0000000-0000-4000-8000-000000000002  app b0000000-...-0002  guardian  e0000000-...-0001
--   Ath A  auth a0000000-0000-4000-8000-000000000003  app b0000000-...-0003  athlete d0000000-...-0001
--   Ath B  auth a0000000-0000-4000-8000-000000000004  app b0000000-...-0004  athlete d0000000-...-0002
-- TEST ROWS CREATED BY THE CHECKS (cleanup deletes exactly these):
--   Sessions  10000000-0000-4000-8000-000000000001 (Check 1, key TEST-004-IDEMPOTENCY-001)
--             10000000-0000-4000-8000-000000000003 (Check 2 positive, key TEST-004-COACH-WRITE-001)
--   Attempted 10000000-0000-4000-8000-000000000002 (Check 1 duplicate — must be REJECTED)
--             10000000-0000-4000-8000-000000000004 (Check 2 out-of-cohort — must be DENIED)
--   Result    20000000-0000-4000-8000-000000000001 (10yd-sprint on session ...0003)
--   Derived   30000000-0000-4000-8000-000000000001 (observation on session ...0003)
--   Draft     40000000-0000-4000-8000-000000000001 (Check 5, athlete A)
--   Plan      50000000-0000-4000-8000-000000000001 (Check 4 override plan, athlete A)
--   Attempted 50000000-0000-4000-8000-000000000002 (Check 4 neither — must be REJECTED)
--
-- STOP: a FAIL in any check is a stop — finish reading the summary,
-- then run 03-cleanup.sql before diagnosing. Do not proceed to a
-- later check that depends on the failed row existing.

-- ---------------------------------------------------------------------------
-- Results table + PRE-FLIGHT (fixtures must exist; fail fast otherwise).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS _tst004_results;
CREATE TEMP TABLE _tst004_results (
  check_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL')),
  detail TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The impersonated blocks run as authenticated/anon; they must be able
-- to record verdicts. (Temp table only — never a schema change.)
GRANT SELECT, INSERT ON _tst004_results TO authenticated, anon;

DO $$
DECLARE
  v_athletes INT;
  v_coach INT;
  v_app_users INT;
BEGIN
  SELECT count(*) INTO v_athletes FROM athletes WHERE id IN (
    'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');
  SELECT count(*) INTO v_coach FROM coaches WHERE id = 'c0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_app_users FROM app_users WHERE id IN (
    'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000004');
  IF v_athletes <> 2 OR v_coach <> 1 OR v_app_users <> 4 THEN
    RAISE EXCEPTION 'PRE-FLIGHT FAILED: athletes=% coach=% app_users=% (expected 2/1/4). Run 01-setup-synthetic-data.sql first.',
      v_athletes, v_coach, v_app_users;
  END IF;
  RAISE NOTICE 'PRE-FLIGHT PASS: fixtures present (2 athletes, 1 coach, 4 app_users).';
END $$;

-- ---------------------------------------------------------------------------
-- GRANTS PRE-FLIGHT (fail fast): RLS and table grants are SEPARATE
-- layers, and both deny with the same SQLSTATE 42501. A missing
-- grant would make every write check fail for the WRONG reason and
-- make check 2a "pass" vacuously (denied by the missing grant, not
-- by the RLS policy). This block runs as postgres and verifies that
-- the authenticated/anon roles hold every table privilege the checks
-- need, BEFORE any check runs. It does NOT grant anything itself.
--
-- WHY THIS EXISTS: Supabase changed its platform default on
-- 30 Oct 2026 — new tables in public NO LONGER automatically get
-- SELECT/INSERT/UPDATE/DELETE for anon/authenticated/service_role;
-- existing tables keep their grants. Migrations 001–004 were applied
-- 12–13 Nov 2026, AFTER that change, and no migration grants table
-- privileges. Check B (12 Nov 2026) proved live SELECT works as
-- authenticated, so this project's tables appear to carry grants —
-- but INSERT was never exercised live. This pre-flight re-checks the
-- live state at run time instead of assuming it.
--
-- IF IT FAILS: STOP. The fix is a GRANT — a live access-control
-- change to the project — which needs Marcus's SEPARATE approval
-- (it is not covered by the §5 check approval). Do not run the
-- write checks until it is resolved; their 42501s would be
-- meaningless.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT := '';
BEGIN
  -- SELECT grants (authenticated) needed by checks 3a/3b/5b/5c.
  IF NOT has_table_privilege('authenticated', 'assessment_sessions', 'SELECT') THEN v_missing := v_missing || ' authenticated:SELECT assessment_sessions;'; END IF;
  IF NOT has_table_privilege('authenticated', 'assessment_results', 'SELECT') THEN v_missing := v_missing || ' authenticated:SELECT assessment_results;'; END IF;
  IF NOT has_table_privilege('authenticated', 'assessment_derived_records', 'SELECT') THEN v_missing := v_missing || ' authenticated:SELECT assessment_derived_records;'; END IF;
  IF NOT has_table_privilege('authenticated', 'assessment_drafts', 'SELECT') THEN v_missing := v_missing || ' authenticated:SELECT assessment_drafts;'; END IF;
  IF NOT has_table_privilege('authenticated', 'athletes', 'SELECT') THEN v_missing := v_missing || ' authenticated:SELECT athletes;'; END IF;
  -- INSERT grants (authenticated) needed by checks 1/2/4/5a.
  IF NOT has_table_privilege('authenticated', 'assessment_sessions', 'INSERT') THEN v_missing := v_missing || ' authenticated:INSERT assessment_sessions;'; END IF;
  IF NOT has_table_privilege('authenticated', 'assessment_results', 'INSERT') THEN v_missing := v_missing || ' authenticated:INSERT assessment_results;'; END IF;
  IF NOT has_table_privilege('authenticated', 'assessment_derived_records', 'INSERT') THEN v_missing := v_missing || ' authenticated:INSERT assessment_derived_records;'; END IF;
  IF NOT has_table_privilege('authenticated', 'development_plans', 'INSERT') THEN v_missing := v_missing || ' authenticated:INSERT development_plans;'; END IF;
  IF NOT has_table_privilege('authenticated', 'assessment_drafts', 'INSERT') THEN v_missing := v_missing || ' authenticated:INSERT assessment_drafts;'; END IF;
  -- SELECT grants (anon) needed by check 3c.
  IF NOT has_table_privilege('anon', 'assessment_sessions', 'SELECT') THEN v_missing := v_missing || ' anon:SELECT assessment_sessions;'; END IF;
  IF NOT has_table_privilege('anon', 'assessment_results', 'SELECT') THEN v_missing := v_missing || ' anon:SELECT assessment_results;'; END IF;
  IF NOT has_table_privilege('anon', 'assessment_derived_records', 'SELECT') THEN v_missing := v_missing || ' anon:SELECT assessment_derived_records;'; END IF;
  IF NOT has_table_privilege('anon', 'athletes', 'SELECT') THEN v_missing := v_missing || ' anon:SELECT athletes;'; END IF;
  IF v_missing <> '' THEN
    RAISE EXCEPTION 'GRANTS PRE-FLIGHT FAILED: missing table grants:% The §5 checks cannot distinguish an RLS denial (42501) from a missing grant (also 42501). STOP — do not run the write checks. The fix is a GRANT (a live access-control change) that needs Marcus''s separate approval.',
      v_missing;
  END IF;
  RAISE NOTICE 'GRANTS PRE-FLIGHT PASS: authenticated/anon hold the SELECT/INSERT grants the checks need.';
END $$;

-- ===========================================================================
-- CHECK 1 — Idempotency (§5.1)
-- Expected: the same session recorded twice under one idempotency key
-- produces ONE row; the duplicate insert is rejected (23505); the
-- ON CONFLICT DO NOTHING form (the application store's retry path)
-- inserts nothing and the row it returns is the ORIGINAL session.
-- The idempotency key is TEST-004-IDEMPOTENCY-001; the battery is
-- generalAthleticAssessment; engine_version 1.1.0 (the store's version).
-- ===========================================================================
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated", "aud": "authenticated"}';

-- 1a. First insert succeeds (also exercises asess_coach_write).
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO assessment_sessions (id, athlete_id, coach_id, battery, recorded_at, context, engine_version, idempotency_key)
    VALUES ('10000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
            'generalAthleticAssessment', '2026-11-13 12:00:00+00', NULL, '1.1.0', 'TEST-004-IDEMPOTENCY-001');
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-1a-first-insert', 'FAIL', 'first insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-1a-first-insert FAIL: first insert failed: % %', SQLSTATE, SQLERRM;
  END;
  IF v_ok THEN
    INSERT INTO _tst004_results VALUES ('CHECK-1a-first-insert', 'PASS', 'session 10000000-...-0001 inserted under key TEST-004-IDEMPOTENCY-001');
    RAISE NOTICE 'CHECK-1a-first-insert PASS: session inserted under key TEST-004-IDEMPOTENCY-001';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-1a-first-insert HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- 1b. Raw duplicate insert (same key, different session id) is REJECTED
-- with unique_violation 23505 from the partial unique index.
DO $$
BEGIN
  BEGIN
    INSERT INTO assessment_sessions (id, athlete_id, coach_id, battery, recorded_at, context, engine_version, idempotency_key)
    VALUES ('10000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
            'generalAthleticAssessment', '2026-11-13 12:05:00+00', NULL, '1.1.0', 'TEST-004-IDEMPOTENCY-001');
    INSERT INTO _tst004_results VALUES ('CHECK-1b-duplicate-rejected', 'FAIL', 'duplicate insert SUCCEEDED but the partial unique index should have rejected it (23505)');
    RAISE NOTICE 'CHECK-1b-duplicate-rejected FAIL: duplicate insert succeeded, index did not reject it';
    RETURN;
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO _tst004_results VALUES ('CHECK-1b-duplicate-rejected', 'PASS', 'duplicate insert rejected with 23505 unique_violation as expected');
    RAISE NOTICE 'CHECK-1b-duplicate-rejected PASS: duplicate insert rejected with 23505';
  WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-1b-duplicate-rejected', 'FAIL', 'wrong error: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-1b-duplicate-rejected FAIL: wrong error %: %', SQLSTATE, SQLERRM;
  END;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-1b-duplicate-rejected HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- 1c. The store's retry form (ON CONFLICT ... DO NOTHING) inserts
-- nothing, and the row for the key is still the ORIGINAL session.
DO $$
DECLARE
  v_n INT;
  v_found_id UUID;
  v_rows INT;
BEGIN
  BEGIN
    INSERT INTO assessment_sessions (id, athlete_id, coach_id, battery, recorded_at, context, engine_version, idempotency_key)
    VALUES ('10000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
            'generalAthleticAssessment', '2026-11-13 12:05:00+00', NULL, '1.1.0', 'TEST-004-IDEMPOTENCY-001')
    ON CONFLICT (athlete_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-1c-retry-noop', 'FAIL', 'ON CONFLICT retry raised: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-1c-retry-noop FAIL: ON CONFLICT retry raised: % %', SQLSTATE, SQLERRM;
    RETURN;
  END;
  SELECT count(*) INTO v_rows FROM assessment_sessions
    WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001' AND idempotency_key = 'TEST-004-IDEMPOTENCY-001';
  -- Exactly one row exists (v_rows = 1, asserted below), so LIMIT 1
  -- returns that row. (min()/max() do not exist for uuid.)
  SELECT id INTO v_found_id FROM assessment_sessions
    WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001' AND idempotency_key = 'TEST-004-IDEMPOTENCY-001' LIMIT 1;
  IF v_n = 0 AND v_rows = 1 AND v_found_id = '10000000-0000-4000-8000-000000000001' THEN
    INSERT INTO _tst004_results VALUES ('CHECK-1c-retry-noop', 'PASS', 'retry inserted 0 rows; the key still resolves to the original session 10000000-...-0001');
    RAISE NOTICE 'CHECK-1c-retry-noop PASS: retry inserted 0 rows, key resolves to original session';
  ELSE
    INSERT INTO _tst004_results VALUES ('CHECK-1c-retry-noop', 'FAIL', 'expected inserted=0 rows=1 id=...0001; got inserted=' || v_n || ' rows=' || v_rows || ' id=' || COALESCE(v_found_id::text, 'null'));
    RAISE NOTICE 'CHECK-1c-retry-noop FAIL: inserted=% rows=% id=%', v_n, v_rows, v_found_id;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-1c-retry-noop HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

COMMIT;

-- ===========================================================================
-- CHECK 2 — Coach scope (§5.2)
-- Expected: the TEST coach (head coach of TST-A only) CANNOT insert a
-- session for athlete B (enrolled in TST-B) — RLS denies it with
-- 42501; the same coach CAN insert a session for athlete A (own
-- cohort), and CAN insert that session's result and derived record
-- (ares/ader coach-write policies).
-- ===========================================================================
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated", "aud": "authenticated"}';

-- 2a. Out-of-cohort insert is DENIED (42501).
DO $$
BEGIN
  BEGIN
    INSERT INTO assessment_sessions (id, athlete_id, coach_id, battery, recorded_at, context, engine_version, idempotency_key)
    VALUES ('10000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001',
            'generalAthleticAssessment', '2026-11-13 12:10:00+00', NULL, '1.1.0', 'TEST-004-OUT-OF-COHORT-001');
    INSERT INTO _tst004_results VALUES ('CHECK-2a-out-of-cohort-denied', 'FAIL', 'out-of-cohort insert SUCCEEDED but RLS should have denied it (42501)');
    RAISE NOTICE 'CHECK-2a-out-of-cohort-denied FAIL: out-of-cohort insert succeeded, RLS did not deny';
    RETURN;
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _tst004_results VALUES ('CHECK-2a-out-of-cohort-denied', 'PASS', 'out-of-cohort insert denied with 42501 insufficient_privilege as expected');
    RAISE NOTICE 'CHECK-2a-out-of-cohort-denied PASS: out-of-cohort insert denied with 42501';
  WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-2a-out-of-cohort-denied', 'FAIL', 'wrong error: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-2a-out-of-cohort-denied FAIL: wrong error %: %', SQLSTATE, SQLERRM;
  END;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-2a-out-of-cohort-denied HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- 2b. Own-cohort session insert succeeds.
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO assessment_sessions (id, athlete_id, coach_id, battery, recorded_at, context, engine_version, idempotency_key)
    VALUES ('10000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
            'generalAthleticAssessment', '2026-11-13 12:05:00+00', NULL, '1.1.0', 'TEST-004-COACH-WRITE-001');
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-2b-own-cohort-insert', 'FAIL', 'own-cohort insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-2b-own-cohort-insert FAIL: own-cohort insert failed: % %', SQLSTATE, SQLERRM;
  END;
  IF v_ok THEN
    INSERT INTO _tst004_results VALUES ('CHECK-2b-own-cohort-insert', 'PASS', 'own-cohort session 10000000-...-0003 inserted');
    RAISE NOTICE 'CHECK-2b-own-cohort-insert PASS: own-cohort session inserted';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-2b-own-cohort-insert HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- 2c. Own-cohort result insert succeeds (ares_coach_write; the store's
-- recordAssessmentSession writes a 10yd-sprint result exactly like this).
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO assessment_results (id, session_id, athlete_id, assessment_id, kind, attempts, result, unit, direction, protocol_version, recorded_at)
    VALUES ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001',
            '10yd-sprint', 'measured', '[2.01, 1.98, 2.03]'::jsonb, 1.98, 'sec', 'lower', 'v1-retest-28d', '2026-11-13 12:05:00+00');
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-2c-own-cohort-result', 'FAIL', 'own-cohort result insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-2c-own-cohort-result FAIL: own-cohort result insert failed: % %', SQLSTATE, SQLERRM;
  END;
  IF v_ok THEN
    INSERT INTO _tst004_results VALUES ('CHECK-2c-own-cohort-result', 'PASS', '10yd-sprint result 20000000-...-0001 inserted on own-cohort session');
    RAISE NOTICE 'CHECK-2c-own-cohort-result PASS: own-cohort result inserted';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-2c-own-cohort-result HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- 2d. Own-cohort derived observation insert succeeds (ader_coach_write).
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO assessment_derived_records (id, session_id, athlete_id, assessment_id, kind, text, value, derived_type, source, caveat, recorded_at)
    VALUES ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001',
            NULL, 'observation', 'TEST observation — synthetic check data.', NULL, NULL, 'coach', 'TEST synthetic observation; not a measurement.', '2026-11-13 12:05:00+00');
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-2d-own-cohort-derived', 'FAIL', 'own-cohort derived insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-2d-own-cohort-derived FAIL: own-cohort derived insert failed: % %', SQLSTATE, SQLERRM;
  END;
  IF v_ok THEN
    INSERT INTO _tst004_results VALUES ('CHECK-2d-own-cohort-derived', 'PASS', 'derived observation 30000000-...-0001 inserted on own-cohort session');
    RAISE NOTICE 'CHECK-2d-own-cohort-derived PASS: own-cohort derived observation inserted';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-2d-own-cohort-derived HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

COMMIT;

-- ===========================================================================
-- CHECK 3 — Athlete scope (§5.3)
-- Expected: athlete A can SELECT their own rows and sees NONE of
-- athlete B's; the parent (guardian of A only) sees A's rows and none
-- of B's; anonymous sees nothing at all. After Checks 1–2, athlete A
-- has 2 sessions / 1 result / 1 derived record and athlete B has 0.
-- ===========================================================================

-- 3a. Athlete A (own rows visible, other's hidden).
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated", "aud": "authenticated"}';

DO $$
DECLARE v_own_s INT; v_other_s INT; v_own_r INT; v_other_r INT; v_own_d INT; v_other_d INT;
BEGIN
  SELECT count(*) INTO v_own_s FROM assessment_sessions WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_other_s FROM assessment_sessions WHERE athlete_id = 'd0000000-0000-4000-8000-000000000002';
  SELECT count(*) INTO v_own_r FROM assessment_results WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_other_r FROM assessment_results WHERE athlete_id = 'd0000000-0000-4000-8000-000000000002';
  SELECT count(*) INTO v_own_d FROM assessment_derived_records WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_other_d FROM assessment_derived_records WHERE athlete_id = 'd0000000-0000-4000-8000-000000000002';
  IF v_own_s = 2 AND v_other_s = 0 AND v_own_r = 1 AND v_other_r = 0 AND v_own_d = 1 AND v_other_d = 0 THEN
    INSERT INTO _tst004_results VALUES ('CHECK-3a-athlete-own', 'PASS', 'athlete A sees own 2 sessions / 1 result / 1 derived and 0 of athlete B''s');
    RAISE NOTICE 'CHECK-3a-athlete-own PASS: athlete A sees own rows only';
  ELSE
    INSERT INTO _tst004_results VALUES ('CHECK-3a-athlete-own', 'FAIL', 'own sessions=' || v_own_s || ' other sessions=' || v_other_s || ' own results=' || v_own_r || ' other results=' || v_other_r || ' own derived=' || v_own_d || ' other derived=' || v_other_d || ' (expected 2/0/1/0/1/0)');
    RAISE NOTICE 'CHECK-3a-athlete-own FAIL: own/other sessions=%/% results=%/% derived=%/%', v_own_s, v_other_s, v_own_r, v_other_r, v_own_d, v_other_d;
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst004_results VALUES ('CHECK-3a-athlete-own', 'FAIL', 'harness error: ' || SQLSTATE || ' ' || SQLERRM);
  RAISE NOTICE 'CHECK-3a-athlete-own FAIL: harness error %: %', SQLSTATE, SQLERRM;
END $$;

COMMIT;

-- 3b. Parent (guardian of A only) — sees A's rows, none of B's.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated", "aud": "authenticated"}';

DO $$
DECLARE v_own_s INT; v_other_s INT; v_own_ath INT; v_other_ath INT;
BEGIN
  SELECT count(*) INTO v_own_s FROM assessment_sessions WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_other_s FROM assessment_sessions WHERE athlete_id = 'd0000000-0000-4000-8000-000000000002';
  SELECT count(*) INTO v_own_ath FROM athletes WHERE id = 'd0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_other_ath FROM athletes WHERE id = 'd0000000-0000-4000-8000-000000000002';
  IF v_own_s = 2 AND v_other_s = 0 AND v_own_ath = 1 AND v_other_ath = 0 THEN
    INSERT INTO _tst004_results VALUES ('CHECK-3b-parent-own', 'PASS', 'parent sees athlete A''s 2 sessions and athlete A record, 0 of athlete B''s');
    RAISE NOTICE 'CHECK-3b-parent-own PASS: parent sees linked athlete only';
  ELSE
    INSERT INTO _tst004_results VALUES ('CHECK-3b-parent-own', 'FAIL', 'own sessions=' || v_own_s || ' other sessions=' || v_other_s || ' own athlete=' || v_own_ath || ' other athlete=' || v_other_ath || ' (expected 2/0/1/0)');
    RAISE NOTICE 'CHECK-3b-parent-own FAIL: own/other sessions=%/% athlete=%/%', v_own_s, v_other_s, v_own_ath, v_other_ath;
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst004_results VALUES ('CHECK-3b-parent-own', 'FAIL', 'harness error: ' || SQLSTATE || ' ' || SQLERRM);
  RAISE NOTICE 'CHECK-3b-parent-own FAIL: harness error %: %', SQLSTATE, SQLERRM;
END $$;

COMMIT;

-- 3c. Anonymous (no JWT claims) — sees nothing in any assessment table.
BEGIN;
SET LOCAL ROLE anon;

DO $$
DECLARE v_s INT; v_r INT; v_d INT; v_ath INT;
BEGIN
  SELECT count(*) INTO v_s FROM assessment_sessions;
  SELECT count(*) INTO v_r FROM assessment_results;
  SELECT count(*) INTO v_d FROM assessment_derived_records;
  SELECT count(*) INTO v_ath FROM athletes;
  IF v_s = 0 AND v_r = 0 AND v_d = 0 AND v_ath = 0 THEN
    INSERT INTO _tst004_results VALUES ('CHECK-3c-anon-nothing', 'PASS', 'anonymous sees 0 sessions / 0 results / 0 derived / 0 athletes');
    RAISE NOTICE 'CHECK-3c-anon-nothing PASS: anonymous sees nothing';
  ELSE
    INSERT INTO _tst004_results VALUES ('CHECK-3c-anon-nothing', 'FAIL', 'sessions=' || v_s || ' results=' || v_r || ' derived=' || v_d || ' athletes=' || v_ath || ' (expected 0/0/0/0)');
    RAISE NOTICE 'CHECK-3c-anon-nothing FAIL: sessions=% results=% derived=% athletes=%', v_s, v_r, v_d, v_ath;
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst004_results VALUES ('CHECK-3c-anon-nothing', 'FAIL', 'harness error: ' || SQLSTATE || ' ' || SQLERRM);
  RAISE NOTICE 'CHECK-3c-anon-nothing FAIL: harness error %: %', SQLSTATE, SQLERRM;
END $$;

COMMIT;

-- ===========================================================================
-- CHECK 4 — Override plan (§5.4)
-- Expected: a development_plans row with status='finalized',
-- baseline_session_id NULL and a non-null override_reason INSERTS
-- successfully (the 004 CHECK fix — the pre-fix CHECK rejected
-- coach-override finalizations); a finalized row with NEITHER
-- baseline nor override is REJECTED with 23514.
-- ===========================================================================
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated", "aud": "authenticated"}';

-- 4a. Override plan inserts (baseline NULL, override_reason set).
DO $$
DECLARE v_ok BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO development_plans (id, athlete_id, status, finalized_by, baseline_session_id, override_reason, override_approved_by)
    VALUES ('50000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'finalized',
            'c0000000-0000-4000-8000-000000000001', NULL, 'TEST override — synthetic check data: baseline deferred, coach override for check.', 'c0000000-0000-4000-8000-000000000001');
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-4a-override-inserts', 'FAIL', 'override plan insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-4a-override-inserts FAIL: override plan insert failed: % %', SQLSTATE, SQLERRM;
  END;
  IF v_ok THEN
    INSERT INTO _tst004_results VALUES ('CHECK-4a-override-inserts', 'PASS', 'finalized override plan 50000000-...-0001 inserted (baseline NULL, override_reason set)');
    RAISE NOTICE 'CHECK-4a-override-inserts PASS: finalized override plan inserted';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-4a-override-inserts HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

-- 4b. Finalized plan with neither baseline nor override is REJECTED (23514).
DO $$
BEGIN
  BEGIN
    INSERT INTO development_plans (id, athlete_id, status, finalized_by, baseline_session_id, override_reason, override_approved_by)
    VALUES ('50000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'finalized',
            'c0000000-0000-4000-8000-000000000001', NULL, NULL, NULL);
    INSERT INTO _tst004_results VALUES ('CHECK-4b-neither-rejected', 'FAIL', 'finalized plan with neither baseline nor override SUCCEEDED but the CHECK should have rejected it (23514)');
    RAISE NOTICE 'CHECK-4b-neither-rejected FAIL: plan with neither baseline nor override succeeded';
    RETURN;
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _tst004_results VALUES ('CHECK-4b-neither-rejected', 'PASS', 'finalized plan with neither baseline nor override rejected with 23514 check_violation as expected');
    RAISE NOTICE 'CHECK-4b-neither-rejected PASS: plan with neither baseline nor override rejected with 23514';
  WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-4b-neither-rejected', 'FAIL', 'wrong error: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-4b-neither-rejected FAIL: wrong error %: %', SQLSTATE, SQLERRM;
  END;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-4b-neither-rejected HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

COMMIT;

-- ===========================================================================
-- CHECK 5 — Draft isolation (§5.5)
-- Expected: an assessment_drafts row (coach-only, no owner policy)
-- exists for athlete A but is INVISIBLE to the athlete and to the
-- parent, and never appears in assessment_sessions.
-- ===========================================================================

-- 5a. Coach creates the draft (adrft_coach ALL — own cohort).
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000001", "role": "authenticated", "aud": "authenticated"}';

DO $$
DECLARE v_ok BOOLEAN := false; v_n INT;
BEGIN
  BEGIN
    INSERT INTO assessment_drafts (id, athlete_id, battery, coach_id, entries, context, idempotency_key)
    VALUES ('40000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'generalAthleticAssessment',
            'c0000000-0000-4000-8000-000000000001',
            '[{"assessmentId": "10yd-sprint", "attempts": [2.01], "modified": false, "capped": false}]'::jsonb,
            '{"note": "TEST draft — synthetic check data."}'::jsonb, 'TEST-004-DRAFT-001');
    v_ok := true;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _tst004_results VALUES ('CHECK-5a-draft-created', 'FAIL', 'draft insert failed: ' || SQLSTATE || ' ' || SQLERRM);
    RAISE NOTICE 'CHECK-5a-draft-created FAIL: draft insert failed: % %', SQLSTATE, SQLERRM;
  END;
  IF v_ok THEN
    SELECT count(*) INTO v_n FROM assessment_drafts WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
    IF v_n = 1 THEN
      INSERT INTO _tst004_results VALUES ('CHECK-5a-draft-created', 'PASS', 'draft 40000000-...-0001 created and visible to the coach (proves it exists for the invisibility checks)');
      RAISE NOTICE 'CHECK-5a-draft-created PASS: draft created and visible to coach';
    ELSE
      INSERT INTO _tst004_results VALUES ('CHECK-5a-draft-created', 'FAIL', 'draft inserted but coach sees ' || v_n || ' drafts (expected 1)');
      RAISE NOTICE 'CHECK-5a-draft-created FAIL: coach sees % drafts', v_n;
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CHECK-5a-draft-created HARNESS FAIL: % %', SQLSTATE, SQLERRM;
END $$;

COMMIT;

-- 5b. Athlete A cannot see the draft.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000003", "role": "authenticated", "aud": "authenticated"}';

DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n FROM assessment_drafts WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  IF v_n = 0 THEN
    INSERT INTO _tst004_results VALUES ('CHECK-5b-athlete-no-draft', 'PASS', 'athlete A sees 0 drafts (draft exists — check 5a proved it)');
    RAISE NOTICE 'CHECK-5b-athlete-no-draft PASS: athlete sees no drafts';
  ELSE
    INSERT INTO _tst004_results VALUES ('CHECK-5b-athlete-no-draft', 'FAIL', 'athlete A sees ' || v_n || ' drafts (expected 0)');
    RAISE NOTICE 'CHECK-5b-athlete-no-draft FAIL: athlete sees % drafts', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst004_results VALUES ('CHECK-5b-athlete-no-draft', 'FAIL', 'harness error: ' || SQLSTATE || ' ' || SQLERRM);
  RAISE NOTICE 'CHECK-5b-athlete-no-draft FAIL: harness error %: %', SQLSTATE, SQLERRM;
END $$;

COMMIT;

-- 5c. Parent cannot see the draft either.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub": "a0000000-0000-4000-8000-000000000002", "role": "authenticated", "aud": "authenticated"}';

DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n FROM assessment_drafts WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  IF v_n = 0 THEN
    INSERT INTO _tst004_results VALUES ('CHECK-5c-parent-no-draft', 'PASS', 'parent sees 0 drafts (draft exists — check 5a proved it)');
    RAISE NOTICE 'CHECK-5c-parent-no-draft PASS: parent sees no drafts';
  ELSE
    INSERT INTO _tst004_results VALUES ('CHECK-5c-parent-no-draft', 'FAIL', 'parent sees ' || v_n || ' drafts (expected 0)');
    RAISE NOTICE 'CHECK-5c-parent-no-draft FAIL: parent sees % drafts', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst004_results VALUES ('CHECK-5c-parent-no-draft', 'FAIL', 'harness error: ' || SQLSTATE || ' ' || SQLERRM);
  RAISE NOTICE 'CHECK-5c-parent-no-draft FAIL: harness error %: %', SQLSTATE, SQLERRM;
END $$;

COMMIT;

-- 5d. The draft never appears in assessment_sessions (absolute count,
-- run as postgres so RLS cannot hide anything).
DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n FROM assessment_sessions WHERE id = '40000000-0000-4000-8000-000000000001';
  IF v_n = 0 THEN
    INSERT INTO _tst004_results VALUES ('CHECK-5d-draft-not-a-session', 'PASS', 'draft id 40000000-...-0001 appears in 0 assessment_sessions rows');
    RAISE NOTICE 'CHECK-5d-draft-not-a-session PASS: draft is not a session';
  ELSE
    INSERT INTO _tst004_results VALUES ('CHECK-5d-draft-not-a-session', 'FAIL', 'draft id appears in ' || v_n || ' assessment_sessions rows (expected 0)');
    RAISE NOTICE 'CHECK-5d-draft-not-a-session FAIL: draft id appears in % sessions', v_n;
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst004_results VALUES ('CHECK-5d-draft-not-a-session', 'FAIL', 'harness error: ' || SQLSTATE || ' ' || SQLERRM);
  RAISE NOTICE 'CHECK-5d-draft-not-a-session FAIL: harness error %: %', SQLSTATE, SQLERRM;
END $$;

-- ===========================================================================
-- SANITY — absolute counts as postgres (RLS bypassed): proves the rows
-- the visibility checks claim are hidden actually EXIST, so a zero
-- from a scoped role is RLS doing its job, not missing data.
-- ===========================================================================
DO $$
DECLARE v_s INT; v_r INT; v_d INT; v_dft INT; v_p INT;
BEGIN
  SELECT count(*) INTO v_s FROM assessment_sessions WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_r FROM assessment_results WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_d FROM assessment_derived_records WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_dft FROM assessment_drafts WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_p FROM development_plans WHERE athlete_id = 'd0000000-0000-4000-8000-000000000001';
  IF v_s = 2 AND v_r = 1 AND v_d = 1 AND v_dft = 1 AND v_p = 1 THEN
    INSERT INTO _tst004_results VALUES ('SANITY-absolute-counts', 'PASS', 'absolute: athlete A has 2 sessions / 1 result / 1 derived / 1 draft / 1 plan');
    RAISE NOTICE 'SANITY-absolute-counts PASS: absolute counts 2/1/1/1/1';
  ELSE
    INSERT INTO _tst004_results VALUES ('SANITY-absolute-counts', 'FAIL', 'absolute: sessions=' || v_s || ' results=' || v_r || ' derived=' || v_d || ' drafts=' || v_dft || ' plans=' || v_p || ' (expected 2/1/1/1/1)');
    RAISE NOTICE 'SANITY-absolute-counts FAIL: sessions=% results=% derived=% drafts=% plans=%', v_s, v_r, v_d, v_dft, v_p;
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _tst004_results VALUES ('SANITY-absolute-counts', 'FAIL', 'harness error: ' || SQLSTATE || ' ' || SQLERRM);
  RAISE NOTICE 'SANITY-absolute-counts FAIL: harness error %: %', SQLSTATE, SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- SUMMARY — one row per check. All 17 rows must be PASS.
-- ---------------------------------------------------------------------------
SELECT check_id, status, detail, checked_at FROM _tst004_results ORDER BY check_id;
SELECT count(*) FILTER (WHERE status = 'PASS') AS pass_count,
       count(*) FILTER (WHERE status = 'FAIL') AS fail_count,
       count(*) AS total FROM _tst004_results;
