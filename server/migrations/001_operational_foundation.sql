-- THE PROGRAM OS — Operational Foundation V1
-- Migration 001: operational data model (PostgreSQL / Supabase-compatible)
--
-- STATUS: version-controlled migration ONLY. Not applied to any database.
-- Supabase project TheProgramOS (ref rkgdwqgmldznczikrjip) was inspected
-- read-only 2026-11-12 and found EMPTY (0 tables in public, 0 auth users).
-- Backend decision 2026-11-12 (FINAL): Supabase is the SOLE backend for
-- The Program OS; the Neon TheProgramOS project is unused. Applying this
-- migration to TheProgramOS requires Marcus's approval — see
-- docs/MORNING_DECISIONS.md and docs/SUPABASE_HANDOFF.md.
-- Verified 2026-11-12: no PG16+ features are used (gen_random_uuid,
-- JSONB, partial indexes, plpgsql FOR UPDATE are all PG15-compatible);
-- the project runs Postgres 15.8.1.50.
--
-- Design notes
-- * Cohort enrollment cap (cohorts.enrollment_cap) and session reservation
--   cap (training_sessions.capacity_effective) are SEPARATE columns on
--   purpose. One is "how many may belong"; the other is "how many may
--   book this session", computed by server/session-capacity.js from
--   coaches, template, facility and equipment, and snapshotted here at
--   scheduling time (capacity_inputs JSONB preserves the inputs so a
--   recalculation is auditable).
-- * Money: memberships.price_cents = 14900 ($149/athlete/month, fixed by
--   the owner). This schema stores membership STATUS; it does not create
--   billing, charges, or a payment integration. Billing activation is an
--   owner decision.
-- * Minors: athletes.dob is date-of-birth (sensitive). Access must be
--   least-privilege (RLS policies below are the starting point — a
--   Director/Coach/Parent role model must be completed before any real
--   athlete record is stored). No athlete PII belongs in browser storage.
-- * Every mutation that matters writes operational_audit_events.
--   Reservations/waitlists/attendance are append-audited by the API
--   layer; the reserve_seat() function below also audits.
-- * Idempotent: safe to re-run (IF NOT EXISTS / ON CONFLICT guards).

BEGIN;

-- CITEXT is used for app_users.email / guardians.email. Supabase provides
-- the citext extension; create it if missing so a fresh database does not
-- fail on the first CREATE TABLE. (Dashboard SQL editor accepts this.)
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('director','coach','parent','athlete','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guardians (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  email CITEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS athletes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob DATE, -- sensitive: minors' data; least-privilege access only
  age_years INT CHECK (age_years BETWEEN 5 AND 19),
  sports TEXT[] NOT NULL DEFAULT '{}',
  eligible_cohort_ids UUID[] NOT NULL DEFAULT '{}', -- DENORMALIZED SNAPSHOT ONLY.
  -- Source of truth for cohort eligibility is the cohort_enrollments join
  -- table (decided 2026-11-12). The Postgres store hydrates this array
  -- from cohort_enrollments (status='enrolled') at read time; never edit
  -- this array as the way to grant eligibility — insert an enrollment row.
  restrictions TEXT[] NOT NULL DEFAULT '{}', -- readiness restrictions, e.g. ['Competitive Conditioning']
  notes TEXT, -- coach notes; never a measurement
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS athlete_guardians (
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  guardian_id UUID NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT 'parent',
  is_primary BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (athlete_id, guardian_id)
);

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active','trialing','past_due','paused','expired','cancelled')),
  price_cents INT NOT NULL DEFAULT 14900, -- $149/athlete/month, owner-fixed
  currency TEXT NOT NULL DEFAULT 'USD',
  start_date DATE NOT NULL,
  end_date DATE, -- NULL = open-ended while active
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memberships_athlete ON memberships (athlete_id, status);

CREATE TABLE IF NOT EXISTS locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL, -- YAK / ELL / CLE in the prototype
  name TEXT NOT NULL,
  facility TEXT,
  arrangement TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS training_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  max_athletes INT, -- operator-supplied occupancy; NULL = unspecified (never inferred from dimensions)
  has_wall BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (location_id, name)
);

