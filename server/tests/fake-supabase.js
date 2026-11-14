/* THE PROGRAM OS — Fake Supabase client for Edge Function tests
 * server/tests/fake-supabase.js
 *
 * An in-memory stand-in for the @supabase/supabase-js client, used to
 * exercise the REAL Edge Function TypeScript modules
 * (supabase/functions/assessment-api/*.ts) in Node without a live
 * project, a Deno runtime, or any network. Synthetic data only.
 *
 * What it fakes, faithfully enough to test the function:
 *   - auth.getUser(token): resolves a token to a canned Supabase Auth
 *     user (unknown tokens fail, like a real invalid JWT).
 *   - from(table): a PostgREST-style query builder supporting the
 *     exact chain the function uses — select/insert/upsert/update/
 *     delete, eq, order, single, maybeSingle — over in-memory
 *     tables. RLS is NOT enforced here: the live RLS policies were
 *     verified separately in the §5 live checks; these tests verify
 *     the JavaScript-layer scoping (api.ts + directory.ts + the
 *     bundled workflow), which is the layer the function adds.
 *   - createClient args are recorded, so tests can assert the
 *     function builds its client with the anon key and never with a
 *     service-role key.
 *
 * The builder is thenable ({ data, error }), exactly like the real
 * client's awaitable queries. Tables are plain arrays on `db`, so
 * tests can assert on the rows the function wrote (including the
 * exact snake_case columns the store adapters send).
 */
'use strict';

const TABLES = [
  'app_users', 'coaches', 'athletes', 'cohorts', 'cohort_enrollments',
  'athlete_guardians', 'guardians',
  'assessment_sessions', 'assessment_results', 'assessment_derived_records',
  'assessment_drafts', 'assessment_schedules', 'assessment_deferrals',
  'development_plans',
];

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.ordering = null;
    this.op = 'select';
    this.payload = null;
    this.onConflict = null;
    this.mode = null;
  }
  select() { return this; }
  insert(row) { this.op = 'insert'; this.payload = row; return this; }
  upsert(row, opts) { this.op = 'upsert'; this.payload = row; this.onConflict = (opts && opts.onConflict) || null; return this; }
  update(row) { this.op = 'update'; this.payload = row; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col, val) { this.filters.push([col, val]); return this; }
  order(col, opts) { this.ordering = [col, !(opts && opts.ascending === false)]; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybeSingle'; return this; }
  then(resolve, reject) {
    try { resolve(this.execute()); } catch (e) { reject(e); }
  }
  execute() {
    const table = this.db[this.table] || (this.db[this.table] = []);
    let rows = table.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.ordering) {
      const [col, asc] = this.ordering;
      rows = [...rows].sort((a, b) => {
        if (a[col] < b[col]) return asc ? -1 : 1;
        if (a[col] > b[col]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this.op === 'insert') {
      const row = { ...this.payload };
      table.push(row);
      return this.finish(row);
    }
    if (this.op === 'upsert') {
      const keys = (this.onConflict || '').split(',').map((s) => s.trim()).filter(Boolean);
      const existing = keys.length
        ? table.find((r) => keys.every((k) => r[k] === this.payload[k]))
        : undefined;
      if (existing) {
        Object.assign(existing, { ...this.payload });
        return this.finish(existing);
      }
      const row = { ...this.payload };
      table.push(row);
      return this.finish(row);
    }
    if (this.op === 'update') {
      rows.forEach((r) => Object.assign(r, { ...this.payload }));
      return this.finish(rows[0] !== undefined ? rows[0] : null, rows.length);
    }
    if (this.op === 'delete') {
      this.db[this.table] = table.filter((r) => !this.filters.every(([c, v]) => r[c] === v));
      return { data: null, error: null };
    }
    return this.finish(rows, rows.length, true);
  }
  finish(value, count, isArray) {
    if (this.mode === 'single') {
      if (isArray) {
        if (count !== 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
        return { data: value[0], error: null };
      }
      if (value == null) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
      return { data: value, error: null };
    }
    if (this.mode === 'maybeSingle') {
      if (isArray) {
        if (count > 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
        return { data: count === 1 ? value[0] : null, error: null };
      }
      return { data: value, error: null };
    }
    return { data: value, error: null };
  }
}

/* Token -> Supabase Auth user id. Unknown tokens fail getUser, the
 * way a real invalid JWT does. */
const TOKEN_USERS = {
  'token-director': 'auth-director',
  'token-coach-marcus': 'auth-coach-marcus',
  'token-coach-other': 'auth-coach-other',
  'token-parent-youth': 'parent-youth-uid',
  'token-athlete-wingback': 'athlete-wingback-uid',
  'token-athlete-youth': 'athlete-youth-uid',
};

function createFakeSupabase(seed) {
  const db = {};
  for (const t of TABLES) db[t] = [];
  if (seed) seed(db);
  const calls = { createClient: [] };
  const client = {
    db,
    calls,
    auth: {
      getUser: async (token) => {
        const id = TOKEN_USERS[token];
        if (!id) return { data: { user: null }, error: { message: 'Invalid JWT' } };
        return { data: { user: { id } }, error: null };
      },
    },
    from: (table) => new FakeQuery(db, table),
  };
  return client;
}

/* Seed the directory tables (app_users / coaches / athletes / cohorts
 * / enrollments / guardians) to mirror server/tests/assessment-api.test.js:
 * a 48-year-old wingback and a 12-year-old youth, both coached by
 * coach-marcus; the youth's parent is parent-youth-uid; each athlete
 * has their own Auth UID. `wingback` / `youth` are the fixture
 * modules (server/fixtures/synthetic-*.js). */
function seedDirectoryTables(wingback, youth) {
  const W = wingback.athlete.id;
  const Y = youth.athlete.id;
  return (db) => {
    db.app_users.push(
      { id: 'app-director', role: 'director', auth_user_id: 'auth-director' },
      { id: 'app-coach-marcus', role: 'coach', auth_user_id: 'auth-coach-marcus' },
      { id: 'app-coach-other', role: 'coach', auth_user_id: 'auth-coach-other' },
      { id: 'app-parent-youth', role: 'parent', auth_user_id: 'parent-youth-uid' },
      { id: 'app-athlete-wingback', role: 'athlete', auth_user_id: 'athlete-wingback-uid' },
      { id: 'app-athlete-youth', role: 'athlete', auth_user_id: 'athlete-youth-uid' },
    );
    db.coaches.push(
      { id: 'coach-marcus', user_id: 'app-coach-marcus' },
      { id: 'coach-other', user_id: 'app-coach-other' },
    );
    db.athletes.push(
      { id: W, age_years: 48, app_user_id: 'app-athlete-wingback' },
      { id: Y, age_years: 12, app_user_id: 'app-athlete-youth' },
    );
    db.cohorts.push({ id: 'cohort-a', head_coach_id: 'coach-marcus' });
    db.cohort_enrollments.push(
      { athlete_id: W, cohort_id: 'cohort-a', status: 'enrolled' },
      { athlete_id: Y, cohort_id: 'cohort-a', status: 'enrolled' },
    );
    db.guardians.push({ id: 'guardian-youth', user_id: 'app-parent-youth' });
    db.athlete_guardians.push({ athlete_id: Y, guardian_id: 'guardian-youth' });
  };
}

module.exports = { createFakeSupabase, seedDirectoryTables, TOKEN_USERS, TABLES };
