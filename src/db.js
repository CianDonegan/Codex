import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const db = new Database('booking.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_phone TEXT,
  service_name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled')),
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS appointment_events (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  undone_event_id TEXT,
  superseded_by_event_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
  ON appointment_events(appointment_id, created_at, event_type);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  route_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offline_holds (
  id TEXT PRIMARY KEY,
  local_device_id TEXT NOT NULL,
  proposed_start TEXT NOT NULL,
  proposed_end TEXT NOT NULL,
  client_name TEXT,
  service_name TEXT,
  expires_at TEXT NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const q = {
  insertAppointment: db.prepare(`
    INSERT INTO appointments (id, client_name, client_phone, service_name, starts_at, ends_at, status, notes)
    VALUES (@id, @client_name, @client_phone, @service_name, @starts_at, @ends_at, @status, @notes)
  `),
  getAppointment: db.prepare('SELECT * FROM appointments WHERE id = ?'),
  listByDay: db.prepare(`
    SELECT * FROM appointments
    WHERE date(starts_at) = date(?)
    ORDER BY starts_at ASC
  `),
  updateReschedule: db.prepare(`
    UPDATE appointments
    SET starts_at=@starts_at, ends_at=@ends_at, version=version+1, updated_at=datetime('now')
    WHERE id=@id AND version=@expected_version
  `),
  updateCancel: db.prepare(`
    UPDATE appointments
    SET status='cancelled', version=version+1, updated_at=datetime('now')
    WHERE id=@id AND version=@expected_version
  `),
  updateUncancel: db.prepare(`
    UPDATE appointments
    SET status='booked', version=version+1, updated_at=datetime('now')
    WHERE id=@id AND version=@expected_version
  `),
  insertEvent: db.prepare(`
    INSERT INTO appointment_events (id, appointment_id, event_type, actor_type, actor_id, reason, payload, undone_event_id)
    VALUES (@id, @appointment_id, @event_type, @actor_type, @actor_id, @reason, @payload, @undone_event_id)
  `),
  listEvents: db.prepare('SELECT * FROM appointment_events WHERE appointment_id = ? ORDER BY created_at ASC'),
  getEvent: db.prepare('SELECT * FROM appointment_events WHERE id = ?'),
  markEventSuperseded: db.prepare('UPDATE appointment_events SET superseded_by_event_id=? WHERE id=?'),
  getIdempotency: db.prepare('SELECT * FROM idempotency_keys WHERE idempotency_key=? AND route_key=?'),
  insertIdempotency: db.prepare(`
    INSERT INTO idempotency_keys (idempotency_key, route_key, payload_hash, response_json)
    VALUES (?, ?, ?, ?)
  `),
  insertOfflineHold: db.prepare(`
    INSERT INTO offline_holds (id, local_device_id, proposed_start, proposed_end, client_name, service_name, expires_at)
    VALUES (@id, @local_device_id, @proposed_start, @proposed_end, @client_name, @service_name, @expires_at)
  `),
  listUnsyncedHolds: db.prepare('SELECT * FROM offline_holds WHERE synced=0 AND datetime(expires_at) > datetime(\'now\')'),
  markHoldSynced: db.prepare('UPDATE offline_holds SET synced=1 WHERE id=?')
};

function withTransaction(fn) {
  return db.transaction(fn)();
}

function writeEvent(appointmentId, eventType, payload, reason = null, undoneEventId = null) {
  q.insertEvent.run({
    id: randomUUID(),
    appointment_id: appointmentId,
    event_type: eventType,
    actor_type: 'owner',
    actor_id: 'local-owner',
    reason,
    payload: JSON.stringify(payload),
    undone_event_id: undoneEventId
  });
}

export { db, q, withTransaction, writeEvent };
