-- THE PROGRAM OS — SaaS Expansion (Marcus mission 2026-11-20)
-- Migration 006: SaaS foundation — organizations (tenants), org
-- memberships, coach-athlete roster links, invitations, guardian
-- consents, additive tenancy columns, org_admin role, RLS helpers +
-- additive link-scope policies.
--
-- STATUS: NOT APPLIED. Branch-only (feature/the-program-saas-
-- commercialization); applying to Supabase project TheProgramOS
-- (ref rkgdwqgmldznczikrjip) is a separate owner decision. Do NOT
-- apply without that approval. Design: docs/SAAS_ARCHITECTURE.md §2.2.
--
-- Postgres 15 compatible. Additive only: new tables, four nullable
-- columns on existing tables, one CHECK re-issue (app_users.role
-- gains 'org_admin'), new RLS helpers and NEW policies only. No
-- existing table, column, or policy is altered, weakened, or removed.
-- Existing rows are untouched: NULL organization_id means "The
-- Program internal, pre-tenancy" and preserves today's behaviour.
-- Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS / guarded
-- re-issue), so a re-run is safe.
--
-- Numbering: the methodology audit proposed a 006 training-
-- methodology migration; the SaaS migrations take 006-008 and the
-- methodology shadow form, if ever approved, becomes 009.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tenants. A solo coach is an organization of one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('solo','team','academy','program_internal')),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who belongs to an org, in what capacity. (Coaches also keep their
-- coaches row; this table is the tenancy link.)
CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  org_role TEXT NOT NULL CHECK (org_role IN ('org_admin','coach')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, app_user_id)
);

