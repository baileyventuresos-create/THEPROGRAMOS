# THE PROGRAM — SaaS API Reference (backend slice, 2026-11-20)

**For the frontend worker.** This is the complete API surface of the
SaaS backend built on branch `feature/the-program-saas-commercialization`
(design: `docs/SAAS_ARCHITECTURE.md`). Everything here runs today in
the dev environment with synthetic data; nothing is deployed, no live
database is touched, no real billing exists.

## Transport

| Surface | Dev (today) | Production shape (future, separately approved) |
|---|---|---|
| SaaS API | `POST /api/saas` on the dev server (`npm run dev`, port 8123), body `{ "method": "...", "params": {...} }` | Edge Function `saas-api` (`verify_jwt = true`), same dispatch |
| Billing | `POST /api/billing`, same envelope (fake adapter) | `saas-api` for checkout/portal; webhook function for events |
| Plans | `GET /api/saas/plans` | same dispatch, method `listPlans` |
| Assessments | unchanged: `POST /api/assessments` | unchanged |

Responses are always `{ "ok": true, "data": ... }` or
`{ "ok": false, "error": { "code": "...", "message": "..." } }`.
Unknown methods return HTTP 400 `INVALID_METHOD`; domain errors
return HTTP 200 with `ok:false` (same convention as the assessment
API). **Branch on `error.code`, never on the message.**

## Auth

Every method takes an injected auth context derived from a verified
Supabase Auth JWT (production) — the service layer never parses
tokens. In dev, send headers instead:

- `X-Dev-Role`: `director` | `coach` | `org_admin` | `parent` | `athlete` (default `director`)
- `X-Dev-User`: the auth UID (default `dev-<role>`)
- `X-Dev-Athlete`: athlete id (athlete role)

Dev users seeded on start: `dev-director-marcus`, `dev-coach-kayla`
/ `-jordan` / `-marcus` (trialing Coach Starter, program-internal
org, cohort links mirrored), `dev-parent-youth`, `dev-athlete-youth`
(12-year-old, guardian consent granted), wingback athlete holds an
active $149 membership. Athlete IDs come from
`server/fixtures/dev-roster.js` (e.g. `ath-synth-youth-12`,
`ath-synth-wingback-48`).

Roles: `director` (platform admin, everything), `org_admin` (one
org), `coach` (linked athletes only), `parent` (own athletes),
`athlete` (self). A SaaS coach's app role is `coach` with an
`org_admin` membership in their solo org.

## Error codes

| Code | Meaning |
|---|---|
| `UNAUTHENTICATED` | No auth UID |
| `FORBIDDEN` | Role may not call this, or athlete/subscription outside your scope (writes) |
| `ATHLETE_NOT_FOUND` | Unknown athlete — **also returned for cross-tenant reads** (existence never leaks) |
| `INVALID_INPUT` | Missing/invalid params |
| `INVALID_METHOD` | Unknown dispatch method (HTTP 400) |
| `ACCOUNT_EXISTS` | Auth UID already registered with a different role |
| `INVITATION_INVALID` | Token unknown, used, or expired |
| `ENTITLEMENT_LIMIT` | Plan cap reached (coach roster, athlete coach-links, org coaches) |
| `SUBSCRIPTION_INACTIVE` | Coach/org subscription lapsed — read-only (writes refused) |
| `CONSENT_REQUIRED` | Minor athlete without granted guardian consent (remote activation gated) |
| `ALREADY_COVERED` | Athlete already has paid access (membership/sponsorship) — checkout refused, `coveringSource` names it |
| `INVALID_GAME_ID` | Game ID not in TP2-001..TP2-130 |
| `GAME_NOT_ASSIGNABLE` | Safety Review / Retired game (TP2-084, 090, 092, 093, 098, 125) |
| `ALREADY_COMPLETED` | Assignment already has a completion |
| `BILLING_LIVE_MODE_REFUSED` | Live Stripe key passed to the test adapter (by construction) |
| `BILLING_NOT_CONFIGURED` | Stripe test mode not connected in this environment |

## Plans (seeded data — `listPlans`)

| Code | Audience | Price | Limits |
|---|---|---|---|
| `free_athlete` | athlete | $0 | 1 training day/week, 90-day history display, 1 coach link |
| `athlete_remote` | athlete | $14.99/mo, $149/yr | full history, unlimited coach links |
| `coach_starter` | coach | $29/mo, $290/yr | 1 coach, ≤15 athletes, 14-day trial, $2.00 overage |
| `coach_pro` | coach | $79/mo, $790/yr | 3 coaches, ≤50 athletes, 14-day trial, $1.50 overage |
| `team_academy` | organization | $199/mo, $1,990/yr | unlimited coaches, ≤150 athletes, 14-day trial |
| `academy_scale` | organization | $349/mo, $3,490/yr | unlimited coaches, ≤400 athletes, 14-day trial |

