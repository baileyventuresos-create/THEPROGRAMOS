# Edge Function — Deploy Steps (assessment-api)

**STATUS: NOT DEPLOYED. These steps are written for a future,
separately approved deploy. No deploy command in this document has
been run; no Supabase CLI exists in the authoring environment, so
the commands below are the documented Supabase CLI flow, not a
transcript of a run. Do not run them without Marcus's explicit
approval for the deploy step itself.**

Function: `assessment-api` in Supabase project TheProgramOS
(ref `rkgdwqgmldznczikrjip`, us-east-2).
Branch: `feature/universal-assessment-reassessment-v1`
(prerequisite: the release sequence merges PR #2 then PR #3 first,
or the deploy runs from this branch — the function code lives on
this branch, not on `main`).

## 0. Prerequisites — all met (verify each before deploying)

| # | Prerequisite | Evidence |
|---|---|---|
| 1 | Migration 004 applied + verified | 26 tables / 15 definitions / 72 policies / 0 rows — `server/live-checks/004/RESULTS.md` |
| 2 | Migration 005 applied + verified | Same counts; `modified` / `capped` columns present; age CHECK `age_years >= 5`; behavioral re-check 6/6 PASS — `server/live-checks/005/RESULTS.md` |
| 3 | Full regression suite green | `npm test` — 249/249 (2026-11-14, incl. 27 Edge Function tests in `server/tests/edge-function.test.js` + 3 interruption tests in `server/tests/phase4-interruption.test.js`) |
| 4 | Typecheck clean | `tsc --noEmit --strict` on the five `.ts` files (Deno + `esm.sh` stubbed; stubs live only in the check setup, not the repo) |
| 5 | Workflow bundle generates | `node build.mjs` in `supabase/functions/assessment-api` writes `vendor/workflow.bundle.mjs` (84.3 kB; factories + battery exports) |
| 6 | `verify_jwt = true` | `supabase/config.toml` (`[functions.assessment-api]`) — platform verifies the JWT before the function runs |
| 7 | No secrets needed | The function uses only `SUPABASE_URL` + `SUPABASE_ANON_KEY`, which Supabase injects into Edge Functions automatically. **Do not set a service-role key on this function** — it must never bypass RLS |

**Still NOT run before any deploy (environment gaps, not blockers
in the code):** `deno check` and `supabase functions serve` — no
Deno or Supabase CLI in the authoring environment. Run both on the
deploy machine as step 1–2 below; stop the deploy if either fails.

## 1. Prepare (deploy machine — needs Deno + Supabase CLI)

```sh
cd theprogramos
git checkout feature/universal-assessment-reassessment-v1
git pull --ff-only

# Static checks the authoring environment could not run:
deno check supabase/functions/assessment-api/index.ts
supabase functions serve assessment-api   # start, curl the battery route below, stop

# Generate the workflow bundle (required — the function fails loudly
# without it) and confirm the battery exports are present:
cd supabase/functions/assessment-api
node build.mjs
node -e "import('./vendor/workflow.bundle.mjs').then(m => console.log(Object.keys(m).sort().join(',')))"
# expected: BATTERY_ID,GAA_TESTS,PROTOCOL_VERSION,RETEST_DAYS,createAccessDirectory,createAssessmentWorkflow
```

Stop here if `deno check` fails, the local serve fails, or the
bundle is missing the battery exports. The bundle is a generated
artifact — never commit it (`vendor/` is git-ignored).

## 2. Deploy

```sh
supabase link --project-ref rkgdwqgmldznczikrjip   # once, if not linked
supabase functions deploy assessment-api --project-ref rkgdwqgmldznczikrjip
```

Confirm the deploy output names the function `assessment-api` and
reports success. No environment variables or secrets are set as
part of this step.

Function URL after deploy:

```text
https://rkgdwqgmldznczikrjip.supabase.co/functions/v1/assessment-api
```

## 3. Smoke-test the deployed function (synthetic data only)

Obtain a real coach JWT by signing in to the app as a coach in the
browser (never paste a token into a shared doc or a shell history
file — use a shell variable in the same session, or the browser's
network tab to copy the `Authorization: Bearer …` header).

```sh
FN=https://rkgdwqgmldznczikrjip.supabase.co/functions/v1/assessment-api
TOKEN="<coach JWT from a live sign-in>"

# 1. Battery route (the Phase 2 UI depends on this):
curl -s "$FN/battery" -H "Authorization: Bearer $TOKEN" | head -c 400
# expected: {"battery":"generalAthleticAssessment","protocolVersion":"gaa-v1","retestDays":28,"tests":[8 tests]}

# 2. Battery without a token must fail (platform verify_jwt):
curl -s -o /dev/null -w "%{http_code}\n" "$FN/battery"
# expected: 401

# 3. Roster (scoped to the signed-in coach):
curl -s -X POST "$FN" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"method":"listAthletes","params":{}}'
# expected: {"ok":true,"data":[...]} — only the coach's own athletes

# 4. Unknown method and malformed body:
curl -s -X POST "$FN" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"method":"nope","params":{}}'
# expected: {"ok":false,"error":{"code":"INVALID_INPUT",...}} with HTTP 400
```

Then run the synthetic end-to-end pass: with the coach JWT, start
an assessment for a synthetic athlete, record attempts (include one
modified and one capped result), complete it, read it back through
`athleteAssessmentView`, and confirm the flags and the 28-day next
due date — then delete the synthetic session and its results from
the dashboard (or a cleanup script) so the project returns to 0
rows. Pattern the checks on the §5 live-check scripts in
`server/live-checks/004/` (same shape: setup → checks → cleanup,
with a visible summary last).

## 4. Rollback / recovery

The function holds no state of its own — all data lives in
Postgres behind RLS, and the function never writes outside the
assessment tables. If the deploy misbehaves:

1. **Disable it immediately:** `supabase functions delete assessment-api --project-ref rkgdwqgmldznczikrjip`
   (deleting the function restores the pre-deploy state; the app
   shows its "assessment service not connected" note and the
   prototype keeps working).
2. **Or redeploy the previous version:** check out the previous
   commit of `supabase/functions/assessment-api/`, regenerate the
   bundle (`node build.mjs`), and re-run the step-2 deploy.
3. **Data:** a bad deploy cannot corrupt stored data beyond what
   RLS already permits — every write runs as the caller. If
   synthetic smoke-test rows remain, remove them with the dashboard
   SQL editor and re-verify the 26 / 15 / 72 / 0 counts.

Edge Functions have no built-in version history — the rollback is
"redeploy from the previous commit", so keep the deployed commit
recorded with the deploy (commit hash + date + who ran it).

## 5. What this deploy does NOT do

- No database migration (004 + 005 are already applied).
- No production application deploy (the prototype is a separate
  step in the release sequence).
- No billing, pricing, or membership change.
- No merge into `main` (merge order: PR #2 foundation, then PR #3
  assessment — a separate owner decision).
- No Neon, Taskmill, or MARVIN involvement — Supabase is the sole
  backend.