CREATE TABLE IF NOT EXISTS coaches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('director','lead_coach','coach','sub_coach')),
  home_location_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','onboarding','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coach_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_min INT NOT NULL CHECK (start_min >= 0 AND start_min < 1440),
  end_min INT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  available BOOLEAN NOT NULL DEFAULT true, -- false = unavailable block
  note TEXT,
  UNIQUE (coach_id, date, start_min, end_min)
);

CREATE TABLE IF NOT EXISTS cohorts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL, -- YAK-A, ELL-B, CLE-B, ...
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL, -- e.g. 'Ages 9-11'
  age_min INT NOT NULL, age_max INT NOT NULL,
  days TEXT[] NOT NULL DEFAULT '{}', -- ['Mon','Wed']
  start_time TEXT NOT NULL, -- '4:30 PM' (prototype format, preserved)
  enrollment_cap INT NOT NULL CHECK (enrollment_cap > 0), -- NOT a session cap
  format TEXT NOT NULL DEFAULT 'Group' CHECK (format IN ('Group','Small group','1:1')),
  emphasis TEXT[] NOT NULL DEFAULT '{}',
  head_coach_id UUID REFERENCES coaches(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cohort_enrollments (
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  cohort_id UUID NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
  enrolled_on DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','paused','left')),
  PRIMARY KEY (athlete_id, cohort_id)
);

CREATE TABLE IF NOT EXISTS session_templates (
  id TEXT PRIMARY KEY, -- p60 / p90 / p45 / sg45 / pp50 (prototype TEMPLATE_SEED)
  name TEXT NOT NULL,
  duration_min INT NOT NULL,
  one_group BOOLEAN NOT NULL DEFAULT false,
  phases JSONB NOT NULL -- {arrive, ignite, build, compete, reset, close} minutes
);

CREATE TABLE IF NOT EXISTS training_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id UUID REFERENCES cohorts(id) ON DELETE SET NULL,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  space_id UUID REFERENCES training_spaces(id) ON DELETE SET NULL,
  template_id TEXT REFERENCES session_templates(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  start_time TEXT NOT NULL,
  duration_min INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','done','cancelled')),
  capacity_effective INT NOT NULL CHECK (capacity_effective >= 0), -- reservation cap, computed (never guessed)
  capacity_preferred INT,
  capacity_inputs JSONB, -- inputs fed to session-capacity.js (auditable)
  capacity_recalc_note TEXT,
  plan_id TEXT, -- link to the human-approved session plan when one exists
  plan_approved_by TEXT, -- human approval is mandatory; never auto-approved
  emphasis TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_loc_date ON training_sessions (location_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_cohort_date ON training_sessions (cohort_id, date);

CREATE TABLE IF NOT EXISTS session_coaches (
  session_id UUID NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'coach',
  PRIMARY KEY (session_id, coach_id)
);

CREATE TABLE IF NOT EXISTS reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled','no_show')),
  promoted_from_waitlist_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  created_by TEXT
);
-- Duplicate confirmed reservations are impossible at the database level,
-- even if two writers race: only one 'confirmed' row per athlete+session.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_confirmed
  ON reservations (session_id, athlete_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_reservations_session ON reservations (session_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_athlete ON reservations (athlete_id, status);

CREATE TABLE IF NOT EXISTS waitlist_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  position INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','promoted','skipped','withdrawn','expired')),
  promoted_reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, athlete_id, status) -- one live waitlist entry per athlete+session
);
CREATE INDEX IF NOT EXISTS idx_waitlist_session ON waitlist_entries (session_id, position);

CREATE TABLE IF NOT EXISTS attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('attended','late','no_show','excused')),
  walk_in BOOLEAN NOT NULL DEFAULT false, -- recorded without a reservation; audited explicitly
  recorded_by TEXT,
  note TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, athlete_id) -- one attendance record per athlete+session
);

CREATE TABLE IF NOT EXISTS operational_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL, -- RESERVED / CANCELLED / WAITLISTED / WAITLIST_PROMOTED / ATTENDANCE_RECORDED / ...
  actor TEXT NOT NULL,
  detail TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON operational_audit_events (entity_type, entity_id, at);

