console.log(`Step 2 checkpoint manual runbook:

1) Idempotent create
   - Send POST /v1/appointments twice with same Idempotency-Key.
   - Expect one created response replayed and only one row in DB.

2) Version conflict
   - Send two reschedules with same expected_version.
   - Expect one success and one 409 VERSION_CONFLICT.

3) Transaction integrity
   - Send create with { force_fail: true }.
   - Expect DB_TRANSACTION_FAILED and no appointment created.

4) Undo trace
   - Cancel appointment then call undo with undo_event_id.
   - Expect status restored and event history preserved.

5) Failure visibility
   - Trigger backend write failure (force_fail true).
   - Expect typed error envelope with request_id.
`);
