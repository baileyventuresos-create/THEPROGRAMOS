# THE PROGRAM OS — Production Integration Report (Execution Phase)

**Marcus approval:** 2026-11-26, 9 instructions. **Status: PARTIAL — merges complete; steps 6–9 gated on dashboard/browser work and the anon key (see §8).** No real athlete accounts created. No billing integration. No new features. **$0 spent.**

## 1. Route A validation — SUCCEEDED (real PostgreSQL)

- Environment: `sudo apt-get update` took 11 min 5 s (72 MB at ~108 kB/s through the sandbox proxy); `apt-get install -y postgresql` took ~12 s. Total ~12.4 min — inside the 15-minute cap.
- Distro ships **PostgreSQL 16.15, not production's 15.8.1.50**; per instructions no hunt for 15. Cluster `16/main` running on 5432; `SELECT version()` confirms 16.15.
- Scratch DB `programos_scratch`: migrations **001–005 then 006–009 applied in order, verbatim** (`psql -v ON_ERROR_STOP=1 -f`, md5sums verified equal to repo files), every file exit 0. One documented shim: 003/004 need Supabase-provided objects, so the scratch DB got the stub from migration 003's own header (schema `auth`, `auth.users(id uuid)`, `auth.uid()` returning NULL, roles `authenticated`/`anon`/`service_role`) — scratch only, no repo files modified.
- **Mocked result:** logic coverage only — 006–009 never proven on a real engine before this run.
- **Real-database result:** all 9 migrations apply cleanly on real PostgreSQL 16.15; acceptance checks pass.
- Evidence (independently re-read from the scratch DB by the coordinator): **47 tables, 132 policies, RLS on all 47** (live baseline 26/72, so +21 tables / +60 policies from 006–009). All 10 new 009 tables present with RLS. `athletes.status` (default `'active'`), `coach_athlete_links.sport` / `.positions` present. Acceptance: athlete created; prospect profile created → corrected (`draft` → `pending_approval`); repeat insert → UNIQUE violation as designed; invalid sport `'hockey'` → CHECK violation; complimentary grant created; second active grant → UNIQUE violation on `uq_grant_active`; revoke then re-grant → succeeds; re-applying 009 verbatim → exit 0 (idempotent).
- **Honest limits:** validated on PG 16.15, not 15.8.1.50. RLS *policies exist and are attached* but row-level enforcement under a real `authenticated` session was not exercised — acceptance inserts ran as superuser (bypasses RLS) and `auth.uid()` was stubbed to NULL. Enforcement must be proven in the step-9 smoke test with real sign-in.

## 2. Draft PRs — done

- **PR #4** SaaS Commercialization V1 (base assessment branch) — draft, created this run.
- **PR #5** Athlete Pathways & Prospect Portal V1 (base SaaS branch) — draft, created this run.
- PRs #2/#3 pre-existed as drafts. Merge order #2 → #3 → #4 → #5.

## 3. Name display — done (`f18d59b`)

`publicProfileView` includes `athleteName` only when athlete + coach approval timestamps are recorded and, for a minor, a granted guardian-consent row is live at read time. Gate re-checks on every public read (consent withdrawn hides the name; editing an approved profile re-opens it so the public read refuses). Reuses existing approval/consent records. Profiles stay private by default. Targeted suites 37/37 pass.

## 4. Production auth — built, BLOCKED on the anon key (`ec0820e`)

- Built: `saas-ui/supabase-auth.js` — dependency-free GoTrue REST client (sign-in, session persistence, proactive refresh, sign-out, `roleForUser()` for director/coach/athlete/parent). Off localhost the "View as" switcher is gone; the SaaS hub gates on a real session. Localhost dev unchanged. Config via gitignored `saas-ui/supabase-config.js` (template committed). Server stays authoritative for roles (`app_users.role` by auth UID). Docs: `docs/PRODUCTION_AUTH.md`. 14 new tests pass (stubbed fetch, no live Supabase).
- **BLOCKED:** no anon key exists in the repo/docs. The registered `custom.supabase` connector returns **HTTP 401 "Invalid access token"** on every call, including its own canonical read — the stored PAT itself is invalid/expired. Nothing was faked: without the key the app reports "Production sign-in is not configured."
- **Unblocks:** (a) reconnect the `custom.supabase` connector with a fresh full-access PAT, then re-run the kept one-off script `/tmp/get-programos-anon-key.py` (writes the key into the gitignored config, never prints it); or (b) copy the anon public key from the dashboard (TheProgramOS → Settings → API) into `saas-ui/supabase-config.js`. Marcus must still create the real Auth users and their `app_users` role rows.

## 5. Edge Function integration — done, NOT deployed

