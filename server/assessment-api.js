/* THE PROGRAM OS — Thin authenticated API for the assessment workflow
 * server/assessment-api.js
 *
 * The same auth model as server/api.js, over the assessment workflow
 * (server/assessment-workflow.js) instead of the reservation engine:
 *
 *   - Every method takes an injected auth context { authUserId, role,
 *     coachId?, athleteId? } as its FIRST argument. The caller (a
 *     Supabase Edge Function or a server route) derives it from a
 *     verified Supabase Auth JWT — this module never parses tokens
 *     and never trusts anything the client sends.
 *   - `actor` is ALWAYS the auth UID. A client-supplied `actor` in
 *     the params is ignored (never trusted).
 *   - Role checks run here in JS AND in Postgres via the RLS policies
 *     in migrations 003 + 004 (defence in depth: the JS check is the
 *     API contract, RLS is the backstop for any direct PostgREST
 *     caller). Coach assessment writes are additionally scoped to
 *     their own cohort athletes (server/assessment-access.js); the
 *     004 coach INSERT policies mirror that scope in SQL.
 *   - Role table: recording workflow (start / recordAttempts /
 *     getDraft / discardDraft / completeAssessment / recordDeferral /
 *     createPlan / finalizePlan) — director, coach (scoped).
 *     Reading results (athleteAssessmentView / advisoryPriorities) —
 *     director, coach (scoped), parent (own athletes), athlete (self).
 *     coachDashboard — director, coach.
 *   - Missing authUserId -> UNAUTHENTICATED; role not allowed or
 *     athlete out of scope -> FORBIDDEN. Workflow rejections
 *     (INCOMPLETE_ASSESSMENT, INVALID_ATTEMPTS, PLAN_NOT_READY, ...)
 *     pass through unchanged with their codes.
 *
 * Testable without live Supabase: inject a workflow built on memory
 * stores — see server/tests/assessment-api.test.js. No network, no
 * credentials. This module owns no writes itself beyond delegating
 * to the workflow.
 */
'use strict';

const { createAssessmentWorkflow } = require('./assessment-workflow');

const ALLOWED = {
  listAthletes: ['director', 'coach', 'parent', 'athlete'],
  startAssessment: ['director', 'coach'],
  recordAttempts: ['director', 'coach'],
  getDraft: ['director', 'coach'],
  discardDraft: ['director', 'coach'],
  completeAssessment: ['director', 'coach'],
  athleteAssessmentView: ['director', 'coach', 'parent', 'athlete'],
  coachDashboard: ['director', 'coach'],
  recordDeferral: ['director', 'coach'],
  planReadiness: ['director', 'coach', 'parent', 'athlete'],
  createPlan: ['director', 'coach'],
  finalizePlan: ['director', 'coach'],
  advisoryPriorities: ['director', 'coach', 'parent', 'athlete'],
};

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function requireAuth(auth, method) {
  if (!auth || typeof auth.authUserId !== 'string' || !auth.authUserId) {
    throw err('UNAUTHENTICATED', 'An authenticated user is required.');
  }
  if (!ALLOWED[method].includes(auth.role)) {
    throw err('FORBIDDEN', `Role '${auth.role}' may not call ${method}.`);
  }
  return auth.authUserId; // actor: always the auth UID, never client input
}

function createAssessmentApi({ workflow } = {}) {
  if (!workflow) throw new Error('createAssessmentApi requires a workflow (createAssessmentWorkflow).');
  const wf = workflow;

  return {
    workflow: wf,

    listAthletes(auth) {
      requireAuth(auth, 'listAthletes');
      return wf.listAthletes(auth);
    },

    async startAssessment(auth, params) {
      requireAuth(auth, 'startAssessment');
      if (!params || !params.athleteId) throw err('INVALID_INPUT', 'startAssessment requires athleteId.');
      return wf.startAssessment(auth, params);
    },

    async recordAttempts(auth, params) {
      requireAuth(auth, 'recordAttempts');
      if (!params || !params.athleteId || !Array.isArray(params.entries)) {
        throw err('INVALID_INPUT', 'recordAttempts requires athleteId and entries.');
      }
      return wf.recordAttempts(auth, params);
    },

    async getDraft(auth, params) {
      requireAuth(auth, 'getDraft');
      if (!params || !params.athleteId) throw err('INVALID_INPUT', 'getDraft requires athleteId.');
      return wf.getDraft(auth, params);
    },

    async discardDraft(auth, params) {
      requireAuth(auth, 'discardDraft');
      if (!params || !params.athleteId) throw err('INVALID_INPUT', 'discardDraft requires athleteId.');
      return wf.discardDraft(auth, params);
    },

    async completeAssessment(auth, params) {
      requireAuth(auth, 'completeAssessment');
      if (!params || !params.athleteId) throw err('INVALID_INPUT', 'completeAssessment requires athleteId.');
      // NOTE: params.actor, if present, is deliberately ignored.
      return wf.completeAssessment(auth, params);
    },

    async athleteAssessmentView(auth, params) {
      requireAuth(auth, 'athleteAssessmentView');
      if (!params || !params.athleteId) throw err('INVALID_INPUT', 'athleteAssessmentView requires athleteId.');
      return wf.athleteAssessmentView(auth, params);
    },

    async coachDashboard(auth, params) {
      requireAuth(auth, 'coachDashboard');
      return wf.coachDashboard(auth, params || {});
    },

    async recordDeferral(auth, params) {
      requireAuth(auth, 'recordDeferral');
      if (!params || !params.athleteId) throw err('INVALID_INPUT', 'recordDeferral requires athleteId.');
      return wf.recordDeferral(auth, params);
    },

    async planReadiness(auth, params) {
      requireAuth(auth, 'planReadiness');
      if (!params || !params.athleteId) throw err('INVALID_INPUT', 'planReadiness requires athleteId.');
      return wf.planReadiness(auth, params);
    },

    async createPlan(auth, params) {
      requireAuth(auth, 'createPlan');
      if (!params || !params.athleteId) throw err('INVALID_INPUT', 'createPlan requires athleteId.');
      return wf.createPlan(auth, params);
    },

    async finalizePlan(auth, params) {
      requireAuth(auth, 'finalizePlan');
      if (!params || !params.planId) throw err('INVALID_INPUT', 'finalizePlan requires planId.');
      return wf.finalizePlan(auth, params);
    },

    async advisoryPriorities(auth, params) {
      requireAuth(auth, 'advisoryPriorities');
      if (!params || !params.athleteId) throw err('INVALID_INPUT', 'advisoryPriorities requires athleteId.');
      return wf.advisoryPriorities(auth, params);
    },
  };
}

module.exports = { createAssessmentApi, ALLOWED };
