/* Module customization hook for the Edge Function tests.
 * server/tests/edge-function-hooks.mjs
 *
 * Node cannot resolve the Edge Function's runtime import
 * `https://esm.sh/@supabase/supabase-js@2` (it only exists in the
 * Deno Edge runtime). This hook maps that one specifier to the local
 * stub (edge-function-supabase-stub.mjs), which returns the fake
 * Supabase client the test installed on globalThis. Everything else
 * resolves normally. Registered by edge-function.test.js before it
 * imports the function entrypoint; node --test runs each test file
 * in its own process, so the hook affects only that file.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'https://esm.sh/@supabase/supabase-js@2') {
    return {
      url: new URL('./edge-function-supabase-stub.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
