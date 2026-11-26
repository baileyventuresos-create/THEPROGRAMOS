# THE PROGRAM OS — Production Integration Plan: Complimentary Athlete Pilot

**Objective:** THE PROGRAM OS operational for the initial complimentary athlete pilot (The Walk-On Project, 2 athletes). **Feature development is FROZEN.** Only the approved name-display change and the integration work below proceed. **$0 additional spend. No production changes or merges until Marcus approves each step by name.**

**Decisions recorded 2026-11-26:** (1) Athlete name MAY appear on authorized prospect profiles, subject to athlete + coach + applicable guardian consent; profiles stay private by default. (2) Feature freeze. (3) Pilot scope below.

## Where things stand (verified 2026-11-26)

- Branches: `main` dc5d42d untouched. PR #2 (foundation, `e4da6cc`) OPEN, MERGEABLE, CLEAN, base main. PR #3 (assessment, `fd3678d`) OPEN, MERGEABLE, CLEAN, base foundation branch. SaaS branch `35df1a2` and Pathways branch `fd3ac73` have **no PRs yet**.
- Tests: **359/359 pass** on the Pathways branch. Reused — no comprehensive re-test planned (see §5).
- Live DB: migrations 001–005 applied + verified (26 tables / 72 policies / 0 rows). Migrations 006–009 branch-only, additive, **unapplied**.
- Edge Function `assessment-api`: scaffolded, verified in Node, **undeployed**. No `saas-api` Edge Function; `directory.ts` does not yet build SaaS links.
- Production sign-in: **does not exist**. The app has dev identities ("View as" switcher) only; no Supabase Auth client in the app. RLS was proven with impersonated JWT claims, never a real login flow.
- Production host: **unconfirmed**. No `netlify.toml` / `vercel.json`; no The Program OS live site on record. Release doc says "Netlify/static hosting per the existing setup — confirm the host".
- Real Postgres: **no engine exists in this environment** (no `psql`/`postgres`/docker; apt lists carry no postgresql candidate). This is the critical-path blocker.

## 1. Shortest safe path (in order)

| # | Step | Approval needed (one per step) |
|---|------|-------------------------------|
| 0 | Create draft PRs: SaaS branch (base = assessment branch) and Pathways branch (base = SaaS branch) | Approve creating the two draft PRs |
| 1 | **Real-Postgres validation of migrations 006–009** — see §2. Nothing downstream that touches production can start until this passes. Branch work (step 2) may run in parallel. | Approve the validation route (§2, option A/B/C) |
| 2 | Name display on authorized profiles: include the athlete name in the public-view allowlist **only when** athlete + coach approval (+ guardian consent if minor) is recorded; profiles stay private by default. Targeted tests only, then one final regression run. | Already approved 2026-11-26 (this change only) |
| 3 | Merge PR #2 (foundation) into main | Approve merging PR #2 |
| 4 | Retarget PR #3 base to main, then merge PR #3 | Approve merging PR #3 |
| 5 | Merge SaaS branch (PR to be created in step 0) | Approve merging the SaaS branch |
| 6 | Merge Pathways branch (after step 2 lands on it) | Approve merging the Pathways branch |
| 7 | Apply migrations 006–009 to production via dashboard SQL editor, **one at a time, verbatim from repo files**, verification after each + totals re-read. Additive only; may run any time after step 1 passes (independent of merges). | Approve applying migrations 006–009 |
| 8 | Deploy `assessment-api` Edge Function (`deno check` + local serve first), with SaaS/Pathways scoping added to `directory.ts` | Approve deploying the Edge Function |
| 9 | Deploy production app on the host Marcus names (§3) | Approve the host + deploying the production app |
| 10 | Production smoke test with **synthetic data**, then clean up to baseline (0 rows). Must use **real sign-in**, not impersonated claims: director creates a synthetic athlete, grants complimentary access, coach assigns training + records an assessment, reassessment comparison renders, prospect profile stays private until approved, unauthorized access refused. | Approve the smoke test |
| 11 | Marcus creates the 2 pilot athlete accounts personally and grants complimentary access | Owner action (Marcus) |

## 2. The critical path: real-Postgres validation

Mocked/in-memory results are logic coverage only; SQL is not validated until it runs on real Postgres. Options, in order of preference:

- **A — Local install in this VM ($0).** Attempt `apt-get update` + install postgresql; if the archives are unreachable behind the sandbox proxy, stop and report — do not improvise another route. If it installs, validate 006–009 on a disposable local copy (apply, exercise create/correct/repeat, read totals back).
- **B — A scratch database Marcus names.** A new Supabase project in the Pro org risks a project charge (verify billing before creating anything); the Neon TheProgramOS project is **preserved, never connect** by standing rule and must not be used unless Marcus explicitly names that route.
- **C — Marcus runs validation** on a machine with Postgres, from the repo files verbatim.

Whichever route is chosen, the deliverable is the same: the four migrations applied on a real engine, acceptance sequence exercised, totals read back, reported as a separate line from the mocked result.

## 3. Pilot-required vs deferred

**Required for the pilot:** the merge chain (§1 steps 3–6); validation + apply of 006–009; the name-display change; production Supabase Auth sign-in (build + verify with a real login flow); Edge Function deploy with SaaS scoping; production app deploy on a confirmed host; smoke test; owner-created pilot accounts with complimentary grants.

**Deferred (not needed for the pilot):** paid subscriptions and billing in full — Stripe test-mode connection, test products, billing webhook, live billing activation, pricing approval. The billing abstraction stays inert (refuses live keys); complimentary access bypasses it entirely. Also deferred: shadow-mode recommendations, the ~20–30 gap drills, conditioning templates, dashboard due-card wiring, notifications, CRM stage values, photo-upload path, org multi-coach scaling beyond the pilot, real-Postgres CI.

**Conditional:** consent legal text (counsel). If either pilot athlete is a minor, legal review becomes pilot-required before that athlete's profile is shared; otherwise it stays deferred. GAA field validation (§8) stays open — pilot results are presented as coach-recorded measurements only, per the standing rule.

## 4. Host decision (needed before step 9)

No live site exists for The Program OS. Marcus to name the host. If Netlify: confirm whether a new site is created and that auto-publish is OFF/manual for the pilot (merge-to-main must not silently deploy until the pilot is proven). If another static host, confirm the deploy command at that time.

## 5. Testing and compute

Reuse the 359/359 result. After the name-display change: targeted tests for that change + one final full regression run. No repeat of the 10-journey validation, no repeat browser walkthrough except the step-10 smoke test. No new test infrastructure.

## 6. What Marcus must do (exact list)

1. Approve this plan.
2. Approve the validation route (§2: A, B, or C).
3. Approve creating the SaaS + Pathways draft PRs.
4. Approve merging PR #2. 5. Approve merging PR #3. 6. Approve merging the SaaS branch. 7. Approve merging the Pathways branch.
8. Approve applying migrations 006–009 (after validation passes).
9. Approve deploying the Edge Function. 10. Name the host + approve deploying the production app.
11. Approve the production smoke test.
12. Create the 2 pilot athlete accounts personally + grant complimentary access (owner action).
13. If a pilot athlete is a minor: approve consent legal review before profile sharing.

## 7. Not verified / still open

Real-Postgres apply of 006–009 (blocker, §2); production Supabase Auth sign-in (does not exist yet); live-DB state (rests on the recorded 2026-11-13 verification); GAA field validity (§8); numeric Supabase Pro-plan limits (not asserted — confirm from Supabase's own pages before any capacity claim); host identity (§4).
