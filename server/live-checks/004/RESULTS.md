# §5 live functional checks — RESULTS (run 2026-11-13)

**Verdict: 17/17 PASS. Cleanup PASS. Project back to its pre-check state.**

- Live project: TheProgramOS (`rkgdwqgmldznczikrjip`), Postgres 15.8.1.50.
- Run: 2026-11-13, 09:06–09:15 PT, dashboard SQL editor, signed in as
  `baileyventuresos-create` (session already active). Marcus approved this
  run the same day.
- Scripts: `01-setup-synthetic-data.sql` → `02-checks.sql` →
  `03-cleanup.sql`, pasted verbatim, in order. No other SQL run except the
  read-only verification re-runs noted below. No GRANT run or needed.
- Branch: `feature/universal-assessment-reassessment-v1`, recorded here;
  `main` untouched; migrations 001–005 not edited by this run.

## Step 1 — setup

Pre-flight PASSED (26 tables / 15 definitions / 72 policies / 0 app rows /
0 test auth users). Fixtures created and verified: auth.users 4, app_users
4, athletes 2, cohorts 2, enrollments 2, guardian links 1.

## Step 2 — checks

Both pre-flights PASSED (fixtures 2 athletes / 1 coach / 4 app_users;
**grants pre-flight PASSED** — `authenticated`/`anon` hold the SELECT/INSERT
grants the checks need, so live INSERT grants DO exist; the 30 Oct 2026
auto-grant change did not leave this project ungranted. No GRANT was run.)

Final aggregate: **pass_count 17, fail_count 0, total 17.**

| Check | Result |
|---|---|
| 1a first insert (key TEST-004-IDEMPOTENCY-001) | PASS |
| 1b duplicate rejected (23505 unique_violation) | PASS |
| 1c retry no-op (ON CONFLICT inserts 0; key → original session) | PASS |
| 2a out-of-cohort denied (42501) | PASS |
| 2b own-cohort insert | PASS |
| 2c own-cohort result (10yd-sprint) | PASS |
| 2d own-cohort derived observation | PASS |
| 3a athlete A sees own 2/1/1, 0 of B's | PASS |
| 3b parent sees A's 2 sessions and A, 0 of B's | PASS |
| 3c anonymous sees 0/0/0/0 | PASS |
| 4a override plan inserts (baseline NULL + override_reason) | PASS |
| 4b neither baseline nor override rejected (23514) | PASS |
| 5a draft created, visible to coach | PASS |
| 5b athlete sees 0 drafts | PASS |
| 5c parent sees 0 drafts | PASS |
| 5d draft id in 0 assessment_sessions rows | PASS |
| SANITY absolute counts (A: 2 sessions / 1 result / 1 derived / 1 draft / 1 plan) | PASS |

## Step 3 — cleanup

**CLEANUP PASS**: 26 public tables / 15 definitions / 72 policies /
0 total app rows / 0 test auth users. Per-table verification: all 25
application tables 0 rows each. No test data remains.

## Honest limits on this evidence

- The dashboard SQL editor displays only the last result set of a
  multi-statement run and does not surface RAISE NOTICE output, so the
  17-row summary SELECT and the scripts' PASS notices were not directly
  visible. The authoritative verdict is the checks run's final aggregate
  (17/0/17), plus the per-check verdicts recorded by the script's own
  harness (each check writes PASS/FAIL into the temp results table; the
  aggregate counts those rows).
- The temp results table (`_tst004_results`) does not survive across runs
  (fresh pooled connection per Run), so a later re-query returns 42P01.
  No re-run of the checks was attempted — they are not idempotent
  (1a would fail on the already-created session).
- To capture the exact numbers, the browser task re-ran read-only SELECTs
  copied verbatim from the scripts themselves (setup verification counts
  and cleanup aggregate counts, combined with UNION ALL into a single
  result set). No other SQL was run.
- The dashboard's destructive-operations warning for the checks run (temp
  results table created without RLS) was dismissed with "Run without RLS",
  which runs the script exactly as written; enabling RLS on the temp table
  would have broken the impersonated blocks' verdict writes.
- Same honest limit as checks A/B/C: JWT-claim impersonation proves the
  policy logic against the claim, not the end-to-end login → JWT issue
  path; the true two-connection race is proven by the unique index itself
  (check 1b), not by concurrent connections.

## What this closes

- Plan §5 (docs/MIGRATION_EXECUTION_PLAN.md) is now DONE for migration 004.
- The grants question is settled live: INSERT grants exist; no GRANT
  action is needed for the assessment tables.
- The 004 CHECK fix is proven live: a finalized plan with baseline NULL
  and an override_reason inserts; without either it is rejected.
