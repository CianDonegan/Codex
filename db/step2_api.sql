-- Step 2 API RPC layer for Supabase
-- Requires db/step1_schema.sql applied.

begin;

create or replace function public.api_error(code text, message text, retryable boolean default false)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object(
      'code', code,
      'message', message,
      'retryable', retryable
    )
  );
$$;

create or replace function public.api_idempotency_replay_or_conflict(
  p_idempotency_key text,
  p_route_key text,
  p_payload_hash text
) returns jsonb
language plpgsql
as $$
declare
  v_existing record;
begin
  select * into v_existing
  from public.idempotency_keys
  where idempotency_key = p_idempotency_key
    and route_key = p_route_key;

  if not found then
    return null;
  end if;

  if v_existing.payload_hash <> p_payload_hash then
    return public.api_error('IDEMPOTENCY_KEY_REUSED', 'Idempotency key already used with different payload.', false);
  end if;

  return v_existing.response_json;
end;
$$;

create or replace function public.api_store_idempotency(
  p_idempotency_key text,
  p_route_key text,
  p_payload_hash text,
  p_response_json jsonb
) returns void
language plpgsql
as $$
begin
  insert into public.idempotency_keys(
    idempotency_key,
    route_key,
    payload_hash,
    response_json,
    expires_at,
    consumed_at,
    created_at
  ) values (
    p_idempotency_key,
    p_route_key,
    p_payload_hash,
    p_response_json,
    now() + interval '7 days',
    now(),
    now()
  )
  on conflict (idempotency_key) do nothing;
end;
$$;

