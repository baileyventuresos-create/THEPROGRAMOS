# THE PROGRAM — SaaS UI (frontend slice, 2026-11-20)

**For the validation worker.** User-facing SaaS experiences built on
the tested backend slice (`docs/SAAS_API.md`). Everything runs in
the dev environment with synthetic data; nothing is deployed, no
live database is touched, no real billing exists.

## What was built

| File | What it is |
|---|---|
| `saas-ui/saas-client.js` | Transport adapter for `POST /api/saas`, `POST /api/billing`, `GET /api/saas/plans`. Envelope `{ok, data\|error{code,message,coveringSource?}}`; errors thrown with `.code` so the UI branches on codes. UMD like `assessment-client.js`. |
| `saas-ui/saas-ui.js` | Injected UI module (UMD). `install()` wraps `vDashboard` / `vCoach` / `vAthleteMode` (SaaS hub prepended) and `vAthlete` (SaaS section appended). `THE PROGRAM OS.html` is never edited. |
| `homepage.html` | Public homepage (first anonymous surface). Standalone static page; pricing fetched from `GET /api/saas/plans` with a static fallback. Links into `./index.html` for log in / create account. |
| `index.html` | Loader-only change: injects `saas-client.js` + `saas-ui.js` and installs `SaasUI` before `boot()` (same pattern as the assessment UI). Hash updated in its own reviewed commit. |
| `server/dev-server.js` | Integration wiring: the dev assessment directory is rebuilt from the live SaaS store on every call, so SaaS-linked remote athletes appear in assessment flows immediately (see below). |
| `server/tests/saas-ui.test.js` | 15 tests: pure helpers, renderers, client envelope, controller flows against the real SaaS API + fake billing. |
| `server/tests/dev-server-saas-links.test.js` | 2 HTTP tests: SaaS links → assessment directory; org_admin pin. |

Suite: **305/305** (288 baseline + 17 new). No existing test was
weakened or removed; the preservation test gained additive
assertions for the new loader lines.

## How each experience is reached (dev)

Start the dev server: `npm run dev` → http://127.0.0.1:8123/

- **Public homepage:** http://127.0.0.1:8123/homepage.html —
  introduction, the 28-day approach, athlete/coach/organization
  offerings, pricing (live from the plans API, monthly/annual
  toggle), Log in / Create account CTAs into the app.
- **App (all roles):** http://127.0.0.1:8123/ — the SaaS hub panel
  ("The Program — remote coaching & subscriptions") is prepended
  to the Director dashboard, Coach mode, and Athlete/Parent mode.
  Hub tabs: **Overview · Account · Athlete · Coach · Organization ·
  Plans & billing**. The dev "View as" buttons in the hub header
  switch the SaaS identity (separate from the prototype's own
  Director/Coach/Athlete mode switch in the topbar — set both).
- **Athlete profile section:** Director → Athletes → any athlete —
  a "Remote coaching — SaaS" panel is appended with tier + history
  counts (or an honest scope error).
- **Assessments:** unchanged — Director → Assessments (live GAA
  section from `assessment-ui/`).

## Dev identities (seeded on server start; restart wipes)

| Identity (hub "View as") | Role | Notes |
|---|---|---|
| Director (Marcus) | `director` / `dev-director-marcus` | Everything. |
| Coach Kayla (YAK) | `coach` / `dev-coach-kayla` | Trialing Coach Starter, program-internal org, cohort links mirrored. |
| Coach Jordan (ELL) | `coach` / `dev-coach-jordan` | Same shape. |
| Coach Marcus (CLE) | `coach` / `dev-coach-marcus` | Same shape. |
| Parent of Synthetic Youth (12) | `parent` / `dev-parent-youth` | Guardian; consent granted for the youth. |
| Athlete: Synthetic Youth (12) | `athlete` / `dev-athlete-youth` (`ath-synth-youth-12`) | Free tier; seeded assessment history (baseline + reassessment). |
| Athlete: Synthetic Wingback (48) | `athlete` / `dev-athlete-wingback` (`ath-synth-wingback-48`) | Holds the active $149 in-person membership → tier `member`; checkout refused `ALREADY_COVERED`. |

New identities: register from the Account tab. In dev the current
"View as" identity stands in for the signed-in user — to register
a *new* person, first switch to a fresh identity (any unused
`X-Dev-User` via the API, or reuse the flows in the tests).
Registration is idempotent per identity.

