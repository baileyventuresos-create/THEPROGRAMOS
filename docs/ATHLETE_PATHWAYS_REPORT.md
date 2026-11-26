# THE PROGRAM OS — Athlete Pathways & Prospect Portal V1
## Final Engineering Report — 2026-11-26

**Branch:** `feature/athlete-pathways-v1` (from SaaS branch head `35df1a2`) · **Head:** `15c8571` · **15 commits** · **Pushed, tree clean** · **Main untouched at `dc5d42d`** · **Pilot:** The Walk-On Project · **Additional operating cost: $0**

**Stacking order (merge sequence):** PR #2 (foundation) → PR #3 (assessment) → SaaS branch → this branch. `main` lacks the entire backend.

---

## 1. Existing architecture findings

Focused audit: `docs/PATHWAYS_AUDIT.md` (350 lines, commit `3e0d0d3`).

- **Backend:** `server/saas-api.js` (24 methods, `{method,params}` dispatch + `ALLOWED` role table), `server/saas-store.js` (in-memory `MemorySaasStore`, `PLANS` catalogue mirroring migration 008), `server/entitlements.js` (pure computed entitlements, never stored), `server/billing.js` (`FakeBillingAdapter`; `StripeTestAdapter` refuses live keys by construction; Stripe not connected), `server/dev-server.js` (Node http on `127.0.0.1:8123`, memory stores, `X-Dev-Role` header auth).
- **Entitlements before this mission:** (1) in-person membership → `member`, (2) sponsorship → `sponsored`, (3) own subscription → `paid`, (4) free (90-day history, 1 coach link, 1 training day/week).
- **Assessment Engine V1:** GAA battery `gaa-v1` (8 tests / 9 definition ids), 28-day reassessment cycle, `progress.js` (vs baseline/previous/PB, maintenance band, under-18 caveat), advisory-only Smart Draft (no auto-prescription, no norms/percentiles/rankings). Already sport-specific: a baseball trio existed (`throw-velo`, `throw-accuracy`, `exit-velo`, `BATTERIES.baseball`). Trend visualisation was tables only — no chart component.
- **Frontend:** `THE PROGRAM OS.html` (2,752 lines, single-file prototype + `window.TP_DATA`, 130 TP2 games); `saas-ui/` wraps `vDashboard`/`vCoach`/`vAthleteMode` and never edits the OS html; `homepage.html`; Edge Function `supabase/functions/assessment-api/` is an **undeployed** scaffold (`verify_jwt=true`, no service-role key). No `saas-api` Edge Function exists.
- **UI identity (exact values, audit §3):** light `--bg:#ECEEED; --surface:#F8F9F8; --ink:#121514; --muted:#59625E; --line:#C7CDCA; --tape:#F2C300; --crit:#B8321C; --ok:#2B7349; --info:#2F5D86`; dark `--bg:#0E1110; --surface:#161A19; --ink:#E7EBE9; --tape:#F2C300`. Fonts: Archivo (display, 850, uppercase), Public Sans (body), JetBrains Mono (numbers/labels). **No border-radius, no shadows, no gradients** — 1px hairlines, square panels, dark 212px sidebar, `.btn` mono 11px uppercase, KPI value mono 26px bold, `.wrap max-width:1080px`. Wordmark `THE PROGRAM`, tagline `PLAY WITH PURPOSE.`
- **Live state (rests on recorded 2026-11-13 verification, not re-queried):** Supabase TheProgramOS `rkgdwqgmldznczikrjip`, Pro, us-east-2, Postgres 15.8.1.50, Micro; migrations 001–005 applied, 26 tables / 72 policies / 0 rows / 0 auth users. Migrations 006–008 branch-only, unapplied. Storage: none. Edge Functions: none deployed. Auth: 0 users. Only dependency `pg ^8.23.1`.
- **Reusable (not rebuilt):** orgs, tenant-scoped coach–athlete links, hashed-token invitations (24-byte token, SHA-256 hash stored, 7-day TTL, no email sent anywhere), guardian-consent gate, computed entitlements, assignments/completions with history, test-mode billing abstraction, athlete/coach/org hubs, sport-as-configuration.

