// State management
let hosts = [];
let activeFilter = 'all';
let warningThreshold = 150; // ms
let audioEnabled = false;
let audioVolume = 0.5;
let notificationsEnabled = false;
let ws = null;
let previousStatuses = new Map(); // hostId -> status
let audioCtx = null;

// DOM Elements
const currentTimeEl = document.getElementById('current-time');
const hostsGridEl = document.getElementById('hosts-grid-container');
const groupFiltersEl = document.getElementById('group-filters');
const logBodyEl = document.getElementById('log-body-container');
const hostModal = document.getElementById('hostModal');
const hostForm = document.getElementById('hostForm');
const formSubmitBtn = document.getElementById('form-submit-btn');

// Stats Elements
const statTotalEl = document.getElementById('val-total');
const statOnlineEl = document.getElementById('val-online');
const statWarningEl = document.getElementById('val-warning');
const statOfflineEl = document.getElementById('val-offline');

/* ==========================================================================
   Clock / Local Time
   ========================================================================== */
function updateClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  currentTimeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
setInterval(updateClock, 1000);
updateClock();

/* ==========================================================================
   Web Audio Synthesizer (Zero-Dependency Custom Audio Engine)
   ========================================================================== */
function initAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function playChime(type) {
  if (!audioEnabled) return;
  
  try {
    initAudioContext();
    
    const masterGain = audioCtx.createGain();
    masterGain.gain.setValueAtTime(audioVolume * 0.4, audioCtx.currentTime);
    masterGain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;

    if (type === 'up') {
      // Pleasant rising arpeggio (C5 -> E5 -> G5)
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
      notes.forEach((freq, index) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + index * 0.08);
        
        gain.gain.setValueAtTime(0.01, now + index * 0.08);
        gain.gain.exponentialRampToValueAtTime(0.8, now + index * 0.08 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.01, now + index * 0.08 + 0.4);
        
        osc.connect(gain);
        gain.connect(masterGain);
        
        osc.start(now + index * 0.08);
        osc.stop(now + index * 0.08 + 0.5);
      });
    } else if (type === 'down') {
      // Dissonant urgent two-tone warning
      const freq1 = 440.00; // A4
      const freq2 = 311.13; // Eb4 (dissonant diminished fifth)
      
      const playTone = (freq, delay) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        
        osc.type = 'sawtooth';
        // Lowpass filter to soften the harsh sawtooth
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1000, now);

        osc.frequency.setValueAtTime(freq, now + delay);
        
        gain.gain.setValueAtTime(0.01, now + delay);
        gain.gain.linearRampToValueAtTime(0.8, now + delay + 0.05);
        gain.gain.linearRampToValueAtTime(0.4, now + delay + 0.15);
        gain.gain.exponentialRampToValueAtTime(0.01, now + delay + 0.45);
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(masterGain);
        
        osc.start(now + delay);
        osc.stop(now + delay + 0.5);
      };

      playTone(freq1, 0);
      playTone(freq2, 0.15);
      playTone(freq1, 0.3);
      playTone(freq2, 0.45);
    }
  } catch (err) {
    console.error('Audio synthesis failed:', err);
  }
}

/* ==========================================================================
   Desktop Notifications
   ========================================================================== */
function requestNotificationPermission() {
  if ('Notification' in window) {
    Notification.requestPermission().then(permission => {
      notificationsEnabled = (permission === 'granted');
      document.getElementById('opt-notifications').checked = notificationsEnabled;
    });
  }
}

function sendNotification(title, body) {
  if (notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body,
        icon: '/favicon.ico'
      });
    } catch (e) {
      console.error('Failed to trigger notification:', e);
    }
  }
}

/* ==========================================================================
   Terminal Logs Panel
   ========================================================================== */
function addLog(message, type = 'info') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
  
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = timestamp + ' ';
  
  const textNode = document.createTextNode(message);
  
  entry.appendChild(timeSpan);
  entry.appendChild(textNode);
  
  logBodyEl.appendChild(entry);
  logBodyEl.scrollTop = logBodyEl.scrollHeight;
}

