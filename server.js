const express = require('express');
const http = require('http');
const https = require('https');
const net = require('net');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function generateUUID() {
  return require('crypto').randomUUID();
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'hosts.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Beautiful initial mix demonstrating all three methods
const defaultHosts = [
  {
    id: generateUUID(),
    name: 'Google DNS (ICMP)',
    host: '8.8.8.8',
    method: 'icmp',
    port: null,
    url: null,
    group: 'Public DNS',
    interval: 5,
    timeout: 2,
    active: true
  },
  {
    id: generateUUID(),
    name: 'Google Website (HTTP/HTTPS)',
    host: 'www.google.com',
    method: 'http',
    port: null,
    url: 'https://www.google.com',
    group: 'Websites',
    interval: 8,
    timeout: 3,
    active: true
  },
  {
    id: generateUUID(),
    name: 'Cloudflare Port 80 (TCP)',
    host: '1.1.1.1',
    method: 'tcp',
    port: 80,
    url: null,
    group: 'Public TCP Check',
    interval: 6,
    timeout: 2,
    active: true
  },
  {
    id: generateUUID(),
    name: 'Localhost Loopback (ICMP)',
    host: '127.0.0.1',
    method: 'icmp',
    port: null,
    url: null,
    group: 'Local Network',
    interval: 3,
    timeout: 1,
    active: true
  },
  {
    id: generateUUID(),
    name: 'Offline Test IP (ICMP)',
    host: '192.0.2.1', // RFC 5737 Test IP (offline)
    method: 'icmp',
    port: null,
    url: null,
    group: 'Testing',
    interval: 10,
    timeout: 2,
    active: true
  },
  {
    id: generateUUID(),
    name: 'Closed Port 9999 (TCP)',
    host: '127.0.0.1',
    method: 'tcp',
    port: 9999, // guaranteed closed locally
    url: null,
    group: 'Testing',
    interval: 10,
    timeout: 1,
    active: true
  }
];

let hosts = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    hosts = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    
    // DB MIGRATION: Ensure all existing hosts have the new fields
    let updated = false;
    hosts = hosts.map(h => {
      if (!h.method) {
        h.method = 'icmp';
        h.port = h.port || null;
        h.url = h.url || null;
        updated = true;
      }
      return h;
    });
    if (updated) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(hosts, null, 2), 'utf8');
    }
  } else {
    hosts = defaultHosts;
    fs.writeFileSync(DATA_FILE, JSON.stringify(hosts, null, 2), 'utf8');
  }
} catch (error) {
  console.error('Failed to load/migrate hosts file, using defaults.', error);
  hosts = defaultHosts;
}

// Memory storage for runtime data
// hostId -> { status, lastPingTime, history: Array<{latency, timestamp, status}> }
const telemetry = new Map();
const activeIntervals = new Map();

// Initialize telemetry map
hosts.forEach(h => {
  telemetry.set(h.id, {
    status: 'unknown',
    lastPingTime: null,
    history: []
  });
});

// Helper to save hosts to disk
function saveHosts() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(hosts, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving hosts file:', error);
  }
}

// WebSocket broadcast helper
function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

/* ==========================================================================
   MONITORING METHODS ENGINES (ICMP, TCP, HTTP)
   ========================================================================== */

// 1. ICMP Ping Engine (spawns macOS native ping)
function executeIcmpCheck(hostObj) {
  return new Promise((resolve) => {
    const { host, timeout } = hostObj;
    const pingProcess = spawn('ping', ['-c', '1', '-t', String(timeout || 2), host]);
    
    let stdout = '';
    pingProcess.stdout.on('data', (data) => { stdout += data.toString(); });
    
    pingProcess.on('close', (code) => {
      let latency = null;
      let status = 'offline';
      
      if (code === 0) {
        const match = stdout.match(/time=([\d.]+)\s*ms/i);
        if (match) {
          latency = parseFloat(match[1]);
          status = 'online';
        }
      }
      resolve({ status, latency });
    });
  });
}

