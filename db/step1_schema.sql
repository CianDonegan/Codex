-- Step 1 (Supabase/Postgres): mission-critical booking schema
-- Source-of-truth tables already exist:
--   appointments(id, created_at, updated_at, deleted_at, version)
--   appointment_events (append-only)
--   idempotency_keys (unique keys)

begin;

-- === 1) Appointments: extend canonical snapshot ===
alter table public.appointments
  add column if not exists client_name text,
  add column if not exists client_phone text,
  add column if not exists service_name text,
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists status text,
  add column if not exists notes text;

alter table public.appointments
  alter column starts_at set not null,
  alter column ends_at set not null,
  alter column status set not null,
  alter column version set default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'appointments_status_check'
  ) then
    alter table public.appointments
      add constraint appointments_status_check
      check (status in ('booked', 'cancelled'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'appointments_time_window_check'
  ) then
    alter table public.appointments
      add constraint appointments_time_window_check
      check (ends_at > starts_at);
  end if;
end;
$$;

create index if not exists idx_appointments_starts_at on public.appointments(starts_at);
create index if not exists idx_appointments_status on public.appointments(status);
create index if not exists idx_appointments_deleted_at on public.appointments(deleted_at);

-- === 2) Appointment events: immutable audit/event log ===
alter table public.appointment_events
  add column if not exists appointment_id uuid,
  add column if not exists event_type text,
  add column if not exists actor_type text,
  add column if not exists actor_id text,
  add column if not exists reason text,
  add column if not exists payload jsonb default '{}'::jsonb,
  add column if not exists undone_event_id uuid,
  add column if not exists superseded_by_event_id uuid;

alter table public.appointment_events
  alter column appointment_id set not null,
  alter column event_type set not null,
  alter column actor_type set not null,
  alter column payload set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'appointment_events_actor_type_check'
  ) then
    alter table public.appointment_events
      add constraint appointment_events_actor_type_check
      check (actor_type in ('owner', 'system'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'appointment_events_event_type_check'
  ) then
    alter table public.appointment_events
      add constraint appointment_events_event_type_check
      check (event_type in (
        'created',
        'rescheduled',
        'cancelled',
        'uncancelled',
        'notes_updated',
        'soft_deleted',
        'restored',
        'undo_applied'
      ));
  end if;
end;
$$;

create index if not exists idx_appointment_events_appointment_created
  on public.appointment_events(appointment_id, created_at);

create unique index if not exists idx_appointment_events_dedupe
  on public.appointment_events(appointment_id, created_at, event_type);

-- === 3) Idempotency keys: safe retries, no duplicate effects ===
alter table public.idempotency_keys
  add column if not exists route_key text,
  add column if not exists payload_hash text,
  add column if not exists response_json jsonb,
  add column if not exists expires_at timestamptz,
  add column if not exists consumed_at timestamptz;

alter table public.idempotency_keys
  alter column route_key set not null,
  alter column payload_hash set not null,
  alter column response_json set not null,
  alter column expires_at set not null;

create index if not exists idx_idempotency_keys_expires_at
  on public.idempotency_keys(expires_at);

-- === 4) Offline holds: explicit local intent, never confirmed ===
create table if not exists public.offline_holds (
  id uuid primary key,
  local_device_id text not null,
  proposed_start timestamptz not null,
  proposed_end timestamptz not null,
  client_name text,
  service_name text,
  expires_at timestamptz not null,
  synced boolean not null default false,
  created_at timestamptz not null default now(),
  check (proposed_end > proposed_start)
);

create index if not exists idx_offline_holds_expires_at on public.offline_holds(expires_at);
create index if not exists idx_offline_holds_synced on public.offline_holds(synced);

-- === 5) Magic link audit table (Supabase auth remains issuer) ===
create table if not exists public.magic_link_attempts (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('email', 'sms')),
  destination text not null,
  requested_at timestamptz not null default now(),
  consumed_at timestamptz,
  status text not null check (status in ('sent', 'verified', 'expired', 'failed')),
  request_metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_magic_link_attempts_requested_at on public.magic_link_attempts(requested_at);
create index if not exists idx_magic_link_attempts_status on public.magic_link_attempts(status);

-- === 6) Guardrails and enforcement triggers ===

-- hard-delete prevention on appointments
create or replace function public.prevent_appointment_hard_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Hard deletes are forbidden. Use deleted_at soft delete instead.';
end;
$$;

drop trigger if exists trg_prevent_appointment_delete on public.appointments;
create trigger trg_prevent_appointment_delete
before delete on public.appointments
for each row execute function public.prevent_appointment_hard_delete();

-- append-only protection on appointment_events
create or replace function public.prevent_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'appointment_events is append-only. Update/Delete forbidden.';
end;
$$;

drop trigger if exists trg_prevent_event_update on public.appointment_events;
create trigger trg_prevent_event_update
before update on public.appointment_events
for each row execute function public.prevent_event_mutation();

drop trigger if exists trg_prevent_event_delete on public.appointment_events;
create trigger trg_prevent_event_delete
before delete on public.appointment_events
for each row execute function public.prevent_event_mutation();

-- auto-maintain updated_at and version increment on appointment state change
create or replace function public.bump_appointment_version_and_timestamp()
returns trigger
language plpgsql
as $$
begin
  if row(new.*) is distinct from row(old.*) then
    new.updated_at := now();
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bump_appointment_version on public.appointments;
create trigger trg_bump_appointment_version
before update on public.appointments
for each row execute function public.bump_appointment_version_and_timestamp();

-- auto-audit for all appointment inserts/updates
create or replace function public.audit_appointment_change()
returns trigger
language plpgsql
as $$
declare
  v_event_type text;
  v_payload jsonb;
begin
  if tg_op = 'INSERT' then
    v_event_type := 'created';
    v_payload := jsonb_build_object('after', to_jsonb(new));
  elsif tg_op = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      v_event_type := 'soft_deleted';
    elsif old.status <> 'cancelled' and new.status = 'cancelled' then
      v_event_type := 'cancelled';
    elsif old.status = 'cancelled' and new.status = 'booked' then
      v_event_type := 'uncancelled';
    elsif old.starts_at is distinct from new.starts_at or old.ends_at is distinct from new.ends_at then
      v_event_type := 'rescheduled';
    elsif old.notes is distinct from new.notes then
      v_event_type := 'notes_updated';
    else
      v_event_type := 'restored';
    end if;

    v_payload := jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new));
  end if;

  insert into public.appointment_events (
    id,
    appointment_id,
    event_type,
    actor_type,
    actor_id,
    reason,
    payload,
    created_at
  ) values (
    gen_random_uuid(),
    coalesce(new.id, old.id),
    v_event_type,
    'system',
    null,
    'auto_audit_trigger',
    v_payload,
    now()
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_audit_appointment_insert on public.appointments;
create trigger trg_audit_appointment_insert
after insert on public.appointments
for each row execute function public.audit_appointment_change();

drop trigger if exists trg_audit_appointment_update on public.appointments;
create trigger trg_audit_appointment_update
after update on public.appointments
for each row execute function public.audit_appointment_change();

commit;
