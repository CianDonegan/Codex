const statusBanner = document.getElementById('status-banner');
const appointmentsEl = document.getElementById('appointments');
const holdsEl = document.getElementById('holds');
const createForm = document.getElementById('create-form');
const createMessage = document.getElementById('create-message');

function toIso(localVal) {
  return new Date(localVal).toISOString();
}

async function getSystemStatus() {
  const res = await fetch('/v1/health');
  const data = await res.json();
  statusBanner.textContent = `System: ${data.status}`;
  statusBanner.className = `banner ${data.status}`;
  return data.status;
}

function renderAppointments(list) {
  appointmentsEl.innerHTML = '';
  if (!list.length) appointmentsEl.innerHTML = '<li>No appointments today.</li>';

  for (const appt of list) {
    const li = document.createElement('li');
    const badgeClass = appt.status === 'cancelled' ? 'cancelled' : 'confirmed';
    li.innerHTML = `
      <strong>${appt.client_name}</strong> — ${appt.service_name}
      <span class="badge ${badgeClass}">${appt.status}</span>
      <div>${new Date(appt.starts_at).toLocaleTimeString()} - ${new Date(appt.ends_at).toLocaleTimeString()}</div>
      <div>Version: ${appt.version}</div>
      <button data-id="${appt.id}" data-v="${appt.version}" class="cancel-btn">Cancel</button>
    `;
    appointmentsEl.appendChild(li);
  }

  document.querySelectorAll('.cancel-btn').forEach((button) => {
    button.addEventListener('click', () => cancelAppointment(button.dataset.id, Number(button.dataset.v)));
  });
}

async function loadAppointments() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`/v1/appointments?date=${today}`);
  const data = await res.json();
  renderAppointments(data.data || []);
}

function listOfflineHolds() {
  const holds = JSON.parse(localStorage.getItem('offline_holds') || '[]');
  holdsEl.innerHTML = '';
  if (!holds.length) holdsEl.innerHTML = '<li>No pending holds.</li>';
  for (const hold of holds) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="badge pending">Pending sync (not booked)</span> ${hold.client_name} ${new Date(hold.proposed_start).toLocaleTimeString()}`;
    holdsEl.appendChild(li);
  }
}

function queueOfflineHold(payload) {
  const holds = JSON.parse(localStorage.getItem('offline_holds') || '[]');
  holds.push({
    id: crypto.randomUUID(),
    local_device_id: 'browser-device',
    proposed_start: payload.starts_at,
    proposed_end: payload.ends_at,
    client_name: payload.client_name,
    service_name: payload.service_name,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  localStorage.setItem('offline_holds', JSON.stringify(holds));
  createMessage.textContent = 'Saved offline as pending hold (not booked).';
  createMessage.className = 'error';
  listOfflineHolds();
}

async function createAppointment(payload) {
  const res = await fetch('/v1/appointments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) {
    createMessage.textContent = `Failed: ${data.error.code} — ${data.error.message}`;
    createMessage.className = 'error';
    return;
  }

  createMessage.textContent = 'Confirmed and saved.';
  createMessage.className = '';
  await loadAppointments();
}

async function cancelAppointment(id, expectedVersion) {
  const res = await fetch(`/v1/appointments/${id}/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({ expected_version: expectedVersion, reason: 'User cancel' })
  });

  const data = await res.json();
  if (!res.ok) {
    alert(`Cancel failed: ${data.error.code} ${data.error.message}`);
    return;
  }
  await loadAppointments();
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(createForm);
  const payload = {
    client_name: String(formData.get('client_name')),
    service_name: String(formData.get('service_name')),
    starts_at: toIso(String(formData.get('starts_at'))),
    ends_at: toIso(String(formData.get('ends_at')))
  };

  const status = await getSystemStatus();
  if (status === 'unsafe' || !navigator.onLine) {
    queueOfflineHold(payload);
    return;
  }
  await createAppointment(payload);
});

window.addEventListener('online', () => { createMessage.textContent = 'Back online.'; });
window.addEventListener('offline', () => { createMessage.textContent = 'Offline mode: holds only, not booked.'; createMessage.className = 'error'; });

await getSystemStatus();
await loadAppointments();
listOfflineHolds();
