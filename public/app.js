const state = { admin: null, attendees: [], authMode: 'login', editingId: null, checkinToken: null };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 3200);
}

function formatDate(value, includeDate = false) {
  if (!value) return 'Not arrived';
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, includeDate
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { hour: 'numeric', minute: '2-digit' }).format(date);
}

function showAuth() {
  $('#auth-screen').hidden = false;
  $('#dashboard-screen').hidden = true;
  $('#checkin-screen').hidden = true;
}

function showDashboard() {
  $('#auth-screen').hidden = true;
  $('#dashboard-screen').hidden = false;
  $('#checkin-screen').hidden = true;
}

function showCheckin() {
  $('#auth-screen').hidden = true;
  $('#dashboard-screen').hidden = true;
  $('#checkin-screen').hidden = false;
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';
  $$('.auth-tab').forEach((tab) => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $$('.register-only').forEach((field) => {
    field.hidden = !isRegister;
    const input = field.querySelector('input');
    if (!input) return;
    input.disabled = !isRegister;
    input.required = isRegister && ['name', 'confirmPassword'].includes(input.name);
  });
  $('#auth-title').textContent = isRegister ? 'Create your workspace' : 'Welcome back';
  $('#auth-subtitle').textContent = isRegister ? 'Start your event guest list in a few steps.' : 'Sign in to open your event workspace.';
  $('#auth-eyebrow').textContent = isRegister ? 'YOUR EVENT, IN GOOD HANDS' : 'YOUR EVENT, IN GOOD HANDS';
  $('#auth-submit').innerHTML = isRegister ? 'Create account <span aria-hidden="true">→</span>' : 'Sign in <span aria-hidden="true">→</span>';
  const password = $('#auth-form [name="password"]');
  password.autocomplete = isRegister ? 'new-password' : 'current-password';
  password.placeholder = isRegister ? 'Choose at least 10 characters' : 'At least 10 characters';
  $('#auth-error').textContent = '';
}

function setEventName(name) {
  $('#sidebar-event-name').textContent = name;
  $('#topbar-event-name').textContent = name;
  $('#list-event-name').textContent = name;
  $('#qr-event-name').textContent = name;
  $('#qr-sheet-event').textContent = name;
  document.title = `${name} | Agile in Africa`;
}

function openView(view) {
  $$('.view-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `view-${view}`));
  $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'qr') loadQr();
}

function createStatus(attendedAt) {
  return element('span', `status-pill ${attendedAt ? '' : 'status-pending'}`, attendedAt ? 'Arrived' : 'Expected');
}

function createGuestCell(attendee) {
  const cell = element('td');
  const primary = element('div', 'guest-primary', attendee.name);
  const secondary = attendee.email || attendee.phone;
  if (secondary) primary.append(element('span', '', secondary));
  cell.append(primary);
  return cell;
}

function renderDashboard() {
  const attendees = state.attendees;
  const arrived = attendees.filter((attendee) => attendee.attended_at);
  const percent = attendees.length ? Math.round((arrived.length / attendees.length) * 100) : 0;
  $('#registered-count').textContent = attendees.length;
  $('#attended-count').textContent = arrived.length;
  $('#attendance-rate').innerHTML = `${percent}<span class="metric-percent">%</span>`;
  $('#list-count').textContent = attendees.length;

  const recentBody = $('#recent-table-body');
  recentBody.replaceChildren();
  $('#recent-empty').hidden = arrived.length > 0;
  $('#recent-table-body').closest('.table-wrap').querySelector('table').hidden = arrived.length === 0;
  arrived.slice().sort((a, b) => new Date(b.attended_at) - new Date(a.attended_at)).slice(0, 6).forEach((attendee) => {
    const row = document.createElement('tr');
    row.append(createGuestCell(attendee));
    row.append(element('td', '', attendee.company || '—'));
    row.append(element('td', '', attendee.profession || '—'));
    row.append(element('td', '', formatDate(attendee.attended_at, true)));
    const status = document.createElement('td');
    status.append(createStatus(attendee.attended_at));
    row.append(status);
    recentBody.append(row);
  });
  renderGuestList();
}

function renderGuestList() {
  const query = $('#guest-search').value.trim().toLowerCase();
  const filter = $('#attendance-filter').value;
  const matching = state.attendees.filter((attendee) => {
    const searchable = [attendee.name, attendee.email, attendee.phone, attendee.company, attendee.profession].join(' ').toLowerCase();
    const matchesQuery = !query || searchable.includes(query);
    const matchesFilter = filter === 'all' || (filter === 'attended' ? Boolean(attendee.attended_at) : !attendee.attended_at);
    return matchesQuery && matchesFilter;
  });
  const body = $('#guest-table-body');
  body.replaceChildren();
  matching.forEach((attendee) => {
    const row = document.createElement('tr');
    row.append(createGuestCell(attendee));
    row.append(element('td', '', [attendee.email, attendee.phone].filter(Boolean).join(' · ') || '—'));
    row.append(element('td', '', attendee.company || '—'));
    row.append(element('td', '', attendee.profession || '—'));
    const arrival = document.createElement('td');
    arrival.append(attendee.attended_at ? element('span', 'status-pill', formatDate(attendee.attended_at, true)) : createStatus(null));
    row.append(arrival);
    const actions = element('td');
    const actionWrap = element('div', 'row-actions');
    const edit = element('button', 'small-action', 'Edit');
    edit.type = 'button';
    edit.dataset.action = 'edit';
    edit.dataset.id = attendee.id;
    const remove = element('button', 'small-action danger', 'Remove');
    remove.type = 'button';
    remove.dataset.action = 'delete';
    remove.dataset.id = attendee.id;
    actionWrap.append(edit, remove);
    actions.append(actionWrap);
    row.append(actions);
    body.append(row);
  });
  const hasGuests = state.attendees.length > 0;
  $('#guest-empty').hidden = hasGuests;
  $('#search-empty').hidden = !hasGuests || matching.length > 0;
  $('#guest-table-body').closest('.table-wrap').querySelector('table').hidden = matching.length === 0;
}

async function refreshDashboard() {
  const [session, dashboard] = await Promise.all([api('/api/auth/session'), api('/api/dashboard')]);
  state.admin = session.admin;
  if (!state.admin) return showAuth();
  state.attendees = dashboard.attendees;
  $('#admin-name').textContent = state.admin.name;
  $('#admin-email').textContent = state.admin.email;
  $('#admin-avatar').textContent = state.admin.name.trim().charAt(0).toUpperCase() || 'A';
  $('#greeting-name').textContent = state.admin.name.split(/\s+/)[0];
  setEventName(state.admin.eventName);
  renderDashboard();
}

function openAttendeeDialog(attendee = null) {
  state.editingId = attendee?.id || null;
  const form = $('#attendee-form');
  form.reset();
  $('#attendee-error').textContent = '';
  $('#modal-title').textContent = attendee ? 'Edit guest' : 'New guest';
  $('#modal-eyebrow').textContent = attendee ? 'UPDATE YOUR GUEST LIST' : 'ADD TO YOUR GUEST LIST';
  $('#save-attendee-button').innerHTML = attendee ? 'Save changes <span aria-hidden="true">→</span>' : 'Save guest <span aria-hidden="true">→</span>';
  if (attendee) Object.entries(attendee).forEach(([key, value]) => { if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value || ''; });
  $('#attendee-dialog').showModal();
}

async function loadQr() {
  try {
    const data = await api('/api/qr');
    $('#qr-image').src = data.image;
    $('#qr-url').href = data.url;
    $('#qr-url').textContent = data.url;
  } catch (error) {
    toast(error.message, true);
  }
}

function attendeeDetails(attendee) {
  const details = element('dl', 'match-details');
  const rows = [
    ['Phone', attendee.phone], ['Email', attendee.email], ['Company', attendee.company],
    ['Profession', attendee.profession], ['Other details', attendee.notes]
  ].filter(([, value]) => value);
  rows.forEach(([label, value]) => {
    const item = document.createElement('div');
    item.append(element('dt', '', label), element('dd', '', value));
    details.append(item);
  });
  if (!rows.length) details.append(element('div', '', 'No additional details on this registration.'));
  return details;
}

function renderMatches(attendees) {
  const list = $('#match-list');
  list.replaceChildren();
  attendees.forEach((attendee) => {
    const card = element('article', 'match-card');
    card.append(element('h2', '', attendee.name), attendeeDetails(attendee));
    if (attendee.attended_at) {
      const status = element('p', 'checked-banner', `Check-in successful · ${formatDate(attendee.attended_at, true)}`);
      status.setAttribute('role', 'status');
      card.append(status);
    } else {
      const button = element('button', 'button button-primary button-wide', 'Check in');
      button.type = 'button';
      button.dataset.attendId = attendee.id;
      card.append(button);
    }
    list.append(card);
  });
}

async function initialize() {
  const route = window.location.pathname.match(/^\/checkin\/([0-9a-f-]+)$/i);
  if (route) {
    state.checkinToken = route[1];
    showCheckin();
    try {
      const data = await api(`/api/public/${state.checkinToken}`);
      $('#checkin-title').textContent = `Welcome to ${data.eventName}.`;
      document.title = `${data.eventName} · Agile in Africa`;
    } catch (error) {
      $('#checkin-title').textContent = 'Check-in unavailable.';
      $('#find-form').hidden = true;
      $('#find-error').textContent = error.message;
    }
    return;
  }
  try {
    const data = await api('/api/auth/session');
    if (!data.admin) return showAuth();
    await refreshDashboard();
    showDashboard();
  } catch (error) {
    showAuth();
    toast(error.message, true);
  }
}

$$('.auth-tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode)));

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());
  if (state.authMode === 'register' && payload.password !== payload.confirmPassword) {
    $('#auth-error').textContent = 'Passwords do not match.';
    $('#auth-form [name="confirmPassword"]').focus();
    return;
  }
  delete payload.confirmPassword;
  const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
  $('#auth-submit').disabled = true;
  $('#auth-error').textContent = '';
  try {
    await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    await refreshDashboard();
    showDashboard();
  } catch (error) {
    $('#auth-error').textContent = error.message;
  } finally {
    $('#auth-submit').disabled = false;
  }
});

