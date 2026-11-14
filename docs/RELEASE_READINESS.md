# THE PROGRAM OS — Release Readiness: Universal Assessment & Reassessment

**Date:** 2026-11-14
**Mission:** COMPLETE ASSESSMENT INTEGRATION & RELEASE READINESS (Marcus, 2026-11-13)
+ FINAL ASSESSMENTS CLEANUP & RELEASE (Marcus, 2026-11-14)
**Branch:** `feature/universal-assessment-reassessment-v1` (head `f4dde5d`)
**Status: CODE-COMPLETE AND VERIFIED — NOT YET READY FOR PRODUCTION.**
Production readiness is blocked only on owner approvals and the deploy-time
checks listed in §6. Nothing in the code or tests blocks the release.

## 1. What was already implemented (before this mission)

- Operational foundation (PR #2, draft): per-session capacity adapter,
  concurrency-safe reservation engine, Postgres migrations 001–003,
  authenticated API, schedule-session link. 22 tables / 58 policies.
- Assessment engine (PR #3, draft, on top of PR #2): GAA battery v1
  (8 tests, full protocols, no invented norms), 28-day reassessment
  engine, baseline gating (plan-finalization only, recorded coach
  override), progress calculator, advisory-only Smart Draft,
  idempotency keys, migration 004.
- Migrations 001–005 applied + verified live on TheProgramOS
  (rkgdwqgmldznczikrjip): 26 tables / 15 definitions / 72 policies /
  0 rows. 004 verified 2026-11-13; 005 verified 2026-11-13 (behavioral
  re-check 6/6 PASS). Live functional checks §5 (004): 17/17 PASS.
- Edge Function scaffold (`supabase/functions/assessment-api/`,
  UNDEPLOYED, `verify_jwt = true`).

## 2. What this mission completed (Phases 1–5)

- **Phase 1 — Verify the foundation:** no branch conflicts (foundation
  is an ancestor of the assessment branch); migrations compatible with
  code; Edge Function supports 004 + 005. Suite at the time: 182/182.
- **Phase 2 — Finish the application:** the Assessments UI is wired to
  the server workflow — all 11 workflow steps usable in the UI
  (roster + due buckets, run-assessment form from `GET …/battery`,
  save/resume/complete, baseline + +28d, history + PBs + comparisons,
  deferral/exclusion, plan controls with override gate), athlete view
  of own results, dev-only "View as" role switcher, dev server
  (`npm run dev`, localhost-only, synthetic data). `THE PROGRAM OS.html`
  byte-identical; only `index.html` changed (one line loading the
  assessment scripts). +26 tests (16 UI, 10 dev-server over real HTTP).
- **Phase 3 — Connect the Edge Function (no deploy):** `GET …/battery`
  route added (same contract as the dev server); stale `KNOWN GAP`
  comments resolved (005 applied); full surface verified in Node
  against the real `.ts` modules — JWT auth, role/access refusals,
  idempotent replay, modified/capped round-trip, Smart Draft
  advisory-only, no service-role key anywhere. Found and fixed a real
  defect: `loadData()` dropped `capped`/`attempts`/`unit` from history
  (stored rows were correct; display lost "(capped)" and units).
  +27 tests. Deploy steps written: `docs/EDGE_FUNCTION_DEPLOY_STEPS.md`.
- **Phase 4 — Full workflow testing:** all 12 mission scenarios
  exercised by executable tests. Closed the one genuine gap found:
  network interruption + retry composed end to end (real client ↔
  real dev server over real HTTP, one faulted attempt). +3 tests,
  +1 capped-display assertion. No failures, new or pre-existing.
- **Phase 5 — This package.**

## 2b. What the cleanup mission completed (2026-11-14, Marcus decision §14)

- **Removed the obsolete Assessments prototype content** — the first
  authorized edit to `THE PROGRAM OS.html`: `vAssess()` no longer
  renders the "REQUIRES PROGRAM VALIDATION" head, the "not being
  collected today" lede, the explainer cards, the TESTS draft-protocol
  cards, the "Due for testing" demo table, or the "Decisions needed"
  list. `vAssess()` returns only the page head; the live section is
  the only assessment experience. The athlete-profile progress-tab
  note was reworded to point at the official Assessments section.
  The preservation-snapshot hash was updated in the separate reviewed
  commit `f90dd11` (old `bdee15bc…`, new `74aba9d7…`). Decision §14
  is CLOSED (`docs/MORNING_DECISIONS.md` §14).
- **Real-browser walkthrough — 22/22 PASS** (Playwright + Chromium
  1255, dev server on localhost, synthetic data): all 10 mission
  steps on desktop, obsolete-content check, mobile layout (390×844,
  0px overflow). Full record + screenshots:
  `docs/browser-walkthrough-2026-11-14/RESULTS.md`.
- **Two defects found and fixed by the walkthrough** (commit
  `5fe4281`): (1) the dev "View as" role buttons carried
  `data-role="coach"`, which the prototype's click handler treats as
  its mode switch — clicking a role button navigated away from the
  Assessments view (automated tests never saw it); fixed by renaming
  to `data-aui-role`, with a regression test. (2) Mobile header
  overflow (dev-only): the panel header's non-wrapping flex row
  forced the page to 758px on a 390px phone; fixed with
  `flex-wrap:wrap`. +1 test (regression).
- The dashboard "Due for testing" KPI + exceptions entry still read
  demo data ("battery not validated") — wiring the card to live
  reassessment data was judged not minimal; it is a follow-up item,
  not a release blocker.

**Final test state: 250 tests, 250 pass, 0 fail** (`npm test`).
`tsc --noEmit --strict` clean on all five Edge Function `.ts` files
(Phase 3, stubs in /tmp only). Typecheck/lint/build scripts do not
exist in the repo (n/a — confirmed, not skipped).

## 3. Branch / commit / PR information

| Item | State |
|---|---|
| Branch | `feature/universal-assessment-reassessment-v1`, head `f4dde5d`, pushed, tree clean |
| `main` | Untouched at `dc5d42d` |
| PR #2 (foundation) | OPEN, draft, base `main`, mergeable: **MERGEABLE**, merge state: CLEAN |
| PR #3 (assessment) | OPEN, draft, base = foundation branch, mergeable: **UNKNOWN** (GitHub-side: uncomputable while its base is itself unmerged — not a local conflict; local merge-tree is clean) |
| Additions | +12,256 / −22 on PR #3 (includes tests, docs, Edge Function, UI wiring) |

**Ready to merge:** PR #2 — **YES** (pending Marcus's approval).
PR #3 — **YES on code and tests**, with mergeability to be confirmed by
GitHub only after PR #2 merges (sequential by design). No merge has been
performed; merging either PR needs Marcus's explicit approval.

## 4. End-to-end test results

- Full regression: **250/250 PASS** (182 at Phase 1 → 219 Phase 2 →
  246 Phase 3 → 249 Phase 4 → 250 after the cleanup walkthrough
  regression test). No failures, new or pre-existing.
- Real-browser walkthrough (2026-11-14): **22/22 PASS** in Chromium
  against the dev server (synthetic data): coach login + roster,
  start, all eight protocols, save/resume, complete + baseline +28d,
  history + PBs, 28-day buckets, reassessment + comparison, parent
  and athlete access, override gate + plan finalization; desktop and
  mobile (0px overflow). Record:
  `docs/browser-walkthrough-2026-11-14/RESULTS.md`.
- Scenario coverage (all executable, synthetic data, isolated env):
  youth 12 + adult 48 full assessments, all 8 protocols;
  incomplete → save → resume → complete, baseline, +28d;
  override gate (409 without override, allowed with);
  28-day buckets (approaching/due/overdue/deferred) + exclusion;
  PBs + baseline/previous/current comparisons + under-18 caveat;
  athlete/parent visibility + forged/out-of-cohort/unauthenticated
  refusals; idempotent duplicates (workflow, dev-server, Edge handler);
  network interruptions + retries (lost response, HTTP 500, lost
  draft-save); modified/capped end to end incl. display;
  Smart Draft advisory-only; dev-server HTTP paths 10/10.
- Live verification already done (not re-run in this mission):
  migrations 001–003 (22/58/10, checks A/B/C), 004 §5 checks 17/17,
  005 behavioral re-check 6/6, all cleaned back to 26/15/72/0.

## 5. Edge Function readiness

**Ready to deploy once Marcus approves the deploy step.** Schema
prerequisites (004 + 005) are met. The route the UI needs exists.
Auth, access, idempotency, and flags are verified. Exact deploy
steps: `docs/EDGE_FUNCTION_DEPLOY_STEPS.md` (§0 prerequisites,
§1 prepare incl. `deno check` + local serve, §2 deploy, §3 smoke
test, §4 rollback, §5 what the deploy does not do).

**Not verified before deploy (environment gaps, not code blockers):**
`deno check` / `supabase functions serve` (no CLI here — run first on
the deploy machine; stop if either fails); the deployed function
against live Supabase (needs deploy approval + real coach-JWT smoke
test, scripted in the deploy doc); RLS against the function (fake
client does not enforce RLS — live RLS verified separately in §5).
Real-browser render is now VERIFIED (22/22 walkthrough in Chromium
against the dev server — the deployed Edge Function path, with a real
coach JWT, is still covered only by the deploy-time smoke test).
Production sign-in flow (Supabase Auth) was not exercised in the
walkthrough (dev uses the "View as" switcher) — it is covered by the
production smoke test in §7.

## 6. Remaining blockers — exact list

Production use is blocked on these, in order. None is a code defect.

1. **Marcus approves the merge order** — PR #2 (foundation) then
   PR #3 (assessment). Deployment is a separate decision after that.
2. **Marcus approves the Edge Function deploy** — then run the deploy
   doc end to end: `deno check`, `supabase functions serve`, deploy,
   live smoke test (synthetic data, cleanup back to 0 rows).
3. **Marcus approves the production application deploy** — separate
   decision; no production deploy is part of this package.
4. **Battery field validation (open since §8)** — the GAA v1 protocol
   is written but unvalidated in the field; do not present results
   to parents as more than coach-recorded measurements until
   validated.

Done since the last version of this package: decision §14 (stale
Assessments copy) — decided and implemented in the cleanup mission;
the first real-browser pass — 22/22 in Chromium against the dev
server. Follow-up item, not a blocker: wiring the dashboard "Due for
testing" card to live reassessment data (still demo data).

Minor nits recorded, not blocking: migration 005's SQL file header
still says "NOT APPLIED" (stale file text; it was applied via the
dashboard — the file was left untouched as the applied artifact).
Repo visibility (PUBLIC though The Program is non-public) is an
owner decision, unchanged. $149 flat vs the prototype's "$149 / $179"
tier mention, facility max-occupancy numbers, and billing activation
remain open owner items.

## 7. Exact production release sequence

Each step needs its own explicit approval from Marcus. One approval
covers one step only.

1. **§14 decided + implemented** (cleanup mission 2026-11-14 —
   obsolete Assessments content removed; decision closed).
2. **Real-browser pass DONE** — 22/22 in Chromium against the dev
   server (record: `docs/browser-walkthrough-2026-11-14/RESULTS.md`).
3. **Approve + merge PR #2** (foundation) into `main`. Verify the
   merge is clean and `main` builds/passes.
4. **Rebase/merge-check PR #3** onto the new `main`; confirm GitHub
   reports it mergeable; **approve + merge PR #3**.
5. **Approve + deploy the Edge Function** per
   `docs/EDGE_FUNCTION_DEPLOY_STEPS.md`: `deno check` →
   `supabase functions serve` (local smoke) → `supabase functions
   deploy assessment-api` → live smoke test with a real coach JWT
   (synthetic data only) → cleanup back to 26/15/72/0. Record the
   deployed commit hash + date + who ran it.
6. **Approve + deploy the production application** (separate step;
   Netlify/static hosting per the existing setup — confirm the host
   and deploy command at that time; nothing in this package deploys
   it).
7. **Production smoke test** (synthetic data, then clean up):
   - Sign in as a coach; open Assessments; roster loads, due
     buckets correct.
   - Start an assessment for a synthetic athlete; record attempts
     incl. one modified and one capped; save, resume, complete;
     baseline established; next due +28d.
   - History + PBs + comparison render; plan finalization refused
     without baseline/override, allowed with a recorded override.
   - Athlete view shows only own results; a second coach's athlete
     is refused.
   - Duplicate completion replays idempotently (one session).
   - Delete all synthetic rows; re-verify 26 tables / 15 definitions
     / 72 policies / 0 rows.
8. **Rollback / recovery:**
   - Edge Function misbehaving: `supabase functions delete
     assessment-api` (app shows "assessment service not
     connected"; prototype keeps working), or redeploy from the
     previous commit (regenerate the bundle first — `node build.mjs`).
     Edge Functions have no built-in version history.
   - Bad app deploy: redeploy the previous `main` commit.
   - Data: all writes run as the caller behind RLS; a bad deploy
     cannot corrupt beyond what RLS permits. Remove leftover
     synthetic rows via the dashboard SQL editor and re-verify
     26/15/72/0.
   - Migrations 001–005 are additive; no rollback migration is
     needed or provided. Do not delete tables, columns, policies,
     or production data without Marcus's explicit approval.

## 8. Supabase configuration requirements

- Project TheProgramOS (`rkgdwqgmldznczikrjip`, us-east-2).
  No new project, no second database, no paid infrastructure.
- Migrations 001–005 already applied — no migration in this release.
- Edge Function `assessment-api`: `verify_jwt = true`
  (`supabase/config.toml`); uses only `SUPABASE_URL` +
  `SUPABASE_ANON_KEY` (injected automatically). **Never set a
  service-role key on this function.**
- Auth: existing Supabase Auth + roles; no auth weakening, no new
  provider, no account creation as part of this release.
- The workflow bundle (`vendor/workflow.bundle.mjs`) is generated
  at deploy time (`node build.mjs`) and is git-ignored — never
  committed, never deployed stale.

## 9. Boundaries kept throughout this mission

No merge into `main`. No Edge Function deploy. No production
application deploy. No production env var / migration / data
changes. Nothing on Neon (unused, preserved), Taskmill, or MARVIN.
Synthetic data only. No secrets in code or logs.
