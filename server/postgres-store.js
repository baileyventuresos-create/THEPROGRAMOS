/* THE PROGRAM OS — PostgreSQL store (backend completion, Supabase-only)
 *
 * PostgresStore implements the exact store interface reservation-engine.js
 * expects (see the interface comment at the top of that file), backed by
 * the schema in server/migrations/001 (+ 002 for assessments, not used
 * here). It is the production counterpart of MemoryStore / SqliteStore in
 * reservation-stores.js: same engine, same rules, real transactions.
 *
 * Connection: pass a `pg` Pool (or a Pool-like with query/connect), a
 * connection string, or a pg config object. Credentials are NEVER
 * hard-coded and NEVER committed: use PostgresStore.fromEnv(), which
 * reads DATABASE_URL (or the PG* variables via pg's own defaults) at
 * call time. No .env file is committed by this repo.
 *
 * Hydration (what the engine needs that the raw tables do not store as
 * one row):
 *   - getSession: cohort { id, age:[min,max] } from cohorts, capacityInput
 *     from capacity_inputs, capacityEffective from capacity_effective,
 *     coaches from session_coaches, space name from training_spaces.
 *   - getAthlete: eligibleCohortIds hydrated from the cohort_enrollments
 *     join table (status='enrolled') — the SINGLE source of truth for
 *     cohort eligibility (decided 2026-11-12). The athletes table's
 *     eligible_cohort_ids column is a denormalized snapshot and is NOT
 *     read here; never grant eligibility by editing it.
 *
 * Atomic gate: insertReservation() calls reserve_seat() (migration 001)
 * as the final gate, so capacity is enforced transactionally in Postgres
 * even if the JS checks race. reserve_seat() outcomes:
 *   - 'confirmed' -> the reservation row is returned.
 *   - 'waitlisted' -> the seat vanished between the engine's check and
 *     the atomic gate; reserve_seat() ALREADY inserted the waitlist entry
 *     (and its WAITLISTED audit row). The store throws RACE_WAITLISTED
 *     with the created entry attached (.waitlist) so the engine can return
 *     { outcome: 'waitlisted' } WITHOUT inserting a second entry.
 *   - 'already_waitlisted' -> the athlete was already waiting; throws
 *     ALREADY_WAITLISTED (same code the engine uses on its own full
 *     branch) with the existing entry attached.
 *   - unique violation (23505) on the confirmed index -> throws DUPLICATE
 *     with a clean code instead of a raw Postgres error.
 *   - reserve_seat()'s own session_not_bookable exception -> rethrown as
 *     SESSION_NOT_BOOKABLE.
 * Known duplication: reserve_seat() writes a RESERVED audit row AND the
 * engine writes one via insertAudit() after insertReservation() returns,
 * so a reservation made through this store has two RESERVED audit rows
 * (one from SQL, one from the engine). That is append-only audit noise,
 * not a correctness problem; reconcile by action + reservation id if a
 * single audit stream is ever needed. Do not "fix" it by dropping the
 * engine audit — the Memory/SQLite stores rely on it.
 *
 * Transactions: transaction(fn) checks out one client, BEGINs, runs fn
 * with every store call routed to that client, then COMMITs (or
 * ROLLBACKs on error). The engine's per-session mutex plus this plus
 * reserve_seat() is the same layered guarantee as the SQLite store.
 *
 * This module is testable without live Supabase: pass any Pool-like
 * (see server/tests/postgres-store.test.js, which injects a fake).
 * Requires the `pg` package (see package.json). No network call happens
 * at import time.
 */
'use strict';

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function toISODate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function mapSession(row) {
  if (!row) return null;
  const cohort = row.cohort_id
    ? { id: row.cohort_id, age: [row.age_min, row.age_max] }
    : null;
  return {
    id: row.id,
    cohortId: row.cohort_id || null,
    cohort,
    locationId: row.location_id,
    space: row.space_name || null,
    spaceId: row.space_id || null,
    templateId: row.template_id || null,
    date: toISODate(row.date),
    startTime: row.start_time,
    durationMin: row.duration_min,
    status: row.status,
    coaches: Array.isArray(row.coach_ids) ? row.coach_ids : [],
    capacityEffective: row.capacity_effective,
    capacityPreferred: row.capacity_preferred ?? null,
    capacityInput: row.capacity_inputs || null,
    emphasis: row.emphasis || [],
    planId: row.plan_id || null,
    planApprovedBy: row.plan_approved_by || null,
  };
}

function mapAthlete(row) {
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    age: row.age_years,
    restrictions: row.restrictions || [],
    eligibleCohortIds: Array.isArray(row.cohort_ids) ? row.cohort_ids : [],
    notes: row.notes || null,
  };
}