## 2. Implemented functionality

**Complimentary access (new entitlement step 0, above everything).** `resolveAthleteEntitlements` now: **(0) complimentary grant → (1) in-person → (2) sponsorship → (3) own subscription → (4) free**. Complimentary athletes get `tier:'complimentary'`, `source:'complimentary_grant'`, full history, unlimited coach links; `athleteCoverageBlock()` refuses checkout with `ALREADY_COVERED` / `coveringSource:'complimentary_grant'`; revoked/expired grants fall back to the next covering source. No payment prompts, trial notices, or subscription restrictions while active.

**Owner-controlled account management (director-only, server-enforced).** `ownerCreateAthlete` (no card/subscription), `ownerListAthletes` (all athletes + grant status), `grantComplimentary` (indefinite `expiresAt:null` or optional expiry), `revokeComplimentary`, `suspendAthlete`, `reactivateAthlete`, `updateAthleteRole`, `ownerInviteAthlete` (hashed-token invitation), `listAudit`. Every action writes an audit row via `store.audit()`. Owner console in the director tab: account table, create/grant/invite forms, suspend/reactivate/revoke, audit history.

**Coach management portal.** Assign sports + positions on the coach–athlete link (`assignSport`); development goals (`set/update/listDevelopmentGoals`); training assignment + completion (reused); attendance/training history; assessment recording (reused workflow); scouting evaluations (`record/listScoutingEvaluations` — only coach-approved ones enter a public profile); prospect-profile editor + approval; share-link creation/revocation; recruitment CRM.

**Private athlete portal.** Extended athlete hub: personal athletic profile (sports, positions, measurements), development goals, coach feedback, media portfolio (approved external links/embeds only), recruitment opportunities (server-backed read of own referrals/opportunities), prospect-profile status + athlete approval action, 9 SVG trend charts over existing `progressForAthlete` data (baseline/PB markers, canonical calculator status in captions). Athletes see only their own data (server-enforced).

**Assessment Engine integration.** GAA core untouched. Added 5 measured sport definitions + `BATTERIES.soccer/.basketball/.football/.flag_football` following the baseball pattern, with protocol entries. No norms, thresholds, professional-readiness scores, medical diagnoses, or population rankings introduced. Baseline/reassessment/progress/PB logic reused unchanged; all historical data preserved.

**Professional prospect profiles.** `prospect_profiles` (bio, sports, positions, measurements, accomplishments, playing history, verified metrics, availability, contact info, status draft/pending_approval/approved) + `profile_shares` (token-hash, expiry, revocable). Approval requires **both athlete + coach**; minors additionally require a guardian-consent row. `getPublicProfile` is unauthenticated, token-only, and returns approved public fields only — never contact info, training notes, or medical data. Private by default. Public view: `prospect.html` (no login; tape "SHARED PRIVATELY BY LINK" bar; photo placeholder block). **Deliberate privacy posture: the public profile carries no athlete name** — Marcus to confirm whether the name should be added (see §12).

**Recruitment CRM (lightweight, internal).** `recruitment_contacts` (org, sport, league, level, region, contact, title, email/phone, requirements), `recruitment_opportunities` (tryout/combine/other), `recruitment_notes` (with follow-up dates), `referrals` (status/outcome). Levels: collegiate, developmental, pre-professional, semi-professional, professional, national team. Regions: WA/OR/CA first, free-text for expansion. Full list methods (`listOpportunities`, `listRecruitmentNotes`, `listReferrals`) — server-backed, survives refresh. No mass outreach, contract negotiation, or agent functionality.

**Media integration.** `prospect_media_links` (kind highlight/full_game/other, http(s) URL only, approved_by/at). External links/embeds only (YouTube/Vimeo allowlist). No uploads, Storage, paid hosting, generative video, or paid AI. Media visibility follows the profile's sharing state.

