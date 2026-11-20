-- THE PROGRAM OS — SaaS Expansion (Marcus mission 2026-11-20)
-- Migration 008: subscriptions, sponsorships, billing events
-- (test-mode shape only).
--
-- STATUS: NOT APPLIED. Branch-only; applying to Supabase project
-- TheProgramOS (ref rkgdwqgmldznczikrjip) is a separate owner
-- decision. Do NOT apply without that approval. Design:
-- docs/SAAS_ARCHITECTURE.md §2.2 (migration 008) + §2.6.
--
-- subscriptions is SEPARATE from memberships (the in-person $149
-- status record) and never overloaded: the two money systems meet
-- only in server/entitlements.js resolution order (in-person
-- membership > sponsorship > own subscription > free). Entitlements
-- are COMPUTED from these rows, never stored.
--
-- Billing is test-mode only in this scope: provider is 'none' or
-- 'stripe_test'; the billing adapter refuses live keys by
-- construction (server/billing.js). No live product, price, or
-- charge exists. Plan prices/limits below are the market-research
-- recommendations (docs/SAAS_MARKET_RESEARCH.md §6) seeded as DATA
-- so Marcus can tune them without code; they are not approved
-- public prices. Annual = 10x monthly. 14-day no-card trials on
-- coach/org tiers. Sponsored athletes are never charged.
--
-- Postgres 15 compatible, additive only, idempotent.

BEGIN;

-- Plan catalogue (seeded; limits are data so tiers can be tuned
-- without code). limits JSONB: {maxAthletes, maxCoaches,
-- historyDays (null = full), maxCoachLinks (null = unlimited),
-- canAssess, canAssign, trialDays, priceMonthlyCents,
-- priceAnnualCents, overagePerAthleteCents}.
CREATE TABLE IF NOT EXISTS subscription_plans (
  code TEXT PRIMARY KEY,  -- 'free_athlete','athlete_remote','coach_starter','coach_pro','team_academy','academy_scale'
  audience TEXT NOT NULL CHECK (audience IN ('athlete','coach','organization')),
  name TEXT NOT NULL,
  limits JSONB NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true
);