function mapMembership(row) {
  if (!row) return null;
  return {
    id: row.id,
    athleteId: row.athlete_id,
    status: row.status,
    priceCents: row.price_cents,
    startDate: toISODate(row.start_date),
    endDate: toISODate(row.end_date),
  };
}

function mapReservation(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    athleteId: row.athlete_id,
    status: row.status,
    promotedFromWaitlistId: row.promoted_from_waitlist_id || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    cancelReason: row.cancel_reason || null,
    actor: row.created_by || null,
  };
}

function mapWaitlist(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    athleteId: row.athlete_id,
    position: row.position,
    status: row.status,
    promotedReservationId: row.promoted_reservation_id || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function mapAttendance(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    athleteId: row.athlete_id,
    reservationId: row.reservation_id || null,
    status: row.status,
    walkIn: !!row.walk_in,
    actor: row.recorded_by || null,
    note: row.note || null,
    recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
  };
}

function mapAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    actor: row.actor,
    detail: row.detail || '',
    at: row.at ? new Date(row.at).toISOString() : null,
  };
}

class PostgresStore {
  /* Accepts: a pg Pool (or Pool-like with query/connect), a connection
   * string, a pg config object, or { pool }. Anything else throws. */
  constructor(poolOrConfig) {
    this._ownsPool = false;
    if (poolOrConfig && typeof poolOrConfig.query === 'function'
      && typeof poolOrConfig.connect === 'function') {
      this.pool = poolOrConfig;
    } else if (poolOrConfig && poolOrConfig.pool) {
      this.pool = poolOrConfig.pool;
    } else if (typeof poolOrConfig === 'string' || (poolOrConfig && typeof poolOrConfig === 'object')) {
      const { Pool } = require('pg');
      this.pool = typeof poolOrConfig === 'string'
        ? new Pool({ connectionString: poolOrConfig })
        : new Pool(poolOrConfig);
      this._ownsPool = true;
    } else {
      throw new Error('PostgresStore needs a pg Pool, a connection string, or a pg config object.');
    }
    this._txClient = null;
  }

  /* Build from the environment at call time. Reads DATABASE_URL if set;
   * otherwise lets pg fall back to its PG* variables. Never commits or
   * logs the value. */
  static fromEnv() {
    const { Pool } = require('pg');
    const connectionString = process.env.DATABASE_URL || undefined;
    return new PostgresStore(new Pool(connectionString ? { connectionString } : {}));
  }

  _client() { return this._txClient || this.pool; }

  async _query(text, params) {
    return this._client().query(text, params || []);
  }