function clearLogs() {
  logBodyEl.innerHTML = '';
  addLog('Terminal logs cleared.', 'system');
}

/* ==========================================================================
   Dialog (Modal) Settings & Safari Fallback (Light-Dismiss)
   ========================================================================== */
// Fallback for browsers without native dialog backdrop closing (Safari < 18)
if (!('closedBy' in HTMLDialogElement.prototype)) {
  hostModal.addEventListener('click', (event) => {
    if (event.target !== hostModal) return;
    
    const rect = hostModal.getBoundingClientRect();
    const isInside = (
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width
    );
    
    if (!isInside) {
      closeHostModal();
    }
  });
}

function handleMethodChange(method) {
  const hostGroup = document.getElementById('form-host-group');
  const portGroup = document.getElementById('form-port-group');
  const urlGroup = document.getElementById('form-url-group');
  
  const hostInput = document.getElementById('form-host');
  const portInput = document.getElementById('form-port');
  const urlInput = document.getElementById('form-url');
  
  if (method === 'icmp') {
    hostGroup.style.display = 'block';
    hostInput.required = true;
    portGroup.style.display = 'none';
    portInput.required = false;
    urlGroup.style.display = 'none';
    urlInput.required = false;
  } else if (method === 'tcp') {
    hostGroup.style.display = 'block';
    hostInput.required = true;
    portGroup.style.display = 'block';
    portInput.required = true;
    urlGroup.style.display = 'none';
    urlInput.required = false;
  } else if (method === 'http') {
    hostGroup.style.display = 'none';
    hostInput.required = false;
    portGroup.style.display = 'none';
    portInput.required = false;
    urlGroup.style.display = 'block';
    urlInput.required = true;
  }
}

function openAddHostModal() {
  document.getElementById('modalTitle').textContent = 'Tambah IP Monitoring';
  formSubmitBtn.textContent = 'Simpan Monitor';
  document.getElementById('form-host-id').value = '';
  hostForm.reset();
  document.getElementById('form-method').value = 'icmp';
  handleMethodChange('icmp');
  hostModal.showModal();
  initAudioContext(); // Lazy-init audio context on click
}

function openEditHostModal(id) {
  const hostObj = hosts.find(h => h.id === id);
  if (!hostObj) return;
  
  document.getElementById('modalTitle').textContent = 'Edit Host Monitoring';
  formSubmitBtn.textContent = 'Perbarui Monitor';
  document.getElementById('form-host-id').value = hostObj.id;
  document.getElementById('form-name').value = hostObj.name;
  document.getElementById('form-method').value = hostObj.method || 'icmp';
  document.getElementById('form-host').value = hostObj.host || '';
  document.getElementById('form-port').value = hostObj.port || 80;
  document.getElementById('form-url').value = hostObj.url || '';
  document.getElementById('form-group-name').value = hostObj.group;
  document.getElementById('form-interval').value = hostObj.interval;
  document.getElementById('form-timeout').value = hostObj.timeout;
  
  handleMethodChange(hostObj.method || 'icmp');
  hostModal.showModal();
  initAudioContext(); // Lazy-init audio context on click
}

function closeHostModal() {
  hostModal.close();
}

