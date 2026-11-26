-- THE PROGRAM OS — Operational Foundation V1
-- Migration 002: assessment persistence (PostgreSQL / Supabase-compatible)
--
-- STATUS: APPLIED 2026-11-12 to Supabase project TheProgramOS
-- (ref rkgdwqgmldznczikrjip) with Marcus's approval, via the dashboard
-- SQL editor. Verified after apply: 22 public tables, 10 assessment
-- definitions seeded.
-- Follows assessment-engine/INTEGRATION.md "Future persistence model"
-- (assessment_definitions / assessment_sessions / assessment_results)
-- with one addition: a derived_records table that keeps the prototype's
-- LOCKED separation — measured results, coach observations, and system
-- interpretations are different rows, different kinds, never mixed.
--
-- Rules enforced by this schema + server/assessment-store.js:
-- * Every attempt is preserved (attempts JSONB); the result is derived
--   by the engine from the attempts, never typed in by hand.
-- * Baselines are derived (first valid result); history is never
--   overwritten. A baseline-policy change inserts a new derived row.
-- * Interpretations (trend, asymmetry) are stored as kind='interpretation'
--   with engine_version + caveat; they are never presented as measurements.
-- * The asymmetry 'monitor' label is a product signal, not a medical
--   threshold or diagnosis (assessment-engine/README.md). No percentile /
--   ranking / diagnostic claims are stored or produced.
-- * Assessment rows reference athletes.id (migration 001). No assessment
--   data is stored in browser storage.

BEGIN;

CREATE TABLE IF NOT EXISTS assessment_definitions (
  id TEXT PRIMARY KEY, -- e.g. '10yd-sprint' (engine DEFINITIONS keys)
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  unit TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('higher','lower')),
  attempt_count INT NOT NULL CHECK (attempt_count >= 1),
  aggregation TEXT NOT NULL DEFAULT 'best' CHECK (aggregation IN ('best','mean','median')),
  module TEXT, -- NULL = General Athlete; 'baseball' = Baseball module
  pair_id TEXT, -- e.g. 'rotational-scoop' links L/R definitions
  side TEXT CHECK (side IS NULL OR side IN ('left','right')),
  protocol_version TEXT NOT NULL DEFAULT 'v1',
  retest_days INT NOT NULL DEFAULT 28,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS assessment_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  coach_id UUID REFERENCES coaches(id) ON DELETE SET NULL,
  battery TEXT NOT NULL, -- 'generalAthlete' | 'baseball' | 'custom'
  recorded_at TIMESTAMPTZ NOT NULL,
  context JSONB, -- {equipment, surface, protocolVersion, timingMethod}
  engine_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asess_athlete ON assessment_sessions (athlete_id, recorded_at);

CREATE TABLE IF NOT EXISTS assessment_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  assessment_id TEXT NOT NULL REFERENCES assessment_definitions(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL DEFAULT 'measured' CHECK (kind = 'measured'),
  attempts JSONB NOT NULL, -- every attempt, preserved
  result NUMERIC, -- engine-derived (best per definition); NULL when no valid attempt
  unit TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('higher','lower')),
  protocol_version TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (session_id, assessment_id) -- one result per assessment per session
);
CREATE INDEX IF NOT EXISTS idx_ares_athlete ON assessment_results (athlete_id, assessment_id, recorded_at);

CREATE TABLE IF NOT EXISTS assessment_derived_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES assessment_sessions(id) ON DELETE CASCADE,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  assessment_id TEXT, -- NULL for session-level observations; pair id for asymmetry
  kind TEXT NOT NULL CHECK (kind IN ('observation','interpretation')),
  derived_type TEXT, -- 'baseline' | 'trend-vs-baseline' | 'bilateral-asymmetry' | NULL (observation)
  value JSONB, -- interpretation payload (engine output); NULL for observations
  text TEXT, -- coach observation text; NULL for interpretations
  source TEXT NOT NULL, -- 'assessment-engine' | 'derived-first-valid-result' | 'coach'
  engine_version TEXT,
  caveat TEXT NOT NULL, -- why this record must not be read as a measurement/diagnosis
  recorded_at TIMESTAMPTZ NOT NULL,
  CHECK ((kind = 'observation' AND text IS NOT NULL AND value IS NULL)
      OR (kind = 'interpretation' AND value IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_ader_athlete ON assessment_derived_records (athlete_id, assessment_id, recorded_at);

ALTER TABLE assessment_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_derived_records ENABLE ROW LEVEL SECURITY;

-- Seed the V1 definitions exactly as the engine defines them (engine is
-- the source of truth; this seed must match assessment-engine.js).
INSERT INTO assessment_definitions (id, name, domain, unit, direction, attempt_count, aggregation, module, pair_id, side, retest_days) VALUES
  ('10yd-sprint','10-Yard Sprint','acceleration','sec','lower',3,'best',NULL,NULL,NULL,28),
  ('broad-jump','Standing Broad Jump','horizontal_power','in','higher',3,'best',NULL,NULL,NULL,28),
  ('rotational-scoop-r','Rotational Scoop Throw — Right','rotational_power','ft','higher',3,'best',NULL,'rotational-scoop','right',28),
  ('rotational-scoop-l','Rotational Scoop Throw — Left','rotational_power','ft','higher',3,'best',NULL,'rotational-scoop','left',28),
  ('push-ups','Quality Push-Ups','relative_strength','reps','higher',1,'best',NULL,NULL,NULL,28),
  ('side-plank-r','Side Plank — Right','trunk_control','sec','higher',1,'best',NULL,'side-plank','right',28),
  ('side-plank-l','Side Plank — Left','trunk_control','sec','higher',1,'best',NULL,'side-plank','left',28),
  ('throw-velo','Throwing Velocity','throwing_velocity','mph','higher',5,'best','baseball',NULL,NULL,28),
  ('throw-accuracy','Throwing Accuracy','throwing_accuracy','pct','higher',1,'best','baseball',NULL,NULL,28),
  ('exit-velo','Exit Velocity','bat_speed_output','mph','higher',5,'best','baseball',NULL,NULL,28)
ON CONFLICT (id) DO NOTHING;

COMMIT;
