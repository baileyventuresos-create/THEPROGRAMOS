// THE PROGRAM OS — Supabase Edge Function: assessment-api
// supabase/functions/assessment-api/index.ts
//
// STATUS: UNDEPLOYED SCAFFOLD. No function has been deployed, no secret
// has been set, no dashboard deploy has run. See README.md in this
// directory before touching anything here.
//
// What this is: the HTTP + auth boundary for the assessment workflow.
// It verifies the caller's Supabase Auth JWT, builds the auth context
// and access directory from the verified identity, and dispatches to
// the same methods as server/assessment-api.js (same role rules, same
// error codes). It also serves the read-only GAA protocol at
// GET …/battery (same shape as the dev server's route, same JWT
// verification). The workflow logic itself lives in the bundled Node
// modules (see workflow.ts + README §3) and the data access in the
// PostgREST store adapters (store.ts).
//
// Auth boundary (defence in depth, same as server/api.js):
//   1. config.toml sets verify_jwt = true, so Supabase verifies the
//      JWT before this function is even invoked.
//   2. This file calls auth.getUser(token) to resolve the JWT to a
//      user. No request is processed without a verified user.
//   3. The role/coach/athlete mapping is read from the database
//      (app_users / coaches / athletes), never from client input.
//   4. All data access uses the USER-scoped Supabase client (the
//      caller's own JWT), so Postgres RLS (migrations 003 + 004) is
//      the backstop. service_role is never used for user requests.
//   5. `actor` is always the auth UID. A client-supplied actor is
//      ignored, exactly as server/assessment-api.js does.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createAssessmentApi, ALLOWED, type AuthContext } from "./api.ts";
import { buildDirectory, type DirectoryRow } from "./directory.ts";
import { createSupabaseStores } from "./store.ts";
import { loadWorkflow, loadBattery } from "./workflow.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function statusFor(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED": return 401;
    case "FORBIDDEN": return 403;
    case "ATHLETE_NOT_FOUND":
    case "PLAN_NOT_FOUND": return 404;
    case "INVALID_INPUT":
    case "INVALID_ATTEMPTS":
    case "INVALID_DEFERRAL":
    case "INCOMPLETE_ASSESSMENT": return 400;
    case "PLAN_NOT_READY":
    case "DUPLICATE":
    case "ALREADY_WAITLISTED": return 409;
    default: return 500;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // --- Read-only protocol route: GET …/battery ------------------------
  // Same JWT verification as POST (see verifiedClient): the platform
  // (verify_jwt = true) rejects anonymous calls before this runs, and
  // the function verifies the user itself. The battery is protocol
  // text, not athlete data — every authenticated app user gets the
  // same payload, and no role check applies. Shape matches the dev
  // server (server/dev-server.js) and the browser client
  // (assessment-ui/assessment-client.js getBattery()): the client
  // calls GET <endpoint>/battery and expects { battery,
  // protocolVersion, retestDays, tests }.
  const pathname = new URL(req.url).pathname.replace(/\/+$/, "");
  if (req.method === "GET" && pathname.endsWith("/battery")) {
    try {
      await verifiedClient(req);
      const battery = await loadBattery();
      return json(200, battery);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "INTERNAL";
      const message = e instanceof Error ? e.message : String(e);
      return json(statusFor(code), { ok: false, error: { code, message } });
    }
  }

  if (req.method !== "POST") {
    return json(405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Only GET …/battery and POST are supported." } });
  }

  // --- 1. Verify the JWT (auth boundary) -------------------------------
  let supabase: SupabaseClient;
  let userId: string;
  try {
    ({ supabase, userId } = await verifiedClient(req));
  } catch (e) {
    const code = (e as { code?: string }).code ?? "INTERNAL";
    const message = e instanceof Error ? e.message : String(e);
    return json(statusFor(code), { ok: false, error: { code, message } });
  }
  const user = { id: userId };

  // --- 2. Parse the request --------------------------------------------
  let body: { method?: string; params?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: { code: "INVALID_INPUT", message: "Request body must be JSON." } });
  }
  const method = typeof body.method === "string" ? body.method : "";
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, method)) {
    return json(400, { ok: false, error: { code: "INVALID_INPUT", message: `Unknown method: ${method || "(missing)"}.` } });
  }
  const params = (body.params && typeof body.params === "object" ? body.params : {}) as Record<string, unknown>;

  try {
    // --- 3. Build the auth context + access directory from the JWT -----
    // Role / coach / athlete mappings come from the database, never
    // from the client. See directory.ts for the exact queries and for
    // how they mirror the RLS helpers in migration 003.
    const { auth, directory }: { auth: AuthContext; directory: DirectoryRow } =
      await buildDirectory(supabase, user.id);

    // --- 4. Wire the workflow (bundled Node modules + PostgREST stores)
    const stores = createSupabaseStores(supabase);
    const workflow = await loadWorkflow(stores, directory);
    const api = createAssessmentApi({ workflow });

    // --- 5. Dispatch (same methods, same role rules as server/assessment-api.js)
    const fn = (api as unknown as Record<string, (auth: AuthContext, params: Record<string, unknown>) => unknown>)[method];
    const data = await fn(auth, params);
    return json(200, { ok: true, data });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "INTERNAL";
    const message = e instanceof Error ? e.message : String(e);
    // Workflow error codes pass through unchanged; HTTP status is derived.
    return json(statusFor(code), { ok: false, error: { code, message } });
  }
});

// --- JWT verification, shared by the GET /battery route and POST -------
// Verifies the caller's Supabase Auth JWT and returns a user-scoped
// client (the caller's own JWT, so Postgres RLS applies to every
// query) plus the verified user id. Throws UNAUTHENTICATED when the
// token is missing or invalid, SERVER_MISCONFIGURED when the function
// env is unset. The actor is always the verified user id; a
// client-supplied actor is never trusted (see api.ts).
async function verifiedClient(req: Request): Promise<{ supabase: SupabaseClient; userId: string }> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    throw Object.assign(new Error("A Bearer token is required."), { code: "UNAUTHENTICATED" });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw Object.assign(
      new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not set on the function."),
      { code: "SERVER_MISCONFIGURED" },
    );
  }

  // User-scoped client: every query below runs as the caller, so RLS applies.
  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    throw Object.assign(
      new Error("The supplied token is not a valid Supabase Auth JWT."),
      { code: "UNAUTHENTICATED" },
    );
  }
  return { supabase, userId: user.id };
}