async function submitHostForm(event) {
  event.preventDefault();
  
  const id = document.getElementById('form-host-id').value;
  const method = document.getElementById('form-method').value;
  
  const data = {
    name: document.getElementById('form-name').value.trim(),
    method: method,
    host: method !== 'http' ? document.getElementById('form-host').value.trim() : '',
    port: method === 'tcp' ? parseInt(document.getElementById('form-port').value) : null,
    url: method === 'http' ? document.getElementById('form-url').value.trim() : null,
    group: document.getElementById('form-group-name').value.trim() || 'General',
    interval: parseInt(document.getElementById('form-interval').value),
    timeout: parseInt(document.getElementById('form-timeout').value)
  };
  
  try {
    let response;
    if (id) {
      // Edit
      response = await fetch(`/api/hosts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (response.ok) addLog(`Host "${data.name}" diperbarui.`, 'system');
    } else {
      // Add new
      response = await fetch('/api/hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (response.ok) addLog(`Host "${data.name}" berhasil ditambahkan.`, 'system');
    }
    
    if (!response.ok) {
      const err = await response.json();
      alert(`Error: ${err.error}`);
      return;
    }
    
    closeHostModal();
  } catch (error) {
    console.error('Failed to submit form:', error);
    alert('Koneksi server gagal.');
  }
}

/* ==========================================================================
   REST APIs Trigger Actions
   ========================================================================== */
async function toggleHostActive(id) {
  try {
    const response = await fetch(`/api/hosts/${id}/toggle`, { method: 'POST' });
    if (response.ok) {
      const updated = await response.json();
      addLog(`Status monitoring "${updated.name}" ditoggle ke: ${updated.active ? 'Aktif' : 'Nonaktif'}.`, 'system');
    }
  } catch (err) {
    console.error('Toggle failed:', err);
  }
}

async function deleteHost(id, name) {
  if (!confirm(`Apakah Anda yakin ingin menghapus "${name}" dari monitoring?`)) return;
  try {
    const response = await fetch(`/api/hosts/${id}`, { method: 'DELETE' });
    if (response.ok) {
      addLog(`Host "${name}" berhasil dihapus.`, 'system');
    }
  } catch (err) {
    console.error('Delete failed:', err);
  }
}

async function forcePing(id, name) {
  addLog(`Menjalankan manual ping untuk "${name}"...`, 'info');
  try {
    const cardEl = document.getElementById(`host-card-${id}`);
    if (cardEl) {
      const triggerBtn = cardEl.querySelector('.btn-card-action[title="Ping Sekarang"]');
      if (triggerBtn) triggerBtn.style.animation = 'beacon-pulse 1s infinite linear';
    }
    
    const response = await fetch(`/api/hosts/${id}/ping`, { method: 'POST' });
    const result = await response.json();
    
    if (cardEl) {
      const triggerBtn = cardEl.querySelector('.btn-card-action[title="Ping Sekarang"]');
      if (triggerBtn) triggerBtn.style.animation = '';
    }

    if (result.status === 'online') {
      addLog(`Manual ping "${name}": Sukses (${result.latency} ms)`, 'success');
    } else {
      addLog(`Manual ping "${name}": Gagal (Offline/Timeout)`, 'error');
    }
  } catch (err) {
    console.error('Manual ping failed:', err);
  }
}

/* ==========================================================================
   High-Performance SVG Sparkline Generator
   ========================================================================== */
function generateSparklineSVG(history) {
  const width = 300;
  const height = 40;
  const maxPoints = 20;
  
  // Cut the history array to keep only the last maxPoints
  const dataPoints = history.slice(-maxPoints);
  
  if (dataPoints.length === 0) {
    return `<svg class="sparkline-svg" viewBox="0 0 ${width} ${height}">
      <text x="${width/2}" y="${height/2 + 4}" fill="var(--text-muted)" font-size="10" font-family="var(--font-sans)" text-anchor="middle">Menunggu data...</text>
    </svg>`;
  }

  // Calculate scales
  // Filter only valid numeric latencies to find the max
  const latencies = dataPoints.filter(d => d.latency !== null).map(d => d.latency);
  const maxVal = latencies.length > 0 ? Math.max(...latencies, 50) : 100; // default max of at least 50ms to keep graphs balanced
  
  const stepX = width / (maxPoints - 1);
  const getX = (idx) => {
    // Offset x to align nicely to the right if history is smaller than maxPoints
    const offsetIndex = idx + (maxPoints - dataPoints.length);
    return offsetIndex * stepX;
  };
  
  const getY = (val) => {
    if (val === null) return height - 2; // Offline points sit at the bottom edge
    // Inverse scale (SVG y=0 is top)
    const scaled = ((val / maxVal) * (height - 8)); // leave 8px padding
    return height - scaled - 4;
  };

  let pathData = '';
  let fillPathData = '';
  let gridLines = '';
  
  // Draw light horizontal threshold line (warning threshold)
  if (warningThreshold < maxVal) {
    const warnY = getY(warningThreshold);
    gridLines += `<line x1="0" y1="${warnY}" x2="${width}" y2="${warnY}" stroke="rgba(245, 158, 11, 0.15)" stroke-width="1" stroke-dasharray="2,4"/>`;
  }
  
  // Draw base helper lines
  gridLines += `<line x1="0" y1="${height/2}" x2="${width}" y2="${height/2}" stroke="rgba(255, 255, 255, 0.02)" stroke-width="1"/>`;

  let lastValidX = 0;
  let lastValidY = height - 2;
  let firstPoint = true;
  const circles = [];

  for (let i = 0; i < dataPoints.length; i++) {
    const pt = dataPoints[i];
    const x = getX(i);
    const y = getY(pt.latency);
    
    if (pt.status === 'offline') {
      // Render small offline red indicator dots on sparkline
      circles.push(`<circle cx="${x}" cy="${y}" r="2" fill="var(--danger)"/>`);
      
      // If we went offline, draw a drop to the bottom
      if (firstPoint) {
        pathData = `M ${x} ${height - 2}`;
        fillPathData = `M ${x} ${height} L ${x} ${height - 2}`;
        firstPoint = false;
      } else {
        pathData += ` L ${x} ${height - 2}`;
        fillPathData += ` L ${x} ${height - 2}`;
      }
    } else {
      if (firstPoint) {
        pathData = `M ${x} ${y}`;
        fillPathData = `M ${x} ${height} L ${x} ${y}`;
        firstPoint = false;
      } else {
        pathData += ` L ${x} ${y}`;
        fillPathData += ` L ${x} ${y}`;
      }
      
      // Draw highlight dots on spikes
      if (pt.latency > warningThreshold) {
        circles.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="var(--warning)" filter="drop-shadow(0 0 2px var(--warning))"/>`);
      }
      
      lastValidX = x;
      lastValidY = y;
    }
  }
  
  // Close the fill path to create a lovely gradient mountain under the line
  fillPathData += ` L ${lastValidX} ${height} Z`;

  // Determine stroke color of sparkline path based on warning threshold
  const currentStatus = dataPoints[dataPoints.length - 1].status;
  const currentLatency = dataPoints[dataPoints.length - 1].latency;
  let strokeColor = 'var(--accent)';
  let gradientId = 'sparkline-grad-accent';
  
  if (currentStatus === 'offline') {
    strokeColor = 'var(--danger)';
    gradientId = 'sparkline-grad-danger';
  } else if (currentLatency > warningThreshold) {
    strokeColor = 'var(--warning)';
    gradientId = 'sparkline-grad-warning';
  } else if (currentStatus === 'paused') {
    strokeColor = 'var(--paused)';
    gradientId = 'sparkline-grad-paused';
  }

  return `
    <svg class="sparkline-svg" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="sparkline-grad-accent" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.0"/>
        </linearGradient>
        <linearGradient id="sparkline-grad-warning" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--warning)" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="var(--warning)" stop-opacity="0.0"/>
        </linearGradient>
        <linearGradient id="sparkline-grad-danger" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--danger)" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="var(--danger)" stop-opacity="0.0"/>
        </linearGradient>
        <linearGradient id="sparkline-grad-paused" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--paused)" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="var(--paused)" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <path class="sparkline-fill" d="${fillPathData}" fill="url(#${gradientId})" />
      <path class="sparkline-path" d="${pathData}" stroke="${strokeColor}" />
      ${circles.join('')}
    </svg>
  `;
}

