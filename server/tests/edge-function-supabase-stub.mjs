/* Stand-in for `@supabase/supabase-js` (esm.sh) in the Edge Function tests.
 * server/tests/edge-function-supabase-stub.mjs
 *
 * The Edge Function entrypoint (supabase/functions/assessment-api/
 * index.ts) imports createClient from esm.sh, which Node cannot
 * resolve. The test registers edge-function-hooks.mjs so that import
 * lands here instead. createClient returns the fake Supabase client
 * the test installed on globalThis.__fakeSupabase (see
 * server/tests/fake-supabase.js), and records every call — including
 * the key it was given — on globalThis.__createClientCalls, so tests
 * can assert the function builds its client with the anon key and
 * never with a service-role key.
 */
export function createClient(url, key, options) {
  globalThis.__createClientCalls = globalThis.__createClientCalls || [];
  globalThis.__createClientCalls.push({ url, key, options });
  return globalThis.__fakeSupabase;
}
