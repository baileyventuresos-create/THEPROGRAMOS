-- THE PROGRAM OS — Athlete Pathways & Prospect Portal V1 (Marcus mission 2026-11-26)
-- Migration 009: complimentary grants, prospect profiles + shares,
-- recruitment CRM, media links, development goals, scouting
-- evaluations, sport/positions on coach-athlete links.
--
-- STATUS: NOT APPLIED. Branch-only (feature/athlete-pathways-v1);
-- applying to Supabase project TheProgramOS (ref
-- rkgdwqgmldznczikrjip) is a separate owner decision. Do NOT apply
-- without that approval. Design: docs/PATHWAYS_AUDIT.md §6 (G1-G6).
--
-- Postgres 15 compatible, additive only, idempotent.
-- New tables only + two nullable columns on existing tables. No
-- existing table, column, or policy is altered, weakened, or
-- removed. Existing rows are untouched.
--
-- Deliberate limits (do not weaken): media links are URL/embed
-- links ONLY — no uploads, no Storage bucket, no paid hosting;
-- no population norms, percentiles, rankings, or
-- professional-readiness scores anywhere in this migration;
-- prospect profiles are private by default and shareable only via
-- a hashed token after athlete + coach approval (+ guardian
-- consent for minors); no mass outreach, no contract negotiation,
-- no agent functionality in the CRM tables.
--
-- Real-Postgres validation gate: no Postgres engine exists in the
-- build environment (docs/PATHWAYS_AUDIT.md §5). This migration
-- must be proven on a real Postgres copy (Neon scratch / Supabase
-- scratch) per the production-migration-validation protocol before
-- any production apply. Do not claim it as validated until then.

BEGIN;

