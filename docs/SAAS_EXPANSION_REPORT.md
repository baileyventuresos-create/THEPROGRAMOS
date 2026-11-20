# THE PROGRAM — Research, Build & Validate SaaS Expansion: Final Report

**Mission:** Marcus, 2026-11-20. **Branch:** `feature/the-program-saas-commercialization`
(based at `fd3678d`, the assessment-branch head — see dependency note in §4).
**Status: IMPLEMENTED AND VALIDATED on the branch. NOT merged, NOT deployed.**
Ready to merge: **NO** — merge requires Marcus's explicit approval, and the branch
depends on PR #2 → PR #3 landing first (see §4 and §9).

Companion documents: `docs/SAAS_MARKET_RESEARCH.md` (research),
`docs/SAAS_ARCHITECTURE.md` (design), `docs/SAAS_API.md` (API reference),
`docs/SAAS_UI.md` (frontend handoff), `docs/saas-validation-2026-11-20/RESULTS.md`
(validation evidence).

## 1. Research findings and competitive positioning

All prices fetched 2026-11-20 (full evidence + sources in
`docs/SAAS_MARKET_RESEARCH.md`).

- **The market prices the coach, not the athlete.** Attached athletes are free on
  every coach platform. Athletes only pay for direct-to-consumer content
  (TrainHeroic Marketplace programs $15–$40/mo) or human coaching services
  ($50–$397/mo, not SaaS).
- **Entry coach price clusters at $29/mo** (TrueCoach $29.98/5 clients; CoachRx
  $29/5). **Working tier at $79/mo** (CoachRx 6–50 clients; Trainerize Pro 30).
  TrueCoach charges $164.98 for 50 clients — the undercut target.
- **Org flat band is $900–$2,800/yr** (TeamBuildr $90–$280/mo, annual = 10×;
  Volt $900–$1,900/yr per team).