Annual = 10× monthly. Prices are research recommendations seeded as
data (not approved public prices). **Sponsored athletes and $149
in-person members are never charged** — checkout returns
`ALREADY_COVERED`.

## Entitlements (computed, never stored)

Athlete precedence: **in-person membership > sponsorship > own
subscription > free**. Coach: org subscription > own subscription >
read-only. Lapse never deletes data; reactivation restores access.
`myEntitlements` returns the resolved object
(`{tier, planCode, source, fullHistory, historyDays, maxCoachLinks, ...}`).

## Methods — accounts & organizations

### `registerAthlete` — roles: athlete, director
Provisioning on first authenticated call (idempotent).
Params: `email`*, `name`*, `age`, `dob`, `sports[]`.
Returns: `{appUser, athlete, entitlements, alreadyRegistered}`.
New athletes start on the free tier.

### `registerCoach` — roles: coach, director
Params: `email`*, `name`*, `orgName`.
Creates app user (`coach`), a solo organization, an `org_admin`
membership, the coach record, and a 14-day `coach_starter` trial.
Returns: `{appUser, coach, organization, trial, entitlements, alreadyRegistered}`.

### `createOrganization` — roles: coach, org_admin, director
Params: `name`*, `kind` (`team`|`academy`), `slug`.
Founder becomes `org_admin`; a 14-day `team_academy` trial starts.
Returns: `{organization, trial, entitlements}`.

### `inviteToOrg` — roles: org_admin, director
Params: `organizationId`*, `email`*.
Returns: `{invitation, token}` — **the raw token is returned once**;
only its SHA-256 hash is stored. 7-day expiry. Enforces the org
plan's coach cap (`ENTITLEMENT_LIMIT`).

### `inviteAthlete` — roles: coach, org_admin, director
Params: `email`*, `organizationId`, `inviteRole` (`athlete`|`parent`).
Same token rules as `inviteToOrg`.

### `acceptInvitation` — roles: coach, athlete, parent, org_admin, director
Params: `token`*, `athleteId` (athlete invites), `name`.
Coach invite → org membership + coach record. Athlete invite →
roster link to the inviting coach (consent/cap gates apply).
Single-use: replay → `INVITATION_INVALID`.

### `orgOverview` — roles: org_admin, director
Params: `organizationId`*.
Returns: `{organization, entitlements, coaches[{coach, athleteCount}], athleteCount, athletes, pendingInvitations}`.

## Methods — roster

### `linkAthlete` — roles: coach, org_admin, director
Params: `athleteId`*, `coachId` (defaults to caller), `organizationId`, `source`, `confirmOverage`.
Gates, in order: minor consent (`CONSENT_REQUIRED`) → coach
subscription active (`SUBSCRIPTION_INACTIVE`) → coach roster cap
(`ENTITLEMENT_LIMIT`, soft overage only with `confirmOverage:true`)
→ athlete free-tier link cap (`ENTITLEMENT_LIMIT`).
Returns: `{link, alreadyLinked, overage}`.

### `unlinkAthlete` — roles: coach, org_admin, director, athlete
Params: `athleteId`*, `coachId`, `organizationId`.
Ends the link (access ends; athlete data/history retained).

### `myRoster` — roles: coach, org_admin, director
Returns: `{athletes: [{athlete, links}], count}` — coach: own
links; org_admin: org-wide; director: all.

## Methods — assignments & history

### `createAssignment` — roles: coach, director
Params: `athleteId`*, `title`*, `instructions`, `gameIds[]`
(TP2 IDs), `build` (`LEARN|COMPETE|PRESSURE|CHAOS`), `dose`
(`{rounds, workSec, restSec, distance, reps, note}` — coach-set
programming), `dueAt`, `developmentPlanId`, `organizationId`.
Gates: link scope (`FORBIDDEN`), coach subscription
(`SUBSCRIPTION_INACTIVE`), minor consent, game validation
(`INVALID_GAME_ID` / `GAME_NOT_ASSIGNABLE`).
Assignments are coach-authored, always — no assessment score ever
creates one.

### `listAssignments` — roles: coach, org_admin, director, parent, athlete
Params: `athleteId` (defaults to self for athletes), `status`.
Cross-tenant → `ATHLETE_NOT_FOUND`.

