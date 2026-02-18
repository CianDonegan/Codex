# Codex

## Mission-Critical Booking System Plan

## Explicit Non-Goals (MVP)

- No payment processing
- No staff multi-calendar support
- No automatic conflict resolution
- No background auto-merge of scheduling conflicts
- No real-time collaborative editing

### Step 1: Database Setup

> Skill note: no listed skill applies to this task, so I’m proceeding with a direct reliability-first data model design.

#### Purpose
This phase establishes the backend database as the single source of truth. If the schema is weak, appointments can disappear, conflicts become invisible, and undo/recovery becomes unreliable.

#### Why this is necessary
Before API and UI work, you need a data model that guarantees:
- no destructive deletes,
- complete traceability,
- reversible changes,
- explicit offline intent handling.

**Timestamp invariant:** All timestamps are stored in UTC (`TIMESTAMPTZ`).
Client-local time is converted at the edge only.

---

## Core schema (MVP-safe)

Use four core tables:

1. `appointments` — current canonical snapshot.
2. `appointment_events` — append-only event/audit log.
3. `offline_holds` — local/offline intent records (not confirmed bookings).
4. `magic_links` — passwordless auth tokens.

### Why this is a hybrid model (not full event sourcing)

This system does not fully derive state from events at read time.
The `appointments` table acts as a materialized snapshot for performance
and simplicity, while the event log provides auditability and recovery.

---

## Example schema (PostgreSQL)

```sql
CREATE TABLE appointments (
  id UUID PRIMARY KEY,
  client_name TEXT NOT NULL,
  client_phone TEXT,
  service_name TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled')),
  notes TEXT,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_appointments_starts_at ON appointments(starts_at);
CREATE INDEX idx_appointments_status ON appointments(status);

CREATE TABLE appointment_events (
  id UUID PRIMARY KEY,
  appointment_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created',
    'rescheduled',
    'cancelled',
    'uncancelled',
    'notes_updated',
    'soft_deleted',
    'restored'
  )),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'system')),
  actor_id TEXT,
  reason TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE appointment_events
  ADD CONSTRAINT uq_appointment_events_natural
  UNIQUE (appointment_id, created_at, event_type);

CREATE INDEX idx_events_appointment_id_created_at
  ON appointment_events(appointment_id, created_at);

CREATE TABLE offline_holds (
  id UUID PRIMARY KEY,
  local_device_id TEXT NOT NULL,
  proposed_start TIMESTAMPTZ NOT NULL,
  proposed_end TIMESTAMPTZ NOT NULL,
  client_name TEXT,
  service_name TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  synced BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_offline_holds_expires_at ON offline_holds(expires_at);

CREATE TABLE magic_links (
  id UUID PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  destination TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_magic_links_expires_at ON magic_links(expires_at);
```

---

## Why each table exists

- `appointments`: fast read model for today-first operations.
- `appointment_events`: immutable audit trail for undo, traceability, and recovery.
- `offline_holds`: explicit pending intent while offline (never treated as confirmed).
- `magic_links`: simple secure auth without password management.

---

## Reliability risks and prevention

- **Data loss risk:** hard deletes remove appointments permanently.
  - Prevent with cancel/soft-delete semantics and event logging.
- **Silent failure risk:** updating appointment without writing event.
  - Prevent by enforcing one transaction for state + event write.
- **False confidence risk:** offline hold shown as confirmed booking.
  - Prevent by labeling holds as pending/not booked.
- **Race condition risk:** concurrent edits overwrite each other.
  - Prevent with `version` field for optimistic concurrency.

---

## Transaction rule (non-negotiable)

Every mutation must perform these atomically:
1. Update `appointments` row.
2. Insert `appointment_events` row.
3. Commit together.

If one fails, both fail.

---

## Manual checkpoint test (must pass before Step 2)

1. Create an appointment row.
2. Insert matching `created` event.
3. Reschedule appointment and insert `rescheduled` event.
4. Cancel appointment and insert `cancelled` event.
5. Query history and confirm all events exist in order.
6. Confirm appointment still exists (not hard-deleted).

Only proceed once all six checks pass.

---

### Step 2: Backend API Design

> Skill note: no listed skill applies to this task, so I’m proceeding with a direct reliability-first backend API design.

#### Purpose
This phase defines the safety boundary between UI/devices and the database. The API must make failures visible, prevent silent overwrites, and ensure every confirmed write is traceable.

