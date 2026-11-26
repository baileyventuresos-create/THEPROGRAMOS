/* THE PROGRAM OS — Supabase client config (TEMPLATE — copy to
 * saas-ui/supabase-config.js and fill in; supabase-config.js is
 * gitignored and never committed).
 *
 * The anon key is a PUBLIC/publishable key by Supabase design — it
 * ships in browser code — but it still lives in config, never
 * hardcoded in source and never in logs. The service_role key is
 * NEVER stored here or anywhere in the browser.
 *
 * Get the values from the Supabase dashboard: project
 * TheProgramOS (rkgdwqgmldznczikrjip) → Settings → API →
 * Project URL + anon public key. Or regenerate this file with
 * /tmp/get-programos-anon-key.py once the custom.supabase
 * connector is reconnected (its stored token currently returns
 * 401 — see docs/PRODUCTION_AUTH.md).
 */
window.THE_PROGRAM_SUPABASE_URL = 'https://rkgdwqgmldznczikrjip.supabase.co';
window.THE_PROGRAM_SUPABASE_ANON_KEY = 'PASTE_THE_ANON_PUBLIC_KEY_HERE';
