# Phase 4 Test Report — Full Assessment Workflow Testing

Mission: THE PROGRAM OS — Complete Assessment Integration & Release Readiness.
Branch: `feature/universal-assessment-reassessment-v1`, head at time of writing: see
`git log` (Phase 4 commits on top of Phase 3's `2fb6cab`).

Method: every scenario below is exercised by executable tests (Node built-in
runner), not by a checklist. Synthetic data only, isolated environments only
(memory stores, throwaway dev server on an ephemeral localhost port). Nothing
touched the live Supabase project, and no process was left running.

## Regression baseline

| Run | Result |
|---|---|
| Baseline at Phase 3 head `2fb6cab` (re-run by Phase 4) | 246 tests, 246 pass, 0 fail |
| Full suite after Phase 4 additions | **249 tests, 249 pass, 0 fail** |
| Edge Function tests alone | 27 / 27 |
| Dev-server (real HTTP) tests alone | 10 / 10 |
| Reassessment + progress + baseline-gating + Smart Draft | 31 / 31 |

Command: `npm test` (`node --test server/tests/*.test.js
assessment-engine/assessment-engine.test.js`). No failures were found in
Phase 4 — new or pre-existing — so nothing was fixed by weakening or
removing a test, and no pre-existing failure exists to document.

Typecheck/lint/build: the repo has no such scripts (confirmed in Phase 1;
`package.json` has only `test` and `dev`). Phase 3 ran
`tsc --noEmit --strict` on the five Edge Function `.ts` files with stubs
in `/tmp`; Phase 4 touched no `.ts` file, so no tsc re-run was required.

## Scenario results

### 1. Youth (12) and adult (48) full assessments — PASS
- `assessment-workflow.test.js`: adult start → partial save → resume →
  complete; youth modified push-ups baseline with youth caveat and
  parent view.
- `adult-validation.test.js` (4): synthetic 48-year-old wingback
  baseline, 28-day due date, reassessment, progress, plan; retry cannot
  duplicate the session; youth/adult accommodations differ for the same
  test.
- `unified-athlete-005.test.js` (12): adult ages 5+ run the same paths
  as youth; age 12 works identically with the under-18 caveat; cohort
  age bands preserved.
- `assessment-battery.test.js` (8): exactly the 8 mission tests, complete
  standardized protocols, age-appropriate alternatives, no invented
  norms/medical thresholds.

### 2. Incomplete → save → resume → complete; baseline; +28d — PASS
- `assessment-workflow.test.js`: adult partial save, resume, complete —
  baseline established, draft deleted, next due exactly +28 days.
- `dev-server.test.js` (10): same flow over real HTTP
  (`startAssessment` → `recordAttempts` → `getDraft` → `completeAssessment`
  → `athleteAssessmentView` → `planReadiness` → `createPlan` →
  `finalizePlan`), plus incomplete completion refused with the missing
  list and nothing stored.

### 3. Coach overrides — PASS
- `baseline-gating.test.js` (7): gate is plan-finalization only; no
  baseline → not finalizable; explicit recorded override finalizes; a
  silent one does not.
- `assessment-workflow.test.js`: plan gated without baseline, finalized
  with baseline, override recorded.
- `dev-server.test.js`: `finalizePlan` on an unready plan refused
  (`PLAN_NOT_READY`), then finalized with a recorded override reason.
- `edge-function.test.js`: plan finalization refuses an unready plan
  without an override (409) through the real Edge HTTP handler.

### 4. 28-day scheduling; approaching/due/overdue/deferred; exclusion — PASS
- `reassessment.test.js` (9): next due exactly 28 days after completion;
  status transitions never-assessed → not-due → approaching → due →
  overdue; active deferral pauses the schedule, expired one does not;
  missed assessment stays overdue until completed or deferred; baseline
  completeness rule (every GAA test recorded, modified, excluded, or
  deferred); dashboard reminders bucket athletes correctly; deferrals
  require coach approval, a reason, and a future date.
- `assessment-workflow.test.js`: overdue stays overdue until completed
  or deferred; deferral flips it to deferred; exclusion lets a baseline
  complete without the unsafe test.
- `dev-server.test.js`: seeded dashboard buckets (youth due, wingback
  overdue, six never-assessed); exclusion over HTTP.

### 5. Personal bests + progress comparisons (baseline/previous/current) — PASS
- `progress.test.js` (8): direction-correct improvement, exact
  percentage math, zero-baseline reports absolute change only (no
  invented percent), PB tracks the best result across all history,
  maintenance band, baseline-only / no-data states, youth growth
  caveat on under-18 results only, athlete summary counts.
- `assessment-workflow.test.js`: 28-day reassessment — progress
  improved, PBs updated, next due set.
- `assessment-ui.test.js`: history renders baseline, PBs, comparisons,
  and the youth caveat.

### 6. Athlete + parent visibility; unauthorized access refused — PASS
- `assessment-workflow.test.js`: athlete sees only self, parent only
  own, coach only own cohort, anon nothing.
- `assessment-api.test.js` (5): role table (recording is coach/director
  only); unauthenticated rejected on every method; out-of-cohort coach
  forbidden; client-supplied actor ignored (recorded coach is always
  the auth UID).
- `dev-server.test.js`: out-of-scope access forbidden over HTTP
  (wrong-coach start, athlete viewing another athlete, parent write).
- `edge-function.test.js`: unauthenticated / out-of-cohort /
  forged-actor refusals with the same codes as the Node server.
- `assessment-ui.test.js`: parent role narrows the roster and hides
  recording.

### 7. Duplicate submissions — PASS
- `assessment-workflow.test.js`: idempotent retry of completion returns
  the original session, inserts nothing.
- `dev-server.test.js`: replay with the same idempotency key returns
  `idempotentReplay: true` and the same session id; history has one
  session.
- `edge-function.test.js`: duplicate completions replay idempotently
  (exactly one session) through the real Edge HTTP handler; idempotency
  key written and found again.
- `adult-validation.test.js`: retrying the baseline recording cannot
  duplicate the session.

### 8. Network interruptions + retries — PASS (new in Phase 4)
- NEW `server/tests/phase4-interruption.test.js` (3) — the one genuine
  coverage gap Phase 4 found. The client-level retry tests
  (`assessment-client.test.js`, 11) use a stubbed fetch and the
  workflow tests call the workflow directly; neither proved the two
  halves compose. The new tests use the real `AssessmentClient`
  against the real dev server over real HTTP, with a fetch wrapper
  that faults exactly one attempt:
  1. **Lost complete response** — the first `completeAssessment`
     request reaches the server and is processed, then the response
     is dropped before the client sees it. The client retries with
     the same idempotency key; the retry replays the original
     session (`idempotentReplay: true`); history has exactly one
     session with the replayed session id; baseline complete; all
     nine measured results present, nothing partial. Both attempts
     carried the identical key (asserted from the captured request
     bodies).
  2. **HTTP 500 on the first complete attempt** — answered 500
     without reaching the server; the client retries and records
     exactly once (`idempotentReplay: false`, one session).
  3. **Lost draft-save response** — the first `recordAttempts`
     request is processed then its response dropped; the retry
     replays the same draft (three entries, no duplicate draft);
     the workflow then completes normally to exactly one session.
- "Retries exhausted → last error thrown" and "application errors /
  HTTP 400 never retried" remain covered in `assessment-client.test.js`.
- "Invalid attempts rejected at completion, not stored" and
  "incomplete completion refused, nothing stored" remain covered in
  `assessment-workflow.test.js` / `dev-server.test.js`.

### 9. Modified/capped attempts, recorded and displayed end to end — PASS
- `unified-athlete-005.test.js`: modified/capped flags round-trip
  through the store on the same record path.
- `edge-function.test.js`: `modified`/`capped` survive the PostgREST
  round-trip end to end through the real Edge HTTP handler, on both
  the memory-store and PostgREST paths (regression assertions for
  the Phase 3 `bed566d` fix: `loadData` had dropped
  `capped`/`attempts`/`unit` from history).
- `assessment-workflow.test.js`: youth modified push-ups baseline.
- `assessment-ui.test.js`: `fmtResult(120, 'sec', { capped: true })`
  renders `120.00 sec (capped)`; NEW in Phase 4 — a capped entry was
  added to the `renderHistory` fixture and the test now asserts the
  history view renders `120.00 sec (capped)`, proving the bed566d
  display path end to end in the UI (previously only `(modified)` was
  asserted in a rendered session).

### 10. Smart Draft advisory-only — PASS
- `smart-draft-adapter.test.js` (7): every advisory output carries the
  advisory-only contract; a single poor result flags one priority at
  low confidence and nothing else; no trend means insufficient
  evidence, not a fabricated priority.
- `assessment-workflow.test.js`: a single declining result is
  low-confidence advisory only; no plan is ever rewritten.
- `edge-function.test.js`: `advisoryOnly: true, autoRewrite: false`,
  and the draft writes nothing.

### 11. Phase 2 UI paths over real HTTP via the dev server — PASS
- `dev-server.test.js` (10), re-run in Phase 4: serves the prototype
  and the assessment UI scripts; battery route returns the real GAA
  protocol; role-scoped `listAthletes`; seeded dashboard buckets;
  full coach workflow over HTTP; incomplete completion refused;
  exclusion; override gate; out-of-scope access forbidden; unknown
  method / malformed JSON / traversal rejected.
- Each test file starts its own dev server on an ephemeral localhost
  port and closes it in `after()`; verified after the run that no
  dev-server process remained and nothing was left listening.

### 12. Full regression — PASS
- `npm test`: 249 tests, 249 pass, 0 fail, 0 skipped.
- No `.ts` files were touched in Phase 4, so the Phase 3
  `tsc --noEmit --strict` result stands (clean on all five Edge
  Function files, Deno + `esm.sh` stubbed in `/tmp`).

## Failures
- **New failures: none.** The 3 new interruption tests passed on first
  run; the capped-display assertion passed on first run.
- **Pre-existing failures: none.** The suite was green at the Phase 3
  head (246/246) and stayed green.
- **Fixes in Phase 4: none required.** No production or test code was
  changed to make anything pass; only tests were added.

## What remains unverified (carried over, not new)
- **Real-browser render** — the UI is exercised via stubbed globals +
  HTTP; no headless browser exists in this environment. A first manual
  browser pass over the dev-server URL is still needed before real use.
- **Deno runtime behavior** — `deno check` / `supabase functions serve`
  cannot run here; they are steps 1–2 of
  `docs/EDGE_FUNCTION_DEPLOY_STEPS.md`, to run on the deploy machine.
- **RLS against the Edge Function** — the fake client does not enforce
  RLS; live RLS was verified separately in the §5 checks.
- **The deployed function against live Supabase** — needs the deploy
  approval plus a real coach-JWT smoke test (scripted in the deploy doc).
- **Decision §14** — the stale Assessments-view copy ("not being
  collected today", "~12 weeks") still sits below the live section
  that contradicts it; the copy refresh should be decided before any
  real use.
- **Migration 005's SQL file header** still says "NOT APPLIED" (stale
  file text — it was applied via the dashboard; left untouched as the
  applied artifact). Recorded in Phase 3, not fixed.