-- ---------------------------------------------------------------------------
-- reserve_seat(): the authoritative concurrency-safe reservation path.
-- One transaction: lock the session row, re-check capacity, enforce the
-- duplicate unique index, insert, audit. Returns 'confirmed' or
-- 'waitlisted' (with position) — or raises an exception with a stable
-- SQLSTATE-adjacent message the API maps to a rejection code.
-- The API/engine layer performs eligibility, coach-availability and
-- facility-conflict checks first; this function is the final atomic gate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reserve_seat(
  p_session_id UUID, p_athlete_id UUID, p_actor TEXT
) RETURNS TABLE (outcome TEXT, reservation_id UUID, waitlist_id UUID, position INT) AS $$
DECLARE
  v_cap INT;
  v_confirmed INT;
  v_res_id UUID;
  v_wl_id UUID;
  v_pos INT;
BEGIN
  SELECT capacity_effective INTO v_cap FROM training_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND'; END IF;
  -- Infeasible sessions refuse to book (2026-11-12 fix): a cap of 0 means
  -- zero coaches or an equipment shortfall — waitlisting everyone would
  -- silently promise seats that can never exist. The engine enforces the
  -- same guard in JS; this is the atomic backstop for direct callers.
  IF v_cap IS NULL OR v_cap <= 0 THEN
    RAISE EXCEPTION 'session_not_bookable: session % has no bookable capacity (effective cap %).', p_session_id, v_cap;
  END IF;

  SELECT COUNT(*) INTO v_confirmed FROM reservations
    WHERE session_id = p_session_id AND status = 'confirmed';

  IF v_confirmed >= v_cap THEN
    SELECT position INTO v_pos FROM waitlist_entries
      WHERE session_id = p_session_id AND athlete_id = p_athlete_id AND status = 'waiting';
    IF v_pos IS NOT NULL THEN
      RETURN QUERY SELECT 'already_waitlisted'::TEXT, NULL::UUID, NULL::UUID, v_pos;
      RETURN;
    END IF;
    SELECT COALESCE(MAX(position), 0) + 1 INTO v_pos FROM waitlist_entries
      WHERE session_id = p_session_id AND status = 'waiting';
    INSERT INTO waitlist_entries (session_id, athlete_id, position, status)
      VALUES (p_session_id, p_athlete_id, v_pos, 'waiting') RETURNING id INTO v_wl_id;
    INSERT INTO operational_audit_events (entity_type, entity_id, action, actor, detail)
      VALUES ('waitlist', v_wl_id::TEXT, 'WAITLISTED', p_actor,
        format('Session full (%s/%s); position %s.', v_confirmed, v_cap, v_pos));
    RETURN QUERY SELECT 'waitlisted'::TEXT, NULL::UUID, v_wl_id, v_pos;
    RETURN;
  END IF;

  INSERT INTO reservations (session_id, athlete_id, status, created_by)
    VALUES (p_session_id, p_athlete_id, 'confirmed', p_actor) RETURNING id INTO v_res_id;
  INSERT INTO operational_audit_events (entity_type, entity_id, action, actor, detail)
    VALUES ('reservation', v_res_id::TEXT, 'RESERVED', p_actor,
      format('Seat %s/%s for session %s.', v_confirmed + 1, v_cap, p_session_id));
  RETURN QUERY SELECT 'confirmed'::TEXT, v_res_id, NULL::UUID, NULL::INT;
END;
$$ LANGUAGE plpgsql;

-- Row-level security: enable on every table holding athlete data.
-- Policies below are the starting point (authenticated staff only by
-- default); role-specific policies (director/coach/parent scoping) must
-- be completed before any real athlete record is stored. Do NOT weaken.
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE athletes ENABLE ROW LEVEL SECURITY;
ALTER TABLE athlete_guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE cohorts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cohort_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_coaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_audit_events ENABLE ROW LEVEL SECURITY;

COMMIT;

-- Rollback (manual, for local dev only — never against production data):
-- DROP FUNCTION IF EXISTS reserve_seat(UUID, UUID, TEXT);
-- DROP TABLE IF EXISTS operational_audit_events, attendance_records,
--   waitlist_entries, reservations, session_coaches, training_sessions,
--   session_templates, cohort_enrollments, cohorts, coach_availability,
--   coaches, training_spaces, locations, memberships, athlete_guardians,
--   athletes, guardians, app_users;
