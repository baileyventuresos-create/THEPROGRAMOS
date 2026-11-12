/* THE PROGRAM OS — Reservation stores (operational foundation V1)
 *
 * Two implementations of the store interface used by reservation-engine.js:
 *   - MemoryStore: in-process, for tests and local development.
 *   - SqliteStore: node:sqlite (Node 22.5+, no dependencies), same
 *     interface, with BEGIN IMMEDIATE transactions so a capacity check
 *     and insert cannot interleave. This is the local stand-in for the
 *     PostgreSQL schema in migrations/001 — same tables, same rules.
 *
 * Neither store is production. Production is PostgreSQL (migrations/001
 * + 002) behind an authenticated API; see docs/INTEGRATION_STRATEGY.md.
 * Athlete records here are fixtures only — no real minor's data.
 */
'use strict';

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

class MemoryStore {
  constructor(seed) {
    this.sessions = new Map(); this.athletes = new Map();
    this.memberships = new Map(); this.coaches = new Map();
    this.reservations = new Map(); this.waitlist = new Map();
    this.attendance = []; this.audit = [];
    this.coachUnavailability = []; // {coachId, date, startMin, endMin}
    this._seq = 0;
    if (seed) this.loadSeed(seed);
  }
  loadSeed(seed) {
    for (const s of seed.sessions || []) this.sessions.set(s.id, clone(s));
    for (const a of seed.athletes || []) this.athletes.set(a.id, clone(a));
    for (const m of seed.memberships || []) this.memberships.set(m.id, clone(m));
    for (const c of seed.coaches || []) this.coaches.set(c.id, clone(c));
    for (const u of seed.coachUnavailability || []) this.coachUnavailability.push(clone(u));
    for (const r of seed.reservations || []) this.reservations.set(r.id, clone(r));
  }
  async getSession(id) { return clone(this.sessions.get(id)) || null; }
  async getAthlete(id) { return clone(this.athletes.get(id)) || null; }
  async getMembership(athleteId) {
    for (const m of this.memberships.values()) if (m.athleteId === athleteId) return clone(m);
    return null;
  }
  async coachAvailable(coachId, date, startMin, endMin) {
    return !this.coachUnavailability.some(u => u.coachId === coachId && u.date === date &&
      startMin < u.endMin && u.startMin < endMin);
  }
  async listSessionsAt(locationId, space, date, startMin, endMin, excludeId) {
    const out = [];
    for (const s of this.sessions.values()) {
      if (s.locationId !== locationId || s.date !== date || s.id === excludeId) continue;
      if (space && s.space && s.space !== space) continue;
      const m = /^(\d+):(\d+)\s*(AM|PM)/i.exec(s.startTime || '');
      if (!m) continue;
      let h = +m[1]; if (/pm/i.test(m[3]) && h < 12) h += 12; if (/am/i.test(m[3]) && h === 12) h = 0;
      const o0 = h * 60 + (+m[2]), o1 = o0 + (+s.durationMin || 60);
      if (startMin < o1 && o0 < endMin) out.push(clone(s));
    }
    return out;
  }
  async countConfirmed(sessionId) {
    let n = 0; for (const r of this.reservations.values()) if (r.sessionId === sessionId && r.status === 'confirmed') n++;
    return n;
  }
  async listConfirmed(sessionId) {
    return [...this.reservations.values()].filter(r => r.sessionId === sessionId && r.status === 'confirmed').map(clone);
  }
  async findReservation(sessionId, athleteId) {
    for (const r of this.reservations.values())
      if (r.sessionId === sessionId && r.athleteId === athleteId && r.status !== 'cancelled') return clone(r);
    return null;
  }
  async getReservation(id) { return clone(this.reservations.get(id)) || null; }
  async listAthleteReservations(athleteId, date) {
    const out = [];
    for (const r of this.reservations.values()) {
      if (r.athleteId !== athleteId || r.status !== 'confirmed') continue;
      const s = this.sessions.get(r.sessionId);
      if (s && s.date === date) out.push(clone(r));
    }
    return out;
  }
  async insertReservation(r) {
    const row = Object.assign({ id: uid('res'), createdAt: new Date().toISOString() }, clone(r));
    this.reservations.set(row.id, row); return clone(row);
  }
  async updateReservation(id, patch) {
    const row = this.reservations.get(id); if (!row) return null;
    Object.assign(row, clone(patch)); return clone(row);
  }
  async listWaitlist(sessionId) {
    return [...this.waitlist.values()].filter(w => w.sessionId === sessionId)
      .sort((a, b) => a.position - b.position).map(clone);
  }
  async insertWaitlist(w) {
    const waiting = (await this.listWaitlist(w.sessionId)).filter(x => x.status === 'waiting');
    const row = Object.assign({ id: uid('wl'), position: waiting.length + 1,
      createdAt: new Date().toISOString() }, clone(w));
    this.waitlist.set(row.id, row); return clone(row);
  }
  async updateWaitlist(id, patch) {
    const row = this.waitlist.get(id); if (!row) return null;
    Object.assign(row, clone(patch)); return clone(row);
  }
  async insertAttendance(a) {
    const row = Object.assign({ id: uid('att'), recordedAt: new Date().toISOString() }, clone(a));
    this.attendance.push(row); return clone(row);
  }
  async listAttendance(sessionId) { return this.attendance.filter(a => a.sessionId === sessionId).map(clone); }
  async insertAudit(e) {
    const row = Object.assign({ id: uid('aud'), at: new Date().toISOString() }, clone(e));
    this.audit.push(row); return clone(row);
  }
  async listAudit(filter) {
    return this.audit.filter(e => !filter || Object.entries(filter).every(([k, v]) => e[k] === v)).map(clone);
  }
  async transaction(fn) { return fn(); } // single-threaded + engine mutex
}

