/* ============================================================
   SmartGuard — Dashboard JavaScript
   Handles: Navigation, API calls, SSE, Person Management,
            History Table, Live Monitor, Toast notifications
============================================================ */

// ── Configuration ─────────────────────────────────────────────
// Dynamic backend resolution for Vercel, Localhost, or Remote Tunneling:
function getApiBase() {
  const urlParams = new URLSearchParams(window.location.search);
  const param = urlParams.get('backend');
  if (param) {
    const cleaned = param.trim().replace(/\/+$/, '');
    localStorage.setItem('smartguard_api_base', cleaned);
    return cleaned;
  }
  const saved = localStorage.getItem('smartguard_api_base');
  if (saved) return saved;

  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (isLocal && window.location.protocol.startsWith('http')) {
    return window.location.origin;
  }
  return 'http://localhost:5000';
}

let API_BASE = getApiBase();

function configureBackendUrl() {
  const current = API_BASE;
  const newUrl = prompt(
    'Enter your Python Backend Server URL (e.g. https://your-tunnel.trycloudflare.com or http://localhost:5000):',
    current
  );
  if (newUrl !== null) {
    const cleaned = newUrl.trim().replace(/\/+$/, '');
    if (cleaned) {
      localStorage.setItem('smartguard_api_base', cleaned);
      API_BASE = cleaned;
      if (typeof showToast === 'function') showToast(`Backend URL set to: ${API_BASE}`, 'info');
    } else {
      localStorage.removeItem('smartguard_api_base');
      API_BASE = getApiBase();
      if (typeof showToast === 'function') showToast(`Reset to default: ${API_BASE}`, 'info');
    }
    connectToBackend();
    connectSSE();
    loadDashboard();
  }
}

// ── State ─────────────────────────────────────────────────────
let currentPage = 'dashboard';
let currentFilter = 'all';
let currentHistoryPage = 0;
const HISTORY_PAGE_SIZE = 20;
let allPersons = [];
let liveEvents = [];
let sseSource = null;
let backendOnline = false;

// ══════════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  startClock();
  connectToBackend();
  loadDashboard();
  connectSSE();
});

// ══════════════════════════════════════════════════════════════
// CLOCK
// ══════════════════════════════════════════════════════════════

function startClock() {
  function updateClock() {
    const now = new Date();
    document.getElementById('system-time').textContent =
      now.toLocaleTimeString('en-GB', { hour12: false });
    document.getElementById('system-date').textContent =
      now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  updateClock();
  setInterval(updateClock, 1000);
}

// ══════════════════════════════════════════════════════════════
// BACKEND CONNECTION CHECK
// ══════════════════════════════════════════════════════════════

async function connectToBackend() {
  try {
    const response = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      backendOnline = true;
      setBackendStatus(true);
    } else {
      setBackendStatus(false);
    }
  } catch (e) {
    setBackendStatus(false);
  }
  // Re-check every 30 seconds
  setTimeout(connectToBackend, 30000);
}

function setBackendStatus(online) {
  const dot   = document.getElementById('backend-dot');
  const label = document.getElementById('backend-label');
  if (online) {
    dot.className   = 'dot dot-online';
    label.textContent = 'Backend Online';
    backendOnline = true;
  } else {
    dot.className   = 'dot dot-offline';
    label.textContent = 'Backend Offline';
    backendOnline = false;
  }
}

// ══════════════════════════════════════════════════════════════
// SERVER-SENT EVENTS — REAL-TIME UPDATES
// ══════════════════════════════════════════════════════════════

function connectSSE() {
  if (sseSource) { sseSource.close(); }

  try {
    sseSource = new EventSource(`${API_BASE}/api/events/stream`);

    sseSource.onopen = () => {
      console.log('[SSE] Connected to event stream');
      setBackendStatus(true);
    };

    sseSource.addEventListener('new_detection', (e) => {
      const data = JSON.parse(e.data);
      console.log('[SSE] New detection:', data);
      handleNewDetection(data);
    });

    sseSource.addEventListener('device_status', (e) => {
      const data = JSON.parse(e.data);
      updateESP32Status(data.online, data.ip || null);
    });

    sseSource.onerror = () => {
      console.warn('[SSE] Connection lost — will retry in 10s');
      sseSource.close();
      setTimeout(connectSSE, 10000);
    };

  } catch (e) {
    console.error('[SSE] Failed to connect:', e);
    setTimeout(connectSSE, 10000);
  }
}

