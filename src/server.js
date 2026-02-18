import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { q, withTransaction, writeEvent } from './db.js';

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/', express.static(path.join(__dirname, 'frontend')));

const systemMode = { status: 'online', checks: { database: 'online', event_log: 'online', queue: 'online' } };

function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function typedError(res, status, code, message, retryable = false) {
  return res.status(status).json({
    ok: false,
    error: { code, message, retryable },
    request_id: randomUUID()
  });
}

function withIdempotency(routeKey, handler) {
  return (req, res) => {
    const key = req.header('Idempotency-Key');
    if (!key) {
      return typedError(res, 400, 'VALIDATION_ERROR', 'Missing Idempotency-Key header');
    }

    const hash = payloadHash(req.body);
    const existing = q.getIdempotency.get(key, routeKey);
    if (existing) {
      if (existing.payload_hash !== hash) {
        return typedError(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key already used with different payload');
      }
      return res.json(JSON.parse(existing.response_json));
    }

    return handler(req, res, (responsePayload) => {
      q.insertIdempotency.run(key, routeKey, hash, JSON.stringify(responsePayload));
    });
  };
}

app.get('/v1/health', (_req, res) => {
  res.json({ status: systemMode.status, checks: systemMode.checks, updated_at: new Date().toISOString() });
});

app.get('/v1/appointments', (req, res) => {
  const date = req.query.date;
  if (!date) {
    return typedError(res, 400, 'VALIDATION_ERROR', 'Missing date query parameter YYYY-MM-DD');
  }
  const list = q.listByDay.all(date);
  res.json({ ok: true, data: list });
});

app.post('/v1/appointments', withIdempotency('create', (req, res, saveIdempotency) => {
  const schema = z.object({
    client_name: z.string().min(1),
    client_phone: z.string().optional(),
    service_name: z.string().min(1),
    starts_at: z.string().datetime(),
    ends_at: z.string().datetime(),
    notes: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);
  }
  if (new Date(parsed.data.ends_at) <= new Date(parsed.data.starts_at)) {
    return typedError(res, 400, 'VALIDATION_ERROR', 'ends_at must be greater than starts_at');
  }

  const id = randomUUID();

  try {
    withTransaction(() => {
      q.insertAppointment.run({ id, ...parsed.data, status: 'booked' });
      writeEvent(id, 'created', { after: parsed.data });
    });
  } catch {
    return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not save appointment safely. No changes were committed.', true);
  }

  const appointment = q.getAppointment.get(id);
  const responsePayload = { ok: true, data: appointment };
  saveIdempotency(responsePayload);
  return res.status(201).json(responsePayload);
}));

app.post('/v1/appointments/:id/reschedule', withIdempotency('reschedule', (req, res, saveIdempotency) => {
  const schema = z.object({
    starts_at: z.string().datetime(),
    ends_at: z.string().datetime(),
    expected_version: z.number().int().positive(),
    reason: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);
  }

  const existing = q.getAppointment.get(req.params.id);
  if (!existing) return typedError(res, 404, 'NOT_FOUND', 'Appointment not found');

  const changes = { id: req.params.id, ...parsed.data };
  try {
    withTransaction(() => {
      const result = q.updateReschedule.run(changes);
      if (result.changes === 0) {
        throw new Error('VERSION_CONFLICT');
      }
      writeEvent(req.params.id, 'rescheduled', {
        before: { starts_at: existing.starts_at, ends_at: existing.ends_at, version: existing.version },
        after: { starts_at: parsed.data.starts_at, ends_at: parsed.data.ends_at, version: existing.version + 1 }
      }, parsed.data.reason);
    });
  } catch (err) {
    if (err.message === 'VERSION_CONFLICT') {
      return typedError(res, 409, 'VERSION_CONFLICT', 'Appointment changed on another device. Refresh and retry.', true);
    }
    return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not reschedule safely. No partial changes were committed.', true);
  }

  const appointment = q.getAppointment.get(req.params.id);
  const responsePayload = { ok: true, data: appointment };
  saveIdempotency(responsePayload);
  return res.json(responsePayload);
}));

app.post('/v1/appointments/:id/cancel', withIdempotency('cancel', (req, res, saveIdempotency) => {
  const schema = z.object({ expected_version: z.number().int().positive(), reason: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const existing = q.getAppointment.get(req.params.id);
  if (!existing) return typedError(res, 404, 'NOT_FOUND', 'Appointment not found');

  try {
    withTransaction(() => {
      const result = q.updateCancel.run({ id: req.params.id, expected_version: parsed.data.expected_version });
      if (result.changes === 0) throw new Error('VERSION_CONFLICT');
      writeEvent(req.params.id, 'cancelled', { before: { status: existing.status }, after: { status: 'cancelled' } }, parsed.data.reason);
    });
  } catch (err) {
    if (err.message === 'VERSION_CONFLICT') {
      return typedError(res, 409, 'VERSION_CONFLICT', 'Appointment changed on another device. Refresh and retry.', true);
    }
    return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not cancel safely. No partial changes were committed.', true);
  }

  const appointment = q.getAppointment.get(req.params.id);
  const responsePayload = { ok: true, data: appointment };
  saveIdempotency(responsePayload);
  return res.json(responsePayload);
}));

app.post('/v1/appointments/:id/undo', withIdempotency('undo', (req, res, saveIdempotency) => {
  const schema = z.object({ undo_event_id: z.string().uuid(), expected_version: z.number().int().positive(), reason: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const event = q.getEvent.get(parsed.data.undo_event_id);
  if (!event || event.appointment_id !== req.params.id) return typedError(res, 404, 'UNDO_NOT_ALLOWED', 'Undo target not found for appointment');
  if (event.superseded_by_event_id) return typedError(res, 409, 'ALREADY_UNDONE', 'This action was already undone');

  const existing = q.getAppointment.get(req.params.id);
  if (!existing) return typedError(res, 404, 'NOT_FOUND', 'Appointment not found');

  try {
    withTransaction(() => {
      if (event.event_type === 'cancelled') {
        const result = q.updateUncancel.run({ id: req.params.id, expected_version: parsed.data.expected_version });
        if (result.changes === 0) throw new Error('VERSION_CONFLICT');
        writeEvent(req.params.id, 'undo_applied', { before: { status: 'cancelled' }, after: { status: 'booked' } }, parsed.data.reason, event.id);
      } else {
        const payload = JSON.parse(event.payload || '{}');
        if (!payload.before?.starts_at || !payload.before?.ends_at) throw new Error('UNDO_NOT_ALLOWED');
        const result = q.updateReschedule.run({
          id: req.params.id,
          starts_at: payload.before.starts_at,
          ends_at: payload.before.ends_at,
          expected_version: parsed.data.expected_version
        });
        if (result.changes === 0) throw new Error('VERSION_CONFLICT');
        writeEvent(req.params.id, 'undo_applied', { before: payload.after, after: payload.before }, parsed.data.reason, event.id);
      }
      q.markEventSuperseded.run(randomUUID(), event.id);
    });
  } catch (err) {
    if (err.message === 'VERSION_CONFLICT') return typedError(res, 409, 'VERSION_CONFLICT', 'Appointment changed on another device. Refresh and retry.', true);
    if (err.message === 'UNDO_NOT_ALLOWED') return typedError(res, 400, 'UNDO_NOT_ALLOWED', 'That event cannot be undone automatically.');
    return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not apply undo safely. No partial changes were committed.', true);
  }

  const appointment = q.getAppointment.get(req.params.id);
  const responsePayload = { ok: true, data: appointment };
  saveIdempotency(responsePayload);
  return res.json(responsePayload);
}));

app.get('/v1/appointments/:id/events', (req, res) => {
  res.json({ ok: true, data: q.listEvents.all(req.params.id) });
});

app.post('/v1/offline-holds/sync', (req, res) => {
  const schema = z.array(z.object({
    id: z.string().uuid(),
    local_device_id: z.string(),
    proposed_start: z.string().datetime(),
    proposed_end: z.string().datetime(),
    client_name: z.string().optional(),
    service_name: z.string().optional(),
    expires_at: z.string().datetime()
  }));

  const parsed = schema.safeParse(req.body?.holds ?? []);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const confirmed = [];
  const failed = [];

  for (const hold of parsed.data) {
    try {
      withTransaction(() => {
        q.insertOfflineHold.run(hold);
        const apptId = randomUUID();
        q.insertAppointment.run({
          id: apptId,
          client_name: hold.client_name || 'Offline hold',
          client_phone: null,
          service_name: hold.service_name || 'TBD',
          starts_at: hold.proposed_start,
          ends_at: hold.proposed_end,
          status: 'booked',
          notes: 'Created from offline hold sync'
        });
        writeEvent(apptId, 'created', { source: 'offline_hold', hold_id: hold.id, after: hold });
        q.markHoldSynced.run(hold.id);
        confirmed.push({ hold_id: hold.id, appointment_id: apptId });
      });
    } catch {
      failed.push({ hold_id: hold.id, code: 'OFFLINE_HOLD_CONFLICT', message: 'Could not confirm hold' });
    }
  }

  res.json({ ok: true, data: { confirmed, conflict: [], failed } });
});

app.get('/v1/offline-holds', (_req, res) => {
  res.json({ ok: true, data: q.listUnsyncedHolds.all() });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`booking api running on http://localhost:${port}`);
});