$$('.nav-link').forEach((button) => button.addEventListener('click', () => openView(button.dataset.view)));
$$('[data-open-view]').forEach((button) => button.addEventListener('click', () => openView(button.dataset.openView)));
$('#add-attendee-top').addEventListener('click', () => openAttendeeDialog());
$('#add-attendee-list').addEventListener('click', () => openAttendeeDialog());
$('#guest-search').addEventListener('input', renderGuestList);
$('#attendance-filter').addEventListener('change', renderGuestList);

$('#guest-table-body').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const attendee = state.attendees.find((item) => item.id === button.dataset.id);
  if (!attendee) return;
  if (button.dataset.action === 'edit') return openAttendeeDialog(attendee);
  if (!window.confirm(`Remove ${attendee.name} from this guest list?`)) return;
  try {
    await api(`/api/attendees/${attendee.id}`, { method: 'DELETE' });
    state.attendees = state.attendees.filter((item) => item.id !== attendee.id);
    renderDashboard();
    toast('Guest removed from your list.');
  } catch (error) {
    toast(error.message, true);
  }
});

$('#attendee-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const button = $('#save-attendee-button');
  button.disabled = true;
  $('#attendee-error').textContent = '';
  try {
    const editing = Boolean(state.editingId);
    const result = await api(editing ? `/api/attendees/${state.editingId}` : '/api/attendees', {
      method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload)
    });
    if (editing) state.attendees = state.attendees.map((item) => item.id === state.editingId ? result.attendee : item);
    else state.attendees.unshift(result.attendee);
    $('#attendee-dialog').close();
    renderDashboard();
    toast(editing ? 'Guest details updated.' : 'Guest added to your list.');
  } catch (error) {
    $('#attendee-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$$('[data-close-modal]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));