- `directory.ts` now builds SaaS/Pathways scoping from migration 006 tables via the user-scoped client (RLS applies); accepts the `org_admin` role (view-only, never assesses). `683b668`.
- **Defect found and fixed by the coordinator (`7affa8d`):** `deno check` initially failed with 8 errors (all TS2352 in `store.ts` — the untyped Supabase client's `.single()` infers `data: null`, so `saved as Row` was a `null` → `Row` cast). Pre-existing code from the assessment mission; never caught because `deno check` had never run in this environment. Fix: type the helper results at the source (`one<Row>(...)` at the 8 call sites) — no behavior change. **`deno check` now passes (exit 0, Deno 2.9.8).** Local serve verified by the coordinator: function boots on :8000, `GET /battery` without a token → **401 UNAUTHENTICATED** (correct auth-boundary behavior); server stopped, port closed. `deno.lock` artifacts removed; tree clean.
- Targeted tests: 4 new (directory links/memberships, org_admin context, SaaS-link coach assess, org_admin view-only); Edge suite 31/31. Function **not deployed**.

## 6. Tests — green

- Full suite **379/379 pass, 0 fail** on the Pathways branch (359 baseline + 20 new), re-run by the coordinator. Suite re-run on merged `main` (clean worktree at `c72fbaf`): **379/379 pass, 0 fail**.

## 7. Merges — ALL COMPLETE (authorized, instruction 5)

Each PR verified MERGEABLE/CLEAN immediately before merging; each was marked ready-for-review first (GitHub refuses to merge drafts). Merge commits:

| PR | Content | Merge SHA |
|----|---------|-----------|
| #2 | Operational Foundation V1 | `a2120ee7ad318fd4db94a508f680ce709263262a` |
| #3 | Universal Assessment & Reassessment Engine (base retargeted to main) | `aa065eda9737a33cb6a93436156252b64a1ef31a` |
| #4 | SaaS Commercialization V1 (base retargeted to main) | `65129da543f6ac52b85c20fcecb834589fa2058f` |
| #5 | Athlete Pathways & Prospect Portal V1 (base retargeted to main) | `c72fbaf28799af89b7d63abffaa4e3687974a50b` |

`origin/main` is now at `c72fbaf`. Nothing else was pushed to main.

## 8. NOT DONE — steps 6–9 need the parent agent (live browser/dashboard) + Marcus

These steps require live-browser/dashboard work the execution coordinator cannot perform. Exact handoff:

### Step 6 — Recovery point + migration apply (FIRST)
1. Confirm a viable recovery point for TheProgramOS from the dashboard (Pro-plan backups/PITR) — verify, do not assert. If none exists, STOP and report.
2. Read live totals before applying (baseline: 26 tables / 72 policies / 0 rows).
3. Apply **006 → 007 → 008 → 009** via the dashboard SQL editor, ONE at a time, VERBATIM from `server/migrations/006_saas_foundation.sql`, `007_training_assignments.sql`, `008_billing_shape.sql`, `009_athlete_pathways.sql` (compare character-for-character before sending; include a marker read-back after each). Verification after each.
4. Expected after-counts (from Route A scratch evidence): **47 tables / 132 policies / 0 rows**.

### Step 7 — Netlify
Verify existing capacity and billing exposure from Netlify's own account/pages before proceeding; confirm free-tier headroom; create the site with **automatic publishing DISABLED** (manual deploys only). If site creation needs Marcus's Netlify dashboard access, that is the blocker to surface.

### Step 8 — Deploys (only after steps 6–7 pass, AND the anon key is in place)
Deploy `assessment-api` Edge Function (`supabase functions deploy assessment-api --project-ref rkgdwqgmldznczikrjip`; confirm output names the function and reports success), then deploy the production app to Netlify (manual deploy). Verify each (function responds; site loads). The function needs `SUPABASE_URL`/`SUPABASE_ANON_KEY` — the anon key (§4) is required here.

### Step 9 — Smoke test + cleanup (only after step 8)
Targeted, AUTHENTICATED smoke test with SYNTHETIC accounts only, using REAL sign-in: director creates a synthetic athlete, grants complimentary access, coach assigns training + records an assessment, reassessment comparison renders, prospect profile stays private until approved, unauthorized access refused. Then DELETE all synthetic test data and verify cleanup to baseline (0 rows; 47 tables / 132 policies present). This is also the run that proves RLS enforcement under a real authenticated session (§1 limits).

## 9. Confirmed additional costs

**$0.** No subscriptions, upgrades, paid DBs, paid APIs, domains, metered services, or paid trials. Deno 2.9.8 installed locally as dev tooling (free). No Stripe involvement; billing abstraction inert.

## 10. Blockers requiring Marcus's intervention (exact)

1. **Anon key** — reconnect the Supabase connector with a fresh PAT, or copy the anon public key from the dashboard into `saas-ui/supabase-config.js` (§4). Without it, production sign-in, the Edge Function deploy, and the smoke test cannot run.
2. **Real Auth users + `app_users` role rows** — Marcus creates them (no accounts were created by this work).
3. **Steps 6–9** — need the parent agent's live-browser/dashboard work (§8). No further action is possible from this coordinator until the anon key and dashboard access are resolved.
