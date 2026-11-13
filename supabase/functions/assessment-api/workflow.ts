// THE PROGRAM OS — Workflow wiring seam for the Edge Function
// supabase/functions/assessment-api/workflow.ts
//
// Loads the assessment workflow (server/assessment-workflow.js +
// its engine/battery/reassessment/gating/progress/smart-draft
// modules) as a bundled ESM module, and wires it to the PostgREST
// stores (store.ts) and the access directory (directory.ts).
//
// WHY A SEAM: the workflow modules are CommonJS Node
// (require(), no Node built-ins in the computation path — the pure
// modules only require each other). Deno cannot import them verbatim.
// The supported path is to bundle them once with esbuild (see
// build.mjs in this directory), which produces
// ./vendor/workflow.bundle.mjs — a single ESM module exporting
// createAssessmentWorkflow, createAssessmentApi's workflow shape,
// and createAccessDirectory. `loadWorkflow` dynamically imports that
// bundle; if it has not been generated yet it throws a clear
// WORKFLOW_BUNDLE_MISSING error instead of failing obscurely.
//
// This is a documented design gap (README.md §4), not a redesign:
// no workflow rule changes, no new behaviour — the same code, only
// packaged for Deno. Do not hand-port the workflow into TypeScript
// to "make it fit"; bundle it, so the tested Node modules remain the
// single source of truth.

import type { AuthContext } from "./api.ts";
import type { DirectoryRow } from "./directory.ts";

export interface Stores {
  store: Record<string, unknown>;
  reassessmentStore: Record<string, unknown>;
  planStore: Record<string, unknown>;
}

interface WorkflowBundle {
  createAssessmentWorkflow: (opts: {
    store: unknown;
    reassessmentStore: unknown;
    planStore: unknown;
    directory: unknown;
  }) => Record<string, (auth: AuthContext, params: Record<string, unknown>) => unknown>;
  createAccessDirectory: (opts: {
    athletes: unknown[];
    coachAuth: Record<string, string>;
  }) => unknown;
}

export async function loadWorkflow(
  stores: Stores,
  directory: DirectoryRow,
): Promise<Record<string, (auth: AuthContext, params: Record<string, unknown>) => unknown>> {
  let bundle: WorkflowBundle;
  try {
    // @ts-ignore: the bundle is generated JS with no type declarations
    // (see build.mjs); its shape is checked at runtime below.
    bundle = (await import("./vendor/workflow.bundle.mjs")) as WorkflowBundle;
  } catch {
    throw Object.assign(
      new Error(
        "Workflow bundle missing: run `node build.mjs` in supabase/functions/assessment-api " +
          "to generate vendor/workflow.bundle.mjs from the tested Node modules (see README.md §3). " +
          "The function is not deployable until the bundle exists.",
      ),
      { code: "WORKFLOW_BUNDLE_MISSING" },
    );
  }
  if (typeof bundle.createAssessmentWorkflow !== "function" || typeof bundle.createAccessDirectory !== "function") {
    throw Object.assign(
      new Error("Workflow bundle is incomplete: it must export createAssessmentWorkflow and createAccessDirectory."),
      { code: "WORKFLOW_BUNDLE_MISSING" },
    );
  }
  const accessDirectory = bundle.createAccessDirectory({
    athletes: directory.athletes,
    coachAuth: directory.coachAuth,
  });
  return bundle.createAssessmentWorkflow({
    store: stores.store,
    reassessmentStore: stores.reassessmentStore,
    planStore: stores.planStore,
    directory: accessDirectory,
  });
}
