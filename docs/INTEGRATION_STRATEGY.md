# THE PROGRAM OS — Integration Strategy (Operational Foundation V1)

How the new backend modules connect to the existing prototype — and what
must be decided before any of it goes live. Nothing in this document
authorises a deployment, a database, or a payment integration.

## 1. Current state

- Prototype: static HTML, no backend, `localStorage` demo state only.
- New: `server/` modules (capacity adapter, reservation engine, stores,
  assessment adapter), PostgreSQL migrations (unapplied), fixtures, tests.
- The two do **not** talk to each other yet, by design: the UI was not
  touched overnight, and no live backend exists to talk to.

## 2. Backend: Supabase / PostgreSQL — DECIDED 2026-11-12 (FINAL)

Why: the data model is relational (reservations, waitlists, attendance,
assessments with history), the concurrency guarantee needs real
transactions, and the prototype's owner already operates Supabase for
Big Whiff — the same operational pattern (RLS, dashboard SQL, no local
prod data) applies. **Decided by Marcus 2026-11-12: Supabase is the
SOLE backend; the dual-database directive is cancelled and the Neon
TheProgramOS project is unused (preserve without modification).**
The target project is TheProgramOS itself (ref `rkgdwqgmldznczikrjip`,
inspected read-only 2026-11-12: EMPTY, 0 tables in public, 0 auth
users) — see MORNING_DECISIONS #2. Applying migrations to it still
needs Marcus's explicit approval.

Alternatives considered: (a) SQLite file on a single host — fine for local
dev (and what `SqliteStore` is for), not for multi-coach/multi-device use;
(b) Firebase/Firestore — transactions exist but the reservation guarantee
would need re-proving and the SQL migration would be discarded; (c) keep
everything in the browser — rejected: capacity enforcement cannot depend
solely on browser-side checks, and minors' data must not live in
`localStorage`.

## 3. Integration sequence (each step separately reviewable)

1. **Dev target: TheProgramOS itself.** The Supabase project
   TheProgramOS (ref `rkgdwqgmldznczikrjip`) is the dev/scratch target
   — no separate scratch project. Once Marcus approves, apply
   `migrations/001` + `002` + `003` to it (in order) via the dashboard
   SQL editor; the project was inspected empty 2026-11-12, so there is
   nothing to collide with. Run the concurrency checks against
   `reserve_seat()` with two concurrent calls (the same test the SQLite
   suite runs) and the RLS policy checks in docs/SUPABASE_HANDOFF.md.
2. **API layer (BUILT 2026-11-12, not yet run against live Supabase).**
   `server/postgres-store.js` (PostgresStore on a `pg` Pool) +
   `server/api.js` (thin authenticated service exposing `reserve`,
   `cancel`, `availableSeats`, `recordAttendance`,
   `reconcileAttendance`, `capacityFor`, `promoteWaitlist`). The engine
   is transport-agnostic; the API adds auth-context role checks +
   actor = auth UID, with the role-scoped RLS policies of migration
   003 as the backstop. No UI integration yet.
3. **Data rehearsal.** Map the prototype's generated state to the new
   schema in a script, run it against scratch, and verify counts. **Do
   not import demo athletes as real records** — they are fictional; the
   rehearsal proves the mapping, then the data is discarded. Real
   enrollment starts from real sign-ups.
4. **Read-only UI adapter (feature-flagged).** The prototype reads
   availability/capacity from the API for display; booking writes go
   through the API only. Booking surfaces in the athlete/parent context
   first (the pattern the assessment INTEGRATION.md already recommends
   for assessments). Director capacity view second. No redesign of any
   existing view.
5. **Session planning link (BUILT 2026-11-12).** `server/schedule-session.js`
   (`scheduleSession()`) takes a human-approved draft, runs
   `computeSessionCapacity()`, and returns the `training_sessions` row
   payload (`capacity_effective`, `capacity_inputs`, `plan_id`,
   `plan_approved_by`) plus `{ feasible, flaggedInfeasible }`. The
   human-approved draft (`draftSession` + Director approval) remains
   the only way session *content* is set. If a draft's expected
   attendance exceeds the computed cap, the session is flagged
   infeasible — capacity is never auto-raised to fit demand. No DB
   write happens in this function; the API/scheduling step owns writes.
6. **Assessments.** `assessment-store.js` becomes the repository behind
   the coach assessment overlay described in INTEGRATION.md (steps 4–7).
   Smart Draft evidence stays behind a feature flag, human-reviewed.
7. **Billing (separate approval).** Only after the membership terms are
   confirmed: choose a provider, map `memberships.status` to the provider's
   subscription state, and activate. The schema stores status only; it
   creates no charges.

## 4. What must never happen in integration

- Real athlete (especially minor) data in `localStorage`, in the public
  repo, or in an unsecured database.
- Browser-side capacity checks as the enforcement point.
- Auto-approving generated sessions, auto-raising capacity, or auto-
  promoting a waitlisted athlete without re-checking eligibility.
- Importing the 80 generated demo athletes as if they were real members.
- Deploying the prototype's demo state as production data.

## 5. Local development (no backend needed)

```sh
node --test server/tests/*.test.js assessment-engine/assessment-engine.test.js
node server/fixtures/generate-75-scenario.js   # regenerates scenario-75-athletes.json
```

`MemoryStore` for unit tests; `SqliteStore(':memory:')` (or a file path)
for a persistent local stand-in. Both implement the same interface the
PostgreSQL layer serves (`server/postgres-store.js`, built 2026-11-12;
tested against an injected fake Pool — no live Supabase needed).