-- ---------------------------------------------------------------------------
-- G1: Complimentary grants (owner-granted free access).
-- expires_at NULL = indefinite. Status is append-style state on the
-- row (active/suspended/revoked); audit trail lives in
-- operational_audit_events via store.audit() (app layer).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS complimentary_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  granted_by TEXT NOT NULL,  -- auth UID of the director (owner) who granted
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,   -- NULL = indefinite
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  reason TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_grant_active
  ON complimentary_grants (athlete_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_grant_athlete ON complimentary_grants (athlete_id, status);

-- ---------------------------------------------------------------------------
-- G3: Prospect profiles + sharing links.
-- A profile is private by default (status draft). It becomes
-- shareable only at status 'approved', which requires BOTH athlete
-- approval AND coach approval; a minor additionally requires a
-- guardian-consent row (guardian_consent_id). Share tokens are
-- stored hashed (SHA-256 hex), same pattern as invitations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prospect_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  bio TEXT,
  primary_sport TEXT NOT NULL CHECK (primary_sport IN ('baseball', 'soccer', 'basketball', 'football', 'flag_football')),
  secondary_sport TEXT CHECK (secondary_sport IS NULL OR secondary_sport IN ('baseball', 'soccer', 'basketball', 'football', 'flag_football')),
  positions TEXT[] NOT NULL DEFAULT '{}',
  measurements JSONB NOT NULL DEFAULT '{}',
  accomplishments JSONB NOT NULL DEFAULT '[]',
  playing_history JSONB NOT NULL DEFAULT '[]',
  verified_metrics JSONB NOT NULL DEFAULT '{}',
  availability TEXT,
  contact_info JSONB NOT NULL DEFAULT '{}',  -- NEVER exposed on a public read
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved')),
  coach_approved_by UUID REFERENCES coaches(id) ON DELETE SET NULL,
  coach_approved_at TIMESTAMPTZ,
  athlete_approved_at TIMESTAMPTZ,
  guardian_consent_id UUID REFERENCES guardian_consents(id) ON DELETE SET NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (athlete_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_athlete ON prospect_profiles (athlete_id, status);

CREATE TABLE IF NOT EXISTS profile_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES prospect_profiles(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_share_token ON profile_shares (token_hash);
CREATE INDEX IF NOT EXISTS idx_share_profile ON profile_shares (profile_id, status);

-- ---------------------------------------------------------------------------
-- G4: Recruitment CRM. No mass outreach, no contract negotiation,
-- no agent functionality. Opportunity levels and regions are data,
-- not rankings: WA/OR/CA first, free-text region for expansion.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_name TEXT NOT NULL,
  sport TEXT,
  league TEXT,
  level TEXT CHECK (level IS NULL OR level IN ('collegiate', 'developmental', 'pre-professional', 'semi-professional', 'professional', 'national team')),
  region TEXT,
  contact_name TEXT,
  title TEXT,
  email TEXT,
  phone TEXT,
  requirements TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'evaluating', 'offered', 'committed', 'declined')),
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  created_by_coach_id UUID REFERENCES coaches(id) ON DELETE SET NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_contact_org ON recruitment_contacts (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_rec_contact_level ON recruitment_contacts (level, region);

CREATE TABLE IF NOT EXISTS recruitment_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES recruitment_contacts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('tryout', 'combine', 'other')),
  date DATE,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_opp_contact ON recruitment_opportunities (contact_id, date);

CREATE TABLE IF NOT EXISTS recruitment_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES recruitment_contacts(id) ON DELETE CASCADE,
  author TEXT NOT NULL,  -- auth UID of the note author
  body TEXT NOT NULL,
  follow_up_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_note_contact ON recruitment_notes (contact_id, follow_up_date);

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES recruitment_contacts(id) ON DELETE CASCADE,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'referred' CHECK (status IN ('referred', 'contacted', 'evaluating', 'offered', 'committed', 'declined')),
  outcome TEXT,
  referred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  referred_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_contact ON referrals (contact_id, status);
CREATE INDEX IF NOT EXISTS idx_referral_athlete ON referrals (athlete_id, status);

-- ---------------------------------------------------------------------------
-- G5: Media links (URL/embed links ONLY — no uploads, no Storage).
-- Visibility follows the profile's sharing state (app layer).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prospect_media_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES prospect_profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('highlight', 'full_game', 'other')),
  url TEXT NOT NULL,
  title TEXT,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_profile ON prospect_media_links (profile_id, kind);

-- ---------------------------------------------------------------------------
-- G6: Development goals + scouting evaluations. Evaluations are
-- visible to the athlete; only coach-approved ones are included in
-- a public prospect profile (app layer).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS development_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  coach_id UUID REFERENCES coaches(id) ON DELETE SET NULL,
  goal TEXT NOT NULL,
  target_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goal_athlete ON development_goals (athlete_id, status);

CREATE TABLE IF NOT EXISTS scouting_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  coach_id UUID REFERENCES coaches(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  coach_approved BOOLEAN NOT NULL DEFAULT true,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eval_athlete ON scouting_evaluations (athlete_id, created_at);

-- ---------------------------------------------------------------------------
-- G2/G6: additive columns on existing tables (nullable; existing
-- rows unaffected). Athlete account status (active/suspended) is
-- owner-managed; sport + positions live on the coach-athlete link.
-- ---------------------------------------------------------------------------
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended'));
ALTER TABLE coach_athlete_links ADD COLUMN IF NOT EXISTS sport TEXT
  CHECK (sport IS NULL OR sport IN ('baseball', 'soccer', 'basketball', 'football', 'flag_football'));
ALTER TABLE coach_athlete_links ADD COLUMN IF NOT EXISTS positions TEXT[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- RLS on every new table. Additive policies only; no existing policy
-- is touched. No anon policies anywhere. Director = full access;
-- linked coach / org admin read-write on their scope; athlete reads
-- own profile; public profile reads are token-gated in the app
-- layer (no anon SELECT policy — the share token is the credential).
-- ---------------------------------------------------------------------------
ALTER TABLE complimentary_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruitment_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruitment_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruitment_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_media_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE development_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting_evaluations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS grant_director ON complimentary_grants;
CREATE POLICY grant_director ON complimentary_grants FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS grant_athlete_read ON complimentary_grants;
CREATE POLICY grant_athlete_read ON complimentary_grants FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS profile_director ON prospect_profiles;
CREATE POLICY profile_director ON prospect_profiles FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS profile_linked ON prospect_profiles;
CREATE POLICY profile_linked ON prospect_profiles FOR ALL TO authenticated
  USING (public.is_my_linked_athlete(athlete_id)) WITH CHECK (public.is_my_linked_athlete(athlete_id));
DROP POLICY IF EXISTS profile_athlete ON prospect_profiles;
CREATE POLICY profile_athlete ON prospect_profiles FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS share_director ON profile_shares;
CREATE POLICY share_director ON profile_shares FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS share_linked ON profile_shares;
CREATE POLICY share_linked ON profile_shares FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.prospect_profiles p
    WHERE p.id = profile_shares.profile_id AND public.is_my_linked_athlete(p.athlete_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.prospect_profiles p
    WHERE p.id = profile_shares.profile_id AND public.is_my_linked_athlete(p.athlete_id)));

DROP POLICY IF EXISTS rec_director ON recruitment_contacts;
CREATE POLICY rec_director ON recruitment_contacts FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS rec_org ON recruitment_contacts;
CREATE POLICY rec_org ON recruitment_contacts FOR ALL TO authenticated
  USING (organization_id IS NOT NULL AND public.is_my_org_admin(organization_id))
  WITH CHECK (organization_id IS NOT NULL AND public.is_my_org_admin(organization_id));
DROP POLICY IF EXISTS rec_coach ON recruitment_contacts;
CREATE POLICY rec_coach ON recruitment_contacts FOR ALL TO authenticated
  USING (created_by_coach_id = public.my_coach_id())
  WITH CHECK (created_by_coach_id = public.my_coach_id());

DROP POLICY IF EXISTS opp_director ON recruitment_opportunities;
CREATE POLICY opp_director ON recruitment_opportunities FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS opp_contact ON recruitment_opportunities;
CREATE POLICY opp_contact ON recruitment_opportunities FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.recruitment_contacts c
    WHERE c.id = recruitment_opportunities.contact_id
      AND (c.created_by_coach_id = public.my_coach_id()
        OR (c.organization_id IS NOT NULL AND public.is_my_org_admin(c.organization_id)))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.recruitment_contacts c
    WHERE c.id = recruitment_opportunities.contact_id
      AND (c.created_by_coach_id = public.my_coach_id()
        OR (c.organization_id IS NOT NULL AND public.is_my_org_admin(c.organization_id)))));

