'use strict';
// server.js — Lamplight
//
// One Node process. The SmartSpectra SDK owns the camera from here; the page
// in your browser is only a display. Nothing is uploaded anywhere except the
// key check the SDK performs with Presage.
//
//   node server.js
//   open http://localhost:4173

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC = path.join(__dirname, 'public');
const RECEIPTS = path.join(__dirname, 'receipts');

// ---------------------------------------------------------------------------
// MetricType codes. Requested by code, never by bundle — cardioMetrics drags
// in pressure and HRV and can trip METRIC_NOT_AUTHORIZED.
// ---------------------------------------------------------------------------
const M = { CHEST: 1, RATE: 2, PULSE: 15 };

// Validation codes as the native layer reports them, with the one physical
// action that resolves each. Copy describes the room and the posture. It never
// describes the person.
const CAUSE = {
  1:  { code: 'no_face',          label: 'No face in frame',       fix: 'Sit squarely in front of the camera. Check nothing is covering the lens.' },
  2:  { code: 'multiple_faces',   label: 'More than one face',     fix: 'Move somewhere you are the only person in the shot.' },
  3:  { code: 'off_centre',       label: 'Face off-centre',        fix: 'Shift so your face sits in the middle of the frame.' },
  5:  { code: 'too_dark',         label: 'Not enough light',       fix: 'Turn on a light, or bring a lamp round to face you.' },
  6:  { code: 'too_bright',       label: 'Too much backlight',     fix: 'The light is behind you. Turn it around, or move so it lights your face.' },
  7:  { code: 'chest_not_visible',label: 'Chest out of view',      fix: 'Move back from the screen so your upper body is in frame.' },
  10: { code: 'camera_tuning',    label: 'Camera still adjusting', fix: 'Give it a few seconds. The camera is settling its exposure.' },
  11: { code: 'frame_rate_low',   label: 'Camera too slow',        fix: 'Close other apps using the camera, or try a different USB port.' },
  12: { code: 'too_much_motion',  label: 'Too much movement',      fix: 'Set the laptop on a firm surface and sit still for the reading.' },
  13: { code: 'face_too_close',   label: 'Too close',              fix: 'Move back from the camera.' },
  14: { code: 'face_too_far',     label: 'Too far away',           fix: 'Move closer to the camera.' },
  15: { code: 'face_too_high',    label: 'Face too high',          fix: 'Lower your seat, or tilt the screen up.' },
  16: { code: 'face_too_low',     label: 'Face too low',           fix: 'Raise your seat, or tilt the screen down.' },
  17: { code: 'face_not_forward', label: 'Not facing camera',      fix: 'Turn to face the camera directly.' },
};

// Minimum time before a metric may be shown. Showing a number early is worse
// than showing none — the model has not seen enough of the signal yet.
const WARMUP = { pulse: 12000, breathing: 30000 };

// ---------------------------------------------------------------------------
// Session state, broadcast to every connected page over SSE.
// ---------------------------------------------------------------------------
const state = {
  phase: 'idle',          // idle | starting | measuring | stopping | stopped | error
  cause: null,            // current CAUSE entry, or null
  causeSince: null,
  pulse: null,            // { value, confidence, stable, at }
  breathing: null,
  startedAt: null,
  packets: 0,
  elapsedMs: 0,
  pulseSamples: 0,      // numeric pulse values seen in packets, before warm-up gating
  breathSamples: 0,     // numeric breathing values seen, before warm-up gating
  lastPush: 0,
  roomLog: [],            // ordered list of distinct causes seen this session
  error: null,
  exposureNotice: null,
};

const clients = new Set();

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* client gone */ }
  }
}

function pushState() { emit('state', state); }

function noteCause(entry) {
  const now = Date.now();
  if (state.cause && entry && state.cause.code === entry.code) return;
  if (!entry && !state.cause) return;
  state.cause = entry;
  state.causeSince = entry ? now : null;
  if (entry && !state.roomLog.some((c) => c.code === entry.code)) {
    state.roomLog.push({ code: entry.code, label: entry.label, fix: entry.fix, firstSeenMs: state.startedAt ? now - state.startedAt : 0 });
  }
  pushState();
}

// ---------------------------------------------------------------------------
// SDK control
// ---------------------------------------------------------------------------
let sdk = null;
let ticker = null;
let sessionMeta = null;

function metricReady(kind) {
  if (!state.startedAt) return false;
  const age = Date.now() - state.startedAt;
  // The warm-up clock is only honest if the camera can actually see us.
  if (state.cause && ['no_face', 'too_dark', 'chest_not_visible'].includes(state.cause.code)) return false;
  return age >= WARMUP[kind];
}

