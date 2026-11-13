// THE PROGRAM OS — esbuild entry for the Edge Function workflow bundle
// supabase/functions/assessment-api/entry.mjs
//
// Bundled by build.mjs into vendor/workflow.bundle.mjs. Re-exports
// exactly the two factories the Edge Function needs from the tested
// Node modules; everything else in the dependency graph is pulled in
// by esbuild. Nothing here changes workflow behaviour — it only
// selects the exports.

export { createAssessmentWorkflow } from "../../../server/assessment-workflow.js";
export { createAccessDirectory } from "../../../server/assessment-access.js";
