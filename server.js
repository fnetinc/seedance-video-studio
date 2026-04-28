const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);

const PORT = process.env.PORT || 3000;
const USEAPI_TOKEN = process.env.USEAPI_TOKEN;
const RUNWAY_EMAIL = process.env.RUNWAY_EMAIL || '';
const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const USEAPI_BASE = 'https://api.useapi.net/v1/runwayml';

if (!USEAPI_TOKEN) console.warn('[warn] USEAPI_TOKEN is not set.');
if (!APP_USERNAME || !APP_PASSWORD) console.warn('[warn] APP_USERNAME / APP_PASSWORD not set — login will fail.');

const app = express();
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const authHeader = () => ({ Authorization: `Bearer ${USEAPI_TOKEN}` });

// ── Auth ────────────────────────────────────────────────────────────

function checkBasicAuth(req) {
  if (!APP_USERNAME || !APP_PASSWORD) return false;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return user === APP_USERNAME && pass === APP_PASSWORD;
}

function requireAuth(req, res, next) {
  if (!APP_USERNAME || !APP_PASSWORD) return res.status(500).json({ error: 'Auth not configured on server.' });
  if (!checkBasicAuth(req)) return res.status(401).json({ error: 'Authentication required.' });
  next();
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!APP_USERNAME || !APP_PASSWORD) return res.status(500).json({ error: 'Auth not configured on server.' });
  if (username !== APP_USERNAME || password !== APP_PASSWORD) return res.status(401).json({ error: 'Invalid credentials.' });
  res.json({ ok: true });
});

// All /api/* routes (except login) require auth
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login') return next();
  return requireAuth(req, res, next);
});

// Static files (login page, app) are public — auth is enforced on API
app.use(express.static(path.join(__dirname, 'public')));

// ── useapi.net helpers ──────────────────────────────────────────────