// 2. TCP Port Connection Engine (using native net sockets)
function executeTcpCheck(hostObj) {
  return new Promise((resolve) => {
    const { host, port, timeout } = hostObj;
    const start = Date.now();
    const timeoutMs = (timeout || 2) * 1000;
    
    let resolved = false;
    const socket = new net.Socket();
    
    socket.setTimeout(timeoutMs);
    
    socket.connect(port || 80, host, () => {
      if (resolved) return;
      resolved = true;
      const latency = Date.now() - start;
      socket.destroy();
      resolve({ status: 'online', latency });
    });
    
    socket.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      
      // If server actively rejects connection (e.g. connection refused),
      // it means the host IP itself is online and responding!
      if (err.code === 'ECONNREFUSED') {
        const latency = Date.now() - start;
        resolve({ status: 'online', latency });
      } else {
        resolve({ status: 'offline', latency: null });
      }
    });
    
    socket.on('timeout', () => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ status: 'offline', latency: null });
    });
  });
}

// 3. HTTP/HTTPS Request Engine (using native node client to support older versions too)
function executeHttpCheck(hostObj) {
  return new Promise((resolve) => {
    const { url, timeout } = hostObj;
    const start = Date.now();
    const timeoutMs = (timeout || 2) * 1000;
    
    let resolved = false;
    const client = url.startsWith('https') ? https : http;
    
    let req;
    try {
      req = client.get(url, { timeout: timeoutMs }, (res) => {
        if (resolved) return;
        resolved = true;
        const latency = Date.now() - start;
        res.resume(); // consume response to free memory
        
        // Any successful HTTP response (even 4xx/5xx error pages) indicates
        // that the server host itself is online and running the web server!
        resolve({ status: 'online', latency });
      });
    } catch (e) {
      resolve({ status: 'offline', latency: null });
      return;
    }
    
    req.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      resolve({ status: 'offline', latency: null });
    });
    
    req.on('timeout', () => {
      if (resolved) return;
      resolved = true;
      req.destroy();
      resolve({ status: 'offline', latency: null });
    });
  });
}

// Unified Core Monitor Check Router
function executeCheck(hostObj, isManual = false) {
  return new Promise(async (resolve) => {
    const { id, method } = hostObj;
    let status = 'offline';
    let latency = null;
    
    try {
      if (method === 'tcp') {
        const res = await executeTcpCheck(hostObj);
        status = res.status;
        latency = res.latency;
      } else if (method === 'http') {
        const res = await executeHttpCheck(hostObj);
        status = res.status;
        latency = res.latency;
      } else {
        // default: icmp
        const res = await executeIcmpCheck(hostObj);
        status = res.status;
        latency = res.latency;
      }
    } catch (err) {
      console.error(`Check failed for target ${hostObj.name}:`, err);
      status = 'offline';
      latency = null;
    }
    
    const timestamp = new Date().toISOString();
    const result = {
      hostId: id,
      status,
      latency,
      timestamp,
      isManual
    };
    
    // Store in memory
    let hostTelemetry = telemetry.get(id);
    if (!hostTelemetry) {
      hostTelemetry = { status: 'unknown', lastPingTime: null, history: [] };
      telemetry.set(id, hostTelemetry);
    }
    
    hostTelemetry.status = status;
    hostTelemetry.lastPingTime = timestamp;
    
    // Add to history list (max 50)
    hostTelemetry.history.push({ latency, timestamp, status });
    if (hostTelemetry.history.length > 50) {
      hostTelemetry.history.shift();
    }
    
    // Broadcast instantly to WS clients
    broadcast({
      type: 'PING_UPDATE',
      data: result
    });
    
    resolve(result);
  });
}

/* ==========================================================================
   SCHEDULER & TIMERS
   ========================================================================== */
function startHostMonitoring(hostObj) {
  stopHostMonitoring(hostObj.id);
  
  if (!hostObj.active) return;
  
  const msInterval = (hostObj.interval || 5) * 1000;
  
  // Initial direct check
  executeCheck(hostObj);
  
  const timer = setInterval(() => {
    executeCheck(hostObj);
  }, msInterval);
  
  activeIntervals.set(hostObj.id, timer);
}

function stopHostMonitoring(hostId) {
  if (activeIntervals.has(hostId)) {
    clearInterval(activeIntervals.get(hostId));
    activeIntervals.delete(hostId);
  }
}