// ══════════════════════════════════════════════════════════════
// HANDLE NEW DETECTION EVENT
// ══════════════════════════════════════════════════════════════

function handleNewDetection(data) {
  const isUnknown = data.status === 'unknown';
  const isAuth    = data.status === 'authorized';

  // Update dashboard stats
  refreshDashboardStats();

  // Update live monitor
  updateLiveMonitor(data);

  // Add to live feed
  addToLiveFeed(data);

  // Show alert banner for unknown
  if (isUnknown) {
    showAlertBanner(`Unknown person detected at ${data.location}!`);
    showPage_badge('live', true);
    showToast(`🚨 Unknown person detected at ${data.time}!`, 'error', 6000);
  } else if (isAuth) {
    showToast(`✅ ${data.person_name} recognized at ${data.time}`, 'success', 4000);
  }

  // If on history page, refresh
  if (currentPage === 'history') {
    loadHistory();
  }
  // If on dashboard, refresh events
  if (currentPage === 'dashboard') {
    loadRecentEvents();
  }
}

// ══════════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════════

function showPage(pageName) {
  // Update nav
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById(`nav-${pageName}`);
  if (navEl) navEl.classList.add('active');

  // Update page visibility
  document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
  const pageEl = document.getElementById(`page-${pageName}`);
  if (pageEl) pageEl.classList.remove('hidden');

  currentPage = pageName;

  // Update top bar titles
  const titles = {
    dashboard: ['Dashboard', 'System overview and status'],
    live:      ['Live Monitor', 'Real-time detection feed'],
    persons:   ['Authorized Persons', 'Manage the face recognition database'],
    history:   ['Detection History', 'All past detection events']
  };

  if (titles[pageName]) {
    document.getElementById('page-title').textContent    = titles[pageName][0];
    document.getElementById('page-subtitle').textContent = titles[pageName][1];
  }

  // Load page-specific data
  if (pageName === 'dashboard') loadDashboard();
  if (pageName === 'persons')   loadPersons();
  if (pageName === 'history')   loadHistory();
  if (pageName === 'live')      { showPage_badge('live', false); }

  // Close sidebar on mobile
  if (window.innerWidth < 768) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

// Attach nav click events
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showPage(btn.dataset.page));
});

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function showPage_badge(page, show) {
  const badge = document.getElementById(`${page}-badge`);
  if (badge) badge.style.display = show ? 'flex' : 'none';
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD PAGE
// ══════════════════════════════════════════════════════════════

async function loadDashboard() {
  await Promise.all([
    refreshDashboardStats(),
    loadRecentEvents()
  ]);
}

async function refreshDashboardStats() {
  try {
    const res  = await fetch(`${API_BASE}/api/status`);
    if (!res.ok) return;
    const data = await res.json();

    // Stats
    animateCount('count-authorized', data.total_authorized || 0);
    animateCount('count-unknown',    data.total_unknown    || 0);
    animateCount('count-persons',    data.known_faces_count || 0);

    // Last detection
    if (data.last_detection) {
      const dt = new Date(data.last_detection.time);
      document.getElementById('last-detection-time').textContent = dt.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
      document.getElementById('last-detection-name').textContent = data.last_detection.person || '—';
    }

    // ESP32 status
    updateESP32Status(data.esp32_online, data.esp32_ip, data.last_seen);

  } catch (e) {
    console.warn('[DASH] Failed to load stats:', e);
  }
}

function updateESP32Status(online, ip, lastSeen) {
  const dot   = document.getElementById('esp32-dot');
  const label = document.getElementById('esp32-label');
  const hwDot = document.getElementById('hw-esp32-dot');
  const hwLbl = document.getElementById('hw-esp32-label');
  const ipEl  = document.getElementById('esp32-ip');
  const lsEl  = document.getElementById('esp32-last-seen');

  if (online) {
    dot.className     = 'dot dot-online';
    label.textContent = 'ESP32 Online';
    if (hwDot) hwDot.className = 'dot dot-online';
    if (hwLbl) hwLbl.textContent = 'Connected';
    if (ip && ipEl) ipEl.textContent = ip;
  } else {
    dot.className     = 'dot dot-offline';
    label.textContent = 'Hardware: NOT CONNECTED';
    if (hwDot) hwDot.className = 'dot dot-offline';
    if (hwLbl) hwLbl.textContent = 'NOT CONNECTED';
    if (ipEl) ipEl.textContent = 'Not Connected';
  }

  if (lastSeen && lsEl) {
    const dt = new Date(lastSeen);
    lsEl.textContent = dt.toLocaleTimeString('en-GB', { hour12: false });
  } else if (lsEl) {
    lsEl.textContent = 'Software Demo';
  }
}

async function loadRecentEvents() {
  const container = document.getElementById('recent-events');

  try {
    const res    = await fetch(`${API_BASE}/api/events?limit=5`);
    const data   = await res.json();
    const events = data.events || [];

    if (!events.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📸</div>
          <p>No detection events yet. Upload a photo or simulate motion above...</p>
        </div>`;
      return;
    }

    container.innerHTML = events.map(e => buildEventCard(e)).join('');

  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <p>Cannot connect to backend server.<br>
           Make sure backend is running at <code>${API_BASE}</code></p>
      </div>`;
  }
}

function buildEventCard(event) {
  const isUnknown = event.status === 'unknown';
  const cardClass = isUnknown ? 'unknown-card' : (event.status === 'authorized' ? 'authorized-card' : '');
  const isDemo    = event.is_demo || event.notes === 'DEMO' || (event.device_id && event.device_id.startsWith('DEMO'));
  const badge     = buildStatusBadge(event.status, isDemo);
  const thumbHtml = event.image_url
    ? `<div class="event-thumb"><img src="${API_BASE}${event.image_url}" alt="" loading="lazy" onerror="this.style.display='none'"></div>`
    : `<div class="event-thumb"><div class="event-thumb-placeholder">${isUnknown ? '👤' : '✅'}</div></div>`;

  return `
    <div class="event-card ${cardClass}" onclick="viewImage('${API_BASE}${event.image_url || ''}', '${event.person_name}', '${event.date} ${event.time}')">
      ${thumbHtml}
      <div class="event-info">
        <div class="event-name">${event.person_name || 'Unknown'} ${isDemo ? '<span class="badge-demo">DEMO</span>' : ''}</div>
        <div class="event-meta">
          <span>📍 ${event.location || '—'}</span>
          <span>🕐 ${event.time || '—'}</span>
        </div>
      </div>
      <div class="event-status-col">
        ${badge}
        <span class="event-time-label">${event.date || '—'}</span>
      </div>
    </div>`;
}

function buildStatusBadge(status, isDemo = false) {
  const map = {
    'authorized':               '<span class="status-badge badge-active">✓ Authorized</span>',
    'unknown':                  '<span class="status-badge badge-danger">⚠ Unknown</span>',
    'no_face':                  '<span class="status-badge badge-warning">No Face Detected</span>',
    'recognition_unavailable':  '<span class="status-badge badge-warning">⚠️ Recognition Unavailable</span>',
    'error':                    '<span class="status-badge badge-warning">Error</span>'
  };
  const base = map[status] || `<span class="status-badge">${status}</span>`;
  if (isDemo) {
    return `${base} <span class="badge-demo">DEMO</span>`;
  }
  return base;
}

// ══════════════════════════════════════════════════════════════
// LIVE MONITOR PAGE
// ══════════════════════════════════════════════════════════════

function updateLiveMonitor(data) {
  const container = document.getElementById('live-image-container');
  const captureInfo = document.getElementById('live-capture-info');
  const recogResult = document.getElementById('recog-result');
  const feedSource  = document.getElementById('live-feed-source');

  // Update image
  if (data.image_url) {
    container.innerHTML = `<img src="${API_BASE}${data.image_url}" alt="Latest capture" 
      onclick="viewImage('${API_BASE}${data.image_url}', '${data.person_name}', '${data.date} ${data.time}')"
      style="cursor:pointer; max-height:420px; width:auto; border-radius:var(--radius-md); object-fit:contain;"/>`;
  }

  // Update capture info
  captureInfo.style.display = 'flex';
  document.getElementById('live-time').textContent     = data.time || '--:--:--';
  document.getElementById('live-date').textContent     = data.date || '--/--/----';
  document.getElementById('live-location').textContent = (data.location || '—') + (data.is_demo ? ' [DEMO]' : '');
  if (feedSource) {
    feedSource.textContent = `Source: ${data.location || 'Demo'} ${data.is_demo ? '(DEMO)' : ''}`;
  }

  // Update recognition result
  const isAuth        = data.status === 'authorized';
  const isUnknown     = data.status === 'unknown';
  const isUnavailable = data.status === 'recognition_unavailable';
  const demoBadge     = data.is_demo ? '<div style="margin-top:8px"><span class="badge-demo">DEMO MODE EVENT</span></div>' : '';

  if (isAuth) {
    recogResult.innerHTML = `
      <div class="recog-authorized">
        <div style="font-size:3rem">✅</div>
        <div class="recog-name">${data.person_name}</div>
        <div class="recog-status-badge">✓ AUTHORIZED</div>
        <div class="recog-confidence">Confidence: ${(data.confidence * 100).toFixed(1)}% ${data.distance ? `(Dist: ${data.distance})` : ''}</div>
        ${demoBadge}
      </div>`;
  } else if (isUnknown) {
    recogResult.innerHTML = `
      <div class="recog-unknown">
        <div style="font-size:3rem">🚨</div>
        <div class="recog-name">UNKNOWN PERSON</div>
        <div class="recog-status-badge">⚠ UNAUTHORIZED</div>
        <div class="recog-confidence">${data.telegram_sent ? 'Telegram photo alert sent' : 'Event logged to dashboard'}</div>
        ${demoBadge}
      </div>`;
  } else if (isUnavailable) {
    recogResult.innerHTML = `
      <div class="recog-waiting">
        <div class="recog-icon">⚠️</div>
        <p style="color:var(--accent-amber); font-weight:700">Recognition Unavailable</p>
        <small style="color:var(--text-muted); font-size:0.75rem; margin-top:4px">
          The face recognition engine is not installed on the server.
        </small>
        ${demoBadge}
      </div>`;
  } else {
    recogResult.innerHTML = `
      <div class="recog-waiting">
        <div class="recog-icon">👤</div>
        <p style="color:var(--text-primary); font-weight:600">No Face Detected</p>
        <small style="color:var(--text-muted); font-size:0.75rem; margin-top:4px">
          No face landmarks detected in this frame.
        </small>
        ${demoBadge}
      </div>`;
  }
}

function addToLiveFeed(data) {
  const feed = document.getElementById('live-events-feed');
  const emptyEl = feed.querySelector('.feed-empty');
  if (emptyEl) emptyEl.remove();

  const isUnknown = data.status === 'unknown';
  const isDemo = data.is_demo || data.notes === 'DEMO';
  const item = document.createElement('div');
  item.className = `feed-event-item ${isUnknown ? 'feed-unknown' : 'feed-authorized'}`;
  item.innerHTML = `
    <span class="feed-icon">${isUnknown ? '🚨' : '✅'}</span>
    <span class="feed-person">${data.person_name || 'Unknown'} ${isDemo ? '<span class="badge-demo">DEMO</span>' : ''}</span>
    <span class="feed-time">${data.time || '--:--'}</span>`;

  feed.insertBefore(item, feed.firstChild);

  // Keep only last 20 items
  const items = feed.querySelectorAll('.feed-event-item');
  if (items.length > 20) items[items.length - 1].remove();

  liveEvents.unshift(data);
}

function clearLiveFeed() {
  document.getElementById('live-events-feed').innerHTML =
    '<div class="feed-empty">Feed cleared</div>';
}

// ══════════════════════════════════════════════════════════════
// AUTHORIZED PERSONS PAGE
// ══════════════════════════════════════════════════════════════

async function loadPersons() {
  const grid = document.getElementById('persons-grid');
  grid.innerHTML = '<div class="loading-placeholder"><div class="spinner"></div><span>Loading...</span></div>';

  try {
    const res  = await fetch(`${API_BASE}/api/persons`);
    const data = await res.json();
    allPersons = data.persons || [];
    renderPersons(allPersons);
  } catch (e) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <p>Cannot connect to backend. Is it running?</p>
      </div>`;
  }
}

function renderPersons(persons) {
  const grid = document.getElementById('persons-grid');

  if (!persons.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">👥</div>
        <p>No authorized persons yet.<br>
           Click "Add Person" to add someone.</p>
      </div>`;
    return;
  }

  grid.innerHTML = persons.map(p => buildPersonCard(p)).join('');
}

function buildPersonCard(person) {
  const photoHtml = person.photo_filename
    ? `<img src="${API_BASE}/api/known-faces/${person.photo_filename}" alt="${person.name}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">`
    : '';

  const dateAdded = person.date_added
    ? new Date(person.date_added).toLocaleDateString('en-GB')
    : '—';

  return `
    <div class="person-card" id="person-card-${person.id}">
      <div class="person-photo">
        ${photoHtml}
        <div class="person-photo-placeholder" ${photoHtml ? 'style="display:none"' : ''}>👤</div>
      </div>
      <div class="person-info">
        <div class="person-name">${person.name}</div>
        <div class="person-id">ID: ${String(person.id).padStart(3, '0')} · Added: ${dateAdded}</div>
        <div class="person-status-row">
          <span class="status-badge ${person.status === 'active' ? 'badge-active' : 'badge-warning'}">
            ${person.status === 'active' ? '✓ Authorized' : '⊘ Inactive'}
          </span>
          <div class="person-actions">
            <button class="btn-icon danger" title="Delete" onclick="deletePerson(${person.id}, '${person.name.replace(/'/g, "\\'")}')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>`;
}

function filterPersons() {
  const query = document.getElementById('person-search').value.toLowerCase();
  const filtered = allPersons.filter(p =>
    p.name.toLowerCase().includes(query)
  );
  renderPersons(filtered);
}

// Add Person Modal
function openAddPersonModal() {
  document.getElementById('add-person-modal').style.display = 'flex';
  document.getElementById('person-name').focus();
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
  if (id === 'add-person-modal') {
    document.getElementById('add-person-form').reset();
    document.getElementById('photo-preview').style.display = 'none';
    document.getElementById('upload-placeholder').style.display = 'flex';
  }
}

function previewPhoto(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const preview = document.getElementById('photo-preview');
    preview.src = e.target.result;
    preview.style.display = 'block';
    document.getElementById('upload-placeholder').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

async function submitAddPerson(event) {
  event.preventDefault();

  const name  = document.getElementById('person-name').value.trim();
  const photo = document.getElementById('person-photo').files[0];
  const btn   = document.getElementById('add-person-submit');

  if (!name || !photo) {
    showToast('Please fill in name and upload a photo.', 'warning');
    return;
  }

  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Adding...';

  const formData = new FormData();
  formData.append('name',  name);
  formData.append('photo', photo);

  try {
    const res  = await fetch(`${API_BASE}/api/persons`, { method: 'POST', body: formData });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast(`✅ ${name} added successfully!`, 'success');
      closeModal('add-person-modal');
      loadPersons();
    } else {
      showToast(`❌ ${data.error || 'Failed to add person'}`, 'error');
    }
  } catch (e) {
    showToast('❌ Cannot connect to backend server', 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').textContent = 'Add Person';
  }
}

async function deletePerson(id, name) {
  if (!confirm(`Delete "${name}" from the authorized list?\nThis cannot be undone.`)) return;

  try {
    const res  = await fetch(`${API_BASE}/api/persons/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(`${name} removed.`, 'info');
      document.getElementById(`person-card-${id}`)?.remove();
      allPersons = allPersons.filter(p => p.id !== id);
    } else {
      showToast(data.error || 'Failed to delete', 'error');
    }
  } catch (e) {
    showToast('Cannot connect to backend', 'error');
  }
}

// ══════════════════════════════════════════════════════════════
// DETECTION HISTORY PAGE
// ══════════════════════════════════════════════════════════════

async function loadHistory() {
  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="table-loading"><div class="spinner"></div> Loading...</td></tr>';

  try {
    const offset  = currentHistoryPage * HISTORY_PAGE_SIZE;
    const params  = new URLSearchParams({
      limit:  HISTORY_PAGE_SIZE,
      offset: offset,
      ...(currentFilter !== 'all' && { status: currentFilter })
    });

    const res  = await fetch(`${API_BASE}/api/events?${params}`);
    const data = await res.json();
    const events = data.events || [];
    const total  = data.total  || 0;

    document.getElementById('history-total').textContent = total;
    document.getElementById('page-info').textContent =
      `Page ${currentHistoryPage + 1} of ${Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE))}`;

    // Pagination buttons
    document.getElementById('btn-prev').disabled = currentHistoryPage === 0;
    document.getElementById('btn-next').disabled = offset + events.length >= total;

    if (!events.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-muted);">
        No detection events found for this filter.</td></tr>`;
      return;
    }

    tbody.innerHTML = events.map((e, i) => buildHistoryRow(e, offset + i + 1)).join('');

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--accent-red);">
      ⚠️ Cannot connect to backend server</td></tr>`;
  }
}

function buildHistoryRow(event, num) {
  const isUnknown = event.status === 'unknown';
  const thumbHtml = event.image_url
    ? `<img class="table-thumb" src="${API_BASE}${event.image_url}" alt="" loading="lazy"
         onclick="viewImage('${API_BASE}${event.image_url}', '${event.person_name}', '${event.date} ${event.time}')"
         onerror="this.outerHTML='<div class=\\'table-thumb-placeholder\\'>👤</div>'">`
    : `<div class="table-thumb-placeholder">${isUnknown ? '👤' : '✅'}</div>`;

  const confPct = Math.round((event.confidence || 0) * 100);
  const isLow   = confPct < 50;
  const confHtml = event.status === 'authorized'
    ? `<div class="confidence-bar-cell">
         <div class="confidence-bar"><div class="confidence-fill ${isLow ? 'low' : ''}" style="width:${confPct}%"></div></div>
         <span class="confidence-text">${confPct}%</span>
       </div>`
    : `<span style="color:var(--text-muted); font-size:0.75rem">—</span>`;

  const isDemo = event.is_demo || event.notes === 'DEMO' || (event.device_id && event.device_id.startsWith('DEMO'));

  return `
    <tr>
      <td style="color:var(--text-muted); font-family:'JetBrains Mono',monospace; font-size:0.75rem">#${num}</td>
      <td>${thumbHtml}</td>
      <td style="font-weight:600; color:${isUnknown ? 'var(--accent-red)' : 'var(--text-primary)'}">
        ${event.person_name || '—'} ${isDemo ? '<span class="badge-demo">DEMO</span>' : ''}
      </td>
      <td>${buildStatusBadge(event.status, isDemo)}</td>
      <td style="color:var(--text-secondary); font-size:0.82rem">📍 ${event.location || '—'}</td>
      <td style="font-family:'JetBrains Mono',monospace; font-size:0.8rem; color:var(--text-secondary)">${event.date || '—'}</td>
      <td style="font-family:'JetBrains Mono',monospace; font-size:0.8rem; color:var(--accent-blue)">${event.time || '—'}</td>
      <td>${confHtml}</td>
    </tr>`;
}

function filterHistory(filter, btn) {
  currentFilter      = filter;
  currentHistoryPage = 0;

  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  loadHistory();
}

function changePage(delta) {
  currentHistoryPage = Math.max(0, currentHistoryPage + delta);
  loadHistory();
}

// ══════════════════════════════════════════════════════════════
// IMAGE VIEWER MODAL
// ══════════════════════════════════════════════════════════════

function viewImage(url, name, datetime) {
  if (!url || url.endsWith('/')) return;
  const modal = document.getElementById('image-modal');
  document.getElementById('modal-image-src').src = url;
  document.getElementById('modal-image-info').innerHTML =
    `<strong>${name || 'Captured Image'}</strong> &nbsp;·&nbsp; ${datetime || ''}`;
  modal.style.display = 'flex';
}

// ══════════════════════════════════════════════════════════════
// ALERT BANNER
// ══════════════════════════════════════════════════════════════

function showAlertBanner(message) {
  const banner = document.getElementById('alert-banner');
  document.getElementById('alert-banner-text').textContent = message;
  banner.style.display = 'block';

  // Auto-hide after 10 seconds
  setTimeout(closeAlertBanner, 10000);
}

function closeAlertBanner() {
  document.getElementById('alert-banner').style.display = 'none';
}

// ══════════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ══════════════════════════════════════════════════════════════

function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const toast     = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ══════════════════════════════════════════════════════════════
// UTILITY: ANIMATE COUNT
// ══════════════════════════════════════════════════════════════

function animateCount(elementId, targetValue) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const start    = parseInt(el.textContent) || 0;
  const duration = 600;
  const startTime = performance.now();

  function update(now) {
    const elapsed  = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased    = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (targetValue - start) * eased);
    if (progress < 1) requestAnimationFrame(update);
  }

  requestAnimationFrame(update);
}

// ══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════════════

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Close open modals
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    closeAlertBanner();
  }
  // Number keys for navigation
  if (e.altKey) {
    const pages = ['dashboard', 'live', 'persons', 'history'];
    const idx = parseInt(e.key) - 1;
    if (idx >= 0 && idx < pages.length) showPage(pages[idx]);
  }
});

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// ══════════════════════════════════════════════════════════════
// SOFTWARE DEMO MODE TESTING HANDLERS
// Allows testing face recognition, Telegram alerts, and motion
// without physical ESP32-CAM or PIR sensor
// ══════════════════════════════════════════════════════════════

let currentDemoFile = null;

function handleDemoPhotoSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  currentDemoFile = file;
  const filenameLabel = document.getElementById('demo-filename');
  if (filenameLabel) filenameLabel.textContent = file.name;

  const runBtn = document.getElementById('btn-run-recognition');
  if (runBtn) runBtn.disabled = false;

  // Preview chosen image in live image container
  const reader = new FileReader();
  reader.onload = (e) => {
    const container = document.getElementById('live-image-container');
    container.innerHTML = `<img src="${e.target.result}" alt="Preview" style="max-height:420px; width:auto; border-radius:var(--radius-md); object-fit:contain;"/>`;
  };
  reader.readAsDataURL(file);

  showToast(`Selected "${file.name}". Click "Run Face Recognition" to test.`, 'info');
}

async function uploadDemoPhoto() {
  if (!currentDemoFile) {
    showToast('Please select a photo from your computer first.', 'warning');
    return;
  }

  const runBtn = document.getElementById('btn-run-recognition');
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.textContent = '⏳ Processing Recognition...';
  }

  const formData = new FormData();
  formData.append('image', currentDemoFile);
  formData.append('location', 'Manual Upload (DEMO)');
  formData.append('is_demo', 'true');

  try {
    const res = await fetch(`${API_BASE}/api/demo/upload-image`, {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (res.ok && data.success) {
      handleNewDetection(data);

      if (data.status === 'authorized') {
        showToast(`✅ Authorized: ${data.person_name} (${(data.confidence * 100).toFixed(0)}% match) [DEMO]`, 'success');
      } else if (data.status === 'unknown') {
        showToast(`🚨 Unknown Person Detected [DEMO]`, 'error');
      } else if (data.status === 'no_face') {
        showToast(`👤 No face detected in uploaded photo [DEMO]`, 'warning');
      } else if (data.status === 'recognition_unavailable') {
        showToast(`⚠️ Recognition engine unavailable on server [DEMO]`, 'warning');
      }
    } else {
      showToast(`❌ ${data.error || 'Failed to process image'}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Cannot connect to backend server at ${API_BASE}`, 'error');
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = '🔍 Run Face Recognition (DEMO)';
    }
  }
}

async function simulateMotion(type = 'auto') {
  showToast('⚡ Triggering simulated motion event...', 'info');

  try {
    const res = await fetch(`${API_BASE}/api/demo/simulate-motion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: type })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      handleNewDetection(data);
      showToast(`⚡ Simulated motion event processed: ${data.display_status} [DEMO]`, 'info');
    } else {
      showToast(`❌ ${data.error || 'Failed to simulate motion'}`, 'error');
    }
  } catch (err) {
    showToast(`❌ Cannot connect to backend server at ${API_BASE}`, 'error');
  }
}

async function testTelegramAlert() {
  showToast('📱 Sending test photo alert to Telegram...', 'info');

  try {
    const res = await fetch(`${API_BASE}/api/test/telegram-photo`, {
      method: 'POST'
    });
    const data = await res.json();

    if (res.ok && data.success) {
      showToast(`✅ Telegram: ${data.message}`, 'success');
    } else {
      showToast(`⚠️ Telegram: ${data.message || 'Failed to send alert'}`, 'warning', 6000);
    }
  } catch (err) {
    showToast(`❌ Backend connection failed: ${err.message}`, 'error');
  }
}

console.log(`
  ╔══════════════════════════════════════╗
  ║   SmartGuard Security Dashboard     ║
  ║   Backend: ${API_BASE.padEnd(27)}║
  ║   Mode: Software Demo (No Hardware) ║
  ║   Alt+1 Dashboard  Alt+2 Live       ║
  ║   Alt+3 Persons    Alt+4 History    ║
  ╚══════════════════════════════════════╝
`);