DROP POLICY IF EXISTS note_director ON recruitment_notes;
CREATE POLICY note_director ON recruitment_notes FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS note_contact ON recruitment_notes;
CREATE POLICY note_contact ON recruitment_notes FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.recruitment_contacts c
    WHERE c.id = recruitment_notes.contact_id
      AND (c.created_by_coach_id = public.my_coach_id()
        OR (c.organization_id IS NOT NULL AND public.is_my_org_admin(c.organization_id)))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.recruitment_contacts c
    WHERE c.id = recruitment_notes.contact_id
      AND (c.created_by_coach_id = public.my_coach_id()
        OR (c.organization_id IS NOT NULL AND public.is_my_org_admin(c.organization_id)))));

DROP POLICY IF EXISTS referral_director ON referrals;
CREATE POLICY referral_director ON referrals FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS referral_contact ON referrals;
CREATE POLICY referral_contact ON referrals FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.recruitment_contacts c
    WHERE c.id = referrals.contact_id
      AND (c.created_by_coach_id = public.my_coach_id()
        OR (c.organization_id IS NOT NULL AND public.is_my_org_admin(c.organization_id)))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.recruitment_contacts c
    WHERE c.id = referrals.contact_id
      AND (c.created_by_coach_id = public.my_coach_id()
        OR (c.organization_id IS NOT NULL AND public.is_my_org_admin(c.organization_id)))));