async function apiCall(method, url, opts = {}) {
  console.log(`[api] ${method} ${url}`);
  const res = await fetch(url, { method, ...opts, headers: { ...authHeader(), ...opts.headers } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) console.warn(`[api] ${res.status}`, JSON.stringify(json).slice(0, 400));
  return { ok: res.ok, status: res.status, json };
}

// Treat 5xx, 429, network errors, and useapi/Cloudflare HTML error pages as transient.
function isTransientApiResult(result) {
  if (!result) return true;
  if (result.status >= 500) return true;
  if (result.status === 429) return true;
  if (result.status === 408) return true;
  // Cloudflare/useapi error pages come back as { _raw: "error code: 522" } etc.
  if (result.json?._raw && typeof result.json._raw === 'string' && /error code: \d+/i.test(result.json._raw)) return true;
  return false;
}

async function apiCallWithRetry(method, url, opts = {}, label = 'api') {
  const delaysMs = [10_000, 30_000, 60_000, 120_000, 240_000]; // ~7.5 min total budget
  let lastResult = null;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      const result = await apiCall(method, url, opts);
      if (result.ok) return result;
      lastResult = result;
      if (!isTransientApiResult(result)) return result; // permanent error — surface immediately
      if (attempt === delaysMs.length) return result;
      const wait = delaysMs[attempt];
      console.warn(`[${label}] transient ${result.status}, retry ${attempt + 1}/${delaysMs.length} in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    } catch (err) {
      // Network-level failure (DNS, ECONNRESET, etc.) — retry
      console.warn(`[${label}] network error: ${err.message}, attempt ${attempt + 1}/${delaysMs.length + 1}`);
      if (attempt === delaysMs.length) throw err;
      await new Promise(r => setTimeout(r, delaysMs[attempt]));
    }
  }
  return lastResult;
}

async function uploadAsset(buffer, mimetype, name) {
  const params = new URLSearchParams({ name });
  if (RUNWAY_EMAIL) params.set('email', RUNWAY_EMAIL);
  const { ok, json } = await apiCallWithRetry('POST', `${USEAPI_BASE}/assets/?${params}`, {
    headers: { 'Content-Type': mimetype },
    body: buffer,
  }, 'uploadAsset');
  if (!ok) throw new Error(json?.error || json?.message || JSON.stringify(json));
  return json;
}

async function createVideo(assetId, prompt, mode = 'unlimited') {
  const body = {
    model: 'seedance-2',
    text_prompt: prompt,
    duration: 15,
    aspect_ratio: '16:9',
    resolution: '720p',
    audio: true,
    imageAssetId1: assetId,
  };
  // mode: 'unlimited' uses exploreMode (no credit cost, requires unlimited Runway plan)
  // mode: 'credits' omits exploreMode so Runway charges credits as normal
  if (mode === 'unlimited') body.exploreMode = true;
  if (RUNWAY_EMAIL) body.email = RUNWAY_EMAIL;
  const { ok, json } = await apiCallWithRetry('POST', `${USEAPI_BASE}/videos/create`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'createVideo');
  if (!ok) throw new Error(json?.error || json?.message || JSON.stringify(json));
  return json;
}

async function fetchTask(taskId) {
  const { ok, json } = await apiCallWithRetry('GET', `${USEAPI_BASE}/tasks/${taskId}`, {}, 'fetchTask');
  if (!ok) throw new Error(json?.error || json?.message || JSON.stringify(json));
  return json;
}

function getTaskObj(payload) {
  if (!payload) return null;
  if (payload.task) return payload.task;
  if (Array.isArray(payload.tasks) && payload.tasks.length) return payload.tasks[0];
  if (payload.taskId || payload.status) return payload;
  return null;
}

function getCompositeTaskId(obj) {
  if (!obj) return null;
  const isComposite = (v) => typeof v === 'string' && v.includes('-runwayml:') && v.includes('-task:');
  for (const src of [obj, obj?.task]) {
    if (!src || typeof src !== 'object') continue;
    for (const v of Object.values(src)) if (isComposite(v)) return v;
  }
  return null;
}

function getVideoUrl(task) {
  if (!task) return null;
  const arts = Array.isArray(task.artifacts) ? task.artifacts : [];
  for (const a of arts) {
    if (a?.url && typeof a.url === 'string' && a.url.startsWith('http')) return a.url;
  }
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

// ── ffmpeg helper: extract last frame ───────────────────────────────

async function extractLastFrame(videoBuffer) {
  const id = crypto.randomBytes(8).toString('hex');
  const inFile = path.join(os.tmpdir(), `seedance-in-${id}.mp4`);
  const outFile = path.join(os.tmpdir(), `seedance-out-${id}.jpg`);
  await fs.promises.writeFile(inFile, videoBuffer);
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inFile)
        .inputOptions(['-sseof', '-0.5'])
        .outputOptions(['-frames:v', '1', '-q:v', '2', '-update', '1'])
        .output(outFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    return await fs.promises.readFile(outFile);
  } finally {
    fs.promises.unlink(inFile).catch(() => {});
    fs.promises.unlink(outFile).catch(() => {});
  }
}

// ── Single-shot endpoints (legacy) ──────────────────────────────────

app.post('/api/generate', upload.single('image'), async (req, res) => {
  try {
    if (!USEAPI_TOKEN) return res.status(500).json({ error: 'USEAPI_TOKEN not configured.' });
    if (!req.file) return res.status(400).json({ error: 'Image required.' });
    const prompt = (req.body.prompt || '').toString().trim();
    if (!prompt) return res.status(400).json({ error: 'Prompt required.' });

    const assetName = `ref-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const asset = await uploadAsset(req.file.buffer, req.file.mimetype || 'image/png', assetName);
    const assetId = asset.assetId || asset.id;
    if (!assetId) return res.status(502).json({ error: 'No assetId returned.' });

    const mode = (req.body.mode === 'credits') ? 'credits' : 'unlimited';
    const created = await createVideo(assetId, prompt, mode);
    const task = getTaskObj(created);
    const taskId = getCompositeTaskId(created) || task?.taskId || task?.id;
    if (!taskId) return res.status(502).json({ error: 'No taskId returned.' });

    res.json({ taskId, status: task?.status || 'PENDING', prompt, mode });
  } catch (err) {
    console.error('[generate]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const taskId = req.query.taskId;
    if (!taskId) return res.status(400).json({ error: 'taskId required.' });
    const payload = await fetchTask(taskId);
    const task = getTaskObj(payload) || {};
    const status = task.status || 'UNKNOWN';
    const videoUrl = getVideoUrl(task);
    res.json({
      taskId,
      status,
      videoUrl,
      progressRatio: task.progressRatio ?? null,
      progressText: task.progressText ?? null,
      estimatedTimeToStartSeconds: task.estimatedTimeToStartSeconds ?? null,
      error: task.error || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, taskId: req.query.taskId });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const taskId = req.query.taskId;
    if (!taskId) return res.status(400).json({ error: 'taskId required.' });
    const payload = await fetchTask(taskId);
    const url = getVideoUrl(getTaskObj(payload));
    if (!url) return res.status(404).json({ error: 'Video not ready.' });
    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) return res.status(502).json({ error: `Upstream ${upstream.status}` });
    const safe = taskId.replace(/[^a-z0-9_-]/gi, '_');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="seedance-${safe}.mp4"`);
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// ── Chain orchestrator ──────────────────────────────────────────────

const chains = new Map();
const POLL_INTERVAL_MS = 30 * 1000;
const PER_CLIP_TIMEOUT_MS = 50 * 60 * 1000; // 50 min ceiling per clip

function chainSnapshot(c) {
  return {
    id: c.id,
    mode: c.mode,
    totalPrompts: c.prompts.length,
    prompts: c.prompts,
    currentIndex: c.currentIndex,
    currentStatus: c.currentStatus,
    currentTaskId: c.currentTaskId,
    currentTaskStatus: c.currentTaskStatus,
    currentTaskProgress: c.currentTaskProgress,
    currentClipStartedAt: c.currentClipStartedAt,
    currentPollCount: c.currentPollCount,
    stopped: c.stopped,
    error: c.error,
    startedAt: c.startedAt,
    completedAt: c.completedAt || null,
    clips: c.clips.map(clip => ({ index: clip.index, taskId: clip.taskId, prompt: clip.prompt, sizeBytes: clip.buffer.length })),
  };
}

async function runChain(chainId) {
  const c = chains.get(chainId);
  if (!c) return;

  let referenceBuffer = c.initialImage.buffer;
  let referenceMime = c.initialImage.mimetype;

  try {
    for (let i = 0; i < c.prompts.length; i++) {
      if (c.stopped) { c.currentStatus = 'STOPPED'; return; }
      c.currentIndex = i;
      c.currentClipStartedAt = Date.now();
      c.currentPollCount = 0;
      c.currentTaskStatus = null;
      c.currentTaskProgress = null;

      // Upload reference frame
      c.currentStatus = 'UPLOADING_REFERENCE';
      const assetName = `chain-${c.id}-${i}-${Date.now()}`;
      const asset = await uploadAsset(referenceBuffer, referenceMime, assetName);
      const assetId = asset.assetId || asset.id;
      if (!assetId) throw new Error(`Clip ${i + 1}: no assetId returned`);

      // Create video
      c.currentStatus = 'CREATING_VIDEO';
      const created = await createVideo(assetId, c.prompts[i], c.mode);
      const task = getTaskObj(created);
      const taskId = getCompositeTaskId(created) || task?.taskId || task?.id;
      if (!taskId) throw new Error(`Clip ${i + 1}: no taskId returned`);
      c.currentTaskId = taskId;

      // Patient poll loop
      c.currentStatus = 'GENERATING';
      let videoUrl = null;
      const pollStart = Date.now();
      while (true) {
        if (c.stopped) { c.currentStatus = 'STOPPED'; return; }
        if (Date.now() - pollStart > PER_CLIP_TIMEOUT_MS) throw new Error(`Clip ${i + 1}: timed out after 50 min`);
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        if (c.stopped) { c.currentStatus = 'STOPPED'; return; }
        c.currentPollCount++;
        try {
          const payload = await fetchTask(taskId);
          const t = getTaskObj(payload) || {};
          c.currentTaskStatus = t.status || null;
          c.currentTaskProgress = t.progressRatio ?? null;
          if (t.status === 'SUCCEEDED') {
            videoUrl = getVideoUrl(t);
            if (!videoUrl) throw new Error(`Clip ${i + 1}: SUCCEEDED but no video URL`);
            break;
          }
          if (t.status === 'FAILED') throw new Error(`Clip ${i + 1} failed: ${t.error || 'unknown'}`);
        } catch (e) {
          // Transient errors: log and keep polling
          console.warn(`[chain ${c.id}] poll #${c.currentPollCount} error:`, e.message);
        }
      }

      // Download (with retry — CloudFront signed URLs can flake transiently)
      c.currentStatus = 'DOWNLOADING';
      let videoBuffer = null;
      const downloadDelays = [10_000, 30_000, 60_000, 120_000];
      for (let attempt = 0; attempt <= downloadDelays.length; attempt++) {
        if (c.stopped) { c.currentStatus = 'STOPPED'; return; }
        try {
          const upstream = await fetch(videoUrl);
          if (upstream.ok) {
            videoBuffer = Buffer.from(await upstream.arrayBuffer());
            break;
          }
          if (upstream.status < 500 && upstream.status !== 429) {
            throw new Error(`Clip ${i + 1}: download failed (${upstream.status})`);
          }
          if (attempt === downloadDelays.length) throw new Error(`Clip ${i + 1}: download failed (${upstream.status}) after ${attempt + 1} attempts`);
          console.warn(`[chain ${c.id}] download ${upstream.status}, retry ${attempt + 1}/${downloadDelays.length}`);
        } catch (e) {
          if (attempt === downloadDelays.length) throw e;
          console.warn(`[chain ${c.id}] download error: ${e.message}, retry ${attempt + 1}/${downloadDelays.length}`);
        }
        await new Promise(r => setTimeout(r, downloadDelays[attempt]));
      }
      if (!videoBuffer) throw new Error(`Clip ${i + 1}: download failed`);

      c.clips.push({ index: i, taskId, videoUrl, prompt: c.prompts[i], buffer: videoBuffer });

      // Extract last frame for next iteration
      if (i < c.prompts.length - 1) {
        if (c.stopped) { c.currentStatus = 'STOPPED'; return; }
        c.currentStatus = 'EXTRACTING_FRAME';
        try {
          referenceBuffer = await extractLastFrame(videoBuffer);
          referenceMime = 'image/jpeg';
        } catch (e) {
          throw new Error(`Clip ${i + 1}: frame extraction failed: ${e.message}`);
        }
      }
    }
    c.currentStatus = 'COMPLETED';
    c.completedAt = Date.now();
  } catch (err) {
    console.error(`[chain ${c.id}] FAILED`, err);
    c.error = err.message;
    c.currentStatus = 'FAILED';
  }
}

