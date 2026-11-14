// THE PROGRAM OS — Thin authenticated API for the assessment workflow
// supabase/functions/assessment-api/api.ts
//
// TypeScript port of server/assessment-api.js for the Edge Function
// transport. Same contract, same role table, same error codes — the
// only difference is the module system (ESM/Deno instead of Node CJS).
// The workflow itself is injected (see workflow.ts); this module owns
// no writes beyond delegating to it.
//
// Auth model (identical to server/assessment-api.js):
//   - Every method takes an injected auth context { authUserId, role,
//     coachId?, athleteId? } as its FIRST argument. The caller
//     (index.ts) derives it from a verified Supabase Auth JWT — this
//     module never parses tokens and never trusts client input.
//   - `actor` is ALWAYS the auth UID. A client-supplied `actor` in
//     the params is ignored (never trusted).
//   - Role checks run here in TS AND in Postgres via the RLS policies
//     in migrations 003 + 004 (defence in depth). Coach assessment
//     writes are additionally scoped to their own cohort athletes
//     (server/assessment-access.js); the 004 coach INSERT policies
//     mirror that scope in SQL.

export type Role = "director" | "coach" | "parent" | "athlete";

export interface AuthContext {
  authUserId: string;
  role: Role;
  coachId?: string | null;
  athleteId?: string | null;
}

export const ALLOWED: Record<string, Role[]> = {
  listAthletes: ["director", "coach", "parent", "athlete"],
  startAssessment: ["director", "coach"],
  recordAttempts: ["director", "coach"],
  getDraft: ["director", "coach"],
  discardDraft: ["director", "coach"],
  completeAssessment: ["director", "coach"],
  athleteAssessmentView: ["director", "coach", "parent", "athlete"],
  coachDashboard: ["director", "coach"],
  recordDeferral: ["director", "coach"],
  planReadiness: ["director", "coach", "parent", "athlete"],
  createPlan: ["director", "coach"],
  finalizePlan: ["director", "coach"],
  advisoryPriorities: ["director", "coach", "parent", "athlete"],
};

export type Workflow = Record<
  string,
  (auth: AuthContext, params: Record<string, unknown>) => unknown
>;

export function err(code: string, message: string): Error & { code: string } {
  const e = new Error(message || code) as Error & { code: string };
  e.code = code;
  return e;
}

function requireAuth(auth: AuthContext, method: string): string {
  if (!auth || typeof auth.authUserId !== "string" || !auth.authUserId) {
    throw err("UNAUTHENTICATED", "An authenticated user is required.");
  }
  if (!ALLOWED[method].includes(auth.role)) {
    throw err("FORBIDDEN", `Role '${auth.role}' may not call ${method}.`);
  }
  return auth.authUserId; // actor: always the auth UID, never client input
}

function requireParams(params: Record<string, unknown>, method: string): void {
  const needsAthlete = [
    "startAssessment", "recordAttempts", "getDraft", "discardDraft",
    "completeAssessment", "athleteAssessmentView", "recordDeferral",
    "planReadiness", "createPlan", "advisoryPriorities",
  ];
  if (needsAthlete.includes(method) && !params.athleteId) {
    throw err("INVALID_INPUT", `${method} requires athleteId.`);
  }
  if (method === "recordAttempts" && !Array.isArray(params.entries)) {
    throw err("INVALID_INPUT", "recordAttempts requires athleteId and entries.");
  }
  if (method === "finalizePlan" && !params.planId) {
    throw err("INVALID_INPUT", "finalizePlan requires planId.");
  }
}

export function createAssessmentApi({ workflow }: { workflow: Workflow }) {
  if (!workflow) throw new Error("createAssessmentApi requires a workflow (see workflow.ts).");

  const api: Record<string, (auth: AuthContext, params: Record<string, unknown>) => unknown> = {
    workflow: () => workflow,
  };
  for (const method of Object.keys(ALLOWED)) {
    if (method === "workflow") continue;
    api[method] = (auth: AuthContext, params: Record<string, unknown>) => {
      requireAuth(auth, method);
      requireParams(params ?? {}, method);
      // NOTE: params.actor, if present, is deliberately ignored.
      return workflow[method](auth, params ?? {});
    };
  }
  return api;
}
