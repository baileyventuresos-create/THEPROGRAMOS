# Production authentication — Supabase Auth sign-in

Status: **implemented on `feature/athlete-pathways-v1`, 2026-11-26; not yet
live** — the anon key is still missing (see "Blocker" below) and no real
Supabase Auth users exist yet. Nothing here creates accounts, touches
production, or spends money.

## What changed

- `saas-ui/supabase-auth.js` — dependency-free GoTrue REST client
  (the app has no build step, so no `@supabase/supabase-js`).
  Email/password sign-in, session persistence in localStorage,
  proactive refresh, sign-out, and `roleForUser()` mapping to
  director/coach/athlete/parent.
- `saas-ui/saas-ui.js` + `assessment-ui/assessment-ui.js` — both UIs
  take `{ dev, auth }`. Off localhost the dev "View as" switcher is
  gone: the SaaS hub gates on the Auth session (sign-in form → hub),
  and the assessment section stays quiet until someone signs in.
  `switchRole` refuses in production. Localhost dev is unchanged.
- `index.html` — loader injects `supabase-config.js` +
  `supabase-auth.js`, detects localhost, and passes `{ dev, auth }`
  to both UIs.
- `saas-ui/supabase-config.example.js` — template for the local,
  gitignored `saas-ui/supabase-config.js`.
- `server/tests/production-auth.test.js` — 14 tests (module + both
  UIs, stubbed fetch, no live Supabase).

## Role mapping — read this first

The **server is authoritative**. The Edge Function derives the role
from the database on every request
(`app_users.role WHERE auth_user_id = auth.uid()` — see
`supabase/functions/assessment-api/directory.ts`). The client's
`roleForUser()` reads `app_metadata.role` (fallback
`user_metadata.role`) as a **display hint only**: it decides which hub
the UI shows, never what the server allows. A signed-in user with no
mapped role sees "no app role linked — ask the director" and can call
nothing role-gated.

## Blocker: the anon key is NOT in this repo

The Supabase anon key is a public/publishable key by Supabase design,
but it is still config, never hardcoded. It was **not findable** in
the repo or docs, and the only retrieval path in this environment is
blocked:

- The registered `custom.supabase` connector (Management API) returns
  **HTTP 401 "Invalid access token"** — including on its own canonical
  read (`supabase.py auth-get` for the Big Whiff project), so the
  stored personal access token itself is invalid/expired, not the
  request shape. A read-only fetch of
  `GET /v1/projects/rkgdwqgmldznczikrjip/api-keys` was attempted and
  got the same 401.
- The one-off script is kept at `/tmp/get-programos-anon-key.py`
  (ephemeral; it writes the key straight into the gitignored config
  file and never prints it).

**To unblock:** either (a) reconnect the `custom.supabase` connector
with a fresh full-access personal access token, then re-run the script,
or (b) copy the key from the Supabase dashboard — project
TheProgramOS (`rkgdwqgmldznczikrjip`) → Settings → API → **anon
public key** — into `saas-ui/supabase-config.js` (copy from
`saas-ui/supabase-config.example.js`). The service_role key is NEVER
stored in the browser or this repo.

Until the key is in place the app reports "Production sign-in is not
configured" instead of pretending sign-in works.

## What Marcus still has to do (one step at a time)

1. Supply the anon key as above (or approve reconnecting the
   Supabase connector with a fresh token).
2. Create the real Supabase Auth users (dashboard → Authentication →
   Users) — one per pilot participant. No accounts were created by
   this work.
3. For each user, add the `app_users` row linking
   `auth_user_id` → role (migration 003's `app_role()` model), and
   mirror the role into the user's `app_metadata.role` so the UI
   shows the right hub. The server role is what matters; the
   metadata mirror is display only.
4. Deploy the app to the host Marcus names, with
   `saas-ui/supabase-config.js` deployed alongside it (or the same
   two values injected another way).
5. Sign in as the director in the deployed app and confirm the Owner
   console loads; sign in as a coach/athlete and confirm scoping.
   (Live verification is still pending — nothing in this branch has
   been verified against the live project.)
