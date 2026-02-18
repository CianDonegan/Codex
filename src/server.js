import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var ${key}`);
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const app = express();
app.use(express.json());

const healthChecks = {
  database: 'online',
  auth: 'online',
  queue: 'online'
};

function reqId() {
  return `req_${randomUUID()}`;
}

function typedError(res, status, code, message, retryable = false) {
  return res.status(status).json({
    ok: false,
    error: { code, message, retryable },
    request_id: reqId()
  });
}

function requireIdempotency(req, res) {
  const key = req.header('Idempotency-Key');
  if (!key) {
    typedError(res, 400, 'VALIDATION_ERROR', 'Missing Idempotency-Key header.');
    return null;
  }
  return key;
}

app.get('/v1/health', (_req, res) => {
  const hasDegraded = Object.values(healthChecks).some((v) => v === 'degraded');
  const hasUnsafe = Object.values(healthChecks).some((v) => v === 'failed');
  res.json({
    status: hasUnsafe ? 'unsafe' : hasDegraded ? 'degraded' : 'online',
    checks: healthChecks,
    updated_at: new Date().toISOString()
  });
});

app.post('/v1/auth/magic-link/request', async (req, res) => {
  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const { error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: parsed.data.email
  });

  if (error) return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not send magic link.', true);
  return res.json({ ok: true, data: { sent: true } });
});

app.post('/v1/auth/magic-link/verify', async (req, res) => {
  const schema = z.object({ email: z.string().email(), token: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const { data, error } = await supabase.auth.verifyOtp({
    email: parsed.data.email,
    token: parsed.data.token,
    type: 'email'
  });

  if (error) return typedError(res, 401, 'AUTH_TOKEN_EXPIRED', 'Magic link token invalid or expired.');
  return res.json({ ok: true, data: { session: data.session, user: data.user } });
});

app.get('/v1/appointments', async (req, res) => {
  const date = req.query.date;
  if (!date || typeof date !== 'string') {
    return typedError(res, 400, 'VALIDATION_ERROR', 'date query param is required (YYYY-MM-DD)');
  }

  const from = `${date}T00:00:00.000Z`;
  const to = `${date}T23:59:59.999Z`;

  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .is('deleted_at', null)
    .gte('starts_at', from)
    .lte('starts_at', to)
    .order('starts_at', { ascending: true });

  if (error) return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not fetch appointments.', true);
  return res.json({ ok: true, data });
});

app.post('/v1/appointments', async (req, res) => {
  const idempotencyKey = requireIdempotency(req, res);
  if (!idempotencyKey) return;

  const schema = z.object({
    client_name: z.string().min(1),
    client_phone: z.string().optional().nullable(),
    service_name: z.string().min(1),
    starts_at: z.string().datetime(),
    ends_at: z.string().datetime(),
    notes: z.string().optional().nullable(),
    force_fail: z.boolean().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const { data, error } = await supabase.rpc('api_create_appointment', {
    p_idempotency_key: idempotencyKey,
    p_client_name: parsed.data.client_name,
    p_client_phone: parsed.data.client_phone ?? null,
    p_service_name: parsed.data.service_name,
    p_starts_at: parsed.data.starts_at,
    p_ends_at: parsed.data.ends_at,
    p_notes: parsed.data.notes ?? null,
    p_force_fail: parsed.data.force_fail ?? false
  });

  if (error) return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not save appointment safely.', true);
  if (!data.ok) return typedError(res, data.error.code === 'IDEMPOTENCY_KEY_REUSED' ? 409 : 400, data.error.code, data.error.message, data.error.retryable);
  return res.status(201).json(data);
});

app.post('/v1/appointments/:id/reschedule', async (req, res) => {
  const idempotencyKey = requireIdempotency(req, res);
  if (!idempotencyKey) return;

  const schema = z.object({
    expected_version: z.number().int().positive(),
    starts_at: z.string().datetime(),
    ends_at: z.string().datetime(),
    reason: z.string().optional().nullable()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const { data, error } = await supabase.rpc('api_reschedule_appointment', {
    p_appointment_id: req.params.id,
    p_expected_version: parsed.data.expected_version,
    p_starts_at: parsed.data.starts_at,
    p_ends_at: parsed.data.ends_at,
    p_reason: parsed.data.reason ?? null,
    p_idempotency_key: idempotencyKey
  });

  if (error) return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not reschedule safely.', true);
  if (!data.ok) return typedError(res, data.error.code === 'VERSION_CONFLICT' ? 409 : 400, data.error.code, data.error.message, data.error.retryable);
  return res.json(data);
});

app.post('/v1/appointments/:id/cancel', async (req, res) => {
  const idempotencyKey = requireIdempotency(req, res);
  if (!idempotencyKey) return;

  const schema = z.object({
    expected_version: z.number().int().positive(),
    reason: z.string().optional().nullable()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const { data, error } = await supabase.rpc('api_cancel_appointment', {
    p_appointment_id: req.params.id,
    p_expected_version: parsed.data.expected_version,
    p_reason: parsed.data.reason ?? null,
    p_idempotency_key: idempotencyKey
  });

  if (error) return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not cancel safely.', true);
  if (!data.ok) return typedError(res, data.error.code === 'VERSION_CONFLICT' ? 409 : 400, data.error.code, data.error.message, data.error.retryable);
  return res.json(data);
});

app.post('/v1/appointments/:id/undo', async (req, res) => {
  const idempotencyKey = requireIdempotency(req, res);
  if (!idempotencyKey) return;

  const schema = z.object({
    undo_event_id: z.string().uuid(),
    expected_version: z.number().int().positive(),
    reason: z.string().optional().nullable()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const { data, error } = await supabase.rpc('api_undo_appointment', {
    p_appointment_id: req.params.id,
    p_undo_event_id: parsed.data.undo_event_id,
    p_expected_version: parsed.data.expected_version,
    p_reason: parsed.data.reason ?? null,
    p_idempotency_key: idempotencyKey
  });

  if (error) return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not undo safely.', true);
  if (!data.ok) return typedError(res, data.error.code === 'VERSION_CONFLICT' ? 409 : 400, data.error.code, data.error.message, data.error.retryable);
  return res.json(data);
});

app.get('/v1/appointments/:id/events', async (req, res) => {
  const { data, error } = await supabase
    .from('appointment_events')
    .select('*')
    .eq('appointment_id', req.params.id)
    .order('created_at', { ascending: true });

  if (error) return typedError(res, 500, 'DB_TRANSACTION_FAILED', 'Could not fetch appointment events.', true);
  return res.json({ ok: true, data });
});

app.post('/v1/offline-holds/sync', async (req, res) => {
  const schema = z.object({
    holds: z.array(z.object({
      id: z.string().uuid(),
      local_device_id: z.string(),
      proposed_start: z.string().datetime(),
      proposed_end: z.string().datetime(),
      client_name: z.string().optional().nullable(),
      service_name: z.string().optional().nullable(),
      expires_at: z.string().datetime()
    }))
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return typedError(res, 400, 'VALIDATION_ERROR', parsed.error.issues[0].message);

  const { data, error } = await supabase.rpc('api_sync_offline_holds', { p_holds: parsed.data.holds });
  if (error) return typedError(res, 500, 'OFFLINE_HOLD_CONFLICT', 'Could not sync offline holds.', true);
  return res.json(data);
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  console.log(`Step 2 API listening on http://localhost:${port}`);
});