#### Why this is necessary
Without strict API contracts, retries can duplicate bookings, stale clients can overwrite newer edits, and partial writes can break auditability. A reliable booking system needs typed errors, transaction boundaries, and explicit concurrency controls.

---

## API reliability rules

1. All writes run in a single DB transaction (state + event log together).
2. All mutating routes require idempotency keys.
3. Updates require optimistic concurrency via `expected_version`.
4. Hard delete endpoints are forbidden.
5. Every failure response is typed and actionable.

---

## Core routes (MVP)

### System and auth
- `GET /v1/health`
  - Returns `online | degraded | unsafe` with component checks.
- `POST /v1/auth/magic-link/request`
- `POST /v1/auth/magic-link/verify`

### Appointments
- `GET /v1/appointments?date=YYYY-MM-DD`
- `POST /v1/appointments`
  - headers: `Idempotency-Key`
- `POST /v1/appointments/:id/reschedule`
  - headers: `Idempotency-Key`
  - body includes `expected_version`
- `POST /v1/appointments/:id/cancel`
  - headers: `Idempotency-Key`
  - body includes `expected_version`
- `POST /v1/appointments/:id/undo`
  - headers: `Idempotency-Key`
  - body includes `undo_event_id`, `expected_version`
- `GET /v1/appointments/:id/events`

### Offline reconciliation
- `POST /v1/offline-holds/sync`
  - returns separate arrays: `confirmed[]`, `conflict[]`, `failed[]`

---

## Transaction contracts

### Create appointment
1. Validate request + idempotency key.
2. Insert `appointments` row.
3. Insert `appointment_events(created)` row.
4. Commit.

If any step fails, rollback and return typed error.

### Reschedule/cancel/undo
1. Validate `expected_version` against current row version.
2. Apply state change + increment version.
3. Insert matching event row (`rescheduled`, `cancelled`, `undo_applied`).
4. Commit.

If version mismatches, return `409 VERSION_CONFLICT` with no write.

---

## Concurrency and idempotency handling

Use optimistic update guard:

```sql
UPDATE appointments
SET starts_at = $1, ends_at = $2, version = version + 1, updated_at = now()
WHERE id = $3 AND version = $4;
```

If affected rows = 0, return conflict.

Idempotency key policy:
- Same key + same payload => return original success result.
- Same key + different payload => return `409 IDEMPOTENCY_KEY_REUSED`.

---

## Typed error envelope

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

Recommended codes:
- `VALIDATION_ERROR`
- `VERSION_CONFLICT`
- `IDEMPOTENCY_KEY_REUSED`
- `DB_TRANSACTION_FAILED`
- `AUTH_TOKEN_EXPIRED`
- `OFFLINE_HOLD_CONFLICT`

---

## Risks and prevention

- **Data loss risk:** hard delete route or non-transactional writes.
  - Prevent with soft-delete/cancel semantics and atomic transactions.
- **Silent failure risk:** DB state changed without event insert.
  - Prevent by writing both in one transaction.
- **False confidence risk:** retry duplicates appointment.
  - Prevent with idempotency persistence.
- **Race condition risk:** stale client overwrites newer update.
  - Prevent with version checks and `409` conflicts.

---

## Manual checkpoint test (must pass before Step 3)

1. **Idempotent create**
   - Send same create request twice with same key.
   - Verify one appointment exists.
2. **Version conflict safety**
   - Send two reschedules with same `expected_version`.
   - Verify one succeeds, one returns `409 VERSION_CONFLICT`.
3. **Transactional integrity**
   - Force event insert failure during mutation.
   - Verify appointment state does not change.
4. **Undo trace**
   - Cancel then undo appointment.
   - Verify both events appear in `/events` and version increments correctly.
5. **Failure visibility**
   - Trigger backend write failure.
   - Verify typed error + `request_id` returned to client.

Only proceed once all five checks pass.

---

### Step 3: Today-first Frontend UI

> Skill note: no listed skill applies to this task, so I’m proceeding with a direct reliability-first frontend design.

#### Purpose
This UI step makes the schedule **safe to operate in real time**. The backend can be correct, but if the UI hides failures, users still lose trust and can accidentally double-book.

A today-first UI is necessary because a solo nail & beauty professional makes rapid decisions from the current day timeline. The UI must prioritize:

- what is confirmed now,
- what is still pending sync,
- what failed and needs action.

#### Why this is necessary
Without clear state signaling, a non-technical user cannot distinguish:

