const state = { admin: null, attendees: [], today: null, selectedDay: null, deskAttendee: null, authMode: 'login', editingId: null, checkinToken: null, lastLookupName: '', dashboardStream: null };
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

// Days are 'YYYY-MM-DD' strings in the event's time zone; noon avoids shifting the date across local midnight.
function formatDay(day, long = false) {
  const label = new Intl.DateTimeFormat(undefined, long
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${day}T12:00:00`));
  return day === state.today ? `Today · ${label}` : label;
}

function checkinOn(attendee, day) {
  return attendee.checkins.find((checkin) => checkin.date === day)?.checkedInAt || null;
}

function checkinDays() {
  const days = new Set([state.today]);
  state.attendees.forEach((attendee) => attendee.checkins.forEach((checkin) => days.add(checkin.date)));
  return [...days].sort().reverse();
}

function showAuth() {
  state.dashboardStream?.close();
  state.dashboardStream = null;
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
  if (view === 'desk') $('#desk-code').focus();
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

function renderDayOptions(days) {
  const select = $('#day-select');
  select.replaceChildren(...days.map((day) => {
    const option = element('option', '', formatDay(day));
    option.value = day;
    return option;
  }));
  select.value = state.selectedDay;
  $$('.selected-day-label').forEach((node) => { node.textContent = state.selectedDay === state.today ? 'today' : formatDay(state.selectedDay); });
}

function renderDailyBreakdown(days) {
  const body = $('#daily-table-body');
  body.replaceChildren();
  const registered = state.attendees.length;
  days.forEach((day) => {
    const count = state.attendees.filter((attendee) => checkinOn(attendee, day)).length;
    const row = document.createElement('tr');
    row.classList.toggle('selected-row', day === state.selectedDay);
    row.append(element('td', '', formatDay(day, true)));
    row.append(element('td', '', String(count)));
    row.append(element('td', '', `${registered ? Math.round((count / registered) * 100) : 0}%`));
    const actions = element('td');
    const view = element('button', 'small-action', day === state.selectedDay ? 'Viewing' : 'View');
    view.type = 'button';
    view.dataset.day = day;
    view.disabled = day === state.selectedDay;
    actions.append(view);
    row.append(actions);
    body.append(row);
  });
}

function renderDashboard() {
  const attendees = state.attendees;
  const days = checkinDays();
  if (!days.includes(state.selectedDay)) state.selectedDay = state.today;
  renderDayOptions(days);
  renderDailyBreakdown(days);
  const day = state.selectedDay;
  const arrived = attendees.filter((attendee) => checkinOn(attendee, day));
  const percent = attendees.length ? Math.round((arrived.length / attendees.length) * 100) : 0;
  $('#registered-count').textContent = attendees.length;
  $('#attended-count').textContent = arrived.length;
  $('#attendance-rate').innerHTML = `${percent}<span class="metric-percent">%</span>`;
  $('#list-count').textContent = attendees.length;

  const recentBody = $('#recent-table-body');
  recentBody.replaceChildren();
  $('#recent-empty').hidden = arrived.length > 0;
  $('#recent-table-body').closest('.table-wrap').querySelector('table').hidden = arrived.length === 0;
  arrived.slice().sort((a, b) => new Date(checkinOn(b, day)) - new Date(checkinOn(a, day))).slice(0, 6).forEach((attendee) => {
    const row = document.createElement('tr');
    row.append(createGuestCell(attendee));
    row.append(element('td', '', attendee.company || '—'));
    row.append(element('td', '', attendee.profession || '—'));
    row.append(element('td', '', formatDate(checkinOn(attendee, day))));
    const status = document.createElement('td');
    status.append(createStatus(checkinOn(attendee, day)));
    row.append(status);
    recentBody.append(row);
  });
  renderGuestList();
}

function renderGuestList() {
  const query = $('#guest-search').value.trim().toLowerCase();
  const filter = $('#attendance-filter').value;
  const day = state.selectedDay;
  const matching = state.attendees.filter((attendee) => {
    const searchable = [attendee.name, attendee.code, attendee.email, attendee.phone, attendee.company, attendee.profession].join(' ').toLowerCase();
    const matchesQuery = !query || searchable.includes(query);
    const matchesFilter = filter === 'all' || (filter === 'attended' ? Boolean(checkinOn(attendee, day)) : !checkinOn(attendee, day));
    return matchesQuery && matchesFilter;
  });
  const body = $('#guest-table-body');
  body.replaceChildren();
  matching.forEach((attendee) => {
    const row = document.createElement('tr');
    row.append(createGuestCell(attendee));
    row.append(element('td', 'checkin-code', attendee.code || '—'));
    row.append(element('td', '', [attendee.email, attendee.phone].filter(Boolean).join(' · ') || '—'));
    row.append(element('td', '', attendee.company || '—'));
    row.append(element('td', '', attendee.profession || '—'));
    const arrival = document.createElement('td');
    const arrivedAt = checkinOn(attendee, day);
    arrival.append(arrivedAt ? element('span', 'status-pill', formatDate(arrivedAt)) : createStatus(null));
    row.append(arrival);
    row.append(element('td', '', attendee.checkins.map((checkin) => formatDay(checkin.date)).join(', ') || '—'));
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

function connectDashboardStream() {
  if (state.dashboardStream) return;
  const stream = new EventSource('/api/events');
  state.dashboardStream = stream;
  stream.addEventListener('dashboard-update', () => {
    refreshDashboard().catch((error) => toast(error.message, true));
  });
  stream.addEventListener('error', () => {
    if (stream.readyState === EventSource.CLOSED && state.dashboardStream === stream) {
      state.dashboardStream = null;
    }
  });
}

async function refreshDashboard() {
  const [session, dashboard] = await Promise.all([api('/api/auth/session'), api('/api/dashboard')]);
  state.admin = session.admin;
  if (!state.admin) return showAuth();
  state.attendees = dashboard.attendees;
  // Follow the calendar when the admin is watching "today" and midnight passes.
  if (!state.selectedDay || state.selectedDay === state.today) state.selectedDay = dashboard.today;
  state.today = dashboard.today;
  $('#admin-name').textContent = state.admin.name;
  $('#admin-email').textContent = state.admin.email;
  $('#admin-avatar').textContent = state.admin.name.trim().charAt(0).toUpperCase() || 'A';
  $('#greeting-name').textContent = state.admin.name.split(/\s+/)[0];
  setEventName(state.admin.eventName);
  renderDashboard();
  connectDashboardStream();
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
    ['Check-in code', attendee.code], ['Phone', attendee.phone], ['Email', attendee.email], ['Company', attendee.company],
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

function renderDeskResult(attendee) {
  const card = element('article', 'match-card');
  card.append(element('h2', '', attendee.name), attendeeDetails(attendee));
  if (attendee.checked_in_today) {
    const status = element('p', 'checked-banner', `Checked in for today · ${formatDate(attendee.checked_in_today)}`);
    status.setAttribute('role', 'status');
    card.append(status);
  } else {
    const button = element('button', 'button button-primary button-wide', 'Check in for today');
    button.type = 'button';
    button.dataset.deskCheckin = attendee.id;
    card.append(button);
  }
  $('#desk-result').replaceChildren(card);
  state.deskAttendee = attendee;
}

function renderMatches(attendees) {
  const list = $('#match-list');
  list.replaceChildren();
  attendees.forEach((attendee) => {
    const card = element('article', 'match-card');
    card.append(element('h2', '', attendee.name), attendeeDetails(attendee));
    if (attendee.checked_in_today) {
      const status = element('p', 'checked-banner', `Checked in for today · ${formatDate(attendee.checked_in_today)}`);
      status.setAttribute('role', 'status');
      card.append(status);
    } else {
      const button = element('button', 'button button-primary button-wide', 'Check in for today');
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
$('#day-select').addEventListener('change', (event) => {
  state.selectedDay = event.target.value;
  renderDashboard();
});
$('#daily-table-body').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-day]');
  if (!button) return;
  state.selectedDay = button.dataset.day;
  renderDashboard();
});

$('#guest-table-body').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const attendee = state.attendees.find((item) => item.id === button.dataset.id);
  if (!attendee) return;
  if (button.dataset.action === 'edit') return openAttendeeDialog(attendee);
  if (!window.confirm(`Remove ${attendee.name} from this guest list?`)) return;
  try {
    await api(`/api/attendees/${attendee.id}`, { method: 'DELETE' });
    await refreshDashboard();
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
    await api(editing ? `/api/attendees/${state.editingId}` : '/api/attendees', {
      method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload)
    });
    $('#attendee-dialog').close();
    await refreshDashboard();
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

$('#desk-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('#desk-code').value.replace(/\s+/g, '');
  const button = $('#desk-find-button');
  $('#desk-error').textContent = '';
  $('#desk-result').replaceChildren();
  button.disabled = true;
  try {
    const result = await api(`/api/attendees/code/${encodeURIComponent(code)}`);
    renderDeskResult(result.attendee);
    $('#desk-result [data-desk-checkin]')?.focus();
  } catch (error) {
    $('#desk-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#desk-result').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-desk-checkin]');
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api(`/api/attendees/${button.dataset.deskCheckin}/checkin`, { method: 'POST' });
    renderDeskResult({ ...state.deskAttendee, checked_in_today: result.checkedInAt });
    toast(result.alreadyCheckedIn ? `${state.deskAttendee.name} was already checked in today.` : `${state.deskAttendee.name} is checked in.`);
    // Ready for the next guest in the queue.
    $('#desk-code').value = '';
    $('#desk-code').focus();
  } catch (error) {
    button.disabled = false;
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
  state.lastLookupName = $('#find-name').value.trim();
  $('#find-error').textContent = '';
  $('#find-success').textContent = '';
  $('#find-success').hidden = true;
  $('#register-prompt').hidden = true;
  $('#register-success').hidden = true;
  $('#match-list').replaceChildren();
  const button = $('#find-button');
  button.disabled = true;
  try {
    const result = await api(`/api/public/${state.checkinToken}/find`, {
      method: 'POST', body: JSON.stringify({ name: state.lastLookupName })
    });
    renderMatches(result.attendees);
    $('#find-success').textContent = 'Registration found. Review your details below.';
    $('#find-success').hidden = false;
  } catch (error) {
    $('#find-error').textContent = error.message;
    $('#register-prompt').hidden = error.status !== 404;
  } finally {
    $('#find-name').value = '';
    button.disabled = false;
  }
});

$('#show-register-button').addEventListener('click', () => {
  $('#find-error').textContent = '';
  $('#find-success').textContent = '';
  $('#find-success').hidden = true;
  $('#public-register-error').textContent = '';
  $('#public-register-form').reset();
  $('#public-register-form [name="name"]').value = state.lastLookupName;
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
    $('#find-error').textContent = '';
    $('#find-success').textContent = '';
    $('#find-success').hidden = true;
    $('#register-prompt').hidden = true;
    $('#find-name').value = result.attendee.name;
    $('#register-code').textContent = result.attendee.code;
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
    toast(result.alreadyCheckedIn ? 'You have already checked in today.' : 'Check-in successful. Welcome!');
  } catch (error) {
    button.disabled = false;
    toast(error.message, true);
  }
});

initialize();