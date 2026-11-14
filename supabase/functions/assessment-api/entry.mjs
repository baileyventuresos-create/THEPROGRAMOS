// THE PROGRAM OS — esbuild entry for the Edge Function workflow bundle
// supabase/functions/assessment-api/entry.mjs
//
// Bundled by build.mjs into vendor/workflow.bundle.mjs. Re-exports
// the factories the Edge Function needs from the tested Node modules,
// plus the GAA battery protocol constants (server/assessment-
// battery.js) so the function can serve the same read-only
// GET …/battery route the dev server provides (see workflow.ts
// loadBattery). Nothing here changes workflow behaviour — it only
// selects the exports.

export { createAssessmentWorkflow } from "../../../server/assessment-workflow.js";
export { createAccessDirectory } from "../../../server/assessment-access.js";
export { GAA_TESTS, PROTOCOL_VERSION, BATTERY_ID, RETEST_DAYS } from "../../../server/assessment-battery.js";