- a confirmed appointment stored on the server,
- a temporary local/offline hold,
- an action that failed due to conflict or connectivity.

That creates **false confidence**, which is a reliability failure even if the backend is implemented correctly.

---

## UI model (single source of truth friendly)

Use one normalized client model for appointment cards:

```ts
type UiAppointment = {
  id: string;
  clientName: string;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  status: "booked" | "cancelled";
  version: number;              // backend version for concurrency

  syncState: "confirmed" | "pending" | "failed";
  // confirmed = server committed
  // pending = local intent/offline hold, not committed
  // failed = last mutation rejected or network write failed

  lastErrorCode?:
    | "VERSION_CONFLICT"
    | "NETWORK_UNAVAILABLE"
    | "VALIDATION_ERROR"
    | "DB_TRANSACTION_FAILED"
    | "OFFLINE_HOLD_CONFLICT";

  idempotencyKey?: string;      // used for safe retry
  undoAvailableUntil?: string;  // one-tap undo window display
};
```

### Safety reasoning
- `version` prevents stale overwrites.
- `syncState` prevents fake “saved” signals.
- `idempotencyKey` enables retry without duplication.
- `lastErrorCode` keeps failures visible and actionable.

---

## Today-first page layout

1. **System status banner (always visible)**
   - `Online` (green): all writes allowed.
   - `Degraded` (amber): writes may fail; warn before submit.
   - `Offline` (red): read-only for confirmed server data; allow only temporary holds.

2. **Today timeline list (default landing)**
   - grouped by time slots.
   - cards show client/service/time and state badge.

3. **Quick actions per card**
   - Reschedule
   - Cancel
   - Undo (if available)

4. **Pending/failed tray (sticky footer or top panel)**
   - lists unsynced holds and failed actions.
   - one-tap retry, one-tap discard hold.

---

## Confirmed vs Pending vs Failed (visual contract)

Use explicit labels and colors:

- **Confirmed** → solid green badge: `Confirmed`
- **Pending** → amber badge: `Pending sync (not booked)`
- **Failed** → red badge: `Failed - action required`

Never use ambiguous wording like “Saved” for pending operations.

Example component logic:

```tsx
function SyncBadge({ syncState }: { syncState: UiAppointment["syncState"] }) {
  if (syncState === "confirmed") {
    return <span className="badge badge-green">Confirmed</span>;
  }
  if (syncState === "pending") {
    return <span className="badge badge-amber">Pending sync (not booked)</span>;
  }
  return <span className="badge badge-red">Failed - action required</span>;
}
```

---

## Frontend API usage patterns (versioning + idempotency)

### Create/reschedule/cancel requests

- Generate `Idempotency-Key` per user action.
- Send `expected_version` for mutating existing appointments.
- Mark UI item `pending` until server confirms.
- On success: set `syncState = confirmed`, update `version` from response.
- On `409 VERSION_CONFLICT`: set `failed`, show refresh CTA.

```ts
async function rescheduleAppointment(input: {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  expectedVersion: number;
}) {
  const idempotencyKey = crypto.randomUUID();

  setUiState(input.appointmentId, {
    syncState: "pending",
    idempotencyKey,
    lastErrorCode: undefined,
  });

  const res = await fetch(`/v1/appointments/${input.appointmentId}/reschedule`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      expected_version: input.expectedVersion,
    }),
  });

  const payload = await res.json();

  if (res.ok) {
    setUiState(input.appointmentId, {
      syncState: "confirmed",
      version: payload.data.version,
      startsAt: payload.data.starts_at,
      endsAt: payload.data.ends_at,
    });
    return;
  }

  setUiState(input.appointmentId, {
    syncState: "failed",
    lastErrorCode: payload?.error?.code ?? "DB_TRANSACTION_FAILED",
  });
}
```

### Conflict handling UX

If `VERSION_CONFLICT`, show:
- “This appointment changed on another device.”
- Buttons: `Refresh appointment` and `Retry with latest version`.

Do not auto-overwrite server state.

---

## Offline read-only behavior for today

### Rules

- Confirmed appointments shown from last successful server snapshot for **today only**.
- UI enters read-only mode when offline for server-backed records.
- User can create **temporary holds** only, labeled `Pending sync (not booked)`.

### Why
This avoids silent data loss. If the app cannot reach backend truth, it must not pretend confirmation.

Example mode gate:

```ts
function canPerformServerWrite(systemStatus: "online" | "degraded" | "offline") {
  return systemStatus === "online" || systemStatus === "degraded";
}

function onCreateAppointment(form: CreateForm) {
  if (!canPerformServerWrite(getSystemStatus())) {
    createOfflineHold(form); // local only
    toast.warning("Saved as temporary hold. Not booked until synced.");
    return;
  }

  void createConfirmedAppointment(form);
}
```

---

## Explicit error handling contract

Display and recover in <60s:

- Network down → banner red + failed tray action “Retry when online”.
- Version conflict → “Refresh and review” CTA.
- Validation error → inline field errors (no silent fail).
- Transaction fail → red toast + retry with same idempotency key.

A failed action must always remain visible until user resolves or dismisses intentionally.

---

## Checkpoint test (must pass before Step 4)

Manual test checklist:

1. **Initial load**
   - Open app on today view.
   - Confirm system banner visible and today appointments loaded.

2. **Pending state visibility**
   - Trigger reschedule and throttle network.
   - Card shows `Pending sync (not booked)` until response returns.

3. **Conflict handling**
   - Simulate two tabs editing same appointment.
   - One tab gets `VERSION_CONFLICT` with visible failed state + refresh CTA.

4. **Offline read-only**
   - Disconnect network.
   - Confirm today confirmed records are viewable but editing them is blocked.
   - Create temporary hold and verify it is labeled not booked.

5. **Failure persistence**
   - Force API write failure.
   - Confirm failed item appears in failed tray with retry option.

Only proceed once all five checks pass.

---

### Step 4: Offline Handling

> Skill note: no listed skill applies to this task, so I’m proceeding with a direct reliability-first offline design.

#### Purpose
This phase makes offline behavior safe, honest, and recoverable. The app must keep the day running when connectivity drops, without ever pretending an offline action is confirmed.

#### Why this is necessary
If queueing and sync are unclear, users get false confidence ("I thought it saved") and appointments can be double-booked or silently lost after reconnect. A reliable offline model separates:

- **intent captured locally**
- **server-confirmed truth**

That distinction is the core safety boundary.

---

## Offline architecture rules

1. Backend remains source of truth.
2. Offline writes are stored as **queued intents** only.
3. Every queued intent is visible in UI until resolved.
4. Every resolved intent shows explicit outcome: confirmed, conflict, or failed.
5. No offline action is labeled "booked" before server commit.

---

## Queueing model (client-side)

Store an append-only queue in IndexedDB (or equivalent durable local storage):

```ts
type QueueItem = {
  id: string; // local UUID
  createdAt: string;
  type: "create_hold" | "reschedule" | "cancel" | "undo";
  appointmentId?: string;
  payload: Record<string, unknown>;

  expectedVersion?: number;   // required for updates
  idempotencyKey: string;     // stable across retries

  status: "queued" | "syncing" | "confirmed" | "conflict" | "failed";
  lastErrorCode?: string;
  lastErrorMessage?: string;
  retryCount: number;
};
```

### Why these fields matter
- `idempotencyKey` avoids duplicates when reconnect retries happen.
- `expectedVersion` catches stale updates explicitly.
- `status` prevents invisible failure.
- `retryCount` helps surface stuck items for manual recovery.

---

## Sync reconciliation rules (on reconnect)

Process queue in strict FIFO order (oldest first):

1. Load next `queued|failed` item.
2. Mark `syncing` in UI.
3. Send request with same `Idempotency-Key` and `expected_version` if needed.
4. Resolve response:
   - **2xx success** → mark `confirmed`, update local snapshot/version.
   - **409 VERSION_CONFLICT** → mark `conflict` (requires user decision).
   - **4xx validation** → mark `failed` with actionable message.
   - **5xx/network** → mark `failed`, keep retryable.
5. Continue to next item.

Never skip conflicting items silently. Conflicts must remain visible.

Example worker:

```ts
async function syncQueue() {
  const items = await queueRepo.listPendingInOrder();

  for (const item of items) {
    await queueRepo.update(item.id, { status: "syncing" });

    try {
      const res = await sendQueuedIntent(item);
      const body = await res.json();

      if (res.ok) {
        await applyServerSnapshot(body.data); // update appointment + version
        await queueRepo.update(item.id, { status: "confirmed", lastErrorCode: undefined });
        continue;
      }

      if (res.status === 409 && body?.error?.code === "VERSION_CONFLICT") {
        await queueRepo.update(item.id, {
          status: "conflict",
          lastErrorCode: "VERSION_CONFLICT",
          lastErrorMessage: "Changed elsewhere. Tap to review.",
        });
        continue;
      }

      await queueRepo.update(item.id, {
        status: "failed",
        lastErrorCode: body?.error?.code ?? "UNKNOWN_ERROR",
        lastErrorMessage: body?.error?.message ?? "Sync failed. Retry.",
        retryCount: item.retryCount + 1,
      });
    } catch {
      await queueRepo.update(item.id, {
        status: "failed",
        lastErrorCode: "NETWORK_UNAVAILABLE",
        lastErrorMessage: "Offline. Will retry when online.",
        retryCount: item.retryCount + 1,
      });
    }
  }
}
```

