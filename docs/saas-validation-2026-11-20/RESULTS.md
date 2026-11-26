# THE PROGRAM — SaaS Validation Results (2026-11-20)

**Mission:** RESEARCH, BUILD & VALIDATE SAAS EXPANSION (Marcus, 2026-11-20) — validation worker.
**Branch:** `feature/the-program-saas-commercialization` (started at `7d780ea`; validation commits `f507c0e`, `8d111a3`).
**Environment:** dev server (`server/dev-server.js`, memory stores, seeded synthetic data), headless Chromium (playwright-core in `/tmp/pw-setup` + `~/.cache/ms-playwright/chromium-1255`). Live Supabase untouched; no deploy, no merge, no live billing, synthetic data only.

## How validation was run (three layers)

1. **Automated suite** — `npm test` (Node built-in runner). Baseline 305/305 re-verified at start; final **310/310** (5 new tests: 4 org_admin + 1 data-session regression). No existing test weakened or removed. Log: `npm-test.log`.
2. **HTTP journey script** — `validate-journeys.js` boots the dev server on an ephemeral port and exercises J1–J10 (+ consent gate) over real HTTP (`/homepage.html`, `GET /api/saas/plans`, `POST /api/saas`, `POST /api/billing`, `POST /api/assessments`). **59/59 checks pass.** Log: `validate-journeys.log`.
3. **Real-browser walkthrough** — `walkthrough.js` drives the actual app in headless Chromium (desktop 1440×900 + mobile 390×844), clicks through the SaaS hub, captures 18 screenshots, checks console/page errors and horizontal overflow. **22/22 checks pass.** Log: `walkthrough.log`, screenshots in `screenshots/`.

## Per-journey results

| # | Journey | Result | Automated evidence | Browser evidence |
|---|---|---|---|---|
| J1 | Visitor discovers The Program, selects a subscription | **PASS** | HTTP: homepage 200 with test-mode banner + app CTAs; plans API returns 6 seeded plans | Homepage renders live pricing (6 cards), testbar, hero, Log in / Create account (`01`, `02`) |
| J2 | Athlete registers, receives correct access (free tier) | **PASS** | HTTP: `registerAthlete` → tier `free`, `historyDays` 90; `myEntitlements` free | Youth athlete tab shows "Athlete Free", 90-day window note, seeded assessment history (`04`) |
| J3 | No payment → no paid features (server-side refusal) | **PASS** | HTTP: athlete `createAssignment`/`myRoster` → `FORBIDDEN`; 2nd coach link for free athlete → `ENTITLEMENT_LIMIT`; expired coach link → `SUBSCRIPTION_INACTIVE` (J9) | Safety Review game checkbox disabled in composer (server also rejects: `GAME_NOT_ASSIGNABLE`); free-tier limits visible (`10`) |
| J4 | Training assigned → completed → persistent history | **PASS** (see honesty note) | HTTP: assign (TP2-001/003, COMPETE, dose) → complete (25 min, RPE 7) → history join shows completion; double-complete → `ALREADY_COMPLETED`; `INVALID_GAME_ID`/`GAME_NOT_ASSIGNABLE` enforced | Coach composer → athlete sees assignment → completes → history table updates (`10`, `11`) |
| J5 | Coach subscribes (test mode), roster, invitations, caps, assigns | **PASS** | HTTP: register → solo org + 14-day `coach_starter` trial; `coach_pro` test checkout → active; invite token single-use (`INVITATION_INVALID` on replay); roster fills to 15, 16th → `ENTITLEMENT_LIMIT`, explicit overage → `overage:true` | Kayla roster "4 of 15 athletes" with Assign/Progress/Sponsor/Unlink; invite + link forms with gate order stated (`09`, `15`) |
| J6 | Coach views athlete progress + assessments | **PASS** | HTTP: Kayla `athleteAssessmentView` youth → 2 seeded sessions; `athleteHistory` joins assessments (2); parent views own athlete | Assessments section: live GAA workflow, 8 athletes with due/overdue/never-assessed buckets (`12`) |
| J7 | Organization manages multiple coaches | **PASS** | HTTP: create org → invite coach → accept → `orgOverview` (2 coaches, 1 athlete); org_admin assessment view in-org OK / write `FORBIDDEN` / out-of-org `FORBIDDEN` | Org created from UI (identity flips to org_admin), overview renders coaches + counts (`13`, `14`) |
| J8 | Coach A cannot access Coach B's athletes (release-blocking) | **PASS** | HTTP: Jordan → youth `listAssignments`/`athleteHistory` → `ATHLETE_NOT_FOUND` (no existence leak), assessments → `FORBIDDEN`, `createAssignment` → `FORBIDDEN`, rosters disjoint both ways; unit suite covers every path incl. directory layer | Jordan roster lists only `dev-ath-04`, `dev-ath-05` (`15`) |
| J9 | Cancel/expire updates entitlements; history retained | **PASS** | HTTP: athlete checkout → `paid`; cancel at period end → still `paid`; director expire → `free`; completions still returned; coach: expire all granting subs → `readOnly:true`, new links `SUBSCRIPTION_INACTIVE`, roster still readable | Cancel-at-period-end control visible on coach subscription table (`15`) |
| J10 | In-person workflows preserved; $149 member precedence | **PASS** | HTTP: wingback checkout → `ALREADY_COVERED` (`coveringSource: in_person_membership`); entitlements → `member`, full history; seeded wingback baseline visible to cohort coach; battery route intact (8 tests). Suite: reservation engine, session capacity, cohort caps all green | Wingback tab: "In-person member — $149 membership", ALREADY_COVERED honesty copy; checkout attempt refused in UI (`07`, `08`) |
| JX | Guardian consent gate (extra) | **PASS** | HTTP: minor link → `CONSENT_REQUIRED`; director `grantConsent` (`paper_on_file`) → link activates | — (API-level; consent UI is API-driven in dev) |

