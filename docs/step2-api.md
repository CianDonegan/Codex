# Step 2 Backend API (Supabase)

This implements Step 2 from `README.md` with typed failures, idempotency, optimistic concurrency, and transactional mutation RPCs.

## Setup

1. Apply DB migrations in order:
   - `db/step1_schema.sql`
   - `db/step2_api.sql`
2. Copy `.env.example` to `.env` and provide keys.
3. Start API:

```bash
npm install
npm start
```

## Routes

### `GET /v1/health`
Returns system mode and checks.

### `POST /v1/auth/magic-link/request`
Body:
```json
{ "email": "owner@example.com" }
```

### `POST /v1/auth/magic-link/verify`
Body:
```json
{ "email": "owner@example.com", "token": "123456" }
```

### `GET /v1/appointments?date=YYYY-MM-DD`
Returns active appointments for date.

### `POST /v1/appointments`
Headers: `Idempotency-Key`

Body:
```json
{
  "client_name": "Ana",
  "service_name": "Gel Manicure",
  "starts_at": "2026-02-18T10:00:00.000Z",
  "ends_at": "2026-02-18T11:00:00.000Z",
  "notes": "Patch test"
}
```

### `POST /v1/appointments/:id/reschedule`
Headers: `Idempotency-Key`

Body:
```json
{
  "expected_version": 1,
  "starts_at": "2026-02-18T11:00:00.000Z",
  "ends_at": "2026-02-18T12:00:00.000Z",
  "reason": "Client requested"
}
```

### `POST /v1/appointments/:id/cancel`
Headers: `Idempotency-Key`

Body:
```json
{
  "expected_version": 2,
  "reason": "No-show"
}
```

### `POST /v1/appointments/:id/undo`
Headers: `Idempotency-Key`

Body:
```json
{
  "undo_event_id": "<event-uuid>",
  "expected_version": 3,
  "reason": "Accidental cancel"
}
```

### `GET /v1/appointments/:id/events`
Returns append-only event history.

### `POST /v1/offline-holds/sync`
Body:
```json
{
  "holds": [
    {
      "id": "11111111-1111-1111-1111-111111111111",
      "local_device_id": "device-a",
      "proposed_start": "2026-02-18T14:00:00.000Z",
      "proposed_end": "2026-02-18T15:00:00.000Z",
      "client_name": "Mia",
      "service_name": "Nail Art",
      "expires_at": "2026-02-18T18:00:00.000Z"
    }
  ]
}
```

Response contains `confirmed[]`, `conflict[]`, `failed[]`.

## Error contract

```json
{
  "ok": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Appointment changed on another device. Refresh and retry.",
    "retryable": true
  },
  "request_id": "req_123"
}
```

Supported codes:
- `VALIDATION_ERROR`
- `VERSION_CONFLICT`
- `IDEMPOTENCY_KEY_REUSED`
- `DB_TRANSACTION_FAILED`
- `AUTH_TOKEN_EXPIRED`
- `OFFLINE_HOLD_CONFLICT`