-- The SaaS roster: coach <-> athlete, tenant-scoped. Distinct from
-- cohort_enrollments (in-person). A coach sees an athlete iff an
-- ACTIVE link exists (or via org_admin over the org's links).
-- Athletes stay tenant-neutral: ending a link ends access, never data.
CREATE TABLE IF NOT EXISTS coach_athlete_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES coaches(id) ON DELETE RESTRICT,
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  source TEXT NOT NULL CHECK (source IN ('coach_invite','athlete_request','org_assignment','program_internal')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_by TEXT,  -- auth UID of the actor (audit convention)
  UNIQUE (coach_id, athlete_id, organization_id, status)
);
-- Partial unique index for the live link (same pattern as reservations):
CREATE UNIQUE INDEX IF NOT EXISTS uq_link_active
  ON coach_athlete_links (coach_id, athlete_id, organization_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_link_coach ON coach_athlete_links (coach_id, status);
CREATE INDEX IF NOT EXISTS idx_link_athlete ON coach_athlete_links (athlete_id, status);
CREATE INDEX IF NOT EXISTS idx_link_org ON coach_athlete_links (organization_id, status);

-- Invitations (coach -> athlete/guardian, org -> coach). Token stored
-- hashed (SHA-256 hex); the raw token is shown to the inviter once.
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invited_by UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  invite_role TEXT NOT NULL CHECK (invite_role IN ('coach','athlete','parent')),
  coach_id UUID REFERENCES coaches(id) ON DELETE SET NULL,  -- set when a coach invites an athlete
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invite_org ON invitations (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_invite_token ON invitations (token_hash);

-- Guardian consent (mechanism only; legal text is counsel's — design §2.8).
-- Append-only: grant and withdrawal are separate rows; current state
-- is the latest row for the athlete.
CREATE TABLE IF NOT EXISTS guardian_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  guardian_id UUID NOT NULL REFERENCES guardians(id) ON DELETE RESTRICT,
  consent_version TEXT NOT NULL,  -- version of the terms presented (text owned by counsel)
  status TEXT NOT NULL CHECK (status IN ('granted','withdrawn')),
  method TEXT NOT NULL DEFAULT 'in_app',  -- how consent was captured (audit)
  granted_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consent_athlete ON guardian_consents (athlete_id, status);

-- ---------------------------------------------------------------------------
-- Additive columns (nullable; existing rows unaffected). NULL means
-- "The Program internal, pre-tenancy". Backfilling existing internal
-- rows to the program_internal org is a separate, separately
-- approved data step — NOT part of this schema migration.
-- ---------------------------------------------------------------------------
ALTER TABLE coaches           ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE cohorts           ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE locations         ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE training_sessions ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

-- app_users.role gains 'org_admin' (CHECK re-issue, guarded by
-- definition match like migration 005; existing roles all kept).
DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.app_users'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%role%'
      AND pg_get_constraintdef(oid) LIKE '%director%'
      AND pg_get_constraintdef(oid) NOT LIKE '%org_admin%'
  LOOP
    EXECUTE format('ALTER TABLE public.app_users DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.app_users'::regclass
      AND conname = 'app_users_role_check'
  ) THEN
    ALTER TABLE public.app_users
      ADD CONSTRAINT app_users_role_check
      CHECK (role IN ('director','coach','parent','athlete','admin','org_admin'));
  END IF;
END $$;

-- The Program's own in-person operation as a tenant (fixed id/slug so
-- later data steps can reference it deterministically).
INSERT INTO organizations (id, kind, name, slug)
VALUES ('11111111-1111-4111-8111-111111111111', 'program_internal', 'The Program', 'the-program-internal')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS helpers (SECURITY DEFINER, migration 003 style)
-- ---------------------------------------------------------------------------
-- Orgs where the caller is an active member.
CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS SETOF UUID
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT organization_id FROM public.organization_memberships
    WHERE app_user_id = public.app_user_id() AND status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.is_my_org(p_org_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE organization_id = p_org_id
        AND app_user_id = public.app_user_id() AND status = 'active'
    );
$$;

CREATE OR REPLACE FUNCTION public.is_my_org_admin(p_org_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE organization_id = p_org_id
        AND app_user_id = public.app_user_id()
        AND status = 'active' AND org_role = 'org_admin'
    );
$$;

-- Athlete linked to the caller: active link to the caller's coach
-- row, OR an active link inside an org the caller admins.
CREATE OR REPLACE FUNCTION public.is_my_linked_athlete(p_athlete_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.coach_athlete_links l
      WHERE l.athlete_id = p_athlete_id AND l.status = 'active'
        AND (l.coach_id = public.my_coach_id()
             OR public.is_my_org_admin(l.organization_id))
    );
$$;

-- Latest consent row for the athlete says 'granted'.
CREATE OR REPLACE FUNCTION public.has_guardian_consent(p_athlete_id UUID) RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((
      SELECT status = 'granted' FROM public.guardian_consents
      WHERE athlete_id = p_athlete_id
      ORDER BY created_at DESC LIMIT 1
    ), false);
$$;

-- ---------------------------------------------------------------------------
-- RLS on every new table. Additive policies only; no existing policy
-- is touched. No anon policies anywhere.
-- ---------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE coach_athlete_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_director ON organizations;
CREATE POLICY org_director ON organizations FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS org_member_read ON organizations;
CREATE POLICY org_member_read ON organizations FOR SELECT TO authenticated
  USING (public.is_my_org(id));
DROP POLICY IF EXISTS org_admin_write ON organizations;
CREATE POLICY org_admin_write ON organizations FOR UPDATE TO authenticated
  USING (public.is_my_org_admin(id)) WITH CHECK (public.is_my_org_admin(id));

DROP POLICY IF EXISTS orgmem_director ON organization_memberships;
CREATE POLICY orgmem_director ON organization_memberships FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS orgmem_member_read ON organization_memberships;
CREATE POLICY orgmem_member_read ON organization_memberships FOR SELECT TO authenticated
  USING (app_user_id = public.app_user_id() OR public.is_my_org(organization_id));
DROP POLICY IF EXISTS orgmem_admin_write ON organization_memberships;
CREATE POLICY orgmem_admin_write ON organization_memberships FOR ALL TO authenticated
  USING (public.is_my_org_admin(organization_id))
  WITH CHECK (public.is_my_org_admin(organization_id));

DROP POLICY IF EXISTS link_director ON coach_athlete_links;
CREATE POLICY link_director ON coach_athlete_links FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS link_coach ON coach_athlete_links;
CREATE POLICY link_coach ON coach_athlete_links FOR ALL TO authenticated
  USING (coach_id = public.my_coach_id()) WITH CHECK (coach_id = public.my_coach_id());
DROP POLICY IF EXISTS link_org_admin ON coach_athlete_links;
CREATE POLICY link_org_admin ON coach_athlete_links FOR ALL TO authenticated
  USING (public.is_my_org_admin(organization_id))
  WITH CHECK (public.is_my_org_admin(organization_id));
DROP POLICY IF EXISTS link_athlete_read ON coach_athlete_links;
CREATE POLICY link_athlete_read ON coach_athlete_links FOR SELECT TO authenticated
  USING (public.is_my_athlete(athlete_id));

DROP POLICY IF EXISTS invite_director ON invitations;
CREATE POLICY invite_director ON invitations FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS invite_org ON invitations;
CREATE POLICY invite_org ON invitations FOR ALL TO authenticated
  USING (public.is_my_org(organization_id)) WITH CHECK (public.is_my_org(organization_id));

DROP POLICY IF EXISTS consent_director ON guardian_consents;
CREATE POLICY consent_director ON guardian_consents FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS consent_guardian ON guardian_consents;
CREATE POLICY consent_guardian ON guardian_consents FOR ALL TO authenticated
  USING (public.is_my_athlete(athlete_id)) WITH CHECK (public.is_my_athlete(athlete_id));
DROP POLICY IF EXISTS consent_coach_read ON guardian_consents;
CREATE POLICY consent_coach_read ON guardian_consents FOR SELECT TO authenticated
  USING (public.is_my_linked_athlete(athlete_id) OR public.is_my_cohort_athlete(athlete_id));

-- ---------------------------------------------------------------------------
-- Additive link-scope on existing assessment tables (design §2.4):
-- NEW permissive policies alongside the cohort ones. Postgres ORs
-- permissive policies, so cohort access is preserved exactly while
-- active-link access is added. No existing policy is edited.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS asess_link_read ON assessment_sessions;
CREATE POLICY asess_link_read ON assessment_sessions FOR SELECT TO authenticated
  USING (public.is_my_linked_athlete(athlete_id));
DROP POLICY IF EXISTS asess_link_write ON assessment_sessions;
CREATE POLICY asess_link_write ON assessment_sessions FOR INSERT TO authenticated
  WITH CHECK (public.is_my_linked_athlete(athlete_id));
DROP POLICY IF EXISTS ares_link_read ON assessment_results;
CREATE POLICY ares_link_read ON assessment_results FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.assessment_sessions s
    WHERE s.id = assessment_results.session_id
      AND public.is_my_linked_athlete(s.athlete_id)
  ));
DROP POLICY IF EXISTS ares_link_write ON assessment_results;
CREATE POLICY ares_link_write ON assessment_results FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.assessment_sessions s
    WHERE s.id = assessment_results.session_id
      AND public.is_my_linked_athlete(s.athlete_id)
  ));

COMMIT;

-- Rollback (manual, local dev only — never against production data):
-- DROP POLICY IF EXISTS ares_link_write ON assessment_results;
-- DROP POLICY IF EXISTS ares_link_read ON assessment_results;
-- DROP POLICY IF EXISTS asess_link_write ON assessment_sessions;
-- DROP POLICY IF EXISTS asess_link_read ON assessment_sessions;
-- DROP TABLE IF EXISTS guardian_consents;
-- DROP TABLE IF EXISTS invitations;
-- DROP TABLE IF EXISTS coach_athlete_links;
-- DROP TABLE IF EXISTS organization_memberships;
-- DROP TABLE IF EXISTS organizations;
-- (The nullable organization_id columns and the widened role CHECK
-- are harmless if left in place; re-applying 006 is idempotent.)