/* ==========================================================================
   UI Card Rendering Engine (Super Performance Direct DOM)
   ========================================================================== */
function renderHostGrid() {
  const filteredHosts = hosts.filter(h => {
    if (activeFilter === 'all') return true;
    return h.group.toLowerCase() === activeFilter.toLowerCase();
  });
  
  hostsGridEl.innerHTML = '';
  
  if (filteredHosts.length === 0) {
    hostsGridEl.innerHTML = `
      <div class="glass-panel" style="grid-column: 1/-1; padding: 3rem; text-align: center; color: var(--text-secondary);">
        <h3>Belum ada IP yang dimonitor dalam grup ini.</h3>
        <p style="margin-top: 0.5rem; font-size: 0.875rem;">Silakan tambahkan IP baru dengan menekan tombol <strong>Tambah IP</strong>.</p>
      </div>
    `;
    return;
  }
  
  filteredHosts.forEach(h => {
    const card = createHostCardDOM(h);
    hostsGridEl.appendChild(card);
  });
}

function createHostCardDOM(h) {
  const card = document.createElement('div');
  card.className = 'host-card glass-panel';
  card.id = `host-card-${h.id}`;
  
  // Dynamic method badges
  let methodBadge = '';
  if (h.method === 'tcp') {
    methodBadge = `<span style="font-size: 0.65rem; color: #a78bfa; border: 1px solid rgba(139, 92, 246, 0.2); background: rgba(139, 92, 246, 0.08); padding: 0.125rem 0.375rem; border-radius: 4px; font-weight: 700; text-transform: uppercase;">TCP:${h.port}</span>`;
  } else if (h.method === 'http') {
    methodBadge = `<span style="font-size: 0.65rem; color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.2); background: rgba(99, 102, 241, 0.08); padding: 0.125rem 0.375rem; border-radius: 4px; font-weight: 700; text-transform: uppercase;">HTTP</span>`;
  } else {
    methodBadge = `<span style="font-size: 0.65rem; color: #34d399; border: 1px solid rgba(16, 185, 129, 0.2); background: rgba(16, 185, 129, 0.08); padding: 0.125rem 0.375rem; border-radius: 4px; font-weight: 700; text-transform: uppercase;">ICMP</span>`;
  }

  // Display target endpoint
  const endpointDisp = h.method === 'http' 
    ? (h.url.length > 35 ? h.url.substring(0, 32) + '...' : h.url)
    : (h.method === 'tcp' ? `${h.host}:${h.port}` : h.host);
  
  // Calculate average latency
  const validPings = h.history.filter(p => p.status === 'online');
  const avgLatency = validPings.length > 0
    ? (validPings.reduce((sum, p) => sum + p.latency, 0) / validPings.length).toFixed(1)
    : '0.0';
    
  // Calculate packet loss percentage
  const totalPings = h.history.length;
  const lostPings = h.history.filter(p => p.status === 'offline').length;
  const packetLoss = totalPings > 0 ? ((lostPings / totalPings) * 100).toFixed(0) : '0';
  
  // Determine warning states
  let warningClass = '';
  let statusText = h.status;
  
  if (h.status === 'online') {
    const latestPing = h.history[h.history.length - 1];
    if (latestPing && latestPing.latency > warningThreshold) {
      warningClass = 'status-warning';
      statusText = 'Warning';
    } else {
      warningClass = 'status-online';
    }
  } else if (h.status === 'offline') {
    warningClass = 'status-offline';
  } else if (h.status === 'paused') {
    warningClass = 'status-paused';
  } else {
    warningClass = 'status-unknown';
  }

  // Get current latency display
  const latestPingObj = h.history[h.history.length - 1];
  const currentLatencyDisp = (h.status === 'online' && latestPingObj)
    ? `${latestPingObj.latency.toFixed(1)} <span>ms</span>`
    : '--';

  card.innerHTML = `
    <div class="host-header">
      <div class="host-meta">
        <div style="display: flex; align-items: center; gap: 0.375rem; margin-bottom: 0.25rem; flex-wrap: wrap;">
          <span class="host-group" style="margin-bottom: 0;">${escapeHTML(h.group)}</span>
          ${methodBadge}
        </div>
        <h3 class="host-name">${escapeHTML(h.name)}</h3>
        <span class="host-ip" title="${escapeHTML(h.method === 'http' ? h.url : h.host)}">${escapeHTML(endpointDisp)}</span>
      </div>
      <div class="status-badge ${warningClass}">
        <span class="status-beacon"></span>
        <span>${statusText}</span>
      </div>
    </div>
    
    <div class="host-telemetry">
      <div class="metric-box">
        <span class="metric-label">Latency</span>
        <span class="metric-value">${currentLatencyDisp}</span>
      </div>
      <div class="metric-box">
        <span class="metric-label">Average</span>
        <span class="metric-value">${h.status === 'paused' ? '--' : avgLatency + ' <span>ms</span>'}</span>
      </div>
      <div class="metric-box">
        <span class="metric-label">Loss</span>
        <span class="metric-value" style="color: ${packetLoss > 0 ? 'var(--danger)' : 'var(--text-primary)'};">${h.status === 'paused' ? '--' : packetLoss + '<span>%</span>'}</span>
      </div>
    </div>

    <div class="sparkline-wrapper">
      ${generateSparklineSVG(h.history)}
    </div>

    <div class="card-actions">
      <button class="btn-card-action toggle-active ${h.active ? 'active' : 'paused'}" onclick="toggleHostActive('${h.id}')" title="${h.active ? 'Pause Monitoring' : 'Resume Monitoring'}">
        <svg width="14" height="14"><use href="${h.active ? '#icon-pause' : '#icon-play'}"></use></svg>
      </button>
      <button class="btn-card-action" onclick="forcePing('${h.id}', '${escapeQuote(h.name)}')" title="Ping Sekarang" ${h.active ? '' : 'disabled'}>
        <svg width="14" height="14"><use href="#icon-refresh"></use></svg>
      </button>
      <button class="btn-card-action" onclick="openEditHostModal('${h.id}')" title="Edit Monitor">
        <svg width="14" height="14"><use href="#icon-edit"></use></svg>
      </button>
      <button class="btn-card-action danger" onclick="deleteHost('${h.id}', '${escapeQuote(h.name)}')" title="Hapus Monitor">
        <svg width="14" height="14"><use href="#icon-delete"></use></svg>
      </button>
    </div>
  `;
  
  return card;
}