---

## Conflict handling (non-deceptive)

When `conflict` is detected, show a clear comparison view:

- **Server version (authoritative)**
- **Your queued change (local intent)**

Actions (one tap each):
1. `Keep server value` (discard local intent)
2. `Apply my change to latest` (reload latest version, then retry with new expected version)

No hidden auto-merge for time changes. Scheduling conflicts are user-visible safety decisions.

---

## UX copy for honest offline behavior

Use explicit language:

- While offline create/reschedule/cancel: `Saved offline as pending. Not booked yet.`
- On reconnect success: `Synced and confirmed.`
- On conflict: `Needs review. Another device changed this appointment.`
- On repeated failure: `Could not sync. Tap to retry or call support.`

Avoid "Saved" without qualifiers.

---

## Recovery flows for non-technical users (<60 seconds)

Add a persistent **Sync Center** panel with each unresolved queue item and one-tap actions:

1. **Retry all**
   - Replays all `failed` queue items with existing idempotency keys.
2. **Review conflicts**
   - Opens side-by-side compare and two-choice resolution.
3. **Call-safe fallback**
   - One tap to show today's unresolved items for manual phone confirmation.
4. **Export recovery snapshot**
   - One tap copy/share plain text summary for support.

Example recovery summary format:

```txt
Pending Sync Items (3)
- 09:30 Ana Gel Manicure (create_hold) queued 08:58
- 11:00 Mia Reschedule to 11:30 (conflict)
- 14:00 Zoe Cancel (failed: network)
```

This ensures staff can recover quickly without technical debugging.

---

## Safety pitfalls to avoid

- **Data loss risk:** clearing queue automatically on app restart.
  - Prevent by durable storage + startup integrity check.
- **Silent failure risk:** background sync errors only in console.
  - Prevent by visible sync center + banner count badge.
- **False confidence risk:** converting offline hold to booked UI before server ack.
  - Prevent by immutable `pending` label until confirmation response.
- **Race condition risk:** parallel sync workers processing same item.
  - Prevent by single-flight sync lock (`sync_in_progress` mutex).

---

## Manual checkpoint test (must pass before Step 5)

1. **Offline queue visibility**
   - Disconnect internet.
   - Perform create hold + cancel + reschedule.
   - Verify all three appear in Sync Center as `queued/pending` (not confirmed).

2. **Reconnect sync success**
   - Reconnect internet.
   - Run sync.
   - Verify successful items move to `confirmed` and timeline updates with server versions.

3. **Conflict path**
   - While one device is offline, edit same appointment from another device.
   - Reconnect offline device.
   - Verify `conflict` appears with side-by-side resolution options.

4. **Failure recovery under 60 seconds**
   - Force one server error for a queue item.
   - Verify user can retry from Sync Center and resolve or escalate in under 60 seconds.

5. **No deceptive confirmation**
   - During offline mode, verify no label/button/text implies booking is confirmed.

Only proceed once all five checks pass.

---

### Step 5: Undo & Audit Logic

> Skill note: no listed skill applies to this task, so I’m proceeding with a direct reliability-first undo/audit design.

#### Purpose
Undo protects against human mistakes under real-world pressure (wrong time, wrong client, accidental cancel). Audit logic protects trust by making every change explainable.

#### Why this is necessary
A simple “edit history in place” approach can hide what happened and create unrecoverable states. In a mission-critical booking system, undo must be implemented as **new compensating events** so history remains complete and verifiable.

---

## Core design rules

1. Never rewrite or delete prior events.
2. Undo always appends a new event (`undo_applied`, `uncancelled`, `restored`).
3. Every undo references the exact event it compensates (`undone_event_id`).
4. Undo itself must be undoable (reversible chain).
5. Timeline state is derived from ordered events + current snapshot.

---

## Event schema additions for undo traceability