$('#edit-event-button').addEventListener('click', () => {
  const form = $('#event-form');
  form.elements.eventName.value = state.admin.eventName;
  $('#event-error').textContent = '';
  $('#event-dialog').showModal();
});

$('#event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const eventName = new FormData(event.currentTarget).get('eventName');
  try {
    const result = await api('/api/event', { method: 'PATCH', body: JSON.stringify({ eventName }) });
    state.admin = result.admin;
    setEventName(state.admin.eventName);
    $('#event-dialog').close();
    toast('Event name updated.');
  } catch (error) {
    $('#event-error').textContent = error.message;
  }
});

$('#signout-button').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    state.admin = null;
    showAuth();
    setAuthMode('login');
  } catch (error) {
    toast(error.message, true);
  }
});

$('#print-qr').addEventListener('click', () => window.print());
$('#copy-qr-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#qr-url').href);
    toast('Check-in link copied.');
  } catch {
    toast('Could not copy the link. Select and copy the URL instead.', true);
  }
});

$('#find-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#find-error').textContent = '';
  $('#register-prompt').hidden = true;
  $('#match-list').replaceChildren();
  const button = $('#find-button');
  button.disabled = true;
  try {
    const result = await api(`/api/public/${state.checkinToken}/find`, {
      method: 'POST', body: JSON.stringify({ name: $('#find-name').value })
    });
    renderMatches(result.attendees);
  } catch (error) {
    $('#find-error').textContent = error.message;
    $('#register-prompt').hidden = error.status !== 404;
  } finally {
    button.disabled = false;
  }
});

$('#show-register-button').addEventListener('click', () => {
  $('#public-register-error').textContent = '';
  $('#public-register-form').reset();
  $('#public-register-form [name="name"]').value = $('#find-name').value.trim();
  $('#register-success').hidden = true;
  $('#find-form').hidden = true;
  $('#register-prompt').hidden = true;
  $('#public-register-panel').hidden = false;
  $('#public-register-form [name="email"]').focus();
});

$('#cancel-public-register').addEventListener('click', () => {
  $('#public-register-panel').hidden = true;
  $('#find-form').hidden = false;
  $('#find-name').focus();
});

$('#public-register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#submit-public-register');
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  button.disabled = true;
  $('#public-register-error').textContent = '';
  try {
    const result = await api(`/api/public/${state.checkinToken}/register`, {
      method: 'POST', body: JSON.stringify(payload)
    });
    $('#public-register-panel').hidden = true;
    $('#find-form').hidden = false;
    $('#find-name').value = result.attendee.name;
    $('#register-success').hidden = false;
    $('#find-name').focus();
  } catch (error) {
    $('#public-register-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#match-list').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-attend-id]');
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api(`/api/public/${state.checkinToken}/attend`, {
      method: 'POST', body: JSON.stringify({ attendeeId: button.dataset.attendId })
    });
    const cards = [...$('#match-list').children];
    const card = cards.find((item) => item.querySelector('[data-attend-id]')?.dataset.attendId === button.dataset.attendId);
    if (card) renderMatches([result.attendee]);
    toast('Check-in successful. Welcome!');
  } catch (error) {
    button.disabled = false;
    toast(error.message, true);
  }
});

initialize();