// Update single host card DOM node directly for extreme rendering performance
function updateHostCard(h) {
  const existingCard = document.getElementById(`host-card-${h.id}`);
  if (!existingCard) {
    renderHostGrid(); // fallback to full render if card not found
    return;
  }
  
  const newCard = createHostCardDOM(h);
  existingCard.replaceWith(newCard);
}

/* ==========================================================================
   Header Stats & Filter Syncing
   ========================================================================== */
function calculateGlobalStats() {
  let total = hosts.length;
  let online = 0;
  let warning = 0;
  let offline = 0;
  
  hosts.forEach(h => {
    if (h.status === 'online') {
      const latest = h.history[h.history.length - 1];
      if (latest && latest.latency > warningThreshold) {
        warning++;
      } else {
        online++;
      }
    } else if (h.status === 'offline') {
      offline++;
    }
  });
  
  statTotalEl.textContent = total;
  statOnlineEl.textContent = online;
  statWarningEl.textContent = warning;
  statOfflineEl.textContent = offline;
}

function updateGroupFilters() {
  // Extract all unique groups
  const groups = new Set();
  hosts.forEach(h => {
    if (h.group) groups.add(h.group);
  });
  
  // Save current active group
  const prevActive = activeFilter;
  
  // Redraw filter buttons
  groupFiltersEl.innerHTML = `<button class="tab-btn ${activeFilter === 'all' ? 'active' : ''}" data-group="all" onclick="changeGroupFilter('all')">Semua</button>`;
  
  Array.from(groups).sort().forEach(grp => {
    const btn = document.createElement('button');
    btn.className = `tab-btn ${activeFilter.toLowerCase() === grp.toLowerCase() ? 'active' : ''}`;
    btn.textContent = grp;
    btn.setAttribute('data-group', grp);
    btn.onclick = () => changeGroupFilter(grp);
    groupFiltersEl.appendChild(btn);
  });
}