Use append-only `appointment_events` with explicit linkage:

```ts
type AppointmentEvent = {
  id: string;
  appointmentId: string;
  eventType:
    | "created"
    | "rescheduled"
    | "cancelled"
    | "uncancelled"
    | "notes_updated"
    | "undo_applied";

  payload: Record<string, unknown>; // before/after snapshots
  actorType: "owner" | "system";
  actorId?: string;
  reason?: string;

  undoneEventId?: string;    // event this one compensates
  supersededByEventId?: string; // optional back-link for quick lookup

  createdAt: string;
};
```

### Safety reasoning
- `undoneEventId` makes intent explicit and auditable.
- `supersededByEventId` helps UI render “this action was undone” fast.
- `payload` keeps before/after values for deterministic restoration.

---

## Undo API contract (compensating event pattern)

Endpoint:
- `POST /v1/appointments/:id/undo`

Request body:

```json
{
  "undo_event_id": "evt_123",
  "expected_version": 8,
  "reason": "Accidental cancel"
}
```

Server transaction (single ACID unit):

1. Validate target event exists for appointment.
2. Validate target event is undoable and not already compensated.
3. Validate `expected_version` matches appointment current version.
4. Apply compensating state change to `appointments`.
5. Insert new `appointment_events` row with:
   - `event_type = "undo_applied"` (or typed variant like `uncancelled`)
   - `undone_event_id = target event id`
   - `payload.before` and `payload.after`
6. Optionally mark target event `superseded_by_event_id = new event id`.
7. Increment appointment version and commit.

If any step fails, rollback everything.

---

## One-tap undo UX tied to history

### UI behavior
Each recent user action gets an `Undo` button for a short window (e.g., 30–120 seconds), but full history remains accessible in the event timeline.

Card behavior:
- On action success, show toast: `Appointment moved to 11:30. Undo`
- Tap Undo → send `/undo` with target `event_id` and current `version`
- While request pending: badge `Undo pending...`
- On success: badge `Undo confirmed` + timeline row “Undid reschedule from 11:30 to 11:00”
- On conflict/failure: badge `Undo failed - review`

Example frontend call:

```ts
async function undoEvent(input: {
  appointmentId: string;
  targetEventId: string;
  expectedVersion: number;
}) {
  const idempotencyKey = crypto.randomUUID();

  const res = await fetch(`/v1/appointments/${input.appointmentId}/undo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      undo_event_id: input.targetEventId,
      expected_version: input.expectedVersion,
      reason: "One-tap undo",
    }),
  });

  const body = await res.json();

  if (res.ok) {
    applyServerSnapshot(body.data);
    return;
  }

  showUndoFailure(body?.error?.code ?? "UNDO_FAILED");
}
```

---

## Edge case handling

### 1) Multiple undos on same target
Risk: duplicate compensations.

Rule:
- First successful undo wins.
- Later undo attempts for same `undone_event_id` return `409 ALREADY_UNDONE`.
- UI shows: `Already undone on another device.`

### 2) Undo conflict due to newer edits
Risk: stale undo reverts over fresh data.

Rule:
- Require `expected_version`.
- On mismatch return `409 VERSION_CONFLICT`.
- UI offers: `Refresh history` then optionally `Undo latest compatible event`.

### 3) Partial history on client
Risk: local cache missing events leads to wrong undo target.

Rule:
- Undo validation occurs server-side against authoritative event log.
- If missing target locally, fetch `/appointments/:id/events` before retry.

### 4) Undoing an undo
Risk: unclear chain state.

Rule:
- Allowed via new compensating event referencing prior undo event.
- Event chain remains linear and inspectable.

### 5) Offline undo attempt
Risk: user thinks undo is immediate.

Rule:
- Queue as pending intent only.
- Label clearly: `Undo queued (not yet confirmed)`.
- Confirm only after server acknowledgment.

---

## Audit timeline UX (non-technical clarity)

For each event row, show:
- timestamp
- human-readable action
- actor (`You` or `System`)
- before → after summary
- linkage label (`Undid event at 10:42`)

Example timeline rows:

```txt
10:42 You cancelled appointment
10:43 You undid cancellation (restored booked)
11:10 You rescheduled 11:00 -> 11:30
11:11 You undid reschedule 11:30 -> 11:00
```

This gives immediate trust and fast dispute resolution.

---

## Failure visibility and recovery (<60 seconds)

If undo fails, user must see exactly what to do:

- `ALREADY_UNDONE` → show success-equivalent state (`Already restored`)
- `VERSION_CONFLICT` → one tap `Refresh + retry`
- `UNDO_NOT_ALLOWED` → one tap `Open history` with highlighted reason
- network failure → queue with `pending` badge and `Retry now` action

No hidden retries without visible state.

---

## Manual checkpoint test (must pass before Step 6)

1. **Basic undo**
   - Reschedule appointment.
   - Tap one-tap undo.
   - Verify appointment returns to previous time and a compensating event is appended.

2. **Audit traceability**
   - Open history.
   - Verify original event and undo event are both present and linked.

3. **Duplicate undo protection**
   - Trigger two undos for same event (two tabs/devices).
   - Verify one succeeds and one returns `ALREADY_UNDONE` visibly.

4. **Conflict safety**
   - Change appointment on device A.
   - Attempt stale undo from device B.
   - Verify `VERSION_CONFLICT` and no silent overwrite.

5. **Offline honesty**
   - Perform undo while offline.
   - Verify label says queued/pending (not confirmed), then confirms only after reconnect sync.

Only proceed once all five checks pass.

---

### Step 6: Failure & Recovery Handling

> Skill note: no listed skill applies to this task, so I’m proceeding with a direct reliability-first failure/recovery design.

#### Purpose
This phase ensures the system **never lies** when something breaks. A mission-critical booking product must surface failure immediately, classify it correctly, and guide a non-technical user to a safe recovery path fast.

#### Why this is necessary
Most catastrophic booking incidents are not caused by a single outage—they are caused by hidden failure:

- backend writes failing silently,
- frontend showing stale success state,
- sync queues stuck without visibility.

Failure handling is what prevents "appointment disappeared" events and restores trust under pressure.

---

## System-wide failure model

Classify every failure with three properties:

1. **Layer:** `backend` | `frontend` | `sync`
2. **Severity:** `degraded` | `unsafe`
3. **Actionability:** `retryable` | `needs_review` | `needs_support`

Typed failure object:

```ts
type FailureState = {
  code:
    | "DB_TRANSACTION_FAILED"
    | "VERSION_CONFLICT"
    | "NETWORK_UNAVAILABLE"
    | "SYNC_QUEUE_STALLED"
    | "AUTH_EXPIRED"
    | "DEPENDENCY_DEGRADED"
    | "UNSAFE_CLOCK_SKEW";

  layer: "backend" | "frontend" | "sync";
  severity: "degraded" | "unsafe";
  actionable: "retryable" | "needs_review" | "needs_support";

  message: string;
  userAction: string; // plain-language CTA
  detectedAt: string;
  requestId?: string;
};
```

---

## Explicit failure states by layer

## 1) Backend failure states

### Required behavior
- Every non-2xx mutation returns typed error payload.
- Include `request_id` for support traceability.
- Never return success when event log insert fails.

Error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "DB_TRANSACTION_FAILED",
    "severity": "unsafe",
    "retryable": true,
    "message": "Could not save appointment safely. No changes were committed."
  },
  "request_id": "req_9fa2"
}
```

### Unsafe triggers (backend)
- Cannot write appointment + event atomically.
- Event stream corrupted/missing integrity guarantees.
- Auth verification uncertainty (token replay suspicion).

When unsafe, backend should fail closed for writes.

---

## 2) Frontend failure states

### Required behavior
- Surface failure inline on affected appointment + global banner.
- Keep failed item visible until user resolves or intentionally dismisses.
- Never auto-clear failure to reduce UI noise.

UI labels:
- `Pending sync (not booked)`
- `Failed - retry required`
- `Conflict - review now`
- `System unsafe - writes locked`

### Frontend anti-deception rules
- No optimistic “confirmed” badge until server ack.
- No hidden retries that change state without user-visible status.
- No generic “Something went wrong” without next step.

---

## 3) Sync failure states

### Required behavior
- Sync worker updates queue item status (`syncing|confirmed|failed|conflict`).
- Detect stalled queue (e.g., oldest failed item > N minutes).
- Trigger banner + Sync Center alert with one-tap recovery action.

Stall detector example:

```ts
function detectSyncQueueStall(items: QueueItem[], now: number): FailureState | null {
  const stalled = items.find(
    (i) => (i.status === "failed" || i.status === "syncing") &&
      now - Date.parse(i.createdAt) > 5 * 60 * 1000,
  );

  if (!stalled) return null;

  return {
    code: "SYNC_QUEUE_STALLED",
    layer: "sync",
    severity: "degraded",
    actionable: "retryable",
    message: "Some pending changes are not synced yet.",
    userAction: "Open Sync Center and tap Retry all.",
    detectedAt: new Date(now).toISOString(),
  };
}
```