- **Band pricing by active athletes** is the norm; per-seat metering is the
  minority. Band cliffs (client #6 jumping $29→$79) are the top pricing
  complaint — hence soft overages.
- **Free tiers are rare** (Everfit 5 clients forever; Trainerize 1); **14-day
  trials are standard**. Payment skims are a vulnerability (TrueCoach 5%,
  CoachRx 2% + Stripe) — recommend a 0% platform fee.
- **Assessment is the wedge.** CoachRx includes Body/Move/Work on all plans;
  BridgeAthletic includes coach-scored FMS from $49; TeamBuildr has
  questionnaires + a $50/mo AMS add-on; Teamworks AMS is enterprise quote-only.
  **Nobody sells a standardized battery on a fixed reassessment cycle as the
  headline product.** Standalone testing services get $99–$499/athlete/event,
  proving parents pay for standardized testing.
- **Sport verticals are never price segments** — one price, content packs.

**Positioning:** *"Every other platform starts with programming. The Program
starts with measurement."* 8 tests, every 28 days, coach-verified, 130 movement
games programmed against the evidence; no automatic prescriptions from scores.
**Test, train, retest, every 28 days.**

## 2. Recommended pricing and subscription structure

| Tier | Monthly | Annual (10×) | Cap |
|---|---|---|---|
| Athlete Free | $0 | $0 | 1 training day/week, read-only results, 90-day display window (data retained) |
| Athlete Remote | **$14.99** | $149/yr | Full library, 28-day cycle; family +$7.99/athlete |
| Coach Starter | **$29** | $290/yr | 1 coach, ≤15 athletes, soft overage |
| Coach Pro | **$79** | $790/yr | 3 coaches, ≤50 athletes, 0% platform fee |
| Team/Academy | **$199** | $1,990/yr | Unlimited coaches, ≤150 athletes |
| Academy Scale | **$349** | $3,490/yr | ≤400 athletes; 400+ custom quote |

14-day no-card trials on coach/org tiers; annual = 2 months free everywhere;
active-athlete counting; assessment battery included on **every** paid tier.
Sponsored athletes are never charged (checkout refused `ALREADY_COVERED`).
The $149 in-person membership is a separate, preserved product and was not
used as an anchor anywhere. Prices are stored as data (`subscription_plans`),
so Marcus can change them without code changes.

## 3. Implemented features

**Backend (migrations 006–008 branch-only + server modules + dev endpoints):**
- Organizations (solo/team/academy/program_internal — a solo coach is an org
  of one; The Program itself is `program_internal`), organization memberships,
  tenant-scoped coach–athlete links, invitations (hashed tokens), append-only
  guardian consents with a consent gate for minors.
- Entitlements computed, not stored (`server/entitlements.js`): precedence
  in-person membership > sponsorship > own subscription > free. Server-side
  enforcement with stable error codes; expiry/cancellation fall back by
  derivation (no downgrade job, no deletion; lapsed coach = read-only).
- Training assignments (TP2 game IDs + coach dose/build; Safety Review and
  Retired games rejected server-side) + append-only completions; history is a
  join of assessments + attendance + completions — nothing copied.
- Billing behind `server/billing.js`: a fake adapter for tests/dev and a
  `StripeTestAdapter` that refuses live keys by construction. `ALREADY_COVERED`
  guard makes double-charging sponsored athletes and in-person members
  impossible through the API. Webhook log is idempotent (`billing_events`).
- Assessment access extended additively with active-link scope + read-only
  org_admin view; cohort/guardian/self rules byte-for-byte preserved.
- 22 SaaS API methods (`POST /api/saas`, `POST /api/billing`,
  `GET /api/saas/plans`), documented in `docs/SAAS_API.md`.

**Frontend (injected `saas-ui/` module + `homepage.html`):**
- Public homepage: introduction, the assessment-driven approach, athlete/coach/
  organization offerings, live pricing from the plans API (static fallback),
  registration/login entry points, clear CTAs. Billing labelled test mode.
- Athlete hub: honest tier from `myEntitlements`, assignments + completion,
  history with free-window note, assessment results via the existing UI.
- Coach hub: entitlements + roster cap, roster, invitations/links with
  overage-confirm flow, assignment composer over the 130 TP2 games (Safety
  Review/Retired disabled, server errors surfaced by code), progress, sponsor,
  subscription management.
- Organization hub: create (trials Team/Academy), overview, invite coaches.
- Dev assessment directory rebuilt from the live SaaS store per call — remotely
  linked athletes appear in assessment flows immediately; cohort scope unchanged.
- In-person $149/cohort/assessment flows unchanged.

**Sport verticals:** one shared development engine; `athletes.sports[]` already
exists; baseball module preserved. No sport-specific prescriptions were
manufactured — sport is configuration context (cohort/equipment), not a pricing
segment or a separate programming engine. The assessment system is unchanged.

## 4. Feature branch and commit references

Branch: `feature/the-program-saas-commercialization` (pushed, tree clean).
Base: `fd3678d` (assessment branch head). **Dependency:** this branch stacks on
the assessment branch, which stacks on the foundation branch. Merge order
remains PR #2 (foundation) → PR #3 (assessment) → this branch. `main` lacks the
entire backend.

Key commits: `0f585ce` research · `6887fcd` design · `c4b1377` migrations
006–008 · `dc65f91` server modules · `8d16f55` dev endpoints · `178115d`
backend tests · `a300925` API reference · `27d5b91` frontend + homepage ·
`c8c6e6a` integration + UI tests · `44aaccf` loader · `c0bea10` hash snapshot ·
`7d780ea` UI handoff · `f507c0e` org_admin read fix · `8d111a3` confirm-checkout
freeze fix · `7f09d0a`/`1dcdea1` validation evidence.

## 5. Test results and remaining defects

- **Automated suite: 310/310 pass, 0 fail** (250 baseline + 60 new across the
  mission; zero existing tests modified, weakened, or removed). Re-run and
  verified at close.
- **HTTP journey script: 59/59 checks pass** (`validate-journeys.js`).
- **Real-browser walkthrough: 22/22 checks pass** (headless Chromium, desktop
  1440×900 + mobile 390×844, 0px overflow, no app console/page errors).
- **All 10 mission journeys PASS** (J1 discovery → J10 in-person preserved),
  plus the guardian consent gate. Full evidence:
  `docs/saas-validation-2026-11-20/RESULTS.md`.
- **Defects found and fixed during validation:** (1) org_admin assessment view
  blocked at the API role table — fixed read-only in both `assessment-api.js`
  and Edge `api.ts` (`f507c0e`); (2) confirm-checkout froze the app UI
  (`data-session` collision with the prototype's global handler) — fixed
  (`8d111a3`); caught only by the real-browser pass.
- **Remaining defects / known gaps:** Edge `directory.ts` doesn't build SaaS
  links/orgMemberships (tables in sync; Edge org_admin scope is empty until
  deploy-time wiring — Node/dev path fully proven); solo coach can't call
  `orgOverview` (by design for now); dev-server persistence is within-session
  (memory stores wipe on restart by design — cross-restart persistence is a
  production-store property, proven by store/join tests, not by the dev server).

## 6. Database migration requirements

Migrations 001–005 are already applied live (26 tables / 15 definitions /
72 policies / 0 rows — recorded 2026-11-13 verification). **No additional
production migration is required for the existing system.**

New branch-only migrations in this mission (additive, `IF NOT EXISTS`
throughout, no destructive ops, **unapplied**):
- `006_saas_foundation.sql` — organizations, organization_memberships,
  coach_athlete_links, invitations, guardian_consents; nullable
  `organization_id` on coaches/cohorts/locations/training_sessions
  (NULL = internal pre-tenancy); `app_users.role` gains `org_admin`; RLS
  helpers + additive link-scope policies.
- `007_training_assignments.sql` — training_assignments, training_completions.
- `008_billing_shape.sql` — subscription_plans (seeded with §2 tiers),
  subscriptions, sponsorships, billing_events.

Applying 006–008 to the live project requires Marcus's explicit approval
(pre-check → apply → verify → cleanup package prepared in the architecture
doc, not run). No Postgres binary exists in this VM, so the migrations are
proven by static invariants + schema-snapshot tests, not a live apply.

## 7. Screenshots or preview links

18 screenshots in `docs/saas-validation-2026-11-20/screenshots/` (homepage,
athlete free/paid, wingback member + `ALREADY_COVERED` refusal, coach
roster/composer, completed history, assessments, org create/overview, Jordan
roster, 3× mobile 390px). Local preview: `npm run dev` → app at
`http://127.0.0.1:8123/`, homepage at `/homepage.html` (localhost only; not a
public deployment).

## 8. Instructions for Marcus to test the experiences

1. In the repo on branch `feature/the-program-saas-commercialization`, run
   `npm run dev`. Open `http://127.0.0.1:8123/homepage.html` for the public
   homepage (pricing loads live from the plans API; billing is test mode).
2. Open `http://127.0.0.1:8123/` for the app. Use the dev "View as" switcher:
   **Director** (super admin), **Kayla/Jordan/Marcus** (coaches on trialing
   Starter with mirrored rosters), **parent of youth**, **youth athlete**
   (free tier, seeded assessment history), **wingback athlete** ($149 in-person
   member — checkout is refused `ALREADY_COVERED`).
3. **Athlete:** register a new athlete (Account tab) → free tier shown →
   register/accept an invitation → complete an assignment → history updates.
4. **Coach:** register a coach → 14-day trial starts → invite an athlete →
   assign training from the composer (try a Safety Review game — it's disabled
   and the server rejects it) → view progress + assessments → try exceeding
   the 15-athlete cap (refused unless overage confirmed).
5. **Organization:** create an organization → invite a coach → org overview
   shows coaches/athletes → switch to Jordan and confirm his roster does not
   include Kayla's athletes (cross-tenant isolation).
6. **Billing (test mode):** Plans & billing tab → test checkout → confirm →
   entitlements change immediately; cancel at period end → access continues to
   period end; the wingback member's checkout is refused (already covered).
7. Restarting the dev server wipes all data back to the seed (by design).

## 9. Known launch blockers, deferred features, next steps toward first revenue

**Launch blockers (all owner decisions / external setup, no code defects):**
1. Merge approval + order: PR #2 → PR #3 → this branch.
2. Migration approval: apply 006–008 to live Supabase (with the prepared
   pre-check/verify/cleanup package).
3. Edge Function deploy (incl. wiring SaaS links/orgMemberships into
   `directory.ts`) + production app deploy.
4. Stripe test-mode connection (connector currently not connected): connect
   Stripe, create test Products/Prices, webhook secret as Edge Function
   secret, test-card verification — each separately approved. Live billing
   activation remains an owner decision.
5. Production Supabase Auth sign-in flow (dev uses header-named roles; the
   JWT-consuming API shape is proven, the hosted sign-in UX is not built).
6. Guardian consent legal text (counsel review — mechanism built, language
   not invented).
7. GAA battery field validation (§8) before results are presented as more
   than coach-recorded measurements.
8. Pricing approval (seeded values are research recommendations, stored as
   data).

**Deferred:** methodology shadow-mode recommendations (migration 006's
training tables — renumbered 009 if ever approved; not needed for this
slice); ~20–30 gap drills + conditioning templates from the suitability
review; dashboard due-card wiring to live data; notifications; duplicate-
athlete merging.

**Recommended next steps toward first revenue:**
1. Approve the pricing (§2) and the merge order; merge PR #2 → PR #3 → this
   branch.
2. Apply migrations 006–008 with the prepared package; deploy the Edge
   Function (with directory wiring) + the app; run the production smoke test
   with synthetic data, cleanup to 0 rows.
3. Connect Stripe in test mode; verify the full checkout → entitlement loop
   with test cards; then activate live billing as its own decision.
4. Build the production sign-in flow on Supabase Auth; have counsel review
   the consent language.
5. First revenue path: sell Coach Starter/Pro to independent youth coaches on
   the assessment wedge (battery included on every paid tier); free athlete
   tier as the top of funnel; in-person $149 members as the founding cohort.

**What was NOT verified and why:** real Stripe test-mode behavior (connector
not connected — fake adapter only, by design); production Supabase Auth
sign-in (dev identities only); scratch-Postgres apply of 006–008 (no Postgres
binary in this VM — static invariants stand); live-database state (not
re-queried — rests on the recorded 2026-11-13 verification); Edge Function
SaaS directory wiring (documented, deploy-time); field validity of the GAA
battery (§8, open).

**Authorizations still needed (one approval covers one step):** merge PR #2;
merge PR #3; merge this branch; apply migrations 006–008; deploy the Edge
Function; deploy the production app; connect Stripe (test) + create test
products; activate live billing; pricing approval; consent legal review.

**Ready to merge: NO** — pending the approvals above and the PR #2 → PR #3
dependency. Nothing was merged, deployed, or changed in production during
this mission.