function changeGroupFilter(grp) {
  activeFilter = grp;
  
  // Highlight active button
  const buttons = groupFiltersEl.querySelectorAll('.tab-btn');
  buttons.forEach(btn => {
    if (btn.getAttribute('data-group').toLowerCase() === grp.toLowerCase()) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  
  renderHostGrid();
}

/* ==========================================================================
   WebSockets Telemetry Client
   ========================================================================== */
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  addLog('Menghubungkan ke server WebSocket...', 'info');
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    addLog('WebSocket terhubung. Streaming telemetry diaktifkan.', 'success');
    document.getElementById('main-header').style.borderColor = 'rgba(16, 185, 129, 0.2)';
  };
  
  ws.onclose = () => {
    addLog('WebSocket terputus. Mencoba menghubungkan kembali dalam 5 detik...', 'warning');
    document.getElementById('main-header').style.borderColor = 'rgba(239, 68, 68, 0.2)';
    setTimeout(connectWebSocket, 5000);
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket Error:', error);
  };
  
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    
    switch (message.type) {
      case 'INIT':
        hosts = message.data;
        
        // Save initial statuses for transition tracking
        hosts.forEach(h => {
          previousStatuses.set(h.id, h.status);
        });
        
        updateGroupFilters();
        renderHostGrid();
        calculateGlobalStats();
        addLog(`Berhasil memuat ${hosts.length} target monitoring.`, 'success');
        break;
        
      case 'PING_UPDATE':
        const ping = message.data;
        const hostObj = hosts.find(h => h.id === ping.hostId);
        
        if (hostObj) {
          const oldStatus = previousStatuses.get(ping.hostId) || 'unknown';
          const newStatus = ping.status;
          
          hostObj.status = newStatus;
          
          // Add telemetry ping record
          hostObj.history.push({
            latency: ping.latency,
            timestamp: ping.timestamp,
            status: ping.status
          });
          if (hostObj.history.length > 50) {
            hostObj.history.shift();
          }
          
          // Update the DOM for this card only
          updateHostCard(hostObj);
          calculateGlobalStats();
          
          // Handle transition notifications & alerts
          if (oldStatus !== 'unknown' && oldStatus !== 'paused' && newStatus !== 'paused') {
            if (oldStatus !== 'offline' && newStatus === 'offline') {
              // Outage Event!
              addLog(`[Outage Alert] ${hostObj.name} (${hostObj.host}) OFFLINE!`, 'error');
              playChime('down');
              sendNotification('Server Down!', `${hostObj.name} (${hostObj.host}) tidak merespon ping!`);
            } else if (oldStatus === 'offline' && newStatus === 'online') {
              // Recovery Event!
              addLog(`[Recovery] ${hostObj.name} (${hostObj.host}) kembali ONLINE. Latency: ${ping.latency} ms`, 'success');
              playChime('up');
              sendNotification('Server Pulih!', `${hostObj.name} (${hostObj.host}) kembali online (${ping.latency}ms)`);
            } else if (newStatus === 'online' && ping.latency > warningThreshold && oldStatus === 'online') {
              const prevPing = hostObj.history[hostObj.history.length - 2];
              // Warn only if it just spiked (avoid repetitive warnings)
              if (!prevPing || prevPing.latency <= warningThreshold) {
                addLog(`[Warning] Latency tinggi terdeteksi di ${hostObj.name}: ${ping.latency} ms`, 'warning');
              }
            }
          }
          
          previousStatuses.set(ping.hostId, newStatus);
        }
        break;
        
      case 'HOST_ADDED':
        hosts.push(message.data);
        previousStatuses.set(message.data.id, 'unknown');
        updateGroupFilters();
        renderHostGrid();
        calculateGlobalStats();
        addLog(`Target baru ditambahkan: ${message.data.name}`, 'system');
        break;
        
      case 'HOST_UPDATED':
        const updatedIdx = hosts.findIndex(h => h.id === message.data.id);
        if (updatedIdx !== -1) {
          hosts[updatedIdx] = message.data;
          updateGroupFilters();
          renderHostGrid();
          calculateGlobalStats();
          addLog(`Konfigurasi target "${message.data.name}" diubah.`, 'system');
        }
        break;
        
      case 'HOST_DELETED':
        const delId = message.data.id;
        const delHost = hosts.find(h => h.id === delId);
        hosts = hosts.filter(h => h.id !== delId);
        previousStatuses.delete(delId);
        updateGroupFilters();
        renderHostGrid();
        calculateGlobalStats();
        if (delHost) addLog(`Target monitoring "${delHost.name}" telah dihapus.`, 'system');
        break;
        
      case 'HOST_TOGGLED':
        const toggledHost = hosts.find(h => h.id === message.data.id);
        if (toggledHost) {
          toggledHost.active = message.data.active;
          updateHostCard(toggledHost);
          calculateGlobalStats();
        }
        break;
        
      case 'CONFIG_RESET':
        hosts = message.data;
        hosts.forEach(h => previousStatuses.set(h.id, h.status));
        updateGroupFilters();
        renderHostGrid();
        calculateGlobalStats();
        addLog('Seluruh konfigurasi monitor di-reset (di-impor baru).', 'system');
        break;
    }
  };
}

