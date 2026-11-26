# Apply migration 005 — live run (approved 2026-11-13)

Run order (paste each file, in order, into the Supabase dashboard SQL
editor, project TheProgramOS `rkgdwqgmldznczikrjip`):

1. `00-precheck-005.sql` — must PASS before anything is applied.
2. `server/migrations/005_unified_athlete_age_and_result_flags.sql` — the
   migration itself, pasted verbatim.
3. `01-verify-005.sql` — post-apply checks + cleanup of its own test rows.

## What 005 changes (and nothing else)

- `athletes.age_years`: the 19 maximum is removed; the CHECK becomes
  `age_years >= 5` (floor kept as a data-sanity guard). No upper bound.
  Cohort age bands are unchanged (per-cohort eligibility, not divisions).
- `assessment_results.modified` / `.capped`: BOOLEAN NOT NULL DEFAULT
  FALSE. No new tables, no policy changes, no seed data, no rows
  deleted or rewritten. The only DROP in the file is the old CHECK
  constraint itself (matched by definition, inside the DO block); the
  commented-out rollback lines are never executed.

## Expected results

- Pre-check: 26 tables / 15 definitions / 72 policies / 0 app rows /
  0 test auth users; 4 four-004 tables; 4 RLS helpers; old age CHECK
  (19 max) present; modified/capped absent; `uq_asess_idempotency`
  present.
- Verify: 9 verdicts, all PASS — V1 counts unchanged (26/15/72/0),
  V2 flag columns (BOOLEAN NOT NULL DEFAULT FALSE), V3 age CHECK
  `>= 5` with no 19, V4 no division column, V5 age-48 + age-12 athletes
  in one table, V6a age 5 inserts / V6b age 4 rejected (23514), V7a
  result with flags round-trips / V7b omitted flags default FALSE,
  V8 72 policies with all 25 assessment policies by name. Cleanup
  PASS back to 26/15/72/0.

## Stop conditions

- Pre-check fails: STOP. Do not apply 005 into an unexpected state.
- Any verify verdict FAILs: finish reading the summary, then check
  whether cleanup ran (it is part of 01-verify-005.sql, after the
  summary) before diagnosing.
- No Edge Function deploy, merge, production deploy, or unrelated
  change in this run — application + verification only.

## Honest limits (same as §5)

- The dashboard SQL editor displays only the last result set and does
  not surface RAISE NOTICE output; the verdict is the verify run's
  aggregate (pass/fail/total) plus the cleanup notice. The temp results
  table does not survive across runs.
- V5–V7 run as postgres (RLS bypassed): they prove the CHECK and the
  columns, not a role-scoped policy path. Policy behavior itself was
  proven live by the §5 checks (17/17, 2026-11-13); V8 proves the
  policies are unchanged by 005 (same 72, same 25 assessment policies
  by name).