DROP POLICY IF EXISTS referral_athlete_read ON referrals;
CREATE POLICY referral_athlete_read ON referrals FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS media_director ON prospect_media_links;
CREATE POLICY media_director ON prospect_media_links FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS media_linked ON prospect_media_links;
CREATE POLICY media_linked ON prospect_media_links FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.prospect_profiles p
    WHERE p.id = prospect_media_links.profile_id AND public.is_my_linked_athlete(p.athlete_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.prospect_profiles p
    WHERE p.id = prospect_media_links.profile_id AND public.is_my_linked_athlete(p.athlete_id)));
DROP POLICY IF EXISTS media_athlete_read ON prospect_media_links;
CREATE POLICY media_athlete_read ON prospect_media_links FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.prospect_profiles p
    WHERE p.id = prospect_media_links.profile_id AND public.is_my_athlete(p.athlete_id)));

DROP POLICY IF EXISTS goal_director ON development_goals;
CREATE POLICY goal_director ON development_goals FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS goal_linked ON development_goals;
CREATE POLICY goal_linked ON development_goals FOR ALL TO authenticated
  USING (public.is_my_linked_athlete(athlete_id)) WITH CHECK (public.is_my_linked_athlete(athlete_id));
DROP POLICY IF EXISTS goal_athlete_read ON development_goals;
CREATE POLICY goal_athlete_read ON development_goals FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS eval_director ON scouting_evaluations;
CREATE POLICY eval_director ON scouting_evaluations FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS eval_linked ON scouting_evaluations;
CREATE POLICY eval_linked ON scouting_evaluations FOR ALL TO authenticated
  USING (public.is_my_linked_athlete(athlete_id)) WITH CHECK (public.is_my_linked_athlete(athlete_id));
DROP POLICY IF EXISTS eval_athlete_read ON scouting_evaluations;
CREATE POLICY eval_athlete_read ON scouting_evaluations FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

-- ---------------------------------------------------------------------------
-- G6: Seed the five Pathways sport definitions in
-- assessment_definitions, exactly as the engine defines them (the
-- engine is the source of truth; this seed must match
-- assessment-engine.js). Measured tests only; no norms, thresholds,
-- rankings, or readiness scores.
-- ---------------------------------------------------------------------------
INSERT INTO assessment_definitions (id, name, domain, unit, direction, attempt_count, aggregation, module, pair_id, side, retest_days) VALUES
  ('30m-sprint', '30-Metre Sprint', 'acceleration', 'sec', 'lower', 3, 'best', 'soccer', NULL, NULL, 28),
  ('t-test-agility', 'T-Test Agility', 'agility', 'sec', 'lower', 2, 'best', 'soccer', NULL, NULL, 28),
  ('vertical-jump', 'Vertical Jump', 'vertical_power', 'in', 'higher', 3, 'best', 'basketball', NULL, NULL, 28),
  ('lane-agility', 'Lane Agility Drill', 'agility', 'sec', 'lower', 2, 'best', 'basketball', NULL, NULL, 28),
  ('40yd-dash', '40-Yard Dash', 'acceleration', 'sec', 'lower', 3, 'best', 'football', NULL, NULL, 28)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Rollback (manual, owner-approved only): DROP TABLE IF EXISTS
-- scouting_evaluations, development_goals, prospect_media_links,
-- referrals, recruitment_notes, recruitment_opportunities,
-- recruitment_contacts, profile_shares, prospect_profiles,
-- complimentary_grants CASCADE; ALTER TABLE athletes DROP COLUMN IF
-- EXISTS status; ALTER TABLE coach_athlete_links DROP COLUMN IF
-- EXISTS sport, DROP COLUMN IF EXISTS positions;