function initSchedulers() {
  hosts.forEach(host => {
    if (host.active) {
      startHostMonitoring(host);
    }
  });
}

/* ==========================================================================
   REST API & SERVICE ROUTING
   ========================================================================== */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/hosts', (req, res) => {
  const combined = hosts.map(h => {
    const t = telemetry.get(h.id) || { status: 'unknown', lastPingTime: null, history: [] };
    return {
      ...h,
      status: t.status,
      lastPingTime: t.lastPingTime,
      history: t.history
    };
  });
  res.json(combined);
});

app.post('/api/hosts', (req, res) => {
  const { name, host, method, port, url, group, interval, timeout } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  
  if (method === 'http' && !url) {
    return res.status(400).json({ error: 'URL is required for HTTP/HTTPS checks.' });
  }
  
  if (method !== 'http' && !host) {
    return res.status(400).json({ error: 'Host (IP/Domain) is required for ICMP and TCP checks.' });
  }

  if (method === 'tcp' && !port) {
    return res.status(400).json({ error: 'Port is required for TCP checks.' });
  }
  
  // URL validation & hostname extraction for HTTP targets
  let targetHost = host;
  if (method === 'http') {
    try {
      const parsedUrl = new URL(url);
      targetHost = parsedUrl.hostname;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format. Provide standard http/https protocol.' });
    }
  }
  
  const newHost = {
    id: generateUUID(),
    name,
    host: targetHost,
    method: method || 'icmp',
    port: method === 'tcp' ? parseInt(port) : null,
    url: method === 'http' ? url : null,
    group: group || 'General',
    interval: parseInt(interval) || 5,
    timeout: parseInt(timeout) || 2,
    active: true
  };
  
  hosts.push(newHost);
  saveHosts();
  
  telemetry.set(newHost.id, {
    status: 'unknown',
    lastPingTime: null,
    history: []
  });
  
  startHostMonitoring(newHost);
  
  broadcast({
    type: 'HOST_ADDED',
    data: {
      ...newHost,
      status: 'unknown',
      lastPingTime: null,
      history: []
    }
  });
  
  res.status(201).json(newHost);
});

app.put('/api/hosts/:id', (req, res) => {
  const { id } = req.params;
  const { name, host, method, port, url, group, interval, timeout } = req.body;
  
  const idx = hosts.findIndex(h => h.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Host not found.' });
  }
  
  if (!name) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  
  if (method === 'http' && !url) {
    return res.status(400).json({ error: 'URL is required for HTTP/HTTPS checks.' });
  }
  
  if (method !== 'http' && !host) {
    return res.status(400).json({ error: 'Host (IP/Domain) is required.' });
  }

  if (method === 'tcp' && !port) {
    return res.status(400).json({ error: 'Port is required for TCP checks.' });
  }
  
  let targetHost = host;
  if (method === 'http') {
    try {
      const parsedUrl = new URL(url);
      targetHost = parsedUrl.hostname;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format.' });
    }
  }
  
  const updatedHost = {
    ...hosts[idx],
    name,
    host: targetHost,
    method: method || 'icmp',
    port: method === 'tcp' ? parseInt(port) : null,
    url: method === 'http' ? url : null,
    group: group || 'General',
    interval: parseInt(interval) || 5,
    timeout: parseInt(timeout) || 2
  };
  
  hosts[idx] = updatedHost;
  saveHosts();
  
  if (updatedHost.active) {
    startHostMonitoring(updatedHost);
  }
  
  const t = telemetry.get(id) || { status: 'unknown', lastPingTime: null, history: [] };
  broadcast({
    type: 'HOST_UPDATED',
    data: {
      ...updatedHost,
      status: t.status,
      lastPingTime: t.lastPingTime,
      history: t.history
    }
  });
  
  res.json(updatedHost);
});

app.delete('/api/hosts/:id', (req, res) => {
  const { id } = req.params;
  const idx = hosts.findIndex(h => h.id === id);
  
  if (idx === -1) {
    return res.status(404).json({ error: 'Host not found.' });
  }
  
  stopHostMonitoring(id);
  telemetry.delete(id);
  hosts.splice(idx, 1);
  saveHosts();
  
  broadcast({
    type: 'HOST_DELETED',
    data: { id }
  });
  
  res.json({ success: true });
});