---

## Degraded vs Unsafe operating modes

System mode must be globally visible (banner + status endpoint):

1. **Online (safe)**
   - Reads/writes normal.
2. **Degraded (caution)**
   - Reads available, writes allowed with warnings.
   - Example: SMS provider down but DB healthy.
3. **Unsafe (write-locked)**
   - Reads allowed, non-critical writes blocked.
   - Example: DB transaction integrity uncertain.

Mode contract:
- `degraded` => "Proceed with caution" UX.
- `unsafe` => disable booking mutations, allow only review/recovery actions.

Status payload example:

```json
{
  "status": "unsafe",
  "checks": {
    "database": "degraded",
    "event_log": "failed",
    "queue_processor": "degraded"
  },
  "user_message": "System is in safe-read mode. New bookings are temporarily locked.",
  "updated_at": "2026-02-14T10:55:00Z"
}
```

---

## 60-second recovery flows (non-technical)

Provide a **Recovery Center** with only plain-language actions:

1. **Retry failed changes**
   - Button: `Retry all pending changes`
2. **Resolve conflicts**
   - Button: `Review conflicts now`
3. **Switch to safe-read mode guidance**
   - Message: `Bookings are temporarily locked to protect data.`
4. **Escalate with context**
   - Button: `Copy support report`
   - Includes request IDs + pending queue summary.

Support report example:

```txt
System Mode: UNSAFE
Time: 10:57
Pending Items: 2
- evt_local_18 reschedule (failed DB_TRANSACTION_FAILED) request req_9fa2
- evt_local_19 cancel (conflict VERSION_CONFLICT)
Action Taken: Retry all at 10:58 (failed)
```

Goal: any user can either recover or escalate in <60 seconds.

---

## Failure-to-action mapping table

| Failure code | Visible message | One-tap action | Expected result |
|---|---|---|---|
| `NETWORK_UNAVAILABLE` | "You are offline. Changes are pending." | Retry when online | Queue resumes |
| `VERSION_CONFLICT` | "Changed on another device." | Review conflict | Choose server vs local |
| `DB_TRANSACTION_FAILED` | "Could not save safely." | Retry change | Safe reattempt, no partial write |
| `SYNC_QUEUE_STALLED` | "Sync is delayed." | Retry all | Queue progresses or escalates |
| `AUTH_EXPIRED` | "Session expired." | Send magic link | Re-auth then continue |
| `UNSAFE_CLOCK_SKEW` | "Device time mismatch detected." | Open fix instructions | Restore safe validation |

---

## Guardrails to prevent false confidence

- If status is `unsafe`, disable create/reschedule/cancel/undo buttons.
- If queue item is unresolved, timeline card must show pending/failed marker.
- If backend health unknown, banner must show `degraded` at minimum.
- If recovery action fails, show next best action (support copy report), never silent dead-end.

---

## Final manual checkpoint test (must pass before MVP sign-off)

1. **Backend typed failure visibility**
   - Force DB transaction failure.
   - Verify API returns typed error with `request_id` and frontend shows actionable message.

2. **Frontend state honesty**
   - Trigger mutation timeout.
   - Verify card stays pending/failed, never confirmed without server ack.

3. **Sync stall detection**
   - Simulate stalled queue item >5 minutes.
   - Verify `SYNC_QUEUE_STALLED` banner + Sync Center retry action.

4. **Unsafe mode lock**
   - Force system status `unsafe`.
   - Verify writes are locked, read/recovery actions still available.

5. **Recovery under 60 seconds**
   - From failure state, run non-technical recovery path:
     `Open Recovery Center -> Retry all -> Resolve conflict OR Copy support report`.
   - Verify completion/escalation can be done in under 60 seconds.

6. **No invisible failures**
   - Check that every induced failure appears in at least one user-visible location (banner, card state, sync center, or recovery center).

Only proceed once all six checks pass.

---

## Running the MVP locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

What is implemented now:
- SQLite-backed backend (`booking.db`) as source of truth.
- Transactional create/reschedule/cancel/undo endpoints with event logging.
- Idempotency key handling for mutation routes.
- Today-first UI with system banner, create flow, cancel action.
- Offline create fallback to local pending holds labeled "not booked".