/* ==========================================================================
   Options Drawer Drawer Actions
   ========================================================================== */
function toggleOptionsDrawer() {
  document.getElementById('options-drawer').classList.toggle('open');
}

function toggleNotifications(checked) {
  if (checked) {
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        notificationsEnabled = true;
        addLog('Notifikasi browser diaktifkan.', 'system');
      } else if (Notification.permission !== 'denied') {
        requestNotificationPermission();
      } else {
        alert('Notifikasi diblokir oleh browser Anda. Izinkan secara manual di address bar.');
        document.getElementById('opt-notifications').checked = false;
      }
    } else {
      alert('Browser Anda tidak mendukung notifikasi desktop.');
      document.getElementById('opt-notifications').checked = false;
    }
  } else {
    notificationsEnabled = false;
    addLog('Notifikasi browser dimatikan.', 'system');
  }
}

function toggleAudio(checked) {
  audioEnabled = checked;
  addLog(`Alarm suara ${checked ? 'diaktifkan' : 'dimatikan'}.`, 'system');
  if (checked) {
    initAudioContext();
    // play a quick test chime
    playChime('up');
  }
}

function changeVolume(val) {
  audioVolume = parseFloat(val);
}

function updateWarningThreshold(val) {
  warningThreshold = parseInt(val) || 150;
  addLog(`Ambambang batas latency tinggi diset ke: ${warningThreshold} ms`, 'system');
  renderHostGrid(); // trigger refresh to update visual indicators/curves
}

// Configuration Export
function exportConfig() {
  // Strip history and dynamic telemetry to keep export file lightweight
  const exportData = hosts.map(({ name, host, group, interval, timeout, active }) => ({
    name, host, group, interval, timeout, active
  }));
  
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `wardix-ping-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  addLog('Konfigurasi berhasil diekspor.', 'system');
}

function triggerImportClick() {
  document.getElementById('import-file-input').click();
}

async function importConfig(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!Array.isArray(parsed)) {
        throw new Error('Config file must be a JSON array.');
      }
      
      const response = await fetch('/api/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed)
      });
      
      if (response.ok) {
        addLog('Konfigurasi baru berhasil di-impor.', 'success');
        toggleOptionsDrawer();
      } else {
        const err = await response.json();
        alert(`Gagal mengimpor: ${err.error}`);
      }
    } catch (err) {
      alert(`Format file tidak valid. Error: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

/* ==========================================================================
   Helper Utilities
   ========================================================================== */
function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

function escapeQuote(str) {
  if (!str) return '';
  return str.replace(/'/g, "\\'");
}

// Start WebSocket connection on boot
connectWebSocket();