### `completeAssignment` — roles: athlete, director
Params: `assignmentId`*, `durationMin`, `effortRpe` (1–10),
`athleteNote`, `completedAt`.
Append-only completion; one per assignment (`ALREADY_COMPLETED`).
No tier gate on completing work already assigned.

### `athleteHistory` — roles: coach, org_admin, director, parent, athlete
Params: `athleteId` (defaults to self).
Returns the joined read model — nothing copied:
`{athleteId, entitlements, completions, assignments, assessments, truncated, historyWindowDays}`.
Free tier: 90-day display window (`truncated:true` when rows fall
outside it; rows are retained). Minors without consent →
`CONSENT_REQUIRED`.

## Methods — entitlements & subscriptions

### `myEntitlements` — all roles
Params: `athleteId` (optional; defaults by role).
Returns `{kind, entitlements}` per the precedence rules above.

### `mySubscription` — roles: coach, org_admin, director, athlete
Params: `ownerType`, `ownerId` (default: caller's own).
Returns `{ownerType, ownerId, subscriptions, granting}`.

### `cancelSubscription` — roles: coach, org_admin, director, athlete
Params: `subscriptionId`*, `atPeriodEnd` (default true).
Access continues to period end when `atPeriodEnd`; entitlement
derivation handles the rest. Owner-scoped.

### `expireSubscription` — director only
Params: `subscriptionId`*. Test/admin lifecycle control.

### `listPlans` — all roles
Returns `{plans}` (also `GET /api/saas/plans`).

## Methods — sponsorships & consent

### `sponsorAthlete` — roles: coach, org_admin, director
Params: `athleteId`* (director also: `sponsorType`, `sponsorId`).
Requires the sponsor to hold a granting subscription
(`SUBSCRIPTION_INACTIVE` otherwise) and the athlete in scope.
While active, the athlete resolves as `sponsored` and checkout is
refused `ALREADY_COVERED`.

### `endSponsorship` — roles: coach, org_admin, director
Params: `sponsorshipId` or `athleteId`. Owner-scoped.

### `grantConsent` — roles: parent, director
Params: `athleteId`*, `consentVersion`*, `method` (default
`in_app`), `guardianId`. Append-only. A parent must be a linked
guardian of the athlete. Director may record off-platform consent
(e.g. `method: "paper_on_file"`).

### `withdrawConsent` — roles: parent, director
Params: `athleteId`*. Append-only; re-gates the minor immediately,
history retained.

## Billing (`POST /api/billing`, fake adapter)

- `createCheckoutSession` `{ownerType, ownerId, planCode, interval}` →
  `{sessionId, url, priceCents, interval, planCode}`. Athlete
  checkout first resolves entitlements: covered athletes get
  `ALREADY_COVERED` (+`coveringSource`).
- `confirmCheckout` `{sessionId}` → `{subscription, alreadyComplete}`
  (test/dev stand-in for a completed checkout + webhook).
- `createPortalSession` `{ownerType, ownerId}` → `{url}`.
- `handleProviderEvent` `{providerEventId, type, payload}` →
  idempotent by `providerEventId`; types `subscription.cancelled`,
  `subscription.past_due`, `subscription.renewed`.

The Stripe adapter (`StripeTestAdapter`) refuses live keys by
construction and makes no network calls: Stripe is **not connected**
in this environment (design §2.6). Connecting test mode, creating
test products, and any live billing are separate Marcus decisions.

## Assessment API change (additive)

`server/assessment-access.js` now also accepts `links` and
`orgMemberships` in its directory: a coach with an **active link**
can assess/view that athlete (in addition to cohort scope, which is
unchanged); `org_admin` can **view** (never assess) athletes linked
inside their orgs. The dev server's assessment directory is
unchanged (cohort scope only) — wiring links into it is frontend/
integration work; the SaaS store's links are the source.

## Frontend notes

- Dev server seeds everything above; restart wipes it. The
  assessment-history join in `athleteHistory` reads the real
  workflow view (seeded youth/wingback sessions appear).
- Display rules that must hold in UI: GAA results are
  coach-recorded measurements (unvalidated battery — no norms,
  percentiles, or rankings); assessment recording stays
  coach/director-only at every tier; free-tier history shows the
  90-day window with `truncated` — never imply data was deleted.
- The existing UI-preservation test asserts no billing code in the
  prototype HTML; SaaS UI belongs in an injected module
  (`saas-ui/`, design §2.7), not in `THE PROGRAM OS.html`.