  async transaction(fn) {
    if (this._txClient) return fn(); // already inside a transaction
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      this._txClient = client;
      const out = await fn();
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* already gone */ }
      throw e;
    } finally {
      this._txClient = null;
      client.release();
    }
  }

  async close() {
    if (this._ownsPool && this.pool && typeof this.pool.end === 'function') await this.pool.end();
  }

  async getSession(id) {
    const { rows } = await this._query(
      `SELECT ts.*, c.id AS cohort_id, c.age_min, c.age_max,
              sp.name AS space_name,
              COALESCE((SELECT json_agg(sc.coach_id) FROM session_coaches sc
                        WHERE sc.session_id = ts.id), '[]'::json) AS coach_ids
       FROM training_sessions ts
       LEFT JOIN cohorts c ON c.id = ts.cohort_id
       LEFT JOIN training_spaces sp ON sp.id = ts.space_id
       WHERE ts.id = $1`,
      [id]);
    return mapSession(rows[0] || null);
  }

  async getAthlete(id) {
    const { rows } = await this._query(
      `SELECT a.*,
              COALESCE((SELECT json_agg(ce.cohort_id) FROM cohort_enrollments ce
                        WHERE ce.athlete_id = a.id AND ce.status = 'enrolled'), '[]'::json) AS cohort_ids
       FROM athletes a WHERE a.id = $1`,
      [id]);
    return mapAthlete(rows[0] || null);
  }

  async getMembership(athleteId) {
    const { rows } = await this._query(
      `SELECT * FROM memberships WHERE athlete_id = $1 ORDER BY start_date DESC LIMIT 1`,
      [athleteId]);
    return mapMembership(rows[0] || null);
  }

  async coachAvailable(coachId, dateISO, startMin, endMin) {
    const { rows } = await this._query(
      `SELECT EXISTS(SELECT 1 FROM coach_availability
                     WHERE coach_id = $1 AND date = $2 AND available = false
                       AND $3 < end_min AND start_min < $4) AS blocked`,
      [coachId, dateISO, startMin, endMin]);
    return !rows[0].blocked;
  }

  async listSessionsAt(locationId, spaceName, dateISO, startMin, endMin, excludeId) {
    const { rows } = await this._query(
      `SELECT ts.*, sp.name AS space_name,
              COALESCE((SELECT json_agg(sc.coach_id) FROM session_coaches sc
                        WHERE sc.session_id = ts.id), '[]'::json) AS coach_ids
       FROM training_sessions ts
       LEFT JOIN training_spaces sp ON sp.id = ts.space_id
       WHERE ts.location_id = $1 AND ts.date = $2 AND ts.id <> $3`,
      [locationId, dateISO, excludeId || null]);
    // Space-name match + time overlap in JS (same rule as MemoryStore).
    const out = [];
    for (const row of rows) {
      const s = mapSession(row);
      if (spaceName && s.space && s.space !== spaceName) continue;
      const m = /^(\d+):(\d+)\s*(AM|PM)/i.exec(s.startTime || '');
      if (!m) continue;
      let h = +m[1];
      if (/pm/i.test(m[3]) && h < 12) h += 12;
      if (/am/i.test(m[3]) && h === 12) h = 0;
      const o0 = h * 60 + (+m[2]);
      const o1 = o0 + (+s.durationMin || 60);
      if (startMin < o1 && o0 < endMin) out.push(s);
    }
    return out;
  }

  async countConfirmed(sessionId) {
    const { rows } = await this._query(
      `SELECT COUNT(*)::int AS c FROM reservations WHERE session_id = $1 AND status = 'confirmed'`,
      [sessionId]);
    return rows[0].c;
  }

  async listConfirmed(sessionId) {
    const { rows } = await this._query(
      `SELECT * FROM reservations WHERE session_id = $1 AND status = 'confirmed' ORDER BY created_at ASC`,
      [sessionId]);
    return rows.map(mapReservation);
  }

  async findReservation(sessionId, athleteId) {
    const { rows } = await this._query(
      `SELECT * FROM reservations WHERE session_id = $1 AND athlete_id = $2 AND status <> 'cancelled' LIMIT 1`,
      [sessionId, athleteId]);
    return mapReservation(rows[0] || null);
  }

  async getReservation(id) {
    const { rows } = await this._query(`SELECT * FROM reservations WHERE id = $1`, [id]);
    return mapReservation(rows[0] || null);
  }

  async listAthleteReservations(athleteId, dateISO) {
    const { rows } = await this._query(
      `SELECT r.* FROM reservations r
       JOIN training_sessions ts ON ts.id = r.session_id
       WHERE r.athlete_id = $1 AND r.status = 'confirmed' AND ts.date = $2`,
      [athleteId, dateISO]);
    return rows.map(mapReservation);
  }

  /* Final atomic gate: reserve_seat() (migration 001) enforces capacity
   * and the duplicate-confirmed unique index inside Postgres. */
  async insertReservation(r) {
    let res;
    try {
      res = await this._query(`SELECT * FROM reserve_seat($1, $2, $3)`,
        [r.sessionId, r.athleteId, r.actor || 'system']);
    } catch (e) {
      if (e && e.code === '23505') throw err('DUPLICATE', 'Athlete already holds a confirmed reservation for this session.');
      if (e && /duplicate:/i.test(e.message || '')) throw err('DUPLICATE', 'Athlete already holds a confirmed reservation for this session.');
      if (e && /session_not_bookable/i.test(e.message || '')) {
        throw err('SESSION_NOT_BOOKABLE', 'Session has no bookable capacity.');
      }
      throw e;
    }
    const gate = res.rows[0] || {};
    if (gate.outcome === 'confirmed') {
      const row = await this.getReservation(gate.reservation_id);
      if (!row) throw err('DUPLICATE', 'Reservation confirmed by reserve_seat() but not found on re-read.');
      return row;
    }
    // 'waitlisted' / 'already_waitlisted': the seat vanished between the
    // engine's check and the atomic gate. reserve_seat() already inserted
    // the waitlist entry (and its WAITLISTED audit row) — never insert a
    // second one here. Throw with the entry attached so the engine can
    // return { outcome: 'waitlisted' } for the race loser instead of an
    // error. (Fixed 2026-11-12: previously this threw SESSION_NOT_BOOKABLE,
    // so a cross-process race loser got an error instead of a waitlist spot.)
    if (gate.outcome === 'waitlisted' || gate.outcome === 'already_waitlisted') {
      let wlRow = null;
      if (gate.waitlist_id) {
        const { rows } = await this._query(
          `SELECT * FROM waitlist_entries WHERE id = $1`, [gate.waitlist_id]);
        wlRow = rows[0] || null;
      } else {
        const { rows } = await this._query(
          `SELECT * FROM waitlist_entries WHERE session_id = $1 AND athlete_id = $2 AND status = 'waiting' ORDER BY position ASC LIMIT 1`,
          [r.sessionId, r.athleteId]);
        wlRow = rows[0] || null;
      }
      const waitlist = mapWaitlist(wlRow) || {
        id: gate.waitlist_id || null, sessionId: r.sessionId, athleteId: r.athleteId,
        position: gate.waitlist_position ?? null, status: 'waiting',
      };
      if (gate.outcome === 'already_waitlisted') {
        const e = err('ALREADY_WAITLISTED', `Already waitlisted at position ${waitlist.position}.`);
        e.waitlist = waitlist;
        throw e;
      }
      const e = err('RACE_WAITLISTED', `Session filled during booking (reserve_seat outcome: waitlisted, position ${waitlist.position}).`);
      e.waitlist = waitlist;
      throw e;
    }
    throw err('SESSION_NOT_BOOKABLE', `Unexpected reserve_seat outcome: ${gate.outcome}.`);
  }

  async updateReservation(id, patch) {
    const sets = [];
    const params = [];
    const map = { status: 'status', cancelledAt: 'cancelled_at', cancelReason: 'cancel_reason' };
    for (const [key, col] of Object.entries(map)) {
      if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${col} = $${params.length}`); }
    }
    if (!sets.length) return this.getReservation(id);
    params.push(id);
    const { rows } = await this._query(
      `UPDATE reservations SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    return mapReservation(rows[0] || null);
  }

  async listWaitlist(sessionId) {
    const { rows } = await this._query(
      `SELECT * FROM waitlist_entries WHERE session_id = $1 ORDER BY position ASC`, [sessionId]);
    return rows.map(mapWaitlist);
  }

  async insertWaitlist(w) {
    const { rows } = await this._query(
      `INSERT INTO waitlist_entries (session_id, athlete_id, position, status)
       SELECT $1, $2, COALESCE(MAX(position), 0) + 1, 'waiting'
       FROM waitlist_entries WHERE session_id = $1 AND status = 'waiting'
       RETURNING *`,
      [w.sessionId, w.athleteId]);
    return mapWaitlist(rows[0]);
  }

  async updateWaitlist(id, patch) {
    const sets = [];
    const params = [];
    const map = { status: 'status', position: 'position', promotedReservationId: 'promoted_reservation_id' };
    for (const [key, col] of Object.entries(map)) {
      if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${col} = $${params.length}`); }
    }
    if (!sets.length) {
      const { rows } = await this._query(`SELECT * FROM waitlist_entries WHERE id = $1`, [id]);
      return mapWaitlist(rows[0] || null);
    }
    params.push(id);
    const { rows } = await this._query(
      `UPDATE waitlist_entries SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    return mapWaitlist(rows[0] || null);
  }

  async insertAttendance(a) {
    const { rows } = await this._query(
      `INSERT INTO attendance_records (session_id, athlete_id, reservation_id, status, walk_in, recorded_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [a.sessionId, a.athleteId, a.reservationId || null, a.status, !!a.walkIn, a.actor || 'system', a.note || null]);
    return mapAttendance(rows[0]);
  }

  async listAttendance(sessionId) {
    const { rows } = await this._query(
      `SELECT * FROM attendance_records WHERE session_id = $1 ORDER BY recorded_at ASC`, [sessionId]);
    return rows.map(mapAttendance);
  }

  async insertAudit(e) {
    const { rows } = await this._query(
      `INSERT INTO operational_audit_events (entity_type, entity_id, action, actor, detail)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [e.entityType, e.entityId, e.action, e.actor || 'system', e.detail || '']);
    return mapAudit(rows[0]);
  }

  async listAudit(filter) {
    const where = [];
    const params = [];
    if (filter) {
      if (filter.action) { params.push(filter.action); where.push(`action = $${params.length}`); }
      if (filter.entityType) { params.push(filter.entityType); where.push(`entity_type = $${params.length}`); }
      if (filter.entityId) { params.push(filter.entityId); where.push(`entity_id = $${params.length}`); }
      if (filter.actor) { params.push(filter.actor); where.push(`actor = $${params.length}`); }
    }
    const { rows } = await this._query(
      `SELECT * FROM operational_audit_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at ASC`,
      params);
    return rows.map(mapAudit);
  }
}

module.exports = { PostgresStore };