## Flows to validate (J1–J10 in dev)

1. **Free athlete (J1):** View as Youth athlete → Athlete tab:
   tier `Athlete Free`, assignments (empty until a coach assigns),
   history with seeded assessment sessions.
2. **Paid athlete (J2):** Plans tab → Athlete Remote → Subscribe
   (test mode) → Confirm test checkout → tier flips to `paid`.
   As the Wingback athlete, the same checkout is refused
   `ALREADY_COVERED` (member) — try it.
3. **Coach (J3):** View as Kayla → Coach tab: roster with seeded
   links, cap label `n of 15`. Invite athlete (token shown once),
   or link by athlete ID. Assessments via Director → Assessments.
4. **Assignment loop (J4):** Coach tab → Assign training → pick
   TP2 games (Safety Review/Retired disabled; server rejects
   regardless), set build/dose → Create. Switch to that athlete →
   Athlete tab → Mark complete (duration/RPE/note) → history
   updates. Double-complete → `ALREADY_COMPLETED`.
5. **Sponsorship (J5):** Coach tab → Sponsor on a roster athlete →
   athlete tier becomes `sponsored`; their checkout is refused.
6. **Organization (J6):** Account tab → Register coach (fresh
   identity) → Organization tab → Create organization (identity
   flips to `org_admin` in dev) → overview + invite coach.
7. **Tenant isolation (J7):** Jordan cannot see Kayla's athletes
   anywhere (roster, history, assignments, assessments).
8. **Consent (J8):** register a minor athlete, link as coach →
   `CONSENT_REQUIRED` until a guardian grants consent (API:
   `grantConsent` as the linked parent, or director with
   `method: "paper_on_file"`).
9. **Expiry (J9):** director `expireSubscription` via API → coach
   read-only / athlete back to free; history retained.
10. **In-person preserved (J10):** prototype cohorts/sessions/
    builder unchanged; Wingback holds member tier + paid remote
    access with no second charge.

## Integration wiring (dev assessment directory)

`server/dev-server.js` now rebuilds the assessment access
directory from the live SaaS store per call: dev roster athletes +
SaaS-registered athletes, dynamic `coachAuth` for SaaS coaches,
live `links`, and `orgMemberships` (mapped appUser → auth UID).
Effect: a coach who links a remote athlete through the SaaS API
can immediately assess/view them in the Assessments section; the
athlete themself resolves as self. Covered by
`dev-server-saas-links.test.js`.

## Honesty rules in the UI (do not regress)

- Billing is **test mode only** — banner on homepage, Plans tab,
  and subscription block. No live-billing strings anywhere.
- Access state is always read from `myEntitlements` /
  `mySubscription`; the UI never fakes a tier client-side.
- GAA results are coach-recorded measurements (unvalidated
  battery) — no norms/percentiles/rankings copy anywhere.
- Assignments are coach-authored; no score creates one.
- Free-tier `truncated` history says rows are retained, never
  deleted.
- Sponsored/member checkout shows `ALREADY_COVERED`, never a
  purchase offer.

## Known gaps for validation

1. **org_admin assessment view is blocked at the API role table.**
   `server/assessment-access.js` grants org_admin *view* over
   athletes linked in their orgs, and the dev directory now
   carries the links — but `server/assessment-api.js` `ALLOWED`
   (mirrored in the Edge Function `api.ts`) includes no
   `org_admin` on any method, so org_admin assessment calls
   return `FORBIDDEN` today. Pinned by test. Fix = add
   `org_admin` to the read methods in both tables (backend
   change, separately approved).
2. **Solo coach (role `coach`) cannot call `orgOverview`** —
   the SaaS API requires `org_admin`/`director`. The UI flips
   the dev identity to `org_admin` after `createOrganization`
   (mirrors the server-side promotion). A solo coach who only
   registered (never created an org) sees their org via the
   Coach tab entitlements, not the org overview.
3. **No production sign-in UI** — dev "View as" only, by design
   (Supabase Auth is a deploy-time decision).
4. **Homepage pricing** is fetched live in dev; the static
   fallback mirrors the seeded catalogue if the API is offline.
5. **Mobile:** hub uses wrapping flex + `.tbl-wrap` throughout;
   the earlier 758px overflow pattern (non-wrapping `.ph .r`) is
   guarded by test. A real-browser pass at 390px is still the
   validation worker's to run.