**Honesty note (J4 persistence):** the dev server uses memory stores — a server restart wipes data by design. Persistence is proven (a) within a server session across fresh requests (re-login equivalent), and (b) by the store/join tests in the suite (`saas-api.test.js` assignment→completion→history, free-window truncation retains rows). Cross-restart persistence is a production-store property (Postgres store + migrations), not something the dev server can demonstrate.

**Mobile (390px):** homepage, athlete view, and coach view all render with **0px horizontal overflow** (`16`, `17`, `18`). No app console/page errors during the walkthrough (5 excluded entries are Google-Fonts/404 network noise from the sandboxed environment; fonts fall back gracefully).

## Defects

### Fixed during validation

1. **org_admin assessment view blocked at the API role table** (known defect from `docs/SAAS_UI.md`). `assessment-access.js` granted org_admin view and the directory carried links, but `assessment-api.js` `ALLOWED` (mirrored in Edge `api.ts`) had no `org_admin`. **Fix (`f507c0e`):** added `org_admin` to the READ methods only in both tables — `listAthletes`, `athleteAssessmentView`, `planReadiness`, `advisoryPriorities` (all flow through `requireView`/`listAthletes`). Recording/writing methods, `getDraft` (coach working state), and `coachDashboard` (coach-scoped) stay coach/director. Edge `Role` union gained `org_admin` so the table type-checks; the deep-equal table test keeps both in sync. Pinned dev-server test flipped to the fixed behavior + 4 new unit tests prove: in-org view/list/readiness/advisory succeed; all 9 write methods `FORBIDDEN`; out-of-org athlete `FORBIDDEN`.
2. **SaaS confirm-checkout froze the entire app UI** (found by browser validation). The confirm button carried `data-session=<billing session id>`; the prototype's global click handler treats `data-session` as "open session drawer" (`ds.session`), set `S.drawer` to a nonexistent session, and every subsequent `render()` threw in `drawerSession` before assigning `innerHTML` — server state changed but the screen never updated again. Same collision class as the existing `data-role` guard. **Fix (`8d111a3`):** renamed to `data-sui-session` (renderer + handler) with a regression test pinning the namespaced attribute. Re-verified in Chromium: checkout now renders "Test subscription active" and the paid tier immediately (`06`).

### Remaining (not fixed here — out of validation scope or deploy-time)

1. **Edge Function `directory.ts` does not build SaaS links/orgMemberships.** The Edge `api.ts` table now matches the Node table, but `directory.ts` `isRole` still rejects `org_admin` and the directory carries no `links`/`orgMemberships`, so Edge org_admin scope would be empty. The Edge Function is an undeployed scaffold; this is deploy-time wiring (fetch `coach_athlete_links` + `organization_memberships`, pass to `createAccessDirectory`). Documented in `api.ts`. The Node/dev path is fully wired and proven.
2. **Solo coach cannot call `orgOverview`** (known gap, `docs/SAAS_UI.md` #2): requires `org_admin`/`director`; the UI flips the dev identity to `org_admin` after `createOrganization`. Unchanged; by design for now.
3. **No production sign-in UI** (known gap #3): dev "View as" only; Supabase Auth is a deploy-time decision.

## Could NOT be validated (and why)

- **Real Stripe test mode:** Stripe is not connected in this environment (connector not connected; `StripeTestAdapter` refuses live keys by construction and makes no network calls). All billing validation used the fake adapter's test-mode shape. Connecting test mode / creating test products is a separate Marcus decision.
- **Production Supabase Auth sign-in:** no production sign-in exists yet; dev identities (`X-Dev-Role`/`X-Dev-User` headers) stand in. JWT-derived auth is covered by the Edge scaffold tests in the suite, not by a live sign-in.
- **Scratch-Postgres migration apply (006–008):** no Postgres binary exists in this VM (`psql`/`postgres`/`pg_ctl`/`initdb` absent, no `/usr/lib/postgresql`). Static invariants stand instead: `migration-006-008.test.js` (in suite, green) pins the additive/idempotent/RLS shape of the branch-only migrations. Migrations remain **unapplied**; live Supabase untouched.
- **Cross-restart persistence in dev:** memory stores by design (see J4 note).
- **Real-device / real-user testing:** headless Chromium only; no physical device, no real accounts, synthetic data throughout.

## Final counts

- Suite: **310/310** (`npm test`, re-run at close; baseline 305 + 5 new).
- HTTP journeys: **59/59** (`validate-journeys.js`).
- Browser walkthrough: **22/22** (`walkthrough.js`), 18 screenshots.
- Commits: `f507c0e` (org_admin fix), `8d111a3` (data-session fix), plus this evidence. Tree clean, pushed, no dev server left running.