/* SQLite store — same interface, real transactions. Schema mirrors
 * migrations/001 (subset needed by the engine). */
class SqliteStore {
  constructor(path) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(path || ':memory:');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS athletes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, athlete_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coaches (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coach_unavailability (id INTEGER PRIMARY KEY AUTOINCREMENT,
        coach_id TEXT, date TEXT, start_min INTEGER, end_min INTEGER);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, session_id TEXT, athlete_id TEXT,
        status TEXT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_reservation_active
        ON reservations (session_id, athlete_id) WHERE status = 'confirmed';
      CREATE TABLE IF NOT EXISTS waitlist (id TEXT PRIMARY KEY, session_id TEXT, athlete_id TEXT,
        position INTEGER, status TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attendance (id TEXT PRIMARY KEY, session_id TEXT, athlete_id TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT,
        action TEXT, actor TEXT, at TEXT, detail TEXT);`);
    this._seq = 0;
  }
  loadSeed(seed) {
    const insS = this.db.prepare('INSERT OR REPLACE INTO sessions (id, data) VALUES (?, ?)');
    for (const s of seed.sessions || []) insS.run(s.id, JSON.stringify(s));
    const insA = this.db.prepare('INSERT OR REPLACE INTO athletes (id, data) VALUES (?, ?)');
    for (const a of seed.athletes || []) insA.run(a.id, JSON.stringify(a));
    const insM = this.db.prepare('INSERT OR REPLACE INTO memberships (id, athlete_id, data) VALUES (?, ?, ?)');
    for (const m of seed.memberships || []) insM.run(m.id, m.athleteId, JSON.stringify(m));
    const insC = this.db.prepare('INSERT OR REPLACE INTO coaches (id, data) VALUES (?, ?)');
    for (const c of seed.coaches || []) insC.run(c.id, JSON.stringify(c));
    const insU = this.db.prepare('INSERT INTO coach_unavailability (coach_id, date, start_min, end_min) VALUES (?, ?, ?, ?)');
    for (const u of seed.coachUnavailability || []) insU.run(u.coachId, u.date, u.startMin, u.endMin);
    const insR = this.db.prepare('INSERT OR REPLACE INTO reservations (id, session_id, athlete_id, status, data) VALUES (?, ?, ?, ?, ?)');
    for (const r of seed.reservations || []) insR.run(r.id, r.sessionId, r.athleteId, r.status, JSON.stringify(r));
  }
  _row(table, id) {
    const r = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return r ? JSON.parse(r.data) : null;
  }
  async getSession(id) { return this._row('sessions', id); }
  async getAthlete(id) { return this._row('athletes', id); }
  async getMembership(athleteId) {
    const r = this.db.prepare('SELECT data FROM memberships WHERE athlete_id = ? LIMIT 1').get(athleteId);
    return r ? JSON.parse(r.data) : null;
  }
  async coachAvailable(coachId, date, startMin, endMin) {
    const r = this.db.prepare(`SELECT 1 FROM coach_unavailability WHERE coach_id = ? AND date = ?
      AND ? < end_min AND start_min < ? LIMIT 1`).get(coachId, date, startMin, endMin);
    return !r;
  }
  async listSessionsAt(locationId, space, date, startMin, endMin, excludeId) {
    const rows = this.db.prepare('SELECT data FROM sessions').all().map(r => JSON.parse(r.data));
    return rows.filter(s => {
      if (s.locationId !== locationId || s.date !== date || s.id === excludeId) return false;
      if (space && s.space && s.space !== space) return false;
      const m = /^(\d+):(\d+)\s*(AM|PM)/i.exec(s.startTime || ''); if (!m) return false;
      let h = +m[1]; if (/pm/i.test(m[3]) && h < 12) h += 12; if (/am/i.test(m[3]) && h === 12) h = 0;
      const o0 = h * 60 + (+m[2]), o1 = o0 + (+s.durationMin || 60);
      return startMin < o1 && o0 < endMin;
    });
  }
  async countConfirmed(sessionId) {
    return this.db.prepare(`SELECT COUNT(*) c FROM reservations WHERE session_id = ? AND status = 'confirmed'`).get(sessionId).c;
  }
  async listConfirmed(sessionId) {
    return this.db.prepare(`SELECT data FROM reservations WHERE session_id = ? AND status = 'confirmed'`).all(sessionId).map(r => JSON.parse(r.data));
  }
  async findReservation(sessionId, athleteId) {
    const r = this.db.prepare(`SELECT data FROM reservations WHERE session_id = ? AND athlete_id = ? AND status != 'cancelled' LIMIT 1`).get(sessionId, athleteId);
    return r ? JSON.parse(r.data) : null;
  }
  async getReservation(id) { return this._row('reservations', id); }
  async listAthleteReservations(athleteId, date) {
    const rows = this.db.prepare(`SELECT data FROM reservations WHERE athlete_id = ? AND status = 'confirmed'`).all(athleteId).map(r => JSON.parse(r.data));
    return rows.filter(r => { const s = this._row('sessions', r.sessionId); return s && s.date === date; });
  }
  async insertReservation(r) {
    const row = Object.assign({ id: uid('res'), createdAt: new Date().toISOString() }, clone(r));
    this.db.prepare('INSERT INTO reservations (id, session_id, athlete_id, status, data) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.sessionId, row.athleteId, row.status, JSON.stringify(row));
    return clone(row);
  }
  async updateReservation(id, patch) {
    const row = this._row('reservations', id); if (!row) return null;
    Object.assign(row, clone(patch));
    this.db.prepare('UPDATE reservations SET status = ?, data = ? WHERE id = ?').run(row.status, JSON.stringify(row), id);
    return clone(row);
  }
  async listWaitlist(sessionId) {
    return this.db.prepare(`SELECT data FROM waitlist WHERE session_id = ? ORDER BY position ASC`).all(sessionId).map(r => JSON.parse(r.data));
  }
  async insertWaitlist(w) {
    const waiting = (await this.listWaitlist(w.sessionId)).filter(x => x.status === 'waiting');
    const row = Object.assign({ id: uid('wl'), position: waiting.length + 1, createdAt: new Date().toISOString() }, clone(w));
    this.db.prepare('INSERT INTO waitlist (id, session_id, athlete_id, position, status, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.sessionId, row.athleteId, row.position, row.status, JSON.stringify(row));
    return clone(row);
  }
  async updateWaitlist(id, patch) {
    const row = this._row('waitlist', id); if (!row) return null;
    Object.assign(row, clone(patch));
    this.db.prepare('UPDATE waitlist SET status = ?, position = ?, data = ? WHERE id = ?')
      .run(row.status, row.position, JSON.stringify(row), id);
    return clone(row);
  }
  async insertAttendance(a) {
    const row = Object.assign({ id: uid('att'), recordedAt: new Date().toISOString() }, clone(a));
    this.db.prepare('INSERT INTO attendance (id, session_id, athlete_id, data) VALUES (?, ?, ?, ?)')
      .run(row.id, row.sessionId, row.athleteId, JSON.stringify(row));
    return clone(row);
  }
  async listAttendance(sessionId) {
    return this.db.prepare('SELECT data FROM attendance WHERE session_id = ?').all(sessionId).map(r => JSON.parse(r.data));
  }
  async insertAudit(e) {
    const row = Object.assign({ id: uid('aud'), at: new Date().toISOString() }, clone(e));
    this.db.prepare('INSERT INTO audit_events (id, entity_type, entity_id, action, actor, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.entityType, row.entityId, row.action, row.actor, row.at, row.detail || '');
    return clone(row);
  }
  async listAudit(filter) {
    let rows = this.db.prepare('SELECT * FROM audit_events ORDER BY at ASC').all();
    if (filter) rows = rows.filter(e => Object.entries(filter).every(([k, v]) => e[k.replace(/([A-Z])/g, '_$1').toLowerCase()] === v || e[k] === v));
    return rows.map(r => ({ id: r.id, entityType: r.entity_type, entityId: r.entity_id, action: r.action, actor: r.actor, at: r.at, detail: r.detail }));
  }
  async transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = await fn(); this.db.exec('COMMIT'); return out; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }
  close() { this.db.close(); }
}

module.exports = { MemoryStore, SqliteStore };
