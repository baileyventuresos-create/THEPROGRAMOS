# Migration 005 — APPLIED + VERIFIED (run 2026-11-13)

**Verdict: applied and verified. Project clean at 26 tables / 15 definitions /
72 policies / 0 app rows / 0 test auth users.**

- Live project: TheProgramOS (`rkgdwqgmldznczikrjip`), Postgres 15.8.1.50.
- Run: 2026-11-13, 12:13–12:26 PT, dashboard SQL editor, signed in as
  `baileyventuresos-create` (session had expired; GitHub OAuth re-sign-in).
  Marcus approved the application + verification the same day.
- Branch: `feature/universal-assessment-reassessment-v1`; `main` untouched;
  no Edge Function deploy, no merge, no production deploy.
- Regression suite at run time: 181/181 passing.

## Step 1 — pre-check (00-precheck-005.sql): PASS

Ran with "Success. No rows returned", no exception: 26 tables / 15
definitions / 72 policies / 0 app rows / 0 test auth users; 4 four-004
tables; 4 RLS helpers; old age CHECK (19 max) still in place;
modified/capped absent; `uq_asess_idempotency` present.

## Step 2 — migration 005: APPLIED

Pasted verbatim, ran with "Success. No rows returned" (BEGIN...COMMIT,
no error). The 19-year-old maximum is removed; `modified` / `capped`
added to `assessment_results`.

## Step 3 — verify (01-verify-005.sql): RAN TO COMPLETION, no error

Schema effects re-verified directly through the dashboard UI (read-only):
26 public tables; 15 assessment definitions; 72 public policies
(numbered 1/72–72/72, including all 25 named assessment policies);
athletes, app_users, coaches, assessment_sessions, assessment_results
all empty; Authentication Users page: "No users in your project".
Table definitions confirm: `assessment_results` has
"modified boolean not null default false" and "capped boolean not null
default false"; `athletes` has
"constraint athletes_age_years_check check ((age_years >= 5))" and no
division column. Cleanup confirmed (test_auth_users_remaining = 0).

## Evidence gap in step 3 — and how it was closed

The dashboard SQL editor shows only the LAST result set of a
multi-statement run, so 01-verify-005.sql's per-check summary grid
(V1–V8 verdicts) was never visible — and because its checks record
FAILs instead of aborting, "ran without error" alone did not prove
they passed. The summary table is a temp table that does not survive
across runs, so it could not be re-read, and re-running the script
would show the same last result set.

The schema-level verdicts (V1–V4, V8) were instead proven by the direct
UI re-verification above. The behavioral verdicts (V5–V7) were re-run
in `02-verify-behavioral.sql`, which puts the summary SELECT last so
the editor displays it. That run (12:25–12:26 PT) returned the visible
grid below — 6/6 PASS:

| check_id | status | detail |
|---|---|---|
| CLEANUP-back-to-26-15-72-0 | PASS | 26 tables / 15 definitions / 72 policies / 0 app rows / 0 test auth users |
| V5-adult-athlete | PASS | age-48 adult and age-12 youth both stored in the same athletes table |
| V6a-floor-age5 | PASS | age 5 inserts (floor kept as sanity guard) |
| V6b-floor-age4-rejected | PASS | age-4 insert rejected with 23514 check_violation (floor kept) |
| V7a-record-with-flags | PASS | session + result with modified=true, capped=true round-trip; attempts JSONB untouched |
| V7b-defaults-false | PASS | result omitting flags retrieved as modified=false, capped=false (defaults) |

## What this closes

- Migration 005 is APPLIED and VERIFIED live. §15 decision is now DONE.
- Unified athlete system is live in the schema: no age maximum, floor
  of 5 kept, no divisions, `modified`/`capped` present with correct
  defaults. Edge Function deploy prerequisites (004 + 005) are now
  both met at the schema level — deploy itself still needs separate
  approval.
- Harness lesson (recorded for future live runs): put the summary
  SELECT last in any multi-statement verification script, or the
  dashboard will hide the verdicts. 02-verify-behavioral.sql is the
  corrected pattern; the §5 scripts have the same limitation and
  their verdicts rest on the aggregate counts, as recorded in
  server/live-checks/004/RESULTS.md.