-- A subscription belongs to an athlete, a coach, or an organization.
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_code TEXT NOT NULL REFERENCES subscription_plans(code) ON DELETE RESTRICT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('athlete','coach','organization')),
  owner_id UUID NOT NULL,  -- athletes.id | coaches.id | organizations.id (app-layer checked; no polymorphic FK)
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled','expired','incomplete')),
  billing_interval TEXT CHECK (billing_interval IS NULL OR billing_interval IN ('month','year')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  provider TEXT NOT NULL DEFAULT 'none' CHECK (provider IN ('none','stripe_test')),
  provider_customer_id TEXT,       -- test-mode ids only in this design's scope
  provider_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_owner ON subscriptions (owner_type, owner_id, status);

-- Sponsorship: a coach/org covers an athlete's paid access. The
-- athlete is never double-charged (server/billing.js refuses
-- checkout with ALREADY_COVERED while coverage is active).
CREATE TABLE IF NOT EXISTS sponsorships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE RESTRICT,
  sponsor_type TEXT NOT NULL CHECK (sponsor_type IN ('coach','organization')),
  sponsor_id UUID NOT NULL,  -- coaches.id | organizations.id
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,  -- the sponsor's covering subscription
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  UNIQUE (athlete_id, sponsor_type, sponsor_id, status)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sponsor_active
  ON sponsorships (athlete_id, sponsor_type, sponsor_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sponsor_athlete ON sponsorships (athlete_id, status);

-- Provider webhook log (idempotent processing; test-mode only).
CREATE TABLE IF NOT EXISTS billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plan seed (market research §6; data, not code). Prices in cents.
INSERT INTO subscription_plans (code, audience, name, limits) VALUES
  ('free_athlete', 'athlete', 'Athlete Free',
   '{"maxAthletes":null,"maxCoaches":null,"historyDays":90,"maxCoachLinks":1,"canAssess":false,"canAssign":false,"trainingDaysPerWeek":1,"trialDays":0,"priceMonthlyCents":0,"priceAnnualCents":0,"overagePerAthleteCents":0}'::jsonb),
  ('athlete_remote', 'athlete', 'Athlete Remote',
   '{"maxAthletes":null,"maxCoaches":null,"historyDays":null,"maxCoachLinks":null,"canAssess":false,"canAssign":false,"trainingDaysPerWeek":null,"trialDays":0,"priceMonthlyCents":1499,"priceAnnualCents":14900,"overagePerAthleteCents":0}'::jsonb),
  ('coach_starter', 'coach', 'Coach Starter',
   '{"maxAthletes":15,"maxCoaches":1,"historyDays":null,"maxCoachLinks":null,"canAssess":true,"canAssign":true,"trialDays":14,"priceMonthlyCents":2900,"priceAnnualCents":29000,"overagePerAthleteCents":200}'::jsonb),
  ('coach_pro', 'coach', 'Coach Pro',
   '{"maxAthletes":50,"maxCoaches":3,"historyDays":null,"maxCoachLinks":null,"canAssess":true,"canAssign":true,"trialDays":14,"priceMonthlyCents":7900,"priceAnnualCents":79000,"overagePerAthleteCents":150}'::jsonb),
  ('team_academy', 'organization', 'Team / Academy',
   '{"maxAthletes":150,"maxCoaches":null,"historyDays":null,"maxCoachLinks":null,"canAssess":true,"canAssign":true,"trialDays":14,"priceMonthlyCents":19900,"priceAnnualCents":199000,"overagePerAthleteCents":150}'::jsonb),
  ('academy_scale', 'organization', 'Academy Scale',
   '{"maxAthletes":400,"maxCoaches":null,"historyDays":null,"maxCoachLinks":null,"canAssess":true,"canAssign":true,"trialDays":14,"priceMonthlyCents":34900,"priceAnnualCents":349000,"overagePerAthleteCents":125}'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS. Additive policies only; no anon policies. Subscriptions and
-- sponsorships are readable only by their owner (athlete / coach /
-- org admin / director) — a coach cannot see another coach's
-- subscription, roster size, or sponsored athletes (design §2.4.4).
-- billing_events is written only by the future webhook function
-- (service role); no authenticated policy grants writes here.
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsorships ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plans_read ON subscription_plans;
CREATE POLICY plans_read ON subscription_plans FOR SELECT TO authenticated
  USING (active = true);
DROP POLICY IF EXISTS plans_director ON subscription_plans;
CREATE POLICY plans_director ON subscription_plans FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');

DROP POLICY IF EXISTS sub_director ON subscriptions;
CREATE POLICY sub_director ON subscriptions FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS sub_owner_read ON subscriptions;
CREATE POLICY sub_owner_read ON subscriptions FOR SELECT TO authenticated
  USING (
    (owner_type = 'athlete' AND public.is_my_athlete(owner_id))
    OR (owner_type = 'coach' AND owner_id = public.my_coach_id())
    OR (owner_type = 'organization' AND public.is_my_org(owner_id))
  );

DROP POLICY IF EXISTS sponsor_director ON sponsorships;
CREATE POLICY sponsor_director ON sponsorships FOR ALL TO authenticated
  USING (public.app_role() = 'director') WITH CHECK (public.app_role() = 'director');
DROP POLICY IF EXISTS sponsor_read ON sponsorships;
CREATE POLICY sponsor_read ON sponsorships FOR SELECT TO authenticated
  USING (
    public.is_my_athlete(athlete_id)
    OR (sponsor_type = 'coach' AND sponsor_id = public.my_coach_id())
    OR (sponsor_type = 'organization' AND public.is_my_org(sponsor_id))
  );
DROP POLICY IF EXISTS sponsor_write ON sponsorships;
CREATE POLICY sponsor_write ON sponsorships FOR ALL TO authenticated
  USING (
    (sponsor_type = 'coach' AND sponsor_id = public.my_coach_id())
    OR (sponsor_type = 'organization' AND public.is_my_org_admin(sponsor_id))
  )
  WITH CHECK (
    (sponsor_type = 'coach' AND sponsor_id = public.my_coach_id())
    OR (sponsor_type = 'organization' AND public.is_my_org_admin(sponsor_id))
  );

DROP POLICY IF EXISTS billing_events_director ON billing_events;
CREATE POLICY billing_events_director ON billing_events FOR SELECT TO authenticated
  USING (public.app_role() = 'director');

COMMIT;

-- Rollback (manual, local dev only — never against production data):
-- DROP TABLE IF EXISTS billing_events;
-- DROP TABLE IF EXISTS sponsorships;
-- DROP TABLE IF EXISTS subscriptions;
-- DROP TABLE IF EXISTS subscription_plans;