function friendlyStartError(e) {
  const code = e && e.code;
  if (code === 7) {
    return 'No camera available. Check that no other app is using it, and that ' +
           'Windows camera access is allowed for desktop apps.';
  }
  if (code === 2) {
    return 'Presage rejected the API key. Check PHYSIOLOGY_API_KEY is exactly right.';
  }
  return (e && e.message) ? e.message : String(e);
}

function startSession() {
  const apiKey = process.env.PHYSIOLOGY_API_KEY;
  if (!apiKey) {
    state.phase = 'error';
    state.error = 'PHYSIOLOGY_API_KEY is not set. Start the server with the key in the environment.';
    pushState();
    return;
  }

  let SmartSpectraSDK, decodeMetrics, SmartSpectraErrorCode;
  try {
    ({ SmartSpectraSDK, SmartSpectraErrorCode } = require('@smartspectra/node-sdk'));
    ({ decodeMetrics } = require('@smartspectra/node-sdk/messages'));
  } catch (e) {
    state.phase = 'error';
    state.error = 'SDK not installed. Run: npm install';
    pushState();
    return;
  }

  // Reset
  Object.assign(state, {
    phase: 'starting', cause: null, causeSince: null,
    pulse: null, breathing: null, startedAt: null,
    packets: 0, elapsedMs: 0, roomLog: [], error: null, exposureNotice: null,
    pulseSamples: 0, breathSamples: 0, lastPush: 0,
  });
  pushState();

  sdk = new SmartSpectraSDK({
    apiKey,
    requestedMetrics: [M.CHEST, M.RATE, M.PULSE],
    enableTelemetry: false,
  });

  sdk.on('validationStatus', (code) => {
    noteCause(CAUSE[code] || null);
  });

  sdk.on('error', (code, message) => {
    state.phase = 'error';
    state.error = message;
    pushState();
  });

  sdk.on('processingStatus', (status) => {
    if (status === 3 && state.phase === 'starting') {
      state.phase = 'measuring';
      state.startedAt = Date.now();
      pushState();
      startTicker();
    }
  });

  sdk.on('metrics', (buf) => {
    state.packets += 1;
    let m;
    try { m = decodeMetrics(buf); } catch { return; }
    const now = Date.now();
    let changed = false;

    if (m.cardio && Array.isArray(m.cardio.pulseRate)) {
      for (const p of m.cardio.pulseRate) {
        if (p && typeof p.value === 'number' && p.value > 0) {
          state.pulseSamples += 1;
          if (!state.pulseSamples || state.pulseSamples === 1) {
            console.log(`[lamplight] first pulse sample: ${p.value.toFixed(1)} bpm, confidence ${p.confidence}`);
          }
          if (metricReady('pulse')) {
            state.pulse = {
              value: p.value,
              confidence: typeof p.confidence === 'number' ? p.confidence : null,
              stable: p.stable === true,
              at: now,
            };
            changed = true;
          }
        }
      }
    }

    if (m.breathing && Array.isArray(m.breathing.rate)) {
      for (const b of m.breathing.rate) {
        if (b && typeof b.value === 'number' && b.value > 0) {
          state.breathSamples += 1;
          if (state.breathSamples === 1) {
            console.log(`[lamplight] first breathing sample: ${b.value.toFixed(1)} /min, confidence ${b.confidence}`);
          }
          if (metricReady('breathing')) {
            state.breathing = {
              value: b.value,
              confidence: typeof b.confidence === 'number' ? b.confidence : null,
              stable: b.stable === true,
              at: now,
            };
            changed = true;
          }
        }
      }
    }

    // Metrics arrive many times a second. Push at most five times a second —
    // often enough to feel live, rare enough not to flood the connection.
    if (changed && now - state.lastPush > 200) {
      state.lastPush = now;
      pushState();
    }
  });

  const withTimeout = (p, ms, label) => Promise.race([
    Promise.resolve(p).catch(() => {}),
    new Promise((r) => setTimeout(() => {
      emit('notice', { text: `${label} did not finish in ${ms / 1000}s — continuing.` });
      r();
    }, ms)),
  ]);

  // start() can throw SYNCHRONOUSLY (camera missing, camera busy, no device)
  // as well as reject asynchronously. A .catch() on the returned promise does
  // not cover the synchronous throw — that would take the whole process down.
  let started;
  try {
    sdk.useCamera();
    started = sdk.start();
  } catch (e) {
    state.phase = 'error';
    state.error = friendlyStartError(e);
    pushState();
    sdk = null;
    return;
  }

  Promise.resolve(started).then(() => {
    if (state.phase === 'starting') {
      state.phase = 'measuring';
      state.startedAt = Date.now();
      pushState();
      startTicker();
    }
  }).catch((e) => {
    state.phase = 'error';
    state.error = friendlyStartError(e);
    pushState();
  });

  sessionMeta = { startedAt: new Date().toISOString() };
}

