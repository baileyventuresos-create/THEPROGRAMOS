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
    /* SaaS / Pathways scoping (migration 006), built by
     * directory.ts: active coach-athlete links grant the linked
     * coach assess/view scope, and org memberships let org_admins
     * view athletes linked inside orgs they admin. The bundled
     * createAccessDirectory (server/assessment-access.js) filters
     * on status, so the rows pass through as stored. */
    links?: unknown[];
    orgMemberships?: unknown[];
  }) => unknown;
  // GAA battery protocol (server/assessment-battery.js, re-exported
  // by entry.mjs). Present only in bundles generated after the
  // battery route was added (Phase 3); a stale bundle is reported
  // as missing so the caller regenerates it instead of serving a
  // half-protocol.
  GAA_TESTS?: unknown;
  PROTOCOL_VERSION?: unknown;
  BATTERY_ID?: unknown;
  RETEST_DAYS?: unknown;
}

export interface BatteryPayload {
  battery: string;
  protocolVersion: string;
  retestDays: number;
  tests: unknown[];
}

async function loadBundle(): Promise<WorkflowBundle> {
  try {
    // @ts-ignore: the bundle is generated JS with no type declarations
    // (see build.mjs); its shape is checked at runtime below.
    return (await import("./vendor/workflow.bundle.mjs")) as WorkflowBundle;
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
}

export async function loadBattery(): Promise<BatteryPayload> {
  const bundle = await loadBundle();
  if (
    !Array.isArray(bundle.GAA_TESTS) ||
    typeof bundle.PROTOCOL_VERSION !== "string" ||
    typeof bundle.BATTERY_ID !== "string" ||
    typeof bundle.RETEST_DAYS !== "number"
  ) {
    throw Object.assign(
      new Error(
        "Workflow bundle is stale: it does not export the GAA battery. Regenerate it with " +
          "`node build.mjs` in supabase/functions/assessment-api (see README.md §3).",
      ),
      { code: "WORKFLOW_BUNDLE_MISSING" },
    );
  }
  // Deep-clone: the bundle's GAA_TESTS is module-level data, and a
  // caller must never be able to mutate the protocol in place.
  const tests = JSON.parse(JSON.stringify(bundle.GAA_TESTS)) as unknown[];
  return {
    battery: bundle.BATTERY_ID,
    protocolVersion: bundle.PROTOCOL_VERSION,
    retestDays: bundle.RETEST_DAYS,
    tests,
  };
}

export async function loadWorkflow(
  stores: Stores,
  directory: DirectoryRow,
): Promise<Record<string, (auth: AuthContext, params: Record<string, unknown>) => unknown>> {
  const bundle = await loadBundle();
  if (typeof bundle.createAssessmentWorkflow !== "function" || typeof bundle.createAccessDirectory !== "function") {
    throw Object.assign(
      new Error("Workflow bundle is incomplete: it must export createAssessmentWorkflow and createAccessDirectory."),
      { code: "WORKFLOW_BUNDLE_MISSING" },
    );
  }
  const accessDirectory = bundle.createAccessDirectory({
    athletes: directory.athletes,
    coachAuth: directory.coachAuth,
    links: directory.links,
    orgMemberships: directory.orgMemberships,
  });
  return bundle.createAssessmentWorkflow({
    store: stores.store,
    reassessmentStore: stores.reassessmentStore,
    planStore: stores.planStore,
    directory: accessDirectory,
  });
}