app.post('/api/chain/start', upload.single('image'), async (req, res) => {
  try {
    if (!USEAPI_TOKEN) return res.status(500).json({ error: 'USEAPI_TOKEN not configured.' });
    if (!req.file) return res.status(400).json({ error: 'Initial reference image required.' });

    let prompts;
    try {
      prompts = JSON.parse(req.body.prompts || '[]');
    } catch {
      return res.status(400).json({ error: 'prompts must be a JSON array of strings.' });
    }
    if (!Array.isArray(prompts) || !prompts.length) return res.status(400).json({ error: 'At least one prompt required.' });
    prompts = prompts.map(p => String(p).trim()).filter(Boolean);
    if (!prompts.length) return res.status(400).json({ error: 'No non-empty prompts.' });
    if (prompts.length > 100) return res.status(400).json({ error: 'Max 100 prompts per chain.' });

    const mode = (req.body.mode === 'credits') ? 'credits' : 'unlimited';

    const chainId = crypto.randomBytes(8).toString('hex');
    const chain = {
      id: chainId,
      prompts,
      mode,
      currentIndex: 0,
      currentStatus: 'STARTING',
      currentTaskId: null,
      currentTaskStatus: null,
      currentTaskProgress: null,
      currentClipStartedAt: null,
      currentPollCount: 0,
      clips: [],
      stopped: false,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      initialImage: { buffer: req.file.buffer, mimetype: req.file.mimetype || 'image/png' },
    };
    chains.set(chainId, chain);
    runChain(chainId);
    res.json({ chainId, totalPrompts: prompts.length, mode });
  } catch (err) {
    console.error('[chain/start]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chain/status', (req, res) => {
  const c = chains.get(req.query.chainId);
  if (!c) return res.status(404).json({ error: 'Chain not found.' });
  res.json(chainSnapshot(c));
});

app.post('/api/chain/stop', (req, res) => {
  const c = chains.get(req.body?.chainId);
  if (!c) return res.status(404).json({ error: 'Chain not found.' });
  c.stopped = true;
  res.json({ ok: true, snapshot: chainSnapshot(c) });
});

app.get('/api/chain/list', (_req, res) => {
  res.json({ chains: [...chains.values()].map(chainSnapshot) });
});

app.get('/api/chain/clip', (req, res) => {
  const c = chains.get(req.query.chainId);
  if (!c) return res.status(404).json({ error: 'Chain not found.' });
  const idx = parseInt(req.query.index, 10);
  const clip = c.clips[idx];
  if (!clip) return res.status(404).json({ error: 'Clip not ready.' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="clip-${String(idx + 1).padStart(2, '0')}.mp4"`);
  res.send(clip.buffer);
});

app.get('/api/chain/zip', (req, res) => {
  const c = chains.get(req.query.chainId);
  if (!c) return res.status(404).json({ error: 'Chain not found.' });
  if (!c.clips.length) return res.status(404).json({ error: 'No clips yet.' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="chain-${c.id}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (e) => { console.error('[zip]', e); try { res.end(); } catch {} });
  archive.pipe(res);
  for (const clip of c.clips) {
    archive.append(clip.buffer, { name: `clip-${String(clip.index + 1).padStart(2, '0')}.mp4` });
  }
  archive.finalize();
});

app.delete('/api/chain', (req, res) => {
  const id = req.query.chainId || req.body?.chainId;
  const c = chains.get(id);
  if (!c) return res.status(404).json({ error: 'Chain not found.' });
  c.stopped = true;
  chains.delete(id);
  res.json({ ok: true });
});

app.get('/api/accounts', async (_req, res) => {
  try {
    const { ok, json, status } = await apiCall('GET', `${USEAPI_BASE}/accounts/`);
    if (!ok) return res.status(status).json(json);
    const emails = json && typeof json === 'object' ? Object.keys(json) : [];
    res.json({ count: emails.length, emails, pinnedEmail: RUNWAY_EMAIL || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Seedance Video Studio listening on :${PORT}`));