function startTicker() {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => {
    if (state.startedAt) state.elapsedMs = Date.now() - state.startedAt;
    emit('tick', {
      elapsedMs: state.elapsedMs,
      packets: state.packets,
      pulseSamples: state.pulseSamples,
      breathSamples: state.breathSamples,
    });
  }, 500);
}

async function stopSession() {
  if (!sdk) { state.phase = 'idle'; pushState(); return; }
  state.phase = 'stopping';
  pushState();
  if (ticker) { clearInterval(ticker); ticker = null; }

  const withTimeout = (p, ms) => Promise.race([
    Promise.resolve(p).catch(() => {}),
    new Promise((r) => setTimeout(r, ms)),
  ]);

  await withTimeout(sdk.stop(), 10000);
  await withTimeout(sdk.destroy(), 10000);
  sdk = null;

  const receipt = writeReceipt();
  state.phase = 'stopped';
  pushState();
  emit('receipt', receipt);
}

function writeReceipt() {
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const receipt = {
    app: 'Lamplight',
    version: '1.0.0',
    kind: 'measurement-receipt',
    id,
    startedAt: sessionMeta ? sessionMeta.startedAt : null,
    endedAt: now.toISOString(),
    durationMs: state.elapsedMs,
    metrics: {
      pulse: state.pulse ? {
        value: Number(state.pulse.value.toFixed(1)),
        unit: 'bpm',
        confidence: state.pulse.confidence != null ? Number(state.pulse.confidence.toFixed(1)) : null,
        stable: state.pulse.stable,
      } : { value: null, unit: 'bpm', status: 'not readable' },
      breathing: state.breathing ? {
        value: Number(state.breathing.value.toFixed(1)),
        unit: 'breaths/min',
        confidence: state.breathing.confidence != null ? Number(state.breathing.confidence.toFixed(1)) : null,
        stable: state.breathing.stable,
      } : { value: null, unit: 'breaths/min', status: 'not readable' },
    },
    packets: state.packets,
    conditions: state.roomLog.length
      ? state.roomLog.map((c) => ({ condition: c.label, guidance: c.fix, first_seen_ms: c.firstSeenMs }))
      : [{ condition: 'Clear', guidance: 'No obstruction reported.', first_seen_ms: 0 }],
    statement:
      'Values marked null were not measured. Lamplight does not estimate, infer, or fill in a reading it did not receive.',
    device: { platform: process.platform + '-' + process.arch, node: process.version },
  };

  try {
    fs.mkdirSync(RECEIPTS, { recursive: true });
    const file = path.join(RECEIPTS, `receipt-${id}.json`);
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
    receipt.file = path.basename(file);
  } catch (e) {
    receipt.file = null;
  }
  return receipt;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('\n');
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/start' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    startSession();
    return;
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    stopSession();
    return;
  }

  if (url.pathname.startsWith('/receipts/')) {
    const name = path.basename(url.pathname);
    return serveFile(res, path.join(RECEIPTS, name));
  }

  if (url.pathname === '/api/receipts') {
    let files = [];
    try { files = fs.readdirSync(RECEIPTS).filter((f) => f.endsWith('.json')).sort().reverse(); } catch { /* none */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const target = path.join(PUBLIC, rel);
  if (!target.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, target);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  LAMPLIGHT');
  console.log('  ─────────────────────────────────────────');
  console.log(`  open   http://localhost:${PORT}`);
  console.log(`  key    ${process.env.PHYSIOLOGY_API_KEY ? 'set' : 'NOT SET — export PHYSIOLOGY_API_KEY first'}`);
  console.log('');
});

// A camera or native fault must never take the server down mid-session; the
// page is the only thing the user can see, and a dead server shows nothing.
process.on('uncaughtException', (e) => {
  console.error('[lamplight] uncaught:', e && e.message);
  state.phase = 'error';
  state.error = friendlyStartError(e);
  pushState();
});

process.on('SIGINT', async () => {
  if (sdk) { try { await sdk.destroy(); } catch { /* gone */ } }
  process.exit(0);
});