**Sports.** Soccer, baseball, basketball, football, flag football — one shared engine, sport as configuration. Built for two synthetic pilot athletes; architected for hundreds (tenant-scoped links, orgs, no per-athlete code paths).

Full method list: `docs/PATHWAYS_BACKEND_NOTES.md`. API surface: 35 new Pathways methods in `saas-api.js` + `saas-client.js`; dev server serves `GET /api/public/profile?token=…`.

## 3. Interface screenshots

10 screenshots, each verified by opening the image itself (not from test logs): `docs/pathways-validation-2026-11-26/screenshots/` + `RESULTS.md` (+ reproducible `screenshots.js`).

1. `01-owner-console.png` — owner console, 9-row account table (complimentary indefinite / in-person $149 member / free), audit history 10/10.
2. `02-complimentary-grant-form.png` — grant form filled, indefinite checked.
3. `03-athlete-portal.png` — complimentary badge, "never charged", no Subscribe, profile pending approval, goal, coach-approved feedback, media, 9 trend charts.
4. `04-trend-chart.png` — close-up: dashed tape baselines, PB stars, "Baseline 2.3 · Latest 2.25 · Personal best 2.25 ★".
5. `05-coach-prospect-editor.png` — coach Pathways detail: attendance/history, sport+positions, goal/evaluation composers, approved shareable profile editor, media add/remove, share links, CRM row.
6. `06-coach-share-link.png` — share link shown once + shares table (expiry, ACTIVE, REVOKE).
7. `07-public-prospect-profile.png` — no-login public profile: placeholder photo, bio, Soccer–Striker, metrics, video, evaluation, "No personal contact details are published". No athlete name (by design).
8. `08-coach-crm.png` — CRM pipeline: tryout opportunity, note with follow-up, referral.
9. `09-mobile-athlete-portal.png` — 390px single-column athlete portal, all 9 charts legible.
10. `10-public-profile-refusal.png` — bogus token: "THIS PROFILE IS NOT AVAILABLE." — no data leaked.

Two cosmetic nits (RESULTS.md, not fixed): at 390px the goals table overflows its scroll wrapper (`MARK COMPLETE` reachable by horizontal scroll; same for the owner-console action column at 1280px); the YouTube iframe renders as an empty frame in the sandbox (no external network — element + plain link present, not a UI defect).

## 4. Database changes

**Migration 009** `server/migrations/009_athlete_pathways.sql` — branch-only, additive, idempotent, transactional, **UNAPPLIED**, RLS on all new tables. New tables: `complimentary_grants`, `prospect_profiles`, `profile_shares`, `recruitment_contacts`, `recruitment_opportunities`, `recruitment_notes`, `referrals`, `prospect_media_links`, `development_goals`, `scouting_evaluations`. Additive columns: `athletes.status`, `coach_athlete_links.sport`/`positions`. Seeds the 5 new sport definitions. Migrations 006–008 remain unapplied; 001–005 applied live (unchanged).

