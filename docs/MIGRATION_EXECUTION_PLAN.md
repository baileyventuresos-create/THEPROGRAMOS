# Migration Execution Plan — 004 (assessment + reassessment)

Status: PLAN ONLY. Nothing in this document has been applied.
Applying migration 004 to Supabase project TheProgramOS is a
separate owner decision (`docs/MORNING_DECISIONS.md` §11).

## 0. Target

- Project: **TheProgramOS**, ref `rkgdwqgmldznczikrjip`,
  organization BigWiffWiffleBallLeague (Pro), region us-east-2,
  Postgres **15.8.1.50**.
- File: `server/migrations/004_assessment_reassessment.sql`
  (branch `feature/universal-assessment-reassessment-v1`).
- Method used previously for 001–003: dashboard SQL editor, signed
  in with GitHub as `baileyventuresos-create`. Use the same session
  and method; do not use a different project, branch, or connection.

## 1. Migration order and dependencies

Correct order is **001 → 002 → 003 → 004**. 001–003 are already
applied and verified live (see §2). 004 depends on:

- 001: `athletes` and `coaches` tables (foreign keys for schedules,
  deferrals, drafts, plans).
- 002: `assessment_definitions` and `assessment_sessions` tables
  (the `kind` column, the `idempotency_key` column, the GAA seed).
- 003: the RLS helpers `app_role()`, `is_my_cohort_athlete()`,
  `is_my_athlete()` (used by every 004 policy).