create or replace function public.api_create_appointment(
  p_idempotency_key text,
  p_client_name text,
  p_client_phone text,
  p_service_name text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_notes text,
  p_force_fail boolean default false
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_payload_hash text;
  v_replay jsonb;
  v_row public.appointments;
  v_response jsonb;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    return public.api_error('VALIDATION_ERROR', 'Missing Idempotency-Key header.', false);
  end if;

  if p_ends_at <= p_starts_at then
    return public.api_error('VALIDATION_ERROR', 'ends_at must be greater than starts_at.', false);
  end if;

  v_payload_hash := encode(digest(concat_ws('|', p_client_name, coalesce(p_client_phone,''), p_service_name, p_starts_at::text, p_ends_at::text, coalesce(p_notes,'')), 'sha256'), 'hex');
  v_replay := public.api_idempotency_replay_or_conflict(p_idempotency_key, 'POST:/v1/appointments', v_payload_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  insert into public.appointments (
    id, client_name, client_phone, service_name, starts_at, ends_at, status, notes, created_at, updated_at, deleted_at, version
  ) values (
    gen_random_uuid(), p_client_name, p_client_phone, p_service_name, p_starts_at, p_ends_at, 'booked', p_notes, now(), now(), null, 1
  )
  returning * into v_row;

  if p_force_fail then
    raise exception 'forced_failure_for_checkpoint';
  end if;

  v_response := jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
  perform public.api_store_idempotency(p_idempotency_key, 'POST:/v1/appointments', v_payload_hash, v_response);
  return v_response;

exception when others then
  return public.api_error('DB_TRANSACTION_FAILED', 'Could not save appointment safely. No changes were committed.', true);
end;
$$;

create or replace function public.api_reschedule_appointment(
  p_appointment_id uuid,
  p_expected_version integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_reason text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_payload_hash text;
  v_replay jsonb;
  v_row public.appointments;
begin
  if p_ends_at <= p_starts_at then
    return public.api_error('VALIDATION_ERROR', 'ends_at must be greater than starts_at.', false);
  end if;

  v_payload_hash := encode(digest(concat_ws('|', p_appointment_id::text, p_expected_version::text, p_starts_at::text, p_ends_at::text, coalesce(p_reason,'')), 'sha256'), 'hex');
  v_replay := public.api_idempotency_replay_or_conflict(p_idempotency_key, 'POST:/v1/appointments/:id/reschedule', v_payload_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  update public.appointments
  set starts_at = p_starts_at,
      ends_at = p_ends_at,
      notes = coalesce(notes, '')
  where id = p_appointment_id
    and version = p_expected_version
    and deleted_at is null
  returning * into v_row;

  if not found then
    return public.api_error('VERSION_CONFLICT', 'Appointment changed on another device. Refresh and retry.', true);
  end if;

  perform public.api_store_idempotency(
    p_idempotency_key,
    'POST:/v1/appointments/:id/reschedule',
    v_payload_hash,
    jsonb_build_object('ok', true, 'data', to_jsonb(v_row))
  );

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
exception when others then
  return public.api_error('DB_TRANSACTION_FAILED', 'Could not reschedule safely. No changes were committed.', true);
end;
$$;

create or replace function public.api_cancel_appointment(
  p_appointment_id uuid,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_payload_hash text;
  v_replay jsonb;
  v_row public.appointments;
begin
  v_payload_hash := encode(digest(concat_ws('|', p_appointment_id::text, p_expected_version::text, coalesce(p_reason,'')), 'sha256'), 'hex');
  v_replay := public.api_idempotency_replay_or_conflict(p_idempotency_key, 'POST:/v1/appointments/:id/cancel', v_payload_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  update public.appointments
  set status = 'cancelled'
  where id = p_appointment_id
    and version = p_expected_version
    and deleted_at is null
  returning * into v_row;

  if not found then
    return public.api_error('VERSION_CONFLICT', 'Appointment changed on another device. Refresh and retry.', true);
  end if;

  perform public.api_store_idempotency(
    p_idempotency_key,
    'POST:/v1/appointments/:id/cancel',
    v_payload_hash,
    jsonb_build_object('ok', true, 'data', to_jsonb(v_row))
  );

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
exception when others then
  return public.api_error('DB_TRANSACTION_FAILED', 'Could not cancel safely. No changes were committed.', true);
end;
$$;

create or replace function public.api_undo_appointment(
  p_appointment_id uuid,
  p_undo_event_id uuid,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_event record;
  v_payload_hash text;
  v_replay jsonb;
  v_row public.appointments;
begin
  v_payload_hash := encode(digest(concat_ws('|', p_appointment_id::text, p_undo_event_id::text, p_expected_version::text, coalesce(p_reason,'')), 'sha256'), 'hex');
  v_replay := public.api_idempotency_replay_or_conflict(p_idempotency_key, 'POST:/v1/appointments/:id/undo', v_payload_hash);
  if v_replay is not null then
    return v_replay;
  end if;

  select * into v_event
  from public.appointment_events
  where id = p_undo_event_id
    and appointment_id = p_appointment_id;

  if not found then
    return public.api_error('VALIDATION_ERROR', 'Undo target event not found for appointment.', false);
  end if;

  if v_event.event_type = 'cancelled' then
    update public.appointments
    set status = 'booked'
    where id = p_appointment_id
      and version = p_expected_version
      and deleted_at is null
    returning * into v_row;
  else
    update public.appointments
    set starts_at = coalesce((v_event.payload->'before'->>'starts_at')::timestamptz, starts_at),
        ends_at = coalesce((v_event.payload->'before'->>'ends_at')::timestamptz, ends_at)
    where id = p_appointment_id
      and version = p_expected_version
      and deleted_at is null
    returning * into v_row;
  end if;

  if not found then
    return public.api_error('VERSION_CONFLICT', 'Appointment changed on another device. Refresh and retry.', true);
  end if;

  perform public.api_store_idempotency(
    p_idempotency_key,
    'POST:/v1/appointments/:id/undo',
    v_payload_hash,
    jsonb_build_object('ok', true, 'data', to_jsonb(v_row))
  );

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
exception when others then
  return public.api_error('DB_TRANSACTION_FAILED', 'Could not undo safely. No changes were committed.', true);
end;
$$;

create or replace function public.api_sync_offline_holds(
  p_holds jsonb
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_hold jsonb;
  v_appt public.appointments;
  v_confirmed jsonb := '[]'::jsonb;
  v_conflict jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
begin
  for v_hold in select * from jsonb_array_elements(coalesce(p_holds, '[]'::jsonb))
  loop
    begin
      insert into public.offline_holds(id, local_device_id, proposed_start, proposed_end, client_name, service_name, expires_at, synced)
      values (
        (v_hold->>'id')::uuid,
        v_hold->>'local_device_id',
        (v_hold->>'proposed_start')::timestamptz,
        (v_hold->>'proposed_end')::timestamptz,
        v_hold->>'client_name',
        v_hold->>'service_name',
        (v_hold->>'expires_at')::timestamptz,
        false
      )
      on conflict (id) do nothing;

      insert into public.appointments(
        id, client_name, client_phone, service_name, starts_at, ends_at, status, notes, created_at, updated_at, deleted_at, version
      ) values (
        gen_random_uuid(),
        coalesce(v_hold->>'client_name', 'Offline Hold'),
        null,
        coalesce(v_hold->>'service_name', 'TBD'),
        (v_hold->>'proposed_start')::timestamptz,
        (v_hold->>'proposed_end')::timestamptz,
        'booked',
        'Created from offline hold sync',
        now(),
        now(),
        null,
        1
      ) returning * into v_appt;

      update public.offline_holds set synced = true where id = (v_hold->>'id')::uuid;
      v_confirmed := v_confirmed || jsonb_build_array(jsonb_build_object('hold_id', v_hold->>'id', 'appointment_id', v_appt.id));
    exception when others then
      v_failed := v_failed || jsonb_build_array(jsonb_build_object('hold_id', v_hold->>'id', 'code', 'OFFLINE_HOLD_CONFLICT', 'message', 'Could not confirm hold'));
    end;
  end loop;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object('confirmed', v_confirmed, 'conflict', v_conflict, 'failed', v_failed));
end;
$$;

commit;
