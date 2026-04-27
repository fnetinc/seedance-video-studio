const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const USEAPI_TOKEN = process.env.USEAPI_TOKEN;
const RUNWAY_EMAIL = process.env.RUNWAY_EMAIL || '';
const USEAPI_BASE = 'https://api.useapi.net/v1/runwayml';

if (!USEAPI_TOKEN) {
  console.warn('[warn] USEAPI_TOKEN is not set.');
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const authHeader = () => ({ Authorization: `Bearer ${USEAPI_TOKEN}` });

// ── useapi.net helpers ──────────────────────────────────────────────

async function apiCall(method, url, opts = {}) {
  console.log(`[api] ${method} ${url}`);
  const res = await fetch(url, { method, ...opts, headers: { ...authHeader(), ...opts.headers } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  console.log(`[api] ${res.status} ${JSON.stringify(json).slice(0, 500)}`);
  return { ok: res.ok, status: res.status, json };
}

async function uploadAsset(buffer, mimetype, name) {
  const params = new URLSearchParams({ name });
  if (RUNWAY_EMAIL) params.set('email', RUNWAY_EMAIL);
  const { ok, json } = await apiCall('POST', `${USEAPI_BASE}/assets/?${params}`, {
    headers: { 'Content-Type': mimetype },
    body: buffer,
  });
  if (!ok) throw new Error(json?.error || json?.message || JSON.stringify(json));
  return json;
}

async function createVideo(assetId, prompt) {
  const body = {
    model: 'seedance-2',
    text_prompt: prompt,
    duration: 15,
    aspect_ratio: '16:9',
    resolution: '720p',
    audio: true,
    imageAssetId1: assetId,
    exploreMode: true,
  };
  if (RUNWAY_EMAIL) body.email = RUNWAY_EMAIL;
  const { ok, json } = await apiCall('POST', `${USEAPI_BASE}/videos/create`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!ok) throw new Error(json?.error || json?.message || JSON.stringify(json));
  return json;
}

async function fetchTask(taskId) {
  // useapi.net expects taskId as a path segment. Encode it to handle : and @
  const encoded = encodeURIComponent(taskId);
  const qs = RUNWAY_EMAIL ? `?email=${encodeURIComponent(RUNWAY_EMAIL)}` : '';
  const { ok, json } = await apiCall('GET', `${USEAPI_BASE}/tasks/${encoded}${qs}`);
  if (!ok) throw new Error(json?.error || json?.message || JSON.stringify(json));
  return json;
}

// ── Response parsing ────────────────────────────────────────────────

function getTask(payload) {
  if (!payload) return null;
  if (payload.task) return payload.task;
  if (Array.isArray(payload.tasks) && payload.tasks.length) return payload.tasks[0];
  if (payload.taskId || payload.status) return payload;
  return null;
}

function getCompositeTaskId(obj) {
  if (!obj) return null;
  const isComposite = (v) => typeof v === 'string' && v.includes('-runwayml:') && v.includes('-task:');
  // Check top-level and .task
  for (const src of [obj, obj?.task]) {
    if (!src || typeof src !== 'object') continue;
    for (const v of Object.values(src)) {
      if (isComposite(v)) return v;
    }
  }
  return null;
}

function getVideoUrl(task) {
  if (!task) return null;
  // Check artifacts first (Runway's standard shape)
  const arts = Array.isArray(task.artifacts) ? task.artifacts : [];
  for (const a of arts) {
    if (a?.url && typeof a.url === 'string' && a.url.startsWith('http')) return a.url;
  }
  // Fallback: crawl all string values for any http URL that isn't an image
  let found = null;
  const isImage = (s) => /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(s);
  const walk = (node, depth) => {
    if (found || !node || depth > 5) return;
    if (typeof node === 'string') { if (node.startsWith('http') && !isImage(node)) found = node; return; }
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    if (typeof node === 'object') { for (const v of Object.values(node)) walk(v, depth + 1); }
  };
  walk(task, 0);
  return found;
}

// ── Routes ──────────────────────────────────────────────────────────

app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!USEAPI_TOKEN) return res.status(500).json({ error: 'USEAPI_TOKEN not configured.' });
    if (!req.file) return res.status(400).json({ error: 'Image required.' });
    const prompt = (req.body.prompt || '').toString().trim();
    if (!prompt) return res.status(400).json({ error: 'Prompt required.' });

    // 1. Upload asset
    const assetName = `ref-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const asset = await uploadAsset(req.file.buffer, req.file.mimetype || 'image/png', assetName);
    const assetId = asset.assetId || asset.id;
    if (!assetId) return res.status(502).json({ error: 'No assetId returned.', _raw: asset });

    // 2. Create video
    const created = await createVideo(assetId, prompt);
    const task = getTask(created);
    const taskId = getCompositeTaskId(created) || task?.taskId || task?.id;
    if (!taskId) return res.status(502).json({ error: 'No taskId returned.', _raw: created });

    console.log(`[generate] OK taskId=${taskId}`);
    res.json({ taskId, status: task?.status || 'PENDING', prompt, _raw: created });
  } catch (err) {
    console.error('[generate] ERROR', err);
    res.status(500).json({ error: err.message });
  }
});

// Using query param to avoid path-encoding issues with composite taskId
app.get('/api/status', async (req, res) => {
  try {
    if (!USEAPI_TOKEN) return res.status(500).json({ error: 'USEAPI_TOKEN not configured.' });
    const taskId = req.query.taskId;
    if (!taskId) return res.status(400).json({ error: 'taskId query param required.' });

    const payload = await fetchTask(taskId);
    const task = getTask(payload) || {};
    const status = task.status || 'UNKNOWN';
    const videoUrl = getVideoUrl(task);

    console.log(`[status] ${taskId.slice(-12)} → ${status} video=${videoUrl ? 'YES' : 'no'}`);
    if (status === 'SUCCEEDED' && !videoUrl) {
      console.warn('[status] SUCCEEDED but no video URL! artifacts:', JSON.stringify(task.artifacts));
    }
    res.json({ taskId, status, videoUrl, progressRatio: task.progressRatio ?? null, progressText: task.progressText ?? null, estimatedTimeToStartSeconds: task.estimatedTimeToStartSeconds ?? null, error: task.error || null, _raw: payload });
  } catch (err) {
    console.error('[status] ERROR', err);
    res.status(500).json({ error: err.message, taskId: req.query.taskId });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const taskId = req.query.taskId;
    if (!taskId) return res.status(400).json({ error: 'taskId query param required.' });

    const payload = await fetchTask(taskId);
    const task = getTask(payload);
    const url = getVideoUrl(task);
    if (!url) return res.status(404).json({ error: 'Video not ready.', status: task?.status });

    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) return res.status(502).json({ error: `Upstream ${upstream.status}` });

    const safe = taskId.replace(/[^a-z0-9_-]/gi, '_');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="seedance-${safe}.mp4"`);
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error('[download]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

app.post('/api/download-bulk', async (req, res) => {
  try {
    const taskIds = Array.isArray(req.body?.taskIds) ? req.body.taskIds : [];
    if (!taskIds.length) return res.status(400).json({ error: 'taskIds required.' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="seedance-videos-${Date.now()}.zip"`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (e) => { console.error('[zip]', e); try { res.end(); } catch {} });
    archive.pipe(res);

    for (const taskId of taskIds) {
      try {
        const payload = await fetchTask(taskId);
        const url = getVideoUrl(getTask(payload));
        if (!url) continue;
        const upstream = await fetch(url);
        if (!upstream.ok) continue;
        const buf = Buffer.from(await upstream.arrayBuffer());
        const safe = String(taskId).replace(/[^a-z0-9_-]/gi, '_');
        archive.append(buf, { name: `seedance-${safe}.mp4` });
      } catch (e) {
        console.error('[zip-item]', e.message);
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error('[bulk]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

app.get('/api/accounts', async (_req, res) => {
  try {
    if (!USEAPI_TOKEN) return res.status(500).json({ error: 'USEAPI_TOKEN not configured.' });
    const { ok, json, status } = await apiCall('GET', `${USEAPI_BASE}/accounts/`);
    if (!ok) return res.status(status).json(json);
    const emails = json && typeof json === 'object' ? Object.keys(json) : [];
    res.json({ count: emails.length, emails, pinnedEmail: RUNWAY_EMAIL || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Seedance Video Studio listening on :${PORT}`));