004 is transactional (`BEGIN;` … `COMMIT;`) and idempotent where
practical (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING` /
`DROP POLICY IF EXISTS`), so a failed run rolls back and a
re-run is safe.

## 2. Pre-checks (read-only — run before applying anything)

Confirm the live project is in the state the earlier verification
left it (22 tables, 58 policies, 10 definitions, 0 rows):

```sql
-- 001–003 state: expect 22 public tables
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
-- expect 10 assessment definitions (engine V1 seed)
SELECT count(*) FROM assessment_definitions;
-- expect 58 policies across public tables
SELECT count(*) FROM pg_policies WHERE schemaname = 'public';
-- 004 must NOT be applied yet: expect 0 rows (table must not exist)
SELECT to_regclass('public.assessment_schedules');
SELECT to_regclass('public.development_plans');
SELECT to_regclass('public.assessment_drafts');
-- RLS helpers from 003 must exist
SELECT proname FROM pg_proc WHERE proname IN ('app_role', 'is_my_cohort_athlete', 'is_my_athlete');
```

STOP if any pre-check disagrees (different table/policy counts,
004 tables already present, helpers missing). Do not apply 004
into an unexpected state; report the discrepancy instead.

## 3. Apply 004

1. Open the file at the branch head and confirm it is the reviewed
   version (header says `STATUS: NOT APPLIED`; the
   `development_plans` CHECK reads `OR override_reason IS NOT
   NULL`; the file contains `assessment_drafts` and the
   `asess_coach_write` / `ares_coach_write` / `ader_coach_write`
   policies).
2. Paste the whole file into the dashboard SQL editor and run it.
   It runs as a single transaction; a failure anywhere rolls the
   whole migration back.
3. If the editor reports an error, do NOT re-run blindly: read the
   error, check the pre-checks in §2 again (the transaction rolled
   back, so state should be unchanged), and fix the cause before
   retrying.

## 4. Verification queries (read-only, run after a successful apply)

```sql
-- expect 26 public tables (22 + schedules, deferrals, drafts, plans)
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
-- expect 15 assessment definitions (10 V1 + 5 GAA)
SELECT count(*) FROM assessment_definitions;
SELECT id, kind, direction, aggregation FROM assessment_definitions
  WHERE id IN ('5-10-5-shuttle','single-leg-balance-r','single-leg-balance-l',
               '6min-walk-run','movement-assessment');
-- expect 72 policies (58 + 14 new in 004)
SELECT count(*) FROM pg_policies WHERE schemaname = 'public';
-- RLS enabled on every new table
SELECT tablename, rowsecurity FROM pg_tables
  WHERE schemaname = 'public'
  AND tablename IN ('assessment_schedules','assessment_deferrals','assessment_drafts','development_plans');
-- idempotency unique index exists
SELECT indexname FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'uq_asess_idempotency';
-- the plan CHECK allows an override-finalized plan (the 004 fix)
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conrelid = 'public.development_plans'::regclass AND contype = 'c';
-- expect 0 rows everywhere new (no data was seeded or moved)
SELECT (SELECT count(*) FROM assessment_schedules)
     + (SELECT count(*) FROM assessment_deferrals)
     + (SELECT count(*) FROM assessment_drafts)
     + (SELECT count(*) FROM development_plans) AS new_rows;
```

Expected results: 26 tables, 15 definitions (movement-assessment
`kind='observation'`, `direction` NULL, `aggregation='none'`),
72 policies, RLS on all four new tables, the idempotency index
present, the CHECK mentioning `override_reason`, 0 new rows.

## 5. Functional checks after apply (separate approval + cleanup)

The counts in §4 prove the schema landed; they do not prove the
workflow behaves. Before any real use, run the live checks that
were used for 001–003 (recorded in `docs/SUPABASE_HANDOFF.md`):
reserve-seat-style gate checks are already proven; the
assessment-specific live checks are:

1. Idempotency: record the same synthetic session twice with one
   idempotency key → one session row, second call returns the first.
2. Coach scope: a coach JWT for an athlete outside their cohort
   cannot INSERT into `assessment_sessions` (RLS denies it);
   the same coach CAN insert for their own cohort athlete.
3. Athlete scope: an athlete JWT can SELECT their own rows and
   cannot SELECT another athlete's rows; anonymous gets nothing.
4. Override plan: a `development_plans` row with
   `status='finalized'`, `baseline_session_id` NULL and a non-null
   `override_reason` inserts successfully (the CHECK fix); a
   finalized row with neither is rejected.
5. Draft isolation: an `assessment_drafts` row is invisible to the
   athlete/parent role (no owner policy) and never appears in
   `assessment_sessions`.

These checks write test rows into the live project. They need
Marcus's explicit approval for the live step, must use synthetic
data only, and every test row must be deleted afterwards with the
project verified back to 0 rows — exactly as checks A/B/C were
run and cleaned up for 001–003.

## 6. Rollback notes

- 004's commented rollback block (at the end of the file) is for
  local dev only. It drops the new policies, the idempotency
  index/column, and the four new tables, and deletes the five
  seeded definitions. **Never run it against the live project
  once real data exists** — dropping `development_plans` or
  `assessment_deferrals` would destroy real records, and there
  is no restore except the project's daily backup.
- The safe rollback for a failed apply is the transaction itself:
  a failure inside `BEGIN;` … `COMMIT;` rolls everything back.
  A successful apply is rolled forward, not back: fix forward
  with a new additive migration (005), never by editing 004
  after it has been applied.
- The two CHECKs dropped and re-issued on
  `assessment_definitions` are left in place by the rollback
  block; re-applying 004 after a local rollback is idempotent.

## 7. Destructive-operation audit (migrations 001–004)

Grepped and read in full, 2026-11-12:

- **No `DROP TABLE`, `DROP COLUMN`, `DELETE FROM`, or `TRUNCATE`
  in the executable body of any migration.** The only DROP
  statements are `DROP POLICY IF EXISTS` (idempotent re-run
  pattern, policies only) and, in 004, `DROP CONSTRAINT` on two
  auto-named CHECKs on `assessment_definitions`, re-issued
  immediately after with the relaxed definitions.
- 004's `ALTER TABLE assessment_definitions ALTER COLUMN direction
  DROP NOT NULL` only relaxes a constraint; it deletes nothing.
- 001's and 003's commented rollback blocks contain DROP/DELETE
  statements as documentation only; they are comments, not
  executable SQL, and must never be run against live data.
- 004 adds four tables, two columns, one index, and fourteen
  policies. It seeds five definition rows with
  `ON CONFLICT DO NOTHING`. It does not alter or delete any
  existing row.