**Validation — two separate lines:**
- Mocked/in-memory validation: **PASS.** SQL-text assertions (BEGIN/COMMIT, no DROP/DELETE/TRUNCATE/UPDATE, no storage) pass inside the suite; API tests run over the in-memory store mirror. Proves shape and API behaviour only.
- Real-database validation: **NOT RUN — no real Postgres engine exists in this environment** (no `psql`/`postgres`/`pg_ctl`/`initdb`/docker/podman, no `/usr/lib/postgresql`, no `DATABASE_URL`, nothing on 5432/5433; `node_modules/` doesn't even exist — tests run on memory stores). **This is the blocker for any production apply of 006–009.** It needs a Neon scratch branch, Supabase scratch project, or Postgres install elsewhere, each separately approved.

## 5. Owner account management capabilities

Director-only (server-enforced, never client-side only): manually create athlete accounts without cards or subscriptions; send secure hashed-token invitations (7-day TTL, no email sent anywhere); grant indefinite complimentary access or set an optional expiry; suspend, reactivate, revoke; manage roles/permissions; view all athlete accounts with grant status; full audit history of creation, permission changes, suspension, revocation. No real athlete accounts were created — synthetic fixtures only; the owner creates real accounts personally.

## 6. Complimentary access functionality

Precedence: **complimentary > in-person > sponsorship > own subscription > free**. Indefinite or expiring grants; suspension preserves data and falls back to the next covering source on revocation/expiry (nothing deleted). Complimentary athletes see a `COMPLIMENTARY — GRANTED BY THE PROGRAM` badge, full portal functionality, no Subscribe button, no payment prompt, no trial-expiration notice. Only the owner (director) can grant or modify. Verified end-to-end over HTTP: grant → `tier:complimentary` → checkout refused `ALREADY_COVERED` → suspend → reactivate → revoke → falls back to `free`.

## 7. Security controls

- RBAC via `saas-api.js` `ALLOWED` role table + server-side checks on every method; director-only complimentary management; coach authorization scoped to their org/assigned athletes.
- Athlete data isolation: tenant-scoped links, athlete-scoped reads; cross-athlete → `ATHLETE_NOT_FOUND`, cross-coach → `ATHLETE_NOT_FOUND`/`FORBIDDEN`, non-owner grant → `FORBIDDEN`.
- Prospect sharing: token-hash (24 random bytes, SHA-256, returned once), expiry, revocable; revoked/expired/bogus token → `PROFILE_SHARE_INVALID` with zero profile data; public view allowlisted to approved public fields only.
- Consent: dual athlete + coach approval for sharing; guardian-consent gate for minors (append-only `guardian_consents`, latest wins; legal text pending counsel).
- Suspension/revocation: status-based, non-destructive (data retained, access removed).
- Secrets/safety scan of the full diff since `35df1a2`: **clean** — only negations and `secret@example.com` inside a test asserting it is never rendered. All test athletes synthetic/fictional (dev IDs, Synthetic Youth/Pilot/Wingback, Coach Rivera, River State University). No credentials, private media, or secrets committed to the public repo.
- Unauthorized access to another athlete's data = release-blocking defect: **none found** — all refusal paths verified live (see §8/§9).

## 8. Automated test results

**Full suite, re-run by the coordinator: 359 tests, 359 pass, 0 fail, 0 skipped** (~6 s).

- Baseline 310/310 intact (zero existing tests weakened or removed).
- New Pathways tests: **49** — complimentary 9, profiles/CRM 7 + 3 list-read API tests, sports/migration 5, UI 21 + 4 (G1 list reads, F1 caption agreement).
- Two invariant-preserving updates (not weakenings): `tests/ui-preservation.snapshot.json` engine hash updated per that file's documented procedure (engine diff purely additive — 5 sport definitions, GAA core byte-unchanged); `assessment-store.test.js` seed pin now also accepts migration 009 (invariant unchanged: every engine definition must be seeded by a migration).
- Two defects found by validation and fixed on this branch: **G1** — CRM had no list methods for opportunities/notes/referrals (items vanished on refresh); **F1** — trend-chart caption recomputed direction and contradicted the canonical maintenance band at the edge (now uses the calculator's canonical status; 9-case agreement table pins caption == calculator).

## 9. Regression test results

- Full suite 359/359 green (see §8). HTTP journey checks: battery API (GAA v1, 8 tests), `/`, `/prospect.html`, homepage Pathways section all serve; assessment start/record/draft flows pass over HTTP.
- Independent validation: `docs/pathways-validation-2026-11-26/VALIDATION.md` (validator ran the suite and all acceptance checks itself, not trusting builder claims).
- **Acceptance criteria (all 15, live HTTP evidence against the dev server):**

| # | Criterion | Verdict |
|---|---|---|
| 1 | Owner manually creates athlete account | PASS |
| 2 | Owner grants indefinite complimentary access | PASS (`expiresAt:null`, active) |
| 3 | Complimentary athletes get full portal, no payment | PASS (full history, no Subscribe, no trial notice) |
| 4 | Owner can suspend / reactivate / revoke | PASS |
| 5 | Athletes securely access own dashboards | PASS |
| 6 | Coaches assign training + record assessments | PASS |
| 7 | Reassessments produce accurate progress comparisons | PASS (hand-verified: 10yd 2.30→2.25, Δ −0.05s exact; broad jump +4 in exact) |
| 8 | Coaches create professional prospect profiles | PASS |
| 9 | Authorized external recipients view approved profiles | PASS (token-only, no login; no name/contact in payload) |
| 10 | Prospect sharing can be revoked | PASS (`PROFILE_SHARE_INVALID`, zero data) |
| 11 | Recruitment contacts + opportunities tracked | PASS (after G1 fix — list-after-refresh verified) |
| 12 | Unauthorized users cannot access private athlete info | PASS (all refusal paths) |
| 13 | Existing functionality intact | PASS |
| 14 | New interfaces match existing aesthetics | PASS (audit §3 tokens verbatim) |
| 15 | No additional operating costs | PASS (`package.json` diff empty; no new services) |

## 10. Infrastructure capacity

- Current usage (code/docs verified): Storage none; Edge Functions none deployed; Auth 0 users; DB 0 rows; only dependency `pg ^8.23.1`. All Pathways work runs on the existing in-memory dev path and the existing Supabase project shape; media is links-only (no Storage uploads).
- Numeric Pro-plan limits (DB size, storage, Edge invocations, MAU) **do not appear anywhere in repo docs/code and are not asserted here** — they must be confirmed from Supabase's own pages before any capacity claim to Marcus. At current usage (near zero on every metered dimension) the pathways workload is comfortably inside any plan; Micro/DB-size limits matter only at real user volume (a launch decision, not a build blocker).
- "Production build": the repo has **no build script** (`package.json` has only `dev`/`test`, no bundler). Production build here = `npm test` (359/359) + dev-server smoke of all routes, both done. No artefact, no deploy attempted.

## 11. Confirmed additional operating costs

**$0.** No subscriptions, hosting upgrades, paid DB instances, paid APIs, domains, metered services, or paid trials introduced. `package.json` diff is empty. No Stripe live mode (refused by construction), no Storage, no new external service calls (only relative API fetches + YouTube/Vimeo URL embeds + the pre-existing Google Fonts pattern).

## 12. Outstanding blockers

1. **Real-Postgres validation of migrations 006–009 — production-apply blocker.** No Postgres engine exists here. Nothing may be applied live until proven on a real Postgres copy (Neon scratch / Supabase scratch / Postgres install elsewhere, separately approved). Merging applies nothing (all of 006–009 declare NOT APPLIED) — but the merge must not be read as migration approval.
2. **Public profile carries no athlete name** (deliberate privacy posture, `publicProfileView`). Marcus decision: confirm intended, or have the backend add the name — a recruiter currently can't tell whose profile it is.
3. **No `saas-api` Edge Function; Edge `directory.ts` doesn't build SaaS links; no billing webhook; no production sign-in** (dev identities only). Deploy-time / separate-approval work.
4. **Stripe test-mode connection** not connected (fake adapter only, by design); live billing activation is its own decision.
5. **Consent legal text** pending counsel; **GAA field validation** (§8) still open; **pricing approval** for the SaaS tiers still pending.
6. Cosmetic nits (§3): 390px goals-table overflow; YouTube iframe empty in the sandbox (no external network).

## 13. Deployment instructions

**Do not deploy yet.** Merge order: PR #2 → PR #3 → SaaS branch → this branch (each a separate Marcus approval). Then, in order, each separately approved: (a) prove migrations 006–009 on a real Postgres copy; (b) apply 006–009 to production via the dashboard SQL editor, one at a time, verifying after each; (c) deploy the Edge Function (`deno check` + local serve first on the deploy machine); (d) deploy the production app; (e) production smoke test with synthetic data, then clean up to the known baseline (26 tables / 72 policies / 0 rows for 001–005, plus the 009 tables once applied). Rollback: delete-or-redeploy-from-previous-commit for the function; redeploy previous main for the app. **Local preview now:** `npm run dev` → `http://127.0.0.1:8123/` and `/homepage.html` (localhost only). Dev "View as" switcher: Director, coaches, parent, youth athlete (free), wingback ($149 member); complimentary athletes are the synthetic Youth/Pilot fixtures. Restarting the dev server resets to seed.

## 14. Recommended future enhancements

- Add the athlete name to the public profile (after Marcus's §12.2 decision) and a photo-upload path only if a $0 Storage route is approved (currently placeholder block, links only).
- `saas-api` Edge Function + billing webhook + production Supabase Auth sign-in (G8/G9).
- Shadow-mode recommendations (Layer 4, reduced migration-006 form) — only if wanted; Smart Draft stays advisory-only.
- The ~20–30 gap drills + ~4–6 conditioning templates from the suitability review (not needed for Pathways V1).
- Dashboard due-card wiring to live data; notifications; CRM stage values (Marcus's decision).
- Real-Postgres CI for migrations (the recurring gap: mocked tests are logic coverage only).

## 15. Ready to merge: NO

**Ready to merge: NO** — pending Marcus's approvals and the PR #2 → PR #3 → SaaS dependency chain. Nothing was merged, deployed, or changed in production; no live athlete data touched; no real athlete accounts created; $0 spent.

**What was NOT verified and why:** real-Postgres apply of migrations 006–009 (no Postgres engine in this environment); real Stripe test mode (connector not connected); production Supabase Auth sign-in (dev identities only); live-database state (not re-queried — rests on the recorded 2026-11-13 verification); GAA field validity (§8, open); numeric Supabase Pro-plan limits (not in repo docs/code — confirm from Supabase's own pages).

**Authorizations still needed, one step each:** merge PR #2; merge PR #3; merge the SaaS branch; merge this branch; real-Postgres validation run for 006–009; apply migrations 006–009; deploy the Edge Function; deploy the production app; connect Stripe (test) + create test products; activate live billing; pricing approval; consent legal review; public-profile name decision (§12.2).

---

## Commit history (15 commits, `35df1a2..15c8571`)

| Commit | Content |
|---|---|
| `3e0d0d3` | Audit (read-only, 310/310 baseline) |
| `627665b` | G1: complimentary grants as entitlement step (0) + checkout block |
| `1c1354d` | Migration 009 (branch-only, UNAPPLIED) |
| `b564e9c` | G2–G6: owner management, prospect profiles, CRM, media, sport APIs |
| `45e98d6` | G6: sport configs for soccer/basketball/football/flag football |
| `587d458` | 21 new tests; seed pin extended to 009; engine snapshot hash |
| `89c212d` | Backend notes |
| `253aaba` | SaaS client: 35 Pathways methods + token-only public-profile read; dev server `GET /api/public/profile` |
| `33b188b` | Owner console, athlete/coach Pathways portals, trend charts, public-profile renderers |
| `650c06c` | `prospect.html` share page + homepage Pathways section |
| `94842d5` | 21 UI tests |
| `97aa12c` | Visual validation — 10 screenshots + per-shot verification notes |
| `ac5dd9a` | Independent validation — 352/352, 14/15 PASS, 1 PARTIAL (C11) |
| `d75257f` | G1 CRM list reads + athlete recruitment read; F1 band-edge caption |
| `15c8571` | Tests for G1 list reads and F1 caption agreement |

33 files changed, +6,029 / −20 vs `35df1a2`.