app.post('/api/hosts/:id/toggle', (req, res) => {
  const { id } = req.params;
  const idx = hosts.findIndex(h => h.id === id);
  
  if (idx === -1) {
    return res.status(404).json({ error: 'Host not found.' });
  }
  
  hosts[idx].active = !hosts[idx].active;
  saveHosts();
  
  if (hosts[idx].active) {
    startHostMonitoring(hosts[idx]);
  } else {
    stopHostMonitoring(id);
    const t = telemetry.get(id);
    if (t) {
      t.status = 'paused';
      broadcast({
        type: 'PING_UPDATE',
        data: {
          hostId: id,
          status: 'paused',
          latency: null,
          timestamp: new Date().toISOString()
        }
      });
    }
  }
  
  broadcast({
    type: 'HOST_TOGGLED',
    data: hosts[idx]
  });
  
  res.json(hosts[idx]);
});

app.post('/api/hosts/:id/ping', async (req, res) => {
  const { id } = req.params;
  const hostObj = hosts.find(h => h.id === id);
  
  if (!hostObj) {
    return res.status(404).json({ error: 'Host not found.' });
  }
  
  try {
    const result = await executeCheck(hostObj, true);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to run manual check', details: err.message });
  }
});

// Import Configuration overrides
app.post('/api/config/import', (req, res) => {
  const importedHosts = req.body;
  if (!Array.isArray(importedHosts)) {
    return res.status(400).json({ error: 'Invalid config. Expected an array.' });
  }

  const validated = [];
  for (const item of importedHosts) {
    if (!item.name) continue;
    if (item.method === 'http' && !item.url) continue;
    if (item.method !== 'http' && !item.host) continue;
    if (item.method === 'tcp' && !item.port) continue;
    
    validated.push({
      id: item.id || generateUUID(),
      name: item.name,
      host: item.host || '',
      method: item.method || 'icmp',
      port: item.method === 'tcp' ? parseInt(item.port) : null,
      url: item.method === 'http' ? item.url : null,
      group: item.group || 'General',
      interval: parseInt(item.interval) || 5,
      timeout: parseInt(item.timeout) || 2,
      active: item.active !== undefined ? !!item.active : true
    });
  }

  if (validated.length === 0) {
    return res.status(400).json({ error: 'No valid hosts found.' });
  }

  hosts.forEach(h => stopHostMonitoring(h.id));
  hosts = validated;
  saveHosts();

  telemetry.clear();
  hosts.forEach(h => {
    telemetry.set(h.id, {
      status: 'unknown',
      lastPingTime: null,
      history: []
    });
    if (h.active) {
      startHostMonitoring(h);
    }
  });

  const combined = hosts.map(h => {
    const t = telemetry.get(h.id) || { status: 'unknown', lastPingTime: null, history: [] };
    return {
      ...h,
      status: t.status,
      lastPingTime: t.lastPingTime,
      history: t.history
    };
  });

  broadcast({
    type: 'CONFIG_RESET',
    data: combined
  });

  res.json({ success: true, count: validated.length });
});

// WebSocket Server Handshake
wss.on('connection', (ws) => {
  const combined = hosts.map(h => {
    const t = telemetry.get(h.id) || { status: 'unknown', lastPingTime: null, history: [] };
    return {
      ...h,
      status: t.status,
      lastPingTime: t.lastPingTime,
      history: t.history
    };
  });
  
  ws.send(JSON.stringify({
    type: 'INIT',
    data: combined
  }));
});

// Fallback serve public folder
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Port activation
server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` Multi-Ping Monitor is Live!`);
  console.log(` Access dashboard at: http://localhost:${PORT}`);
  console.log(`===============================================`);
  initSchedulers();
});

// Handle graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('Shutting down checks and webserver...');
  hosts.forEach(h => stopHostMonitoring(h.id));
  wss.close(() => {
    server.close(() => {
      console.log('Process exited cleanly.');
      process.exit(0);
    });
  });
}
