# THE PROGRAM OS — Operational Foundation V1 (server/)

Backend operational modules for THE PROGRAM OS. These are **new, additive
modules** — the prototype (`THE PROGRAM OS.html`, loaded by `index.html`)
is untouched. No UI file was modified; see `tests/ui-preservation.snapshot.json`.

## What is here

| File | Purpose |
|---|---|
| `session-capacity.js` | Derives a per-session reservation cap from coaches, template, facility and equipment, mirroring the prototype's `buildConfigs`/`slotMath` rules. No universal athlete limit anywhere. |
| `reservation-engine.js` | Backend reservation engine: eligibility, duplicates, conflicts, coach/facility availability, capacity, waitlists + auto-promotion, attendance, audit trail. Concurrency-safe (per-session mutex + store transactions). |
| `reservation-stores.js` | `MemoryStore` (tests/dev) and `SqliteStore` (Node's built-in `node:sqlite`, no dependencies) implementing the engine's store interface. |
| `assessment-store.js` | Persistence adapter for the assessment engine: measured results, coach observations, and system interpretations stored as separate record kinds; baselines derived, never overwritten. |
| `migrations/001_operational_foundation.sql` | PostgreSQL schema for the full operational model + atomic `reserve_seat()` function. **Not applied anywhere** — no backend project exists yet. |
| `migrations/002_assessment_persistence.sql` | PostgreSQL schema for assessment definitions/sessions/results/derived records, seeded with the engine V1 definitions. **Not applied.** |
| `fixtures/seed-operational.json` | Fictional test fixtures transcribed from the prototype (7 cohorts, 4 coaches, 3 locations, 5 templates). No real athlete data. |
| `fixtures/generate-75-scenario.js` | Computes the 75-athlete weekly seat model; writes `scenario-75-athletes.json`. |
| `tests/*.test.js` | 46 tests (Node built-in runner, zero dependencies) + the pre-existing assessment-engine smoke test. |

## Run the tests

```sh
node --test server/tests/*.test.js assessment-engine/assessment-engine.test.js
```

No install step: Node 22.5+ only (`node:sqlite` is built in). There is no
`package.json` in this repo — that is intentional for now (see
`docs/OPERATIONAL_AUDIT.md`); if a `package.json` is added later it should
only formalise these commands, not change behaviour.

## Rules these modules enforce (owner-fixed)

- Membership is **$149/athlete/month**. This code reads membership status;
  it never sets prices or touches billing.
- A cohort's **enrollment cap ≠ a session's reservation cap**.
- Capacity is **never guessed**: a session without a computed capacity
  cannot be booked.
- Generated training sessions still require **human approval** — this
  engine books seats; it never generates or approves session content.
- No athlete PII in browser storage. The prototype's `localStorage`
  (`tp_os_v24`) holds demo state only and must not be used for real records.